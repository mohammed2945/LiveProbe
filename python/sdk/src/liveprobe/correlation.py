"""Request-scoped occurrence correlation for LiveProbe.

The runtime deliberately correlates captures only from an explicit propagated
identifier.  It never guesses that events belong together from close
timestamps.
"""

from __future__ import annotations

import contextvars
import os
import re
import secrets
import threading
from dataclasses import dataclass
from typing import Any, Mapping

_TRACEPARENT = re.compile(
    r"^(?P<version>[0-9a-fA-F]{2})-"
    r"(?P<trace>[0-9a-fA-F]{32})-"
    r"(?P<span>[0-9a-fA-F]{16})-"
    r"(?P<flags>[0-9a-fA-F]{2})$"
)
_current: contextvars.ContextVar[CorrelationContext | None] = (
    contextvars.ContextVar("liveprobe_correlation", default=None)
)
_httpx_patch_lock = threading.Lock()
_httpx_patched = False
_OTEL_UNRESOLVED = object()
_otel_get_current_span: object = _OTEL_UNRESOLVED
_otel_lock = threading.Lock()


@dataclass(frozen=True, slots=True)
class CorrelationContext:
    """Identity of one explicitly correlated execution."""

    trace_id: str
    span_id: str | None
    source: str
    quality: str = "exact-execution"
    trace_flags: str = "01"

    def event_payload(
        self,
        *,
        local_hit_sequence: int,
        service_instance: str | None,
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "traceId": self.trace_id,
            "source": self.source,
            "quality": self.quality,
            "localHitSequence": local_hit_sequence,
        }
        if self.span_id is not None:
            payload["spanId"] = self.span_id
        if service_instance:
            payload["serviceInstance"] = service_instance
        return payload

    def traceparent(self) -> str | None:
        if (
            len(self.trace_id) != 32
            or self.span_id is None
            or len(self.span_id) != 16
        ):
            return None
        return f"00-{self.trace_id}-{self.span_id}-{self.trace_flags}"


def _header(headers: Mapping[str, str] | object, name: str) -> str | None:
    getter = getattr(headers, "get", None)
    if not callable(getter):
        return None
    value = getter(name)
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def parse_traceparent(value: str | None) -> CorrelationContext | None:
    if value is None:
        return None
    match = _TRACEPARENT.fullmatch(value.strip())
    if match is None:
        return None
    if match.group("version").lower() == "ff":
        return None
    trace_id = match.group("trace").lower()
    span_id = match.group("span").lower()
    if trace_id == "0" * 32 or span_id == "0" * 16:
        return None
    return CorrelationContext(
        trace_id=trace_id,
        span_id=span_id,
        source="liveprobe-w3c",
        trace_flags=match.group("flags").lower(),
    )


def correlation_from_headers(
    headers: Mapping[str, str] | object,
) -> CorrelationContext:
    """Extract a correlation identity, or start a new W3C-compatible trace."""

    parsed = parse_traceparent(_header(headers, "traceparent"))
    if parsed is not None:
        return parsed

    replay_id = _header(headers, "x-liveprobe-replay-id")
    if replay_id is not None:
        return CorrelationContext(
            trace_id=replay_id[:128],
            span_id=None,
            source="controlled-replay",
        )

    legacy_id = _header(headers, "x-trace-id")
    if legacy_id is not None:
        return CorrelationContext(
            trace_id=legacy_id[:128],
            span_id=None,
            source="legacy-x-trace-id",
        )

    return CorrelationContext(
        trace_id=secrets.token_hex(16),
        span_id=secrets.token_hex(8),
        source="liveprobe-w3c",
    )


def _otel_context() -> CorrelationContext | None:
    """Read an active OpenTelemetry span without requiring the dependency."""

    global _otel_get_current_span
    getter = _otel_get_current_span
    if getter is _OTEL_UNRESOLVED:
        with _otel_lock:
            getter = _otel_get_current_span
            if getter is _OTEL_UNRESOLVED:
                try:
                    from opentelemetry import trace  # type: ignore[import-not-found]

                    getter = trace.get_current_span
                except ImportError:
                    getter = None
                _otel_get_current_span = getter
    if not callable(getter):
        return None
    try:
        span_context = getter().get_span_context()
        if not span_context.is_valid:
            return None
        return CorrelationContext(
            trace_id=f"{span_context.trace_id:032x}",
            span_id=f"{span_context.span_id:016x}",
            source="otel",
            trace_flags=f"{int(span_context.trace_flags):02x}",
        )
    except (AttributeError, RuntimeError, TypeError, ValueError):
        return None


def current_correlation() -> CorrelationContext | None:
    """Return OTel identity when active, otherwise the LiveProbe request context."""

    return _otel_context() or _current.get()


def set_correlation(
    context: CorrelationContext,
) -> contextvars.Token[CorrelationContext | None]:
    return _current.set(context)


def reset_correlation(
    token: contextvars.Token[CorrelationContext | None],
) -> None:
    _current.reset(token)


def _inject_request_headers(request: object) -> None:
    context = current_correlation()
    if context is None:
        return
    traceparent = context.traceparent()
    headers = getattr(request, "headers", None)
    if headers is None:
        return
    try:
        if traceparent is not None and "traceparent" not in headers:
            headers["traceparent"] = traceparent
        elif (
            context.source == "legacy-x-trace-id"
            and "x-trace-id" not in headers
        ):
            headers["x-trace-id"] = context.trace_id
        elif (
            context.source == "controlled-replay"
            and "x-liveprobe-replay-id" not in headers
        ):
            headers["x-liveprobe-replay-id"] = context.trace_id
    except (AttributeError, KeyError, TypeError):
        return


def _instrument_httpx() -> bool:
    """Install an opt-in, process-wide httpx propagation hook."""

    global _httpx_patched
    with _httpx_patch_lock:
        if _httpx_patched:
            return True
        try:
            import httpx  # type: ignore[import-not-found]
        except ImportError:
            return False

        original_sync_send = httpx.Client.send
        original_async_send = httpx.AsyncClient.send

        def send(client: object, request: object, *args: Any, **kwargs: Any) -> Any:
            _inject_request_headers(request)
            return original_sync_send(client, request, *args, **kwargs)

        async def async_send(
            client: object,
            request: object,
            *args: Any,
            **kwargs: Any,
        ) -> Any:
            _inject_request_headers(request)
            return await original_async_send(client, request, *args, **kwargs)

        httpx.Client.send = send
        httpx.AsyncClient.send = async_send
        _httpx_patched = True
        return True


def instrument_fastapi(app: object, *, outbound_httpx: bool = True) -> object:
    """Add request correlation to a FastAPI/Starlette application.

    This is intentionally a one-line adapter:

    ``liveprobe.instrument_fastapi(app)``

    Existing OpenTelemetry or W3C ``traceparent`` identity is reused.  If the
    inbound request has none, LiveProbe creates a W3C-compatible identity and
    propagates it through httpx when requested.
    """

    middleware_decorator = getattr(app, "middleware", None)
    if not callable(middleware_decorator):
        raise TypeError("app must provide FastAPI/Starlette middleware()")

    @middleware_decorator("http")
    async def liveprobe_correlation_middleware(
        request: object,
        call_next: Any,
    ) -> object:
        headers = getattr(request, "headers", {})
        context = correlation_from_headers(headers)
        token = set_correlation(context)
        try:
            response = await call_next(request)
            response_headers = getattr(response, "headers", None)
            effective = current_correlation() or context
            traceparent = effective.traceparent()
            if traceparent is not None and response_headers is not None:
                response_headers.setdefault("traceparent", traceparent)
            elif (
                effective.source == "legacy-x-trace-id"
                and response_headers is not None
            ):
                response_headers.setdefault("x-trace-id", effective.trace_id)
            return response
        finally:
            reset_correlation(token)

    if outbound_httpx:
        _instrument_httpx()
    return app


def default_service_instance() -> str | None:
    return (
        os.environ.get("LIVEPROBE_SERVICE_INSTANCE")
        or os.environ.get("HOSTNAME")
        or None
    )


__all__ = [
    "CorrelationContext",
    "correlation_from_headers",
    "current_correlation",
    "default_service_instance",
    "instrument_fastapi",
    "parse_traceparent",
    "reset_correlation",
    "set_correlation",
]
