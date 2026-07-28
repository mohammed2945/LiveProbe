from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from liveprobe.correlation import (
    CorrelationContext,
    correlation_from_headers,
    current_correlation,
    instrument_fastapi,
    parse_traceparent,
    reset_correlation,
    set_correlation,
)


def test_traceparent_validation_and_legacy_fallback() -> None:
    valid = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
    context = parse_traceparent(valid)

    assert context is not None
    assert context.trace_id == "0123456789abcdef0123456789abcdef"
    assert context.span_id == "0123456789abcdef"
    assert context.traceparent() == valid
    assert parse_traceparent("00-" + ("0" * 32) + "-0123456789abcdef-01") is None
    assert (
        correlation_from_headers({"x-trace-id": "legacy-request"}).source
        == "legacy-x-trace-id"
    )
    assert (
        correlation_from_headers({"x-liveprobe-replay-id": "replay-7"}).source
        == "controlled-replay"
    )


def test_context_is_captured_and_reset() -> None:
    first = CorrelationContext("1" * 32, "2" * 16, "liveprobe-w3c")
    second = CorrelationContext("3" * 32, "4" * 16, "liveprobe-w3c")

    first_token = set_correlation(first)
    assert current_correlation() == first
    second_token = set_correlation(second)
    assert current_correlation() == second
    reset_correlation(second_token)
    assert current_correlation() == first
    reset_correlation(first_token)
    assert current_correlation() is None


@dataclass
class FakeResponse:
    headers: dict[str, str] = field(default_factory=dict)


class FakeApp:
    middleware_fn: Any = None

    def middleware(self, kind: str) -> Any:
        assert kind == "http"

        def register(function: Any) -> Any:
            self.middleware_fn = function
            return function

        return register


@dataclass
class FakeRequest:
    headers: dict[str, str]


def test_fastapi_adapter_isolates_concurrent_request_contexts() -> None:
    app = FakeApp()
    instrument_fastapi(app, outbound_httpx=False)
    seen: list[str] = []

    async def invoke(trace_digit: str) -> FakeResponse:
        request = FakeRequest(
            {
                "traceparent": (
                    f"00-{trace_digit * 32}-{trace_digit * 16}-01"
                )
            }
        )

        async def call_next(_: object) -> FakeResponse:
            await asyncio.sleep(0)
            context = current_correlation()
            assert context is not None
            seen.append(context.trace_id)
            return FakeResponse()

        return await app.middleware_fn(request, call_next)

    async def run() -> tuple[FakeResponse, FakeResponse]:
        first, second = await asyncio.gather(invoke("1"), invoke("2"))
        return first, second

    first_response, second_response = asyncio.run(run())

    assert sorted(seen) == ["1" * 32, "2" * 32]
    assert first_response.headers["traceparent"].startswith("00-" + ("1" * 32))
    assert second_response.headers["traceparent"].startswith("00-" + ("2" * 32))
    assert current_correlation() is None
