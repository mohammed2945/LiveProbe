"""Python 3.12+ runtime agent built on PEP 669 ``sys.monitoring``."""

from __future__ import annotations

import inspect
import json
import math
import os
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import CodeType, FrameType
from typing import IO, Any, Mapping

from .serializer import SerializerConfig, render_node, serialize

_MISSING = object()
_TEMPLATE_PATH = re.compile(r"\$\{([^{}]+)\}")
_CONDITION_OPS = frozenset({"eq", "ne", "gt", "gte", "lt", "lte"})
_MAX_REQUEST_TIMEOUT_SECONDS = 10.0
_MAX_SHUTDOWN_TIMEOUT_SECONDS = 30.0
_COMMIT_SHA = re.compile(r"^[0-9a-fA-F]{7,64}$")


def _env(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return None
    return value.strip()


def _resolve_commit_sha(value: str | None) -> tuple[str, str]:
    raw = value.strip() if isinstance(value, str) and value.strip() else None
    source = "config"
    if raw is None:
        raw = _env("LIVEPROBE_COMMIT_SHA") or _env("GIT_COMMIT")
        source = "env"
    if raw is None or raw.lower() == "unknown":
        raise ValueError(
            "commit_sha is required; pass commit_sha or set LIVEPROBE_COMMIT_SHA/GIT_COMMIT"
        )
    if _COMMIT_SHA.fullmatch(raw) is None:
        raise ValueError("commit_sha must be a 7-64 character hexadecimal Git object ID")
    return raw.lower(), source


def _now_rfc3339() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _rfc3339_from_ns(timestamp_ns: int) -> str:
    return (
        datetime.fromtimestamp(timestamp_ns / 1_000_000_000, UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _number(value: object) -> bool:
    return (
        type(value) in (int, float)
        and (type(value) is not float or math.isfinite(value))
    )


def resolve_dot_path(root: object, path: str) -> object:
    """Resolve a path without invoking properties, descriptors, or custom accessors."""

    if not isinstance(path, str) or not path:
        return _MISSING
    current = root
    for segment in path.split("."):
        if not segment:
            return _MISSING
        if isinstance(current, dict):
            current = dict.get(current, segment, _MISSING)
        elif isinstance(current, list) and segment.isdecimal():
            index = int(segment)
            if index >= list.__len__(current):
                return _MISSING
            current = list.__getitem__(current, index)
        elif isinstance(current, tuple) and segment.isdecimal():
            index = int(segment)
            if index >= tuple.__len__(current):
                return _MISSING
            current = tuple.__getitem__(current, index)
        else:
            try:
                candidate = inspect.getattr_static(current, segment, _MISSING)
            except (AttributeError, TypeError):
                return _MISSING
            if candidate is _MISSING or inspect.isdatadescriptor(candidate):
                return _MISSING
            current = candidate
        if current is _MISSING:
            return _MISSING
    return current


@dataclass(frozen=True, slots=True)
class Condition:
    path: str
    op: str
    value: str | int | float | bool | None

    @classmethod
    def parse(cls, raw: object) -> Condition | None:
        if raw is None:
            return None
        if not isinstance(raw, dict):
            raise ValueError("condition must be an object")
        path = dict.get(raw, "path")
        op = dict.get(raw, "op")
        value = dict.get(raw, "value")
        if not isinstance(path, str) or not path or any(
            not segment for segment in path.split(".")
        ):
            raise ValueError("condition.path must be a dot path")
        if op not in _CONDITION_OPS:
            raise ValueError("condition.op is invalid")
        if value is not None and not isinstance(value, (str, int, float, bool)):
            raise ValueError("condition.value must be a JSON scalar")
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("condition.value must be finite")
        assert isinstance(op, str)
        return cls(path=path, op=op, value=value)


def condition_matches(condition: Condition | None, captured: dict[str, object]) -> bool:
    if condition is None:
        return True
    actual = resolve_dot_path(captured, condition.path)
    if actual is _MISSING:
        return False
    expected = condition.value
    if condition.op in {"eq", "ne"}:
        if _number(actual) and _number(expected):
            equal = actual == expected
        else:
            equal = type(actual) is type(expected) and actual == expected
        return equal if condition.op == "eq" else not equal
    if not (_number(actual) and _number(expected)):
        return False
    if condition.op == "gt":
        return actual > expected
    if condition.op == "gte":
        return actual >= expected
    if condition.op == "lt":
        return actual < expected
    return actual <= expected


def _positive_int(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{field_name} must be a positive integer")
    return value


@dataclass(frozen=True, slots=True)
class Probe:
    probe_id: str
    service_id: str
    kind: str
    file: str
    line: int
    hit_limit: int
    ttl_seconds: int
    version: int
    created_by: str
    condition: Condition | None = None
    watch_paths: tuple[str, ...] = ()
    template: str | None = None
    metric_path: str | None = None

    @classmethod
    def parse(cls, raw: object, expected_service: str) -> Probe:
        if not isinstance(raw, dict):
            raise ValueError("probe must be an object")
        probe_id = dict.get(raw, "id")
        service_id = dict.get(raw, "serviceId")
        kind = dict.get(raw, "type")
        file_name = dict.get(raw, "file")
        created_by = dict.get(raw, "createdBy")
        if not isinstance(probe_id, str) or not probe_id:
            raise ValueError("probe.id is required")
        if service_id != expected_service:
            raise ValueError("probe.serviceId does not match this agent")
        if kind not in {"snapshot", "log", "counter", "metric"}:
            raise ValueError("probe.type is invalid")
        if not isinstance(file_name, str) or not file_name:
            raise ValueError("probe.file is required")
        if not isinstance(created_by, str) or not created_by:
            raise ValueError("probe.createdBy is required")

        defaults = {"snapshot": 1, "log": 100, "counter": 10_000, "metric": 10_000}
        line = _positive_int(dict.get(raw, "line"), "line")
        hit_limit = _positive_int(
            dict.get(raw, "hitLimit", defaults[kind]), "hitLimit"
        )
        ttl_seconds = _positive_int(dict.get(raw, "ttlSeconds", 1800), "ttlSeconds")
        version = _positive_int(dict.get(raw, "version"), "version")

        watch_paths_raw = dict.get(raw, "watchPaths", ())
        if not isinstance(watch_paths_raw, (list, tuple)) or not all(
            isinstance(path, str) and path for path in watch_paths_raw
        ):
            raise ValueError("watchPaths must contain non-empty strings")
        template = dict.get(raw, "template")
        metric_path = dict.get(raw, "metricPath")
        if kind == "log" and not isinstance(template, str):
            raise ValueError("log probes require template")
        if kind == "metric" and (
            not isinstance(metric_path, str) or not metric_path
        ):
            raise ValueError("metric probes require metricPath")

        return cls(
            probe_id=probe_id,
            service_id=service_id,
            kind=kind,
            file=file_name.replace("\\", "/"),
            line=line,
            hit_limit=hit_limit,
            ttl_seconds=ttl_seconds,
            version=version,
            created_by=created_by,
            condition=Condition.parse(dict.get(raw, "condition")),
            watch_paths=tuple(watch_paths_raw),
            template=template if isinstance(template, str) else None,
            metric_path=metric_path if isinstance(metric_path, str) else None,
        )


@dataclass(slots=True)
class ProbeState:
    probe: Probe
    emitted: int = 0
    in_flight: int = 0
    active: bool = True
    last_error: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def reserve(self) -> ProbeReservation | None:
        with self.lock:
            if (
                not self.active
                or self.emitted + self.in_flight >= self.probe.hit_limit
            ):
                return None
            self.in_flight += 1
            return ProbeReservation(self)

    def _finish_reservation(
        self, reservation: ProbeReservation, *, emit: bool
    ) -> tuple[bool, bool]:
        with self.lock:
            if reservation.finished:
                return False, False
            reservation.finished = True
            self.in_flight -= 1
            if not emit or not self.active:
                return False, False
            self.emitted += 1
            if self.emitted >= self.probe.hit_limit:
                self.active = False
                return True, True
            return True, False

    def deactivate(self) -> None:
        with self.lock:
            self.active = False

    def is_active(self) -> bool:
        with self.lock:
            return self.active


@dataclass(slots=True)
class ProbeReservation:
    state: ProbeState
    finished: bool = False

    def release(self) -> None:
        self.state._finish_reservation(self, emit=False)

    def commit(self) -> tuple[bool, bool]:
        return self.state._finish_reservation(self, emit=True)


@dataclass(slots=True)
class ProbeCandidate:
    state: ProbeState
    reservation: ProbeReservation | None


@dataclass(frozen=True, slots=True)
class StackEntry:
    fn: str
    file: str
    line: int


@dataclass(frozen=True, slots=True)
class RawHit:
    candidates: tuple[ProbeCandidate, ...]
    variables: dict[str, object]
    stack: tuple[StackEntry, ...]
    timestamp_ns: int


@dataclass(frozen=True, slots=True)
class Lifecycle:
    action: str
    states: tuple[ProbeState, ...]
    detail: str


@dataclass(slots=True)
class MetricAggregate:
    count: int
    total: int | float
    minimum: int | float
    maximum: int | float
    last: int | float

    def add(self, value: int | float) -> None:
        self.count += 1
        self.total += value
        self.minimum = min(self.minimum, value)
        self.maximum = max(self.maximum, value)
        self.last = value


class TokenBucket:
    def __init__(self, rate: float, capacity: float | None = None) -> None:
        self.rate = max(0.0, float(rate))
        self.capacity = max(0.0, float(capacity if capacity is not None else rate))
        self.tokens = self.capacity
        self.updated_at = time.monotonic()
        self.lock = threading.Lock()

    def consume(self, amount: float = 1.0, now: float | None = None) -> bool:
        with self.lock:
            current = time.monotonic() if now is None else now
            elapsed = max(0.0, current - self.updated_at)
            self.updated_at = current
            self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
            if amount > self.tokens:
                return False
            self.tokens -= amount
            return True


class CallbackBudget:
    def __init__(self, milliseconds_per_second: float) -> None:
        self.limit_ns = max(0, int(milliseconds_per_second * 1_000_000))
        self.window_started = time.monotonic()
        self.used_ns = 0
        self.lock = threading.Lock()

    def record(self, duration_ns: int, now: float | None = None) -> bool:
        with self.lock:
            current = time.monotonic() if now is None else now
            if current - self.window_started >= 1.0:
                self.window_started = current
                self.used_ns = 0
            self.used_ns += max(0, duration_ns)
            return self.used_ns > self.limit_ns

    def reset(self, now: float | None = None) -> None:
        with self.lock:
            self.window_started = time.monotonic() if now is None else now
            self.used_ns = 0


@dataclass(frozen=True, slots=True)
class Limits:
    hits_per_sec: float = 10.0
    pause_budget_ms: float = 20.0
    cooldown_seconds: float = 10.0
    bandwidth_kb_per_sec: float = 200.0
    stack_frame_depth: int = 8
    queue_size: int = 4096
    request_timeout: float = 2.0
    shutdown_timeout: float = 5.0

    @classmethod
    def from_mapping(cls, raw: Mapping[str, object] | None) -> Limits:
        source = raw or {}

        def numeric(camel: str, snake: str, default: float) -> float:
            value = source.get(camel, source.get(snake, default))
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{camel} must be a non-negative number")
            result = float(value)
            if not math.isfinite(result) or result < 0:
                raise ValueError(f"{camel} must be a non-negative number")
            return result

        def integer(camel: str, snake: str, default: int) -> int:
            value = source.get(camel, source.get(snake, default))
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{camel} must be a non-negative integer")
            return value

        queue_size = integer("queueSize", "queue_size", 4096)
        if queue_size == 0:
            raise ValueError("queueSize must be positive")
        timeout = numeric("requestTimeout", "request_timeout", 2.0)
        if timeout == 0 or timeout > _MAX_REQUEST_TIMEOUT_SECONDS:
            raise ValueError(
                f"requestTimeout must be in (0, {_MAX_REQUEST_TIMEOUT_SECONDS:g}]"
            )
        shutdown_timeout = numeric(
            "shutdownTimeout", "shutdown_timeout", 5.0
        )
        if (
            shutdown_timeout == 0
            or shutdown_timeout > _MAX_SHUTDOWN_TIMEOUT_SECONDS
        ):
            raise ValueError(
                "shutdownTimeout must be in "
                f"(0, {_MAX_SHUTDOWN_TIMEOUT_SECONDS:g}]"
            )
        return cls(
            hits_per_sec=numeric("hitsPerSec", "hits_per_sec", 10.0),
            pause_budget_ms=numeric("pauseBudgetMs", "pause_budget_ms", 20.0),
            cooldown_seconds=numeric(
                "cooldownSeconds", "cooldown_seconds", 10.0
            ),
            bandwidth_kb_per_sec=numeric(
                "bandwidthKbPerSec", "bandwidth_kb_per_sec", 200.0
            ),
            stack_frame_depth=integer(
                "stackFrameDepth", "stack_frame_depth", 8
            ),
            queue_size=queue_size,
            request_timeout=timeout,
            shutdown_timeout=shutdown_timeout,
        )


class LiveProbe:
    """One LiveProbe agent for one service in the current process."""

    def __init__(
        self,
        *,
        service_id: str,
        broker_url: str,
        api_key: str | None = None,
        commit_sha: str | None = None,
        environment: str | None = None,
        redact_keys: list[str] | tuple[str, ...] | None = None,
        redact_values: list[str] | tuple[str, ...] | None = None,
        limits: Mapping[str, object] | None = None,
        serializer_config: Mapping[str, object] | None = None,
        poll_interval: float = 1.0,
        flush_interval: float = 2.0,
        monitoring: object | None = None,
        output: IO[str] | None = None,
    ) -> None:
        if not isinstance(service_id, str) or not service_id:
            raise ValueError("service_id is required")
        parsed_url = urllib.parse.urlsplit(broker_url)
        if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
            raise ValueError("broker_url must be an absolute HTTP(S) URL")
        if poll_interval <= 0 or flush_interval <= 0:
            raise ValueError("poll and flush intervals must be positive")

        self.service_id = service_id
        self.broker_url = broker_url.rstrip("/")
        self.api_key = api_key if api_key is not None else _env("LIVEPROBE_API_KEY")
        self.commit_sha, self.commit_source = _resolve_commit_sha(commit_sha)
        self.environment = environment
        self.limits = Limits.from_mapping(limits)
        self.serializer_config = SerializerConfig.from_mapping(
            serializer_config,
            redact_keys=redact_keys,
            redact_values=redact_values,
        )
        self.poll_interval = float(poll_interval)
        self.flush_interval = float(flush_interval)
        self.monitoring = monitoring if monitoring is not None else sys.monitoring
        self.output = output if output is not None else sys.stdout

        self._states: dict[str, ProbeState] = {}
        self._active_by_line: dict[int, tuple[ProbeState, ...]] = {}
        self._state_lock = threading.RLock()
        self._audit_lock = threading.Lock()
        self._raw_queue: queue.Queue[RawHit | Lifecycle] = queue.Queue(
            maxsize=self.limits.queue_size
        )
        self._events: list[dict[str, object]] = []
        self._counter_aggregates: dict[str, int] = {}
        self._metric_aggregates: dict[str, MetricAggregate] = {}
        self._version = 0
        self._running = False
        self._installed = False
        self._stopping = False
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._shutdown_lock = threading.Lock()
        self._worker_finished = True
        self._deferred_cleanup = False
        self._shutdown_error: str | None = None
        self._agent_state = "green"
        self._red_until = 0.0
        self._frame_depth_hint: int | None = None
        self._frame_hint_lock = threading.Lock()
        self._dropped_hits = 0

        self._hit_bucket = TokenBucket(
            self.limits.hits_per_sec, self.limits.hits_per_sec
        )
        bandwidth_bytes = self.limits.bandwidth_kb_per_sec * 1024.0
        self._bandwidth_bucket = TokenBucket(
            bandwidth_bytes, bandwidth_bytes * max(1.0, self.flush_interval)
        )
        self._callback_budget = CallbackBudget(self.limits.pause_budget_ms)

        self._tool_id = self.monitoring.DEBUGGER_ID
        self._line_event = self.monitoring.events.LINE
        self._disable = self.monitoring.DISABLE

    @property
    def running(self) -> bool:
        return self._running

    @property
    def agent_state(self) -> str:
        return self._agent_state

    @property
    def shutdown_error(self) -> str | None:
        return self._shutdown_error

    @property
    def shutdown_pending(self) -> bool:
        with self._shutdown_lock:
            return self._deferred_cleanup

    def start(self) -> LiveProbe:
        if self._running:
            return self
        with self._shutdown_lock:
            if self._thread is not None and self._thread.is_alive():
                raise RuntimeError("liveprobe daemon is still stopping")
            self._worker_finished = False
            self._deferred_cleanup = False
            self._shutdown_error = None
        self._stopping = False
        self._stop_event.clear()
        self._install_monitoring()
        self._running = True
        self._thread = threading.Thread(
            target=self._run, name="liveprobe-agent", daemon=True
        )
        self._thread.start()
        self._audit(f"AGENT STARTED {self.service_id}")
        return self

    def stop(self) -> None:
        if not self._running and not self._installed:
            return
        with self._shutdown_lock:
            if self._deferred_cleanup:
                return
        self._running = False
        self._stopping = True
        self._stop_event.set()
        if self._installed:
            try:
                self.monitoring.set_events(self._tool_id, 0)
            except Exception:
                pass
        thread = self._thread
        timed_out = thread is threading.current_thread()
        if thread is not None and not timed_out:
            thread.join(timeout=self.limits.shutdown_timeout)
            timed_out = thread.is_alive()
        if timed_out:
            detail = (
                "daemon did not stop within "
                f"{self.limits.shutdown_timeout:g}s; monitoring cleanup deferred"
            )
            with self._shutdown_lock:
                if self._worker_finished:
                    timed_out = False
                else:
                    self._deferred_cleanup = True
                    self._shutdown_error = detail
            if timed_out:
                self._agent_state = "red"
                with self._state_lock:
                    states = tuple(
                        state
                        for state in self._states.values()
                        if state.is_active()
                    )
                self._enqueue_lifecycle("error", states, detail)
                self._audit(f"AGENT STOP ERROR {detail}")
                return
        try:
            self._uninstall_monitoring()
        except Exception as error:
            self._shutdown_error = (
                f"monitoring cleanup failed: {type(error).__name__}"
            )
            self._audit(f"AGENT STOP ERROR {self._shutdown_error}")
            return
        self._stopping = False
        self._audit(f"AGENT STOPPED {self.service_id}")

    def _install_monitoring(self) -> None:
        if self._installed:
            return
        try:
            self.monitoring.use_tool_id(self._tool_id, "liveprobe")
            self.monitoring.register_callback(
                self._tool_id, self._line_event, self._on_line
            )
            self.monitoring.set_events(self._tool_id, self._line_event)
        except Exception as error:
            try:
                self.monitoring.free_tool_id(self._tool_id)
            except Exception:
                pass
            raise RuntimeError(
                "sys.monitoring DEBUGGER_ID is unavailable"
            ) from error
        self._installed = True

    def _uninstall_monitoring(self) -> None:
        if not self._installed:
            return
        try:
            self.monitoring.set_events(self._tool_id, 0)
            self.monitoring.register_callback(
                self._tool_id, self._line_event, None
            )
        finally:
            try:
                self.monitoring.free_tool_id(self._tool_id)
            finally:
                self._installed = False

    def _on_line(self, code: CodeType, line: int) -> object | None:
        started = time.perf_counter_ns()
        captures: list[ProbeCandidate] = []
        queued = False
        try:
            if self._stopping or self._agent_state == "red":
                return self._disable
            candidates = self._active_by_line.get(line)
            if not candidates:
                return self._disable
            filename = code.co_filename.replace("\\", "/")
            matching = tuple(
                state
                for state in candidates
                if filename.endswith(state.probe.file)
            )
            if not matching:
                return self._disable

            for state in matching:
                if not self._hit_bucket.consume():
                    continue
                if state.probe.condition is not None:
                    if state.is_active():
                        captures.append(ProbeCandidate(state, None))
                    continue
                reservation = state.reserve()
                if reservation is not None:
                    captures.append(ProbeCandidate(state, reservation))
            if not captures:
                return None

            frame = self._find_monitored_frame(code)
            if frame is None:
                for capture in captures:
                    if capture.reservation is not None:
                        capture.reservation.release()
                self._enqueue_lifecycle(
                    "error",
                    tuple(capture.state for capture in captures),
                    "instrumented frame not found",
                )
                return None

            variables = dict(frame.f_locals)
            stack = self._capture_stack(frame)
            hit = RawHit(
                candidates=tuple(captures),
                variables=variables,
                stack=stack,
                timestamp_ns=time.time_ns(),
            )
            try:
                self._raw_queue.put_nowait(hit)
                queued = True
            except queue.Full:
                dropped = len(captures)
                for capture in captures:
                    if capture.reservation is not None:
                        capture.reservation.release()
                captures.clear()
                self._dropped_hits += dropped
            return None
        except Exception:
            if not queued:
                for capture in captures:
                    if capture.reservation is not None:
                        capture.reservation.release()
            self._enqueue_lifecycle(
                "error",
                tuple(capture.state for capture in captures),
                "monitoring callback failed safely",
            )
            return None
        finally:
            try:
                duration = time.perf_counter_ns() - started
                if self._callback_budget.record(duration):
                    self._enter_red("callback budget exceeded")
            except Exception:
                pass

    def _find_monitored_frame(self, code: CodeType) -> FrameType | None:
        with self._frame_hint_lock:
            hint = self._frame_depth_hint
        if hint is not None:
            try:
                hinted = sys._getframe(hint)
            except ValueError:
                hinted = None
            if hinted is not None and hinted.f_code is code:
                return hinted

        current = sys._getframe(1)
        for depth in range(1, 33):
            if current.f_code is code:
                with self._frame_hint_lock:
                    self._frame_depth_hint = depth
                return current
            current = current.f_back
            if current is None:
                break
        return None

    def _capture_stack(self, frame: FrameType) -> tuple[StackEntry, ...]:
        entries: list[StackEntry] = []
        current: FrameType | None = frame
        stack_limit = min(
            self.limits.stack_frame_depth,
            self.serializer_config.max_stack_frames,
        )
        while current is not None and len(entries) < stack_limit:
            entries.append(
                StackEntry(
                    fn=current.f_code.co_name,
                    file=current.f_code.co_filename,
                    line=current.f_lineno,
                )
            )
            current = current.f_back
        return tuple(entries)

    def _enter_red(self, detail: str) -> None:
        with self._state_lock:
            if (
                self._stopping
                or self._agent_state == "red"
                or not self._installed
            ):
                return
            self._agent_state = "red"
            self._red_until = time.monotonic() + self.limits.cooldown_seconds
            try:
                self.monitoring.set_events(self._tool_id, 0)
            except Exception:
                pass
            states = tuple(
                state for state in self._states.values() if state.is_active()
            )
        self._enqueue_lifecycle("suspended", states, detail)

    def _maybe_rearm(self, now: float | None = None) -> None:
        current = time.monotonic() if now is None else now
        with self._state_lock:
            if (
                self._agent_state != "red"
                or current < self._red_until
                or not self._installed
                or self._stopping
            ):
                return
            try:
                self.monitoring.restart_events()
                self.monitoring.set_events(self._tool_id, self._line_event)
            except Exception:
                self._red_until = current + self.limits.cooldown_seconds
                return
            self._callback_budget.reset(current)
            self._agent_state = "green"
            states = tuple(
                state for state in self._states.values() if state.is_active()
            )
        self._enqueue_lifecycle("rearmed", states, "callback budget cooldown ended")

    def _enqueue_lifecycle(
        self, action: str, states: tuple[ProbeState, ...], detail: str
    ) -> None:
        try:
            self._raw_queue.put_nowait(
                Lifecycle(action=action, states=states, detail=detail)
            )
        except queue.Full:
            self._dropped_hits += len(states)

    def _run(self) -> None:
        try:
            next_poll = 0.0
            next_flush = time.monotonic() + self.flush_interval
            while not self._stop_event.is_set():
                now = time.monotonic()
                self._drain_queue()
                self._maybe_rearm(now)
                if now >= next_poll:
                    self._poll()
                    next_poll = time.monotonic() + self.poll_interval
                if self._stop_event.is_set():
                    break
                if now >= next_flush:
                    self._flush()
                    next_flush = time.monotonic() + self.flush_interval
                wait_for = min(next_poll, next_flush) - time.monotonic()
                self._stop_event.wait(max(0.001, min(0.05, wait_for)))
            self._drain_queue()
            self._flush()
        finally:
            self._finish_worker()

    def _finish_worker(self) -> None:
        unexpected = not self._stop_event.is_set()
        if unexpected:
            detail = "daemon exited unexpectedly"
            self._running = False
            self._stopping = True
            self._agent_state = "red"
            self._shutdown_error = detail
            try:
                self.monitoring.set_events(self._tool_id, 0)
            except Exception:
                pass
            self._audit(f"AGENT ERROR {detail}")
        with self._shutdown_lock:
            self._worker_finished = True
            deferred = self._deferred_cleanup
        if not (deferred or unexpected):
            return
        try:
            self._uninstall_monitoring()
        except Exception as error:
            self._shutdown_error = (
                f"monitoring cleanup failed: {type(error).__name__}"
            )
            self._audit(f"AGENT STOP ERROR {self._shutdown_error}")
            return
        self._stopping = False
        with self._shutdown_lock:
            self._deferred_cleanup = False
        if deferred:
            self._audit(f"AGENT STOPPED {self.service_id} after daemon exit")

    def _poll(self) -> None:
        encoded_service = urllib.parse.quote(self.service_id, safe="")
        path = (
            f"/v1/services/{encoded_service}/probes?"
            f"{urllib.parse.urlencode({'since': self._version})}"
        )
        try:
            response = self._request_json("GET", path)
            if dict.get(response, "unchanged") is True:
                return
            version = dict.get(response, "version")
            probes = dict.get(response, "probes")
            if (
                isinstance(version, bool)
                or not isinstance(version, int)
                or version < 0
                or not isinstance(probes, list)
            ):
                raise ValueError("invalid poll response")
            self._reconcile(probes)
            self._version = version
        except urllib.error.HTTPError as error:
            if error.code != 304:
                self._audit(f"BROKER POLL ERROR HTTP {error.code}")
        except (OSError, ValueError, json.JSONDecodeError) as error:
            self._audit(f"BROKER POLL ERROR {type(error).__name__}")

    def _reconcile(self, raw_probes: list[object]) -> None:
        parsed: dict[str, Probe] = {}
        for raw in raw_probes:
            try:
                probe = Probe.parse(raw, self.service_id)
            except ValueError as error:
                self._audit(f"PROBE REJECTED {error}")
                continue
            parsed[probe.probe_id] = probe

        armed: list[ProbeState] = []
        expired: list[ProbeState] = []
        with self._state_lock:
            for probe_id, state in tuple(self._states.items()):
                incoming = parsed.get(probe_id)
                if incoming is None:
                    state.deactivate()
                    expired.append(state)
                    del self._states[probe_id]
                elif incoming != state.probe:
                    state.deactivate()
                    replacement = ProbeState(incoming)
                    self._states[probe_id] = replacement
                    armed.append(replacement)

            for probe_id, probe in parsed.items():
                if probe_id not in self._states:
                    state = ProbeState(probe)
                    self._states[probe_id] = state
                    armed.append(state)
            changed = bool(armed or expired)
            if changed:
                self._refresh_active_index_locked()

        if expired:
            self._enqueue_lifecycle(
                "expired", tuple(expired), "omitted from broker active set"
            )
        if armed:
            self._enqueue_lifecycle("armed", tuple(armed), "broker probe set changed")

    def _refresh_active_index_locked(self) -> None:
        by_line: dict[int, list[ProbeState]] = {}
        for state in self._states.values():
            if state.is_active():
                by_line.setdefault(state.probe.line, []).append(state)
        self._active_by_line = {
            line: tuple(states) for line, states in by_line.items()
        }
        if self._installed:
            self.monitoring.restart_events()

    def _drain_queue(self) -> None:
        while True:
            try:
                item = self._raw_queue.get_nowait()
            except queue.Empty:
                return
            if isinstance(item, Lifecycle):
                self._process_lifecycle(item)
            else:
                try:
                    self._process_hit(item)
                except Exception as error:
                    for capture in item.candidates:
                        if capture.reservation is not None:
                            capture.reservation.release()
                    states = tuple(
                        capture.state for capture in item.candidates
                    )
                    self._process_lifecycle(
                        Lifecycle(
                            action="error",
                            states=states,
                            detail=f"background pipeline failed: {type(error).__name__}",
                        )
                    )
                    self._audit(
                        f"PIPELINE ERROR {type(error).__name__}"
                    )

    def _process_lifecycle(self, lifecycle: Lifecycle) -> None:
        for state in lifecycle.states:
            probe = state.probe
            if lifecycle.action == "armed":
                self._status(state, "armed", f"{probe.file}:{probe.line}")
                self._audit(
                    f"PROBE ARMED {probe.file}:{probe.line} "
                    f"({probe.kind}, by {probe.created_by})"
                )
            elif lifecycle.action == "expired":
                self._status(state, "expired", lifecycle.detail)
                self._audit(
                    f"PROBE EXPIRED {probe.file}:{probe.line} ({probe.probe_id})"
                )
            elif lifecycle.action == "suspended":
                self._status(state, "suspended", lifecycle.detail)
            elif lifecycle.action == "rearmed":
                self._status(state, "armed", lifecycle.detail)
            elif lifecycle.action == "error":
                self._status(state, "error", lifecycle.detail)
        if lifecycle.action == "suspended":
            self._audit(f"SAFETY RED {lifecycle.detail}")
        elif lifecycle.action == "rearmed":
            self._audit("SAFETY GREEN probes rearmed")

    def _process_hit(self, hit: RawHit) -> None:
        for capture in hit.candidates:
            state = capture.state
            if not state.is_active():
                if capture.reservation is not None:
                    capture.reservation.release()
                continue
            probe = state.probe
            if not condition_matches(probe.condition, hit.variables):
                if capture.reservation is not None:
                    capture.reservation.release()
                continue
            if capture.reservation is None:
                capture.reservation = state.reserve()
                if capture.reservation is None:
                    continue

            timestamp = _rfc3339_from_ns(hit.timestamp_ns)
            event: dict[str, object] | None = None
            log_message: str | None = None
            counter_delta = 0
            metric_sample: int | float | None = None
            if probe.kind == "snapshot":
                watches = {
                    path: self._serialize_path(hit.variables, path)
                    for path in probe.watch_paths
                }
                event = {
                    "probeId": probe.probe_id,
                    "type": "snapshot",
                    "ts": timestamp,
                    "variables": serialize(
                        hit.variables, self.serializer_config
                    ),
                    "watches": watches,
                    "stack": [
                        {"fn": entry.fn, "file": entry.file, "line": entry.line}
                        for entry in hit.stack
                    ],
                }
            elif probe.kind == "log":
                log_message = self._render_template(
                    probe.template or "", hit.variables
                )
                event = {
                    "probeId": probe.probe_id,
                    "type": "log",
                    "ts": timestamp,
                    "message": log_message,
                    "level": "info",
                }
            elif probe.kind == "counter":
                counter_delta = 1
            else:
                metric_key = (probe.metric_path or "").rsplit(".", 1)[-1]
                if self.serializer_config.redacts_key(metric_key):
                    capture.reservation.release()
                    self._probe_error_once(
                        state, "metric path is redacted by policy"
                    )
                    continue
                sample = resolve_dot_path(
                    hit.variables, probe.metric_path or ""
                )
                if not _number(sample):
                    capture.reservation.release()
                    self._probe_error_once(
                        state, "metric path did not resolve to a finite number"
                    )
                    continue
                assert isinstance(sample, (int, float))
                metric_sample = sample

            accepted, reached_limit = capture.reservation.commit()
            if not accepted:
                continue
            if event is not None:
                self._append_event(event)
            if log_message is not None:
                self._audit(log_message)
            if counter_delta:
                self._counter_aggregates[probe.probe_id] = (
                    self._counter_aggregates.get(probe.probe_id, 0)
                    + counter_delta
                )
            if metric_sample is not None:
                aggregate = self._metric_aggregates.get(probe.probe_id)
                if aggregate is None:
                    self._metric_aggregates[probe.probe_id] = MetricAggregate(
                        count=1,
                        total=metric_sample,
                        minimum=metric_sample,
                        maximum=metric_sample,
                        last=metric_sample,
                    )
                else:
                    aggregate.add(metric_sample)
            if reached_limit:
                self._hit_limit_reached(state)

    def _render_template(
        self, template: str, variables: dict[str, object]
    ) -> str:
        pieces: list[str] = []
        last = 0
        for match in _TEMPLATE_PATH.finditer(template):
            pieces.append(template[last : match.start()])
            path = match.group(1)
            pieces.append(render_node(self._serialize_path(variables, path)))
            last = match.end()
        pieces.append(template[last:])
        return "".join(pieces)

    def _serialize_path(
        self, variables: dict[str, object], path: str
    ) -> dict[str, Any]:
        key = path.rsplit(".", 1)[-1]
        if self.serializer_config.redacts_key(key):
            return {"t": "redacted"}
        return serialize(
            resolve_dot_path(variables, path),
            self.serializer_config,
            root_key=key,
        )

    def _probe_error_once(self, state: ProbeState, detail: str) -> None:
        with state.lock:
            if state.last_error == detail:
                return
            state.last_error = detail
        self._status(state, "error", detail)

    def _hit_limit_reached(self, state: ProbeState) -> None:
        with self._state_lock:
            self._refresh_active_index_locked()
        probe = state.probe
        self._status(state, "hit-limit-reached", f"{probe.hit_limit} hits")
        self._audit(
            f"PROBE HIT LIMIT {probe.file}:{probe.line} ({probe.probe_id})"
        )

    def _status(self, state: ProbeState, status: str, detail: str) -> None:
        self._append_event(
            {
                "probeId": state.probe.probe_id,
                "type": "status",
                "ts": _now_rfc3339(),
                "status": status,
                "detail": detail,
            }
        )

    def _append_event(self, event: dict[str, object]) -> None:
        if len(self._events) >= self.limits.queue_size:
            self._events.pop(0)
            self._dropped_hits += 1
        self._events.append(event)

    def _aggregate_events(self) -> list[dict[str, object]]:
        timestamp = _now_rfc3339()
        events = [
            {
                "probeId": probe_id,
                "type": "counter",
                "ts": timestamp,
                "delta": delta,
            }
            for probe_id, delta in self._counter_aggregates.items()
            if delta > 0
        ]
        events.extend(
            {
                "probeId": probe_id,
                "type": "metric",
                "ts": timestamp,
                "count": aggregate.count,
                "sum": aggregate.total,
                "min": aggregate.minimum,
                "max": aggregate.maximum,
                "last": aggregate.last,
            }
            for probe_id, aggregate in self._metric_aggregates.items()
            if aggregate.count > 0
        )
        return events

    def _flush(self) -> None:
        aggregate_events = self._aggregate_events()
        sources: list[tuple[str, dict[str, object]]] = [
            ("event", event) for event in self._events
        ]
        sources.extend(
            (str(event["type"]), event) for event in aggregate_events
        )
        base_payload = self._ingest_payload([])
        base_body = json.dumps(
            base_payload,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        capacity = int(self._bandwidth_bucket.capacity)
        if capacity < len(base_body):
            return

        selected: list[tuple[str, dict[str, object]]] = []
        encoded_size = len(base_body)
        index = 0
        while index < len(sources):
            source, event = sources[index]
            event_size = len(
                json.dumps(
                    event,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                ).encode("utf-8")
            )
            separator_size = 1 if selected else 0
            if encoded_size + separator_size + event_size > capacity:
                if selected:
                    break
                self._drop_oversized(source, event)
                sources.pop(index)
                continue
            selected.append((source, event))
            encoded_size += separator_size + event_size
            index += 1

        payload = self._ingest_payload([event for _, event in selected])
        body = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        if len(body) > capacity or not self._bandwidth_bucket.consume(len(body)):
            return
        try:
            self._request_json("POST", "/v1/ingest", body=body)
        except urllib.error.HTTPError as error:
            self._audit(f"BROKER FLUSH ERROR HTTP {error.code}")
            return
        except (OSError, ValueError, json.JSONDecodeError) as error:
            self._audit(f"BROKER FLUSH ERROR {type(error).__name__}")
            return

        normal_sent = sum(source == "event" for source, _ in selected)
        if normal_sent:
            del self._events[:normal_sent]
        for source, event in selected:
            probe_id = event["probeId"]
            if not isinstance(probe_id, str):
                continue
            if source == "counter":
                self._counter_aggregates.pop(probe_id, None)
            elif source == "metric":
                self._metric_aggregates.pop(probe_id, None)

    def _ingest_payload(
        self, events: list[dict[str, object]]
    ) -> dict[str, object]:
        return {
            "serviceId": self.service_id,
            "sdk": "python",
            "commitSha": self.commit_sha,
            "commitSource": self.commit_source,
            "agentStatus": {
                "state": self._agent_state,
                "detail": (
                    f"{len(self._active_by_line)} active locations; "
                    f"{self._dropped_hits} dropped hits"
                ),
            },
            "events": events,
        }

    def _drop_oversized(
        self, source: str, event: dict[str, object]
    ) -> None:
        if source == "event":
            if self._events:
                self._events.pop(0)
        else:
            probe_id = event.get("probeId")
            if isinstance(probe_id, str):
                if source == "counter":
                    self._counter_aggregates.pop(probe_id, None)
                elif source == "metric":
                    self._metric_aggregates.pop(probe_id, None)
        self._dropped_hits += 1
        self._audit(
            f"EVENT DROPPED {event.get('probeId', 'unknown')} exceeds bandwidth burst"
        )

    def _request_json(
        self, method: str, path: str, body: bytes | None = None
    ) -> dict[str, object]:
        headers = {"Accept": "application/json", "User-Agent": "liveprobe-python/0.1"}
        if self.api_key is not None:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.broker_url}{path}",
            data=body,
            headers=headers,
            method=method,
        )
        with urllib.request.urlopen(
            request, timeout=self.limits.request_timeout
        ) as response:
            data = response.read()
        if not data:
            return {}
        decoded = json.loads(data)
        if not isinstance(decoded, dict):
            raise ValueError("broker response must be an object")
        return decoded

    def _audit(self, message: str) -> None:
        with self._audit_lock:
            print(f"[liveprobe] {message}", file=self.output, flush=True)
