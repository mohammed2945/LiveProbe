from __future__ import annotations

import io
import json
import threading
import time
import urllib.error
from typing import Any

import pytest

from liveprobe.runtime import (
    Condition,
    LiveProbe,
    TokenBucket,
    condition_matches,
    resolve_dot_path,
)


def probe(
    probe_id: str,
    kind: str,
    *,
    line: int = 700,
    hit_limit: int = 10,
    **extra: object,
) -> dict[str, object]:
    result: dict[str, object] = {
        "id": probe_id,
        "serviceId": "service",
        "type": kind,
        "file": "test_runtime.py",
        "line": line,
        "hitLimit": hit_limit,
        "ttlSeconds": 1800,
        "version": 1,
        "createdBy": "pytest",
    }
    result.update(extra)
    return result


def make_agent(
    fake_monitoring: Any,
    *,
    limits: dict[str, object] | None = None,
    output: io.StringIO | None = None,
) -> LiveProbe:
    return LiveProbe(
        service_id="service",
        broker_url="http://127.0.0.1:1",
        commit_sha="abcdef1234567890",
        monitoring=fake_monitoring,
        limits=limits,
        output=output or io.StringIO(),
    )


def trigger(agent: LiveProbe, line: int = 700) -> object | None:
    user = {"tier": "free", "apiToken": "hidden"}
    sample = 3.5
    result = agent._on_line(trigger.__code__, line)
    assert user["tier"] == "free" and sample > 0
    return result


def concurrent_condition_target(
    agent: LiveProbe,
    tier: str,
    begin: threading.Event,
    captured: threading.Event,
    release: threading.Event,
) -> None:
    user = {"tier": tier}
    assert begin.wait(timeout=1)
    agent._on_line(concurrent_condition_target.__code__, 701)
    captured.set()
    assert release.wait(timeout=1)
    assert user["tier"] == tier


def test_dot_resolution_is_static_and_conditions_are_strict() -> None:
    class Dangerous:
        def __init__(self) -> None:
            self.safe = {"value": 9}

        @property
        def explosive(self) -> int:
            raise AssertionError("property was invoked")

    captured = {"object": Dangerous(), "one": 1, "truth": True}

    assert resolve_dot_path(captured, "object.safe.value") == 9
    assert not condition_matches(Condition("object.explosive", "eq", 1), captured)
    assert condition_matches(Condition("one", "eq", 1.0), captured)
    assert not condition_matches(Condition("truth", "eq", 1), captured)
    assert not condition_matches(Condition("missing", "ne", "x"), captured)


def test_callback_verifies_frame_and_builds_snapshot(fake_monitoring: Any) -> None:
    output = io.StringIO()
    agent = make_agent(fake_monitoring, output=output)
    agent._install_monitoring()
    try:
        agent._reconcile(
            [
                probe(
                    "prb_snapshot",
                    "snapshot",
                    hit_limit=1,
                    watchPaths=["user.tier", "user.apiToken"],
                )
            ]
        )

        trigger(agent)
        agent._drain_queue()

        snapshots = [
            event for event in agent._events if event["type"] == "snapshot"
        ]
        assert len(snapshots) == 1
        snapshot = snapshots[0]
        assert snapshot["watches"] == {
            "user.tier": {"t": "str", "v": "free"},
            "user.apiToken": {"t": "redacted"},
        }
        assert snapshot["stack"][0]["fn"] == "trigger"
        assert any(
            event.get("status") == "hit-limit-reached"
            for event in agent._events
        )
        assert 700 not in agent._active_by_line
        assert fake_monitoring.restart_count >= 2
        assert "[liveprobe] PROBE ARMED" in output.getvalue()
        assert "[liveprobe] PROBE HIT LIMIT" in output.getvalue()
    finally:
        agent._uninstall_monitoring()


def test_counter_and_metric_are_aggregated(fake_monitoring: Any) -> None:
    agent = make_agent(fake_monitoring)
    agent._install_monitoring()
    try:
        agent._reconcile(
            [
                probe("prb_counter", "counter"),
                probe("prb_metric", "metric", metricPath="sample"),
            ]
        )

        trigger(agent)
        trigger(agent)
        agent._drain_queue()

        aggregates = {
            event["type"]: event for event in agent._aggregate_events()
        }
        assert aggregates["counter"]["delta"] == 2
        assert aggregates["metric"] == {
            "probeId": "prb_metric",
            "type": "metric",
            "ts": aggregates["metric"]["ts"],
            "count": 2,
            "sum": 7.0,
            "min": 3.5,
            "max": 3.5,
            "last": 3.5,
        }
        assert not [
            event
            for event in agent._events
            if event["type"] in {"counter", "metric"}
        ]
    finally:
        agent._uninstall_monitoring()


def test_log_template_is_rendered_only_from_sanitized_nodes(
    fake_monitoring: Any,
) -> None:
    output = io.StringIO()
    agent = make_agent(fake_monitoring, output=output)
    agent._install_monitoring()
    try:
        agent._reconcile(
            [
                probe(
                    "prb_log",
                    "log",
                    template="tier=${user.tier} token=${user.apiToken}",
                )
            ]
        )

        trigger(agent)
        agent._drain_queue()

        logs = [event for event in agent._events if event["type"] == "log"]
        assert logs[0]["message"] == "tier=free token=[REDACTED]"
        assert "[liveprobe] tier=free token=[REDACTED]" in output.getvalue()
        assert "hidden" not in output.getvalue()
    finally:
        agent._uninstall_monitoring()


def test_condition_runs_in_background_and_releases_reservation(
    fake_monitoring: Any,
) -> None:
    agent = make_agent(fake_monitoring)
    agent._install_monitoring()
    try:
        agent._reconcile(
            [
                probe(
                    "prb_condition",
                    "snapshot",
                    condition={"path": "user.tier", "op": "eq", "value": "paid"},
                )
            ]
        )

        trigger(agent)
        agent._drain_queue()

        assert not [
            event for event in agent._events if event["type"] == "snapshot"
        ]
        state = agent._states["prb_condition"]
        assert state.in_flight == 0
        assert state.emitted == 0
        assert state.active
    finally:
        agent._uninstall_monitoring()


def test_false_condition_cannot_block_concurrent_true_hit(
    fake_monitoring: Any,
) -> None:
    agent = make_agent(fake_monitoring)
    agent._install_monitoring()
    agent._reconcile(
        [
            probe(
                "prb_concurrent_condition",
                "snapshot",
                line=701,
                hit_limit=1,
                condition={"path": "user.tier", "op": "eq", "value": "paid"},
            )
        ]
    )
    start_false = threading.Event()
    start_false.set()
    false_captured = threading.Event()
    true_captured_one = threading.Event()
    true_captured_two = threading.Event()
    release = threading.Event()
    false_thread = threading.Thread(
        target=concurrent_condition_target,
        args=(
            agent,
            "free",
            start_false,
            false_captured,
            release,
        ),
    )
    true_thread_one = threading.Thread(
        target=concurrent_condition_target,
        args=(
            agent,
            "paid",
            false_captured,
            true_captured_one,
            release,
        ),
    )
    true_thread_two = threading.Thread(
        target=concurrent_condition_target,
        args=(
            agent,
            "paid",
            false_captured,
            true_captured_two,
            release,
        ),
    )
    try:
        false_thread.start()
        true_thread_one.start()
        true_thread_two.start()
        assert true_captured_one.wait(timeout=1)
        assert true_captured_two.wait(timeout=1)
        release.set()
        false_thread.join(timeout=1)
        true_thread_one.join(timeout=1)
        true_thread_two.join(timeout=1)
        assert not false_thread.is_alive()
        assert not true_thread_one.is_alive()
        assert not true_thread_two.is_alive()

        agent._drain_queue()

        snapshots = [
            event for event in agent._events if event["type"] == "snapshot"
        ]
        assert len(snapshots) == 1
        tier = snapshots[0]["variables"]["c"]["user"]["c"]["tier"]
        assert tier == {"t": "str", "v": "paid"}
        state = agent._states["prb_concurrent_condition"]
        assert state.emitted == 1
        assert state.in_flight == 0
    finally:
        release.set()
        false_thread.join(timeout=1)
        true_thread_one.join(timeout=1)
        true_thread_two.join(timeout=1)
        agent._uninstall_monitoring()


def test_rate_limit_is_checked_before_frame_capture(
    fake_monitoring: Any,
) -> None:
    agent = make_agent(fake_monitoring, limits={"hitsPerSec": 0})
    agent._install_monitoring()
    try:
        agent._reconcile([probe("prb_rate", "snapshot")])

        def fail_if_called(code: object) -> object:
            raise AssertionError("capture started before rate limiting")

        agent._find_monitored_frame = fail_if_called  # type: ignore[method-assign]
        trigger(agent)

        assert agent._raw_queue.qsize() == 1  # armed lifecycle only
    finally:
        agent._uninstall_monitoring()


def test_callback_budget_enters_red_then_rearms(fake_monitoring: Any) -> None:
    output = io.StringIO()
    agent = make_agent(
        fake_monitoring,
        limits={"pauseBudgetMs": 0, "cooldownSeconds": 0},
        output=output,
    )
    agent._install_monitoring()
    try:
        agent._reconcile([probe("prb_red", "counter")])

        trigger(agent)

        assert agent.agent_state == "red"
        assert fake_monitoring.event_calls[-1] == 0
        agent._drain_queue()
        assert any(
            event.get("status") == "suspended" for event in agent._events
        )

        agent._maybe_rearm(time.monotonic() + 1)
        agent._drain_queue()

        assert agent.agent_state == "green"
        assert fake_monitoring.event_calls[-1] == fake_monitoring.events.LINE
        assert fake_monitoring.restart_count >= 2
        assert "[liveprobe] SAFETY RED" in output.getvalue()
        assert "[liveprobe] SAFETY GREEN" in output.getvalue()
    finally:
        agent._uninstall_monitoring()


def test_probe_omission_is_treated_as_ttl_expiration(
    fake_monitoring: Any,
) -> None:
    agent = make_agent(fake_monitoring)
    agent._install_monitoring()
    try:
        agent._reconcile([probe("prb_ttl", "counter")])
        agent._drain_queue()

        agent._reconcile([])
        agent._drain_queue()

        assert "prb_ttl" not in agent._states
        assert any(
            event.get("probeId") == "prb_ttl"
            and event.get("status") == "expired"
            for event in agent._events
        )
    finally:
        agent._uninstall_monitoring()


def test_bandwidth_bucket_never_exceeds_available_bytes() -> None:
    bucket = TokenBucket(rate=100, capacity=100)

    assert bucket.consume(100, now=bucket.updated_at)
    assert not bucket.consume(1, now=bucket.updated_at)
    assert bucket.consume(50, now=bucket.updated_at + 0.5)


def test_oversized_event_is_dropped_without_exceeding_bandwidth(
    fake_monitoring: Any,
) -> None:
    output = io.StringIO()
    agent = make_agent(
        fake_monitoring,
        limits={"bandwidthKbPerSec": 1},
        output=output,
    )
    sent: list[bytes] = []

    def request(method: str, path: str, body: bytes | None = None) -> dict[str, object]:
        assert method == "POST"
        assert path == "/v1/ingest"
        assert body is not None
        sent.append(body)
        return {"accepted": 0}

    agent._request_json = request  # type: ignore[method-assign]
    agent._append_event(
        {
            "probeId": "prb_large",
            "type": "log",
            "ts": "2026-07-19T00:00:00.000Z",
            "message": "x" * 5000,
            "level": "info",
        }
    )

    agent._flush()

    assert sent and len(sent[0]) <= 1024
    assert not agent._events
    assert "EVENT DROPPED prb_large" in output.getvalue()


def test_invalid_ingest_batch_is_dropped_and_does_not_block_later_events(
    fake_monitoring: Any,
) -> None:
    output = io.StringIO()
    agent = make_agent(fake_monitoring, output=output)
    attempts = 0
    accepted: list[list[dict[str, object]]] = []

    def request(method: str, path: str, body: bytes | None = None) -> dict[str, object]:
        nonlocal attempts
        assert method == "POST"
        assert path == "/v1/ingest"
        assert body is not None
        attempts += 1
        payload = json.loads(body)
        if attempts == 1:
            raise urllib.error.HTTPError(
                "http://broker/v1/ingest",
                400,
                "Bad Request",
                {},
                io.BytesIO(
                    b'{"error":{"code":"invalid_request",'
                    b'"message":"event references unknown probe prb_removed"}}'
                ),
            )
        accepted.append(payload["events"])
        return {"accepted": len(payload["events"])}

    agent._request_json = request  # type: ignore[method-assign]
    agent._append_event(
        {
            "probeId": "prb_removed",
            "type": "log",
            "ts": "2026-07-19T00:00:00.000Z",
            "message": "stale",
            "level": "info",
        }
    )

    agent._flush()

    assert not agent._events
    assert agent._dropped_hits == 1
    assert "BROKER FLUSH REJECTED HTTP 400; dropped 1 event(s)" in output.getvalue()

    agent._append_event(
        {
            "probeId": "prb_current",
            "type": "log",
            "ts": "2026-07-19T00:00:01.000Z",
            "message": "current",
            "level": "info",
        }
    )
    agent._flush()

    assert not agent._events
    assert [[event["probeId"] for event in batch] for batch in accepted] == [
        ["prb_current"]
    ]


def test_ingest_payload_includes_commit_metadata(fake_monitoring: Any) -> None:
    agent = make_agent(fake_monitoring)

    assert agent._ingest_payload([]) == {
        "serviceId": "service",
        "sdk": "python",
        "commitSha": "abcdef1234567890",
        "commitSource": "config",
        "agentStatus": {
            "state": "green",
            "detail": "0 active locations; 0 dropped hits",
        },
        "events": [],
    }


def test_commit_sha_is_required(fake_monitoring: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LIVEPROBE_COMMIT_SHA", raising=False)
    monkeypatch.delenv("GIT_COMMIT", raising=False)

    with pytest.raises(ValueError, match="commit_sha is required"):
        LiveProbe(
            service_id="service",
            broker_url="http://127.0.0.1:1",
            monitoring=fake_monitoring,
        )


def test_stop_releases_monitoring_tool(fake_monitoring: Any) -> None:
    output = io.StringIO()
    agent = make_agent(fake_monitoring, output=output)
    agent._install_monitoring()
    agent._running = True

    agent.stop()

    assert not agent.running
    assert fake_monitoring.freed
    assert fake_monitoring.callback is None
    assert "[liveprobe] AGENT STOPPED" in output.getvalue()


def test_stop_defers_monitoring_cleanup_until_blocked_daemon_exits(
    fake_monitoring: Any,
) -> None:
    output = io.StringIO()
    entered_request = threading.Event()
    release_request = threading.Event()
    final_payloads: list[dict[str, object]] = []
    agent = make_agent(
        fake_monitoring,
        limits={"requestTimeout": 0.05, "shutdownTimeout": 0.05},
        output=output,
    )
    agent._reconcile([probe("prb_shutdown", "counter")])

    def blocked_request(
        method: str, path: str, body: bytes | None = None
    ) -> dict[str, object]:
        if method == "POST":
            assert path == "/v1/ingest"
            assert body is not None
            final_payloads.append(json.loads(body))
            return {"accepted": 1}
        assert method == "GET" and body is None
        entered_request.set()
        assert release_request.wait(timeout=2)
        return {"version": 0, "unchanged": True}

    agent._request_json = blocked_request  # type: ignore[method-assign]
    agent.start()
    assert entered_request.wait(timeout=1)

    started = time.monotonic()
    agent.stop()
    elapsed = time.monotonic() - started

    assert elapsed < 0.5
    assert agent.shutdown_error is not None
    assert "monitoring cleanup deferred" in agent.shutdown_error
    assert not fake_monitoring.freed
    assert fake_monitoring.callback is not None
    assert agent._thread is not None and agent._thread.is_alive()
    assert fake_monitoring.event_calls[-1] == 0
    assert "[liveprobe] AGENT STOP ERROR" in output.getvalue()

    release_request.set()
    agent._thread.join(timeout=1)

    assert not agent._thread.is_alive()
    assert fake_monitoring.freed
    assert fake_monitoring.callback is None
    assert any(
        event.get("probeId") == "prb_shutdown"
        and event.get("status") == "error"
        and "monitoring cleanup deferred" in str(event.get("detail"))
        for payload in final_payloads
        for event in payload.get("events", [])
    )
    assert "after daemon exit" in output.getvalue()


@pytest.mark.parametrize(
    "limits",
    [
        {"requestTimeout": 10.01},
        {"shutdownTimeout": 30.01},
    ],
)
def test_network_and_shutdown_waits_have_hard_upper_bounds(
    fake_monitoring: Any, limits: dict[str, object]
) -> None:
    with pytest.raises(ValueError):
        make_agent(fake_monitoring, limits=limits)
