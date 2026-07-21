"""Zero-dependency Python SDK for LiveProbe."""

from __future__ import annotations

import threading
from typing import IO, Mapping

from .runtime import LiveProbe
from .serializer import (
    SanitizedNode,
    SerializerConfig,
    materialize_fixture,
    serialize,
)

__version__ = "0.1.1"
__all__ = [
    "LiveProbe",
    "SanitizedNode",
    "SerializerConfig",
    "materialize_fixture",
    "serialize",
    "start",
    "stop",
]

_singleton: LiveProbe | None = None
_singleton_lock = threading.Lock()


def start(
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
    output: IO[str] | None = None,
) -> LiveProbe:
    """Start the process-wide LiveProbe agent.

    A process may run one agent because ``sys.monitoring.DEBUGGER_ID`` is a
    process-global resource.
    """

    global _singleton
    with _singleton_lock:
        if _singleton is not None:
            if _singleton.running:
                raise RuntimeError("liveprobe is already running")
            if _singleton.shutdown_pending:
                raise RuntimeError("liveprobe daemon is still stopping")
        agent = LiveProbe(
            service_id=service_id,
            broker_url=broker_url,
            api_key=api_key,
            commit_sha=commit_sha,
            environment=environment,
            redact_keys=redact_keys,
            redact_values=redact_values,
            limits=limits,
            serializer_config=serializer_config,
            poll_interval=poll_interval,
            flush_interval=flush_interval,
            output=output,
        )
        _singleton = agent.start()
        return _singleton


def stop() -> None:
    """Stop the process-wide agent and release the monitoring tool ID."""

    global _singleton
    with _singleton_lock:
        agent = _singleton
    if agent is not None:
        agent.stop()
        with _singleton_lock:
            if _singleton is agent and not agent.shutdown_pending:
                _singleton = None
