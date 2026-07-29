"""Start LiveProbe before the recommendation application imports."""

from __future__ import annotations

import atexit
import os
import sys


def enabled(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


if enabled(os.getenv("LIVEPROBE_ENABLED")):
    try:
        import liveprobe

        _agent = liveprobe.start(
            service_id=os.getenv("LIVEPROBE_SERVICE_ID", "recommendation"),
            broker_url=os.environ["LIVEPROBE_BROKER_URL"],
            api_key=os.getenv("LIVEPROBE_API_KEY"),
            commit_sha=os.environ["LIVEPROBE_COMMIT_SHA"],
            environment=os.getenv(
                "LIVEPROBE_ENVIRONMENT", "praxis-evaluation"
            ),
            service_instance=os.getenv("HOSTNAME"),
            poll_interval=float(os.getenv("LIVEPROBE_POLL_INTERVAL", "0.5")),
            flush_interval=float(os.getenv("LIVEPROBE_FLUSH_INTERVAL", "0.5")),
        )
        atexit.register(liveprobe.stop)
    except Exception as error:
        print(
            f"LiveProbe bootstrap failed: {type(error).__name__}: {error}",
            file=sys.stderr,
            flush=True,
        )
        raise
