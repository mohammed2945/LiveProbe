# liveprobe

Python 3.12+ runtime agent for LiveProbe using `sys.monitoring`.

```python
import liveprobe

agent = liveprobe.start(
    service_id="billing",
    broker_url="http://127.0.0.1:7070",
    api_key="dev-key",
    commit_sha="abcdef1234567890",
)

# One-time request correlation for FastAPI/Starlette applications.
liveprobe.instrument_fastapi(app)
```

`commit_sha` is required unless `LIVEPROBE_COMMIT_SHA` or `GIT_COMMIT` is set.
`api_key` defaults to `LIVEPROBE_API_KEY`.

`instrument_fastapi(app)` reuses an active OpenTelemetry span or inbound W3C
`traceparent`. If neither exists, it creates a request-scoped W3C identity.
The identity is isolated with `contextvars`, captured synchronously with every
snapshot/log hit, and propagated through httpx. Existing `X-Trace-Id` and
`X-LiveProbe-Replay-Id` headers are also understood. Set
`outbound_httpx=False` if the application already owns outbound propagation;
the default installs an idempotent process-wide httpx send hook.

LiveProbe never joins events merely because their timestamps are close. Events
without an explicit identity stay uncorrelated.

Configured snapshot watch paths are serialized inside the line callback before
background processing. This freezes the observed scalar/container value at the
actual hit, so an object mutated immediately afterward cannot rewrite the
investigation evidence. Full locals and event delivery remain asynchronous and
bounded by the normal serializer and safety limits.
