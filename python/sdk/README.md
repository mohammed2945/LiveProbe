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
```

`commit_sha` is required unless `LIVEPROBE_COMMIT_SHA` or `GIT_COMMIT` is set.
`api_key` defaults to `LIVEPROBE_API_KEY`.
