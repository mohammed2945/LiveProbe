from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable


DEMO_DIR = Path(__file__).resolve().parent
REPO_ROOT = DEMO_DIR.parent.parent
APP_SOURCE = DEMO_DIR / "app.py"
BROKER_ENTRY = REPO_ROOT / "packages" / "broker" / "dist" / "src" / "index.js"
SERVICE_ID = "billing-worker-e2e"
PROBE_FILE = "app.py"
COMMIT_SHA = "abcdef1234567890"

# A seeded user whose address is present, so every burst renewal succeeds and
# the probe line is reached exactly once per request.
_BURST_USER = "standard-us"
# Driven back to back over loopback this lands far above the 10 hits/second
# budget, which is the point: the counter must stay exact anyway.
_COUNTER_BURST = 50
# Spaced under the budget so captures are never dropped and the aggregate is
# predictable from the request bodies alone.
_METRIC_SUBTOTALS = [1_000, 2_000, 3_000, 4_000, 5_000]
_METRIC_SPACING_SECONDS = 0.15


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _json_request(
    method: str,
    url: str,
    payload: dict[str, object] | None = None,
    *,
    timeout: float = 3.0,
) -> tuple[int, dict[str, Any]]:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url, data=body, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            raw = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        raw = error.read()
    decoded = json.loads(raw) if raw else {}
    if not isinstance(decoded, dict):
        raise AssertionError(f"{method} {url} returned a non-object JSON body")
    return status, decoded


def _wait_for(
    description: str,
    predicate: Callable[[], Any],
    *,
    timeout: float = 15.0,
    processes: tuple[tuple[str, subprocess.Popen[bytes]], ...] = (),
) -> Any:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        for name, process in processes:
            return_code = process.poll()
            if return_code is not None:
                raise RuntimeError(
                    f"{name} exited before {description} (code {return_code})"
                )
        try:
            result = predicate()
            if result:
                return result
        except (
            AssertionError,
            OSError,
            ValueError,
            urllib.error.URLError,
        ) as error:
            last_error = error
        time.sleep(0.05)
    detail = f": {last_error}" if last_error is not None else ""
    raise TimeoutError(f"timed out waiting for {description}{detail}")


def _terminate(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _read_log(path: Path) -> str:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return "<log unavailable>"
    return "\n".join(lines[-60:])


def _rejection_lines(app_log: Path) -> list[str]:
    """Every 400 the agent has reported, read from the whole log.

    The diagnostic reader keeps only a tail; a rejection that scrolled out of
    it would read as an absent rejection rather than a missed one.
    """
    try:
        text = app_log.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return [
        line for line in text.splitlines() if "BROKER FLUSH REJECTED" in line
    ]


def _settled_rejections(app_log: Path) -> list[str]:
    """Rejections recorded once the log has stopped gaining new ones."""
    previous = -1
    for _ in range(60):
        lines = _rejection_lines(app_log)
        if len(lines) == previous:
            return lines
        previous = len(lines)
        time.sleep(0.25)
    raise TimeoutError("agent kept reporting rejected flushes")


def _bug_line() -> int:
    matches = [
        line_number
        for line_number, line in enumerate(
            APP_SOURCE.read_text(encoding="utf-8").splitlines(), start=1
        )
        if "LIVEPROBE_BUG_LINE:" in line
    ]
    if len(matches) != 1:
        raise AssertionError(
            f"expected one LIVEPROBE_BUG_LINE marker, found {len(matches)}"
        )
    return matches[0]


def _service_is_ready(broker_url: str) -> bool:
    status, payload = _json_request("GET", f"{broker_url}/v1/services")
    if status != 200:
        return False
    services = payload.get("services", [])
    return any(
        isinstance(service, dict)
        and service.get("serviceId") == SERVICE_ID
        and service.get("sdk") == "python"
        and isinstance(service.get("agentStatus"), dict)
        and service["agentStatus"].get("state") == "green"
        for service in services
    )


def _stats(app_url: str) -> dict[str, Any]:
    status, payload = _json_request("GET", f"{app_url}/stats")
    if status != 200:
        raise AssertionError(f"stats endpoint returned HTTP {status}")
    return payload


def _completed_requests(app_url: str) -> int:
    payload = _stats(app_url)
    completed = payload.get("requests_completed", 0)
    return completed if isinstance(completed, int) else 0


def _snapshot_event(
    broker_url: str, probe_id: str
) -> dict[str, Any] | None:
    encoded_probe_id = urllib.parse.quote(probe_id, safe="")
    status, payload = _json_request(
        "GET", f"{broker_url}/v1/probes/{encoded_probe_id}/data?waitSeconds=1"
    )
    if status != 200:
        return None
    events = payload.get("events", [])
    if not isinstance(events, list):
        return None
    for event in events:
        if isinstance(event, dict) and event.get("type") == "snapshot":
            return event
    return None


def _create_probe(broker_url: str, payload: dict[str, object]) -> str:
    status, body = _json_request("POST", f"{broker_url}/v1/probes", payload)
    if status != 201:
        raise AssertionError(f"probe creation failed ({status}): {body}")
    probe = body.get("probe")
    if not isinstance(probe, dict) or not isinstance(probe.get("id"), str):
        raise AssertionError("broker did not return a probe id")
    return probe["id"]


def _delete_probe(broker_url: str, probe_id: str) -> None:
    encoded_probe_id = urllib.parse.quote(probe_id, safe="")
    try:
        _json_request(
            "DELETE", f"{broker_url}/v1/probes/{encoded_probe_id}", timeout=2
        )
    except Exception:
        pass


def _probe_data(broker_url: str, probe_id: str) -> dict[str, Any]:
    encoded_probe_id = urllib.parse.quote(probe_id, safe="")
    status, payload = _json_request(
        "GET", f"{broker_url}/v1/probes/{encoded_probe_id}/data"
    )
    if status != 200:
        raise AssertionError(f"probe data returned HTTP {status}")
    return payload


def _probe_events(
    broker_url: str, probe_id: str, event_type: str
) -> list[dict[str, Any]]:
    events = _probe_data(broker_url, probe_id).get("events", [])
    if not isinstance(events, list):
        return []
    return [
        event
        for event in events
        if isinstance(event, dict) and event.get("type") == event_type
    ]


def _counter_total(broker_url: str, probe_id: str) -> int:
    """Sum the counter deltas the agent has flushed so far.

    Counters arrive pre-aggregated, one event per flush, so the running total
    is the sum of every delta rather than the value of the newest event.
    """
    return sum(
        int(event["delta"])
        for event in _probe_events(broker_url, probe_id, "counter")
        if isinstance(event.get("delta"), int)
    )


def _wait_armed(
    broker_url: str,
    probe_id: str,
    processes: tuple[tuple[str, subprocess.Popen[bytes]], ...],
) -> None:
    def is_armed() -> bool:
        status = _probe_data(broker_url, probe_id).get("status")
        return isinstance(status, dict) and status.get("status") == "armed"

    _wait_for(
        f"probe {probe_id} to arm", is_armed, timeout=10, processes=processes
    )


def _drain(
    app_url: str, processes: tuple[tuple[str, subprocess.Popen[bytes]], ...]
) -> int:
    """Wait for in-flight requests to finish so a burst count is unambiguous.

    The traffic generator is stopped before this runs, but requests it already
    issued can still be completing. Every later phase compares a probe total
    against a burst size it drove itself, so a single straggler would make an
    exact assertion wrong.
    """
    previous = -1
    for _ in range(100):
        for name, process in processes:
            if process.poll() is not None:
                raise RuntimeError(f"{name} exited while draining traffic")
        current = _completed_requests(app_url)
        if current == previous:
            return current
        previous = current
        time.sleep(0.1)
    raise TimeoutError("timed out waiting for in-flight requests to drain")


def _burst(app_url: str, subtotals: list[int], *, spacing: float = 0.0) -> None:
    """Drive renewals one at a time so the hit count equals the request count."""
    for subtotal in subtotals:
        status, payload = _json_request(
            "POST",
            f"{app_url}/renew",
            {"user_id": _BURST_USER, "subtotal_cents": subtotal},
            timeout=5.0,
        )
        if status != 200:
            raise AssertionError(
                f"burst renewal returned HTTP {status}: {payload}"
            )
        if spacing > 0:
            time.sleep(spacing)


def _child(node: object, key: str) -> dict[str, Any]:
    if not isinstance(node, dict) or node.get("t") != "obj":
        raise AssertionError(f"expected serialized object while reading {key}")
    children = node.get("c")
    if not isinstance(children, dict):
        raise AssertionError(f"serialized object has no children while reading {key}")
    child = children.get(key)
    if not isinstance(child, dict):
        raise AssertionError(f"serialized evidence is missing {key}")
    return child


def _assert_sanitized_evidence(event: dict[str, Any]) -> None:
    user = _child(event.get("variables"), "user")
    address = _child(user, "address")
    is_legacy = _child(user, "is_legacy")
    if address != {"t": "null", "v": None}:
        raise AssertionError(f"user.address was not sanitized null: {address}")
    if is_legacy != {"t": "bool", "v": True}:
        raise AssertionError(f"user.is_legacy was not sanitized true: {is_legacy}")

    watches = event.get("watches")
    if not isinstance(watches, dict):
        raise AssertionError("snapshot did not include sanitized watches")
    if watches.get("user.address") != {"t": "null", "v": None}:
        raise AssertionError("user.address watch did not show sanitized null")
    if watches.get("user.is_legacy") != {"t": "bool", "v": True}:
        raise AssertionError("user.is_legacy watch did not show sanitized true")
    if watches.get("subtotal_cents / 100") != {"t": "num", "v": 25.0}:
        raise AssertionError("subtotal expression watch did not equal 25")

    stack = event.get("stack")
    if (
        not isinstance(stack, list)
        or not stack
        or len(stack) > 2
        or any(
            not isinstance(frame, dict) or "variables" not in frame
            for frame in stack
        )
    ):
        raise AssertionError("requested stack frames did not include bounded locals")


def _phase_counter_exactness(
    broker_url: str,
    app_url: str,
    line: int,
    processes: tuple[tuple[str, subprocess.Popen[bytes]], ...],
) -> dict[str, Any]:
    """Prove the hit budget bounds capture cost rather than counting.

    A counter and a log probe share one line. The burst runs far above the
    budget, so the log probe — which has to capture to render its message —
    must lose hits, while the counter, which reads nothing, must record every
    one. Asserting the counter alone would pass even with no limiter running,
    so the dropped captures are what give the exact total its meaning.
    """
    counter_id = _create_probe(
        broker_url,
        {
            "serviceId": SERVICE_ID,
            "type": "counter",
            "file": PROBE_FILE,
            "line": line,
            "hitLimit": 10_000,
            "ttlSeconds": 60,
            "createdBy": "e2e:billing-worker",
        },
    )
    log_id = _create_probe(
        broker_url,
        {
            "serviceId": SERVICE_ID,
            "type": "log",
            "file": PROBE_FILE,
            "line": line,
            "template": "renewing ${subtotal_cents}",
            "hitLimit": 10_000,
            "ttlSeconds": 60,
            "createdBy": "e2e:billing-worker",
        },
    )
    try:
        _wait_armed(broker_url, counter_id, processes)
        _wait_armed(broker_url, log_id, processes)
        _burst(app_url, [2_500] * _COUNTER_BURST)

        def counter_reached() -> int | None:
            total = _counter_total(broker_url, counter_id)
            return total if total >= _COUNTER_BURST else None

        # Waiting for "at least" and then asserting equality reports an
        # overcount as a failed assertion rather than as a timeout.
        total = _wait_for(
            "counter total to reach the burst size",
            counter_reached,
            timeout=20,
            processes=processes,
        )
        if total != _COUNTER_BURST:
            raise AssertionError(
                f"counter recorded {total} hits for {_COUNTER_BURST} requests"
            )
        messages = [
            event.get("message")
            for event in _probe_events(broker_url, log_id, "log")
        ]
        if not messages:
            raise AssertionError("log probe on the same line captured nothing")
        if len(messages) >= _COUNTER_BURST:
            raise AssertionError(
                "the hit budget dropped no captures, so the exact counter "
                "total does not demonstrate anything about rate limiting"
            )
        if "renewing 2500" not in messages:
            raise AssertionError(
                f"log template did not render live locals: {messages[:3]}"
            )
        return {
            "requests": _COUNTER_BURST,
            "counter_total": total,
            "log_captures": len(messages),
        }
    finally:
        _delete_probe(broker_url, log_id)
        _delete_probe(broker_url, counter_id)


def _phase_metric_and_log(
    broker_url: str,
    app_url: str,
    line: int,
    processes: tuple[tuple[str, subprocess.Popen[bytes]], ...],
) -> dict[str, Any]:
    """Check metric aggregation and log rendering below the hit budget.

    Spacing the requests under the budget keeps the limiter out of the picture,
    so every field is predictable from the request bodies alone.
    """
    metric_id = _create_probe(
        broker_url,
        {
            "serviceId": SERVICE_ID,
            "type": "metric",
            "file": PROBE_FILE,
            "line": line,
            "metricPath": "subtotal_cents",
            "hitLimit": 10_000,
            "ttlSeconds": 60,
            "createdBy": "e2e:billing-worker",
        },
    )
    log_id = _create_probe(
        broker_url,
        {
            "serviceId": SERVICE_ID,
            "type": "log",
            "file": PROBE_FILE,
            "line": line,
            "template": "renewal subtotal=${subtotal_cents}",
            "logLevel": "warn",
            "hitLimit": 10_000,
            "ttlSeconds": 60,
            "createdBy": "e2e:billing-worker",
        },
    )
    try:
        _wait_armed(broker_url, metric_id, processes)
        _wait_armed(broker_url, log_id, processes)
        _burst(app_url, _METRIC_SUBTOTALS, spacing=_METRIC_SPACING_SECONDS)

        expected = len(_METRIC_SUBTOTALS)

        def metric_reached() -> list[dict[str, Any]] | None:
            events = _probe_events(broker_url, metric_id, "metric")
            observed = sum(int(event["count"]) for event in events)
            return events if observed >= expected else None

        events = _wait_for(
            "metric aggregate to cover the burst",
            metric_reached,
            timeout=20,
            processes=processes,
        )
        count = sum(int(event["count"]) for event in events)
        total = sum(float(event["sum"]) for event in events)
        smallest = min(float(event["min"]) for event in events)
        largest = max(float(event["max"]) for event in events)
        if count != expected:
            raise AssertionError(
                f"metric counted {count} samples for {expected} requests"
            )
        if total != float(sum(_METRIC_SUBTOTALS)):
            raise AssertionError(
                f"metric sum was {total}, expected {sum(_METRIC_SUBTOTALS)}"
            )
        if smallest != float(min(_METRIC_SUBTOTALS)) or largest != float(
            max(_METRIC_SUBTOTALS)
        ):
            raise AssertionError(
                f"metric bounds were {smallest}..{largest}, expected "
                f"{min(_METRIC_SUBTOTALS)}..{max(_METRIC_SUBTOTALS)}"
            )

        def logs_reached() -> list[dict[str, Any]] | None:
            events = _probe_events(broker_url, log_id, "log")
            return events if len(events) >= expected else None

        log_events = _wait_for(
            "one log event per request",
            logs_reached,
            timeout=20,
            processes=processes,
        )
        messages = sorted(str(event.get("message")) for event in log_events)
        wanted = sorted(
            f"renewal subtotal={subtotal}" for subtotal in _METRIC_SUBTOTALS
        )
        if messages != wanted:
            raise AssertionError(
                f"log messages were {messages}, expected {wanted}"
            )
        if any(event.get("level") != "warn" for event in log_events):
            raise AssertionError("log level did not survive the round trip")
        return {
            "samples": count,
            "sum": total,
            "min": smallest,
            "max": largest,
            "log_events": len(log_events),
        }
    finally:
        _delete_probe(broker_url, log_id)
        _delete_probe(broker_url, metric_id)


def _capture_count(
    broker_url: str,
    app_url: str,
    line: int,
    probe_count: int,
    processes: tuple[tuple[str, subprocess.Popen[bytes]], ...],
) -> int:
    """Run a fixed over-budget burst against N log probes on one line.

    Returns the smallest number of captures any single probe managed, which is
    the quantity the per-capture budget is supposed to leave unchanged as N
    grows.
    """
    probe_ids = [
        _create_probe(
            broker_url,
            {
                "serviceId": SERVICE_ID,
                "type": "log",
                "file": PROBE_FILE,
                "line": line,
                "template": f"capture {index} ${{subtotal_cents}}",
                "hitLimit": 10_000,
                "ttlSeconds": 60,
                "createdBy": "e2e:billing-worker",
            },
        )
        for index in range(probe_count)
    ]
    try:
        for probe_id in probe_ids:
            _wait_armed(broker_url, probe_id, processes)
        # Let the bucket refill to capacity so both measurements start level.
        time.sleep(1.5)
        _burst(app_url, [2_500] * _COUNTER_BURST)
        # The flush interval is 0.25s; this is several flushes of slack.
        time.sleep(1.5)
        return min(
            len(_probe_events(broker_url, probe_id, "log"))
            for probe_id in probe_ids
        )
    finally:
        for probe_id in probe_ids:
            _delete_probe(broker_url, probe_id)


def _phase_per_capture_budget(
    broker_url: str,
    app_url: str,
    line: int,
    processes: tuple[tuple[str, subprocess.Popen[bytes]], ...],
) -> dict[str, Any]:
    """Prove the budget is charged per pause rather than per probe.

    One line event reads the frame once and shares it with every probe on the
    line, so three probes should each capture about as often as one probe does.
    Charging per probe instead would drain the bucket three times as fast and
    leave each probe with roughly a third. The threshold sits halfway between
    those outcomes because this is a timing measurement, not an exact one.
    """
    alone = _capture_count(broker_url, app_url, line, 1, processes)
    if alone <= 0:
        raise AssertionError("a single log probe captured nothing")
    together = _capture_count(broker_url, app_url, line, 3, processes)
    if together * 2 <= alone:
        raise AssertionError(
            f"each of three probes on one line captured {together} hits "
            f"against {alone} for a probe on its own, which is the share a "
            "per-probe budget would produce"
        )
    return {"one_probe": alone, "three_probes_min": together}


def _phase_ingest_isolation(
    broker_url: str,
    app_url: str,
    line: int,
    app_log: Path,
    processes: tuple[tuple[str, subprocess.Popen[bytes]], ...],
) -> dict[str, Any]:
    """Prove one rejected event no longer discards the batch around it.

    Deleting a probe the agent has already armed is the realistic way a flush
    turns poisonous: the agent keeps emitting for the fraction of a second
    before its next poll, and the broker refuses any event naming a probe it no
    longer knows. Validation covers the whole request body, so that single
    stale event returns HTTP 400 for the entire batch without saying which
    event was at fault. The counter sharing the line has to survive it.
    """
    counter_id = _create_probe(
        broker_url,
        {
            "serviceId": SERVICE_ID,
            "type": "counter",
            "file": PROBE_FILE,
            "line": line,
            "hitLimit": 10_000,
            "ttlSeconds": 60,
            "createdBy": "e2e:billing-worker",
        },
    )
    poison_id = _create_probe(
        broker_url,
        {
            "serviceId": SERVICE_ID,
            "type": "log",
            "file": PROBE_FILE,
            "line": line,
            "template": "stale ${subtotal_cents}",
            # One hit, so the flush carries a single stale event. Isolation is
            # deliberately bounded at a handful of splits per flush, and a
            # batch that is mostly poison exhausts that budget and takes valid
            # events down with it — which is the documented trade-off, not the
            # behaviour under test here.
            "hitLimit": 1,
            "ttlSeconds": 60,
            "createdBy": "e2e:billing-worker",
        },
    )
    try:
        _wait_armed(broker_url, counter_id, processes)
        _wait_armed(broker_url, poison_id, processes)
        # Earlier phases delete their probes too, so their own stale events are
        # still working through the buffer. Let those settle, then treat only
        # later rejections as evidence that this burst was the poisoned flush.
        before = _settled_rejections(app_log)
        # Delete, then burst without pausing: the agent polls every 100ms, so
        # the opening requests still emit log events for a probe the broker has
        # already forgotten, and those events sit in the same buffer as the
        # counter aggregate.
        _delete_probe(broker_url, poison_id)
        _burst(app_url, [2_500] * _COUNTER_BURST)

        def rejected() -> list[str] | None:
            lines = _rejection_lines(app_log)
            return lines if len(lines) > len(before) else None

        rejections = _wait_for(
            "the broker to refuse the batch carrying the stale event",
            rejected,
            timeout=20,
            processes=processes,
        )

        def counter_reached() -> int | None:
            total = _counter_total(broker_url, counter_id)
            return total if total >= _COUNTER_BURST else None

        total = _wait_for(
            "counter total to survive the rejected batch",
            counter_reached,
            timeout=25,
            processes=processes,
        )
        if total != _COUNTER_BURST:
            raise AssertionError(
                f"counter recorded {total} hits for {_COUNTER_BURST} requests "
                "flushed alongside a rejected event"
            )
        return {
            "counter_total": total,
            "rejection": rejections[-1].strip(),
        }
    finally:
        _delete_probe(broker_url, counter_id)


def main() -> int:
    if sys.version_info < (3, 12):
        raise RuntimeError("billing-worker e2e requires Python 3.12+")
    if not BROKER_ENTRY.is_file():
        raise RuntimeError(
            f"built broker entrypoint is missing: {BROKER_ENTRY}; "
            "build @liveprobe/broker before running this demo"
        )

    broker_port = _free_port()
    app_port = _free_port()
    broker_url = f"http://127.0.0.1:{broker_port}"
    app_url = f"http://127.0.0.1:{app_port}"
    python_path = str(REPO_ROOT / "python" / "sdk" / "src")
    existing_python_path = os.environ.get("PYTHONPATH")
    if existing_python_path:
        python_path = os.pathsep.join((python_path, existing_python_path))

    broker: subprocess.Popen[bytes] | None = None
    app: subprocess.Popen[bytes] | None = None
    traffic: subprocess.Popen[bytes] | None = None
    probe_id: str | None = None

    with tempfile.TemporaryDirectory(prefix="liveprobe-python-e2e-") as temporary:
        temporary_path = Path(temporary)
        broker_log = temporary_path / "broker.log"
        app_log = temporary_path / "app.log"
        traffic_log = temporary_path / "traffic.log"
        try:
            with (
                broker_log.open("wb") as broker_output,
                app_log.open("wb") as app_output,
                traffic_log.open("wb") as traffic_output,
            ):
                broker_env = os.environ.copy()
                broker_env.update(
                    {
                        "HOST": "127.0.0.1",
                        "PORT": str(broker_port),
                    }
                )
                broker_env.pop("LIVEPROBE_STATE_FILE", None)
                broker = subprocess.Popen(
                    ["node", str(BROKER_ENTRY)],
                    cwd=REPO_ROOT,
                    env=broker_env,
                    stdout=broker_output,
                    stderr=subprocess.STDOUT,
                )
                _wait_for(
                    "broker readiness",
                    lambda: _json_request("GET", f"{broker_url}/v1/services")[0]
                    == 200,
                    timeout=10,
                    processes=(("broker", broker),),
                )

                app_env = os.environ.copy()
                app_env.update(
                    {
                        "BUG": "on",
                        "SERVICE_ID": SERVICE_ID,
                        "BROKER_URL": broker_url,
                        "GIT_COMMIT": COMMIT_SHA,
                        "LIVEPROBE_ENABLED": "on",
                        "LIVEPROBE_POLL_INTERVAL": "0.1",
                        "LIVEPROBE_FLUSH_INTERVAL": "0.25",
                        "PYTHONPATH": python_path,
                        "PYTHONUNBUFFERED": "1",
                    }
                )
                app = subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "uvicorn",
                        "app:app",
                        "--host",
                        "127.0.0.1",
                        "--port",
                        str(app_port),
                        "--log-level",
                        "warning",
                    ],
                    cwd=DEMO_DIR,
                    env=app_env,
                    stdout=app_output,
                    stderr=subprocess.STDOUT,
                )

                def app_is_ready() -> bool:
                    status, health = _json_request("GET", f"{app_url}/health")
                    return (
                        status == 200
                        and health.get("bug") == "on"
                        and health.get("liveprobe_started") is True
                    )

                _wait_for(
                    "billing worker readiness",
                    app_is_ready,
                    timeout=10,
                    processes=(("broker", broker), ("app", app)),
                )
                _wait_for(
                    "Python SDK broker registration",
                    lambda: _service_is_ready(broker_url),
                    timeout=10,
                    processes=(("broker", broker), ("app", app)),
                )

                traffic = subprocess.Popen(
                    [
                        sys.executable,
                        str(DEMO_DIR / "traffic.py"),
                        "--base-url",
                        app_url,
                        "--interval",
                        "0.03",
                    ],
                    cwd=DEMO_DIR,
                    env=app_env,
                    stdout=traffic_output,
                    stderr=subprocess.STDOUT,
                )
                active_processes = (
                    ("broker", broker),
                    ("app", app),
                    ("traffic", traffic),
                )
                _wait_for(
                    "initial mixed-user traffic",
                    lambda: _completed_requests(app_url) >= 8,
                    timeout=10,
                    processes=active_processes,
                )
                initial_stats = _stats(app_url)
                if (
                    initial_stats.get("renewals_succeeded", 0) <= 0
                    or initial_stats.get("renewals_failed", 0) <= 0
                ):
                    raise AssertionError(
                        "mixed traffic did not exercise successful and failing renewals"
                    )
                before_probe = int(initial_stats["requests_completed"])

                create_status, create_payload = _json_request(
                    "POST",
                    f"{broker_url}/v1/probes",
                    {
                        "serviceId": SERVICE_ID,
                        "type": "snapshot",
                        "file": PROBE_FILE,
                        "line": _bug_line(),
                        "conditionExpression": (
                            "user.is_legacy == true && subtotal_cents >= 2500"
                        ),
                        "watchPaths": ["user.address", "user.is_legacy"],
                        "watchExpressions": ["subtotal_cents / 100"],
                        "includeStackLocals": True,
                        "stackFrameLimit": 2,
                        "hitLimit": 1,
                        "ttlSeconds": 60,
                        "createdBy": "e2e:billing-worker",
                    },
                )
                if create_status != 201:
                    raise AssertionError(
                        f"probe creation failed ({create_status}): {create_payload}"
                    )
                probe = create_payload.get("probe")
                if not isinstance(probe, dict) or not isinstance(
                    probe.get("id"), str
                ):
                    raise AssertionError("broker did not return a probe id")
                probe_id = probe["id"]

                evidence = _wait_for(
                    "conditioned snapshot evidence",
                    lambda: _snapshot_event(broker_url, probe_id),
                    timeout=15,
                    processes=active_processes,
                )
                if not isinstance(evidence, dict):
                    raise AssertionError("snapshot evidence was not an object")
                _assert_sanitized_evidence(evidence)

                at_evidence = _completed_requests(app_url)
                if at_evidence <= before_probe:
                    raise AssertionError(
                        "request counter did not advance while collecting evidence"
                    )
                after_evidence = _wait_for(
                    "continued requests after snapshot",
                    lambda: (
                        count
                        if (count := _completed_requests(app_url))
                        >= at_evidence + 5
                        else 0
                    ),
                    timeout=5,
                    processes=active_processes,
                )

                # The remaining phases assert exact totals against bursts they
                # drive themselves, so the background traffic has to stop and
                # its in-flight requests have to land first.
                _json_request(
                    "DELETE",
                    f"{broker_url}/v1/probes/"
                    f"{urllib.parse.quote(probe_id, safe='')}",
                )
                probe_id = None
                _terminate(traffic)
                traffic = None
                quiet_processes = (("broker", broker), ("app", app))
                _drain(app_url, quiet_processes)

                line = _bug_line()
                counter_phase = _phase_counter_exactness(
                    broker_url, app_url, line, quiet_processes
                )
                metric_phase = _phase_metric_and_log(
                    broker_url, app_url, line, quiet_processes
                )
                budget_phase = _phase_per_capture_budget(
                    broker_url, app_url, line, quiet_processes
                )
                isolation_phase = _phase_ingest_isolation(
                    broker_url, app_url, line, app_log, quiet_processes
                )

                print(
                    json.dumps(
                        {
                            "result": "PASS",
                            "bug_line": line,
                            "evidence": {
                                "user.address": None,
                                "user.is_legacy": True,
                            },
                            "request_counters": {
                                "before_probe": before_probe,
                                "at_evidence": at_evidence,
                                "after_evidence": after_evidence,
                            },
                            "counter_exactness": counter_phase,
                            "metric_and_log": metric_phase,
                            "per_capture_budget": budget_phase,
                            "ingest_isolation": isolation_phase,
                        },
                        indent=2,
                        sort_keys=True,
                    )
                )
        except Exception:
            print("\n--- broker.log ---", file=sys.stderr)
            print(_read_log(broker_log), file=sys.stderr)
            print("\n--- app.log ---", file=sys.stderr)
            print(_read_log(app_log), file=sys.stderr)
            print("\n--- traffic.log ---", file=sys.stderr)
            print(_read_log(traffic_log), file=sys.stderr)
            raise
        finally:
            if probe_id is not None:
                try:
                    encoded_probe_id = urllib.parse.quote(probe_id, safe="")
                    _json_request(
                        "DELETE",
                        f"{broker_url}/v1/probes/{encoded_probe_id}",
                        timeout=1,
                    )
                except Exception:
                    pass
            _terminate(traffic)
            _terminate(app)
            _terminate(broker)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
