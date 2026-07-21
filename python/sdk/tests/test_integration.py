from __future__ import annotations

import io
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

from liveprobe.runtime import LiveProbe


class BrokerState:
    def __init__(self) -> None:
        self.probes: list[dict[str, object]] = []
        self.ingests: list[dict[str, object]] = []
        self.lock = threading.Lock()


def make_handler(state: BrokerState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            parsed = urlsplit(self.path)
            assert parsed.path == "/v1/services/integration-service/probes"
            since = parse_qs(parsed.query).get("since", ["0"])[0]
            if since == "1":
                self._json(200, {"version": 1, "unchanged": True})
            else:
                self._json(200, {"version": 1, "probes": state.probes})

        def do_POST(self) -> None:
            assert self.path == "/v1/ingest"
            length = int(self.headers["Content-Length"])
            payload = json.loads(self.rfile.read(length))
            with state.lock:
                state.ingests.append(payload)
            self._json(202, {"accepted": len(payload["events"])})

        def _json(self, status: int, payload: object) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            return None

    return Handler


def wait_for(predicate: Any, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition was not reached before timeout")


def integration_target(agent: LiveProbe) -> object | None:
    customer = {"id": "cus_123", "secret": "do-not-send"}
    result = agent._on_line(integration_target.__code__, 901)
    assert customer["id"] == "cus_123"
    return result


def test_daemon_polls_captures_flushes_and_stops(fake_monitoring: Any) -> None:
    state = BrokerState()
    state.probes = [
        {
            "id": "prb_integration",
            "serviceId": "integration-service",
            "type": "snapshot",
            "file": "test_integration.py",
            "line": 901,
            "watchPaths": ["customer.id", "customer.secret"],
            "hitLimit": 1,
            "ttlSeconds": 1800,
            "version": 1,
            "createdBy": "pytest-integration",
        }
    ]
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state))
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    output = io.StringIO()
    agent = LiveProbe(
        service_id="integration-service",
        broker_url=f"http://127.0.0.1:{server.server_port}",
        commit_sha="abcdef1234567890",
        monitoring=fake_monitoring,
        poll_interval=0.02,
        flush_interval=0.02,
        limits={"requestTimeout": 0.5},
        output=output,
    )

    try:
        agent.start()
        wait_for(lambda: 901 in agent._active_by_line)

        integration_target(agent)

        def snapshot_arrived() -> bool:
            with state.lock:
                return any(
                    event.get("type") == "snapshot"
                    for ingest in state.ingests
                    for event in ingest["events"]
                )

        wait_for(snapshot_arrived)
        with state.lock:
            snapshot = next(
                event
                for ingest in state.ingests
                for event in ingest["events"]
                if event.get("type") == "snapshot"
            )
        assert snapshot["watches"] == {
            "customer.id": {"t": "str", "v": "cus_123"},
            "customer.secret": {"t": "redacted"},
        }
        assert snapshot["variables"]["c"]["customer"]["c"]["secret"] == {
            "t": "redacted"
        }
    finally:
        agent.stop()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=1)

    assert fake_monitoring.freed
    assert agent._thread is not None and not agent._thread.is_alive()
    assert "[liveprobe] PROBE ARMED" in output.getvalue()
    assert "[liveprobe] AGENT STOPPED" in output.getvalue()
