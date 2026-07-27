from __future__ import annotations

import io
import json
import threading
import time
import urllib.error
import urllib.request
from typing import Any

import pytest

from liveprobe.runtime import (
    Condition,
    Limits,
    LiveProbe,
    Probe,
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
    redact_values: list[str] | None = None,
    serializer_config: dict[str, object] | None = None,
) -> LiveProbe:
    return LiveProbe(
        service_id="service",
        broker_url="http://127.0.0.1:1",
        commit_sha="abcdef1234567890",
        monitoring=fake_monitoring,
        limits=limits,
        serializer_config=serializer_config,
        output=output or io.StringIO(),
        redact_values=redact_values,
    )


def trigger(agent: LiveProbe, line: int = 700) -> object | None:
    user = {"tier": "free", "apiToken": "hidden"}
    sample = 3.5
    result = agent._on_line(trigger.__code__, line)
    assert user["tier"] == "free" and sample > 0
    return result


def stack_locals_inner(agent: LiveProbe, line: int = 702) -> object | None:
    frame_visible = "inner-visible"
    accessToken = "inner-secret"  # noqa: N806 - intentional redaction fixture
    result = agent._on_line(stack_locals_inner.__code__, line)
    assert frame_visible and accessToken
    return result


def stack_locals_outer(agent: LiveProbe, line: int = 702) -> object | None:
    outer_visible = "outer-visible"
    password = "outer-secret"
    result = stack_locals_inner(agent, line)
    assert outer_visible and password
    return result


def redacted_expression_trigger(
    agent: LiveProbe, line: int = 703
) -> object | None:
    password = "password-must-not-escape"
    classified = "configured-must-not-escape"
    secretAmount = 42  # noqa: N806 - intentional redaction fixture
    result = agent._on_line(redacted_expression_trigger.__code__, line)
    assert password and classified and secretAmount
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
        assert all("variables" not in frame for frame in snapshot["stack"])
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


def test_snapshot_frame_locals_respect_limit_and_redaction(
    fake_monitoring: Any,
) -> None:
    agent = make_agent(fake_monitoring)
    agent._install_monitoring()
    try:
        agent._reconcile(
            [
                probe(
                    "prb_frame_locals",
                    "snapshot",
                    line=702,
                    hit_limit=1,
                    includeStackLocals=True,
                    stackFrameLimit=2,
                )
            ]
        )

        stack_locals_outer(agent)
        agent._drain_queue()

        snapshots = [
            event for event in agent._events if event["type"] == "snapshot"
        ]
        assert len(snapshots) == 1
        stack = snapshots[0]["stack"]
        assert len(stack) == 2
        assert [frame["fn"] for frame in stack] == [
            "stack_locals_inner",
            "stack_locals_outer",
        ]
        inner_variables = stack[0]["variables"]
        outer_variables = stack[1]["variables"]
        assert inner_variables["c"]["frame_visible"] == {
            "t": "str",
            "v": "inner-visible",
        }
        assert inner_variables["c"]["accessToken"] == {"t": "redacted"}
        assert outer_variables["c"]["outer_visible"] == {
            "t": "str",
            "v": "outer-visible",
        }
        assert outer_variables["c"]["password"] == {"t": "redacted"}
        serialized = json.dumps(snapshots[0])
        assert "inner-secret" not in serialized
        assert "outer-secret" not in serialized
    finally:
        agent._uninstall_monitoring()


def test_stack_local_capture_bounds_raw_local_copy(fake_monitoring: Any) -> None:
    agent = make_agent(
        fake_monitoring,
        serializer_config={"maxProps": 2},
    )
    first_variables = {f"local_{index}": index for index in range(100)}

    stack = agent._capture_stack(
        __import__("sys")._getframe(),
        frame_local_limit=1,
        first_variables=first_variables,
    )

    assert stack[0].variables == {"local_0": 0, "local_1": 1}


def test_frame_local_defaults_and_malformed_fields() -> None:
    parsed = Probe.parse(probe("prb_frame_defaults", "snapshot"), "service")

    assert not parsed.include_stack_locals
    assert parsed.stack_frame_limit == 3

    invalid_fields = [
        {"includeStackLocals": None},
        {"includeStackLocals": 1},
        {"includeStackLocals": "true"},
        {"stackFrameLimit": 0},
        {"stackFrameLimit": 9},
        {"stackFrameLimit": True},
        {"stackFrameLimit": 3.5},
    ]
    for fields in invalid_fields:
        with pytest.raises(ValueError):
            Probe.parse(
                probe("prb_invalid_frame_fields", "snapshot", **fields),
                "service",
            )


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
        assert logs[0]["level"] == "info"
        assert "[liveprobe] tier=free token=[REDACTED]" in output.getvalue()
        assert "hidden" not in output.getvalue()
    finally:
        agent._uninstall_monitoring()


@pytest.mark.parametrize("level", ["debug", "info", "warn", "error"])
def test_log_level_is_emitted(
    fake_monitoring: Any,
    level: str,
) -> None:
    agent = make_agent(fake_monitoring)
    agent._install_monitoring()
    try:
        agent._reconcile(
            [
                probe(
                    f"prb_log_{level}",
                    "log",
                    template="tier=${user.tier}",
                    logLevel=level,
                )
            ]
        )

        trigger(agent)
        agent._drain_queue()

        logs = [event for event in agent._events if event["type"] == "log"]
        assert logs == [
            {
                "probeId": f"prb_log_{level}",
                "type": "log",
                "ts": logs[0]["ts"],
                "message": "tier=free",
                "level": level,
            }
        ]
    finally:
        agent._uninstall_monitoring()


@pytest.mark.parametrize("level", ["fatal", None, ["info"]])
def test_invalid_log_level_is_rejected(level: object) -> None:
    with pytest.raises(
        ValueError,
        match="logLevel must be one of debug, info, warn, or error",
    ):
        Probe.parse(
            probe(
                "prb_log_invalid",
                "log",
                template="invalid",
                logLevel=level,
            ),
            "service",
        )


def test_compiled_expressions_integrate_with_all_probe_types(
    fake_monitoring: Any,
) -> None:
    product = {
        "source": "sample * 2",
        "ast": {
            "type": "binary",
            "operator": "multiply",
            "left": {"type": "reference", "path": ["sample"]},
            "right": {"type": "literal", "value": 2},
        },
    }
    paid_condition = {
        "source": 'user.tier == "free"',
        "ast": {
            "type": "binary",
            "operator": "eq",
            "left": {"type": "reference", "path": ["user", "tier"]},
            "right": {"type": "literal", "value": "free"},
        },
    }
    missing = {
        "source": "missing.value",
        "ast": {"type": "reference", "path": ["missing", "value"]},
    }
    agent = make_agent(fake_monitoring)
    agent._install_monitoring()
    try:
        agent._reconcile(
            [
                probe(
                    "prb_expression_snapshot",
                    "snapshot",
                    conditionExpression=paid_condition,
                    watchExpressions=[product, missing],
                ),
                probe(
                    "prb_expression_false",
                    "snapshot",
                    conditionExpression=missing,
                ),
                probe(
                    "prb_expression_log",
                    "log",
                    template="double=${sample * 2}",
                    templateSegments=[
                        {"type": "text", "value": "double="},
                        {"type": "expression", "expression": product},
                        {"type": "text", "value": " missing="},
                        {"type": "expression", "expression": missing},
                    ],
                ),
                probe(
                    "prb_expression_metric",
                    "metric",
                    metricExpression=product,
                ),
            ]
        )

        trigger(agent)
        agent._drain_queue()

        snapshots = [
            event for event in agent._events if event["type"] == "snapshot"
        ]
        assert len(snapshots) == 1
        assert snapshots[0]["probeId"] == "prb_expression_snapshot"
        assert snapshots[0]["watches"] == {
            "sample * 2": {"t": "num", "v": 7.0},
            "missing.value": {"t": "truncated", "v": "unsupported"},
        }
        logs = [event for event in agent._events if event["type"] == "log"]
        assert logs[0]["message"] == (
            "double=7 missing=<expression-error:missing>"
        )
        metrics = {
            event["probeId"]: event for event in agent._aggregate_events()
        }
        assert metrics["prb_expression_metric"]["count"] == 1
        assert metrics["prb_expression_metric"]["sum"] == 7.0
        false_state = agent._states["prb_expression_false"]
        assert false_state.emitted == 0
        assert false_state.in_flight == 0
    finally:
        agent._uninstall_monitoring()


def test_invalid_metric_expression_drops_sample_and_reports_status(
    fake_monitoring: Any,
) -> None:
    agent = make_agent(fake_monitoring)
    agent._install_monitoring()
    try:
        agent._reconcile(
            [
                probe(
                    "prb_invalid_metric_expression",
                    "metric",
                    metricExpression={
                        "source": "sample / 0",
                        "ast": {
                            "type": "binary",
                            "operator": "divide",
                            "left": {
                                "type": "reference",
                                "path": ["sample"],
                            },
                            "right": {"type": "literal", "value": 0},
                        },
                    },
                )
            ]
        )

        trigger(agent)
        agent._drain_queue()

        assert not agent._aggregate_events()
        assert any(
            event.get("probeId") == "prb_invalid_metric_expression"
            and event.get("type") == "status"
            and event.get("status") == "error"
            and event.get("detail")
            == "invalid-metric: sample / 0 (division-by-zero)"
            for event in agent._events
        )
        state = agent._states["prb_invalid_metric_expression"]
        assert state.emitted == 0
        assert state.in_flight == 0
    finally:
        agent._uninstall_monitoring()


def test_compiled_expressions_never_use_or_expose_redacted_data(
    fake_monitoring: Any,
) -> None:
    def expression(source: str, *path: str) -> dict[str, object]:
        return {
            "source": source,
            "ast": {"type": "reference", "path": list(path)},
        }

    password = expression("password", "password")
    classified = expression("classified", "classified")
    secret_amount = expression("secretAmount", "secretAmount")
    classified_condition = {
        "source": 'classified == "allowed"',
        "ast": {
            "type": "binary",
            "operator": "eq",
            "left": {"type": "reference", "path": ["classified"]},
            "right": {"type": "literal", "value": "allowed"},
        },
    }
    output = io.StringIO()
    agent = make_agent(
        fake_monitoring,
        output=output,
        redact_values=["configured-must-not-escape"],
    )
    agent._install_monitoring()
    try:
        agent._reconcile(
            [
                probe(
                    "prb_redacted_condition",
                    "snapshot",
                    line=703,
                    conditionExpression=classified_condition,
                ),
                probe(
                    "prb_redacted_watches",
                    "snapshot",
                    line=703,
                    watchExpressions=[password, classified],
                ),
                probe(
                    "prb_redacted_log",
                    "log",
                    line=703,
                    template="${password} ${classified}",
                    templateSegments=[
                        {"type": "expression", "expression": password},
                        {"type": "text", "value": " "},
                        {"type": "expression", "expression": classified},
                    ],
                ),
                probe(
                    "prb_redacted_metric",
                    "metric",
                    line=703,
                    metricExpression=secret_amount,
                ),
            ]
        )

        redacted_expression_trigger(agent)
        agent._drain_queue()

        snapshots = [
            event for event in agent._events if event["type"] == "snapshot"
        ]
        assert len(snapshots) == 1
        assert snapshots[0]["probeId"] == "prb_redacted_watches"
        assert snapshots[0]["watches"] == {
            "password": {"t": "truncated", "v": "unsupported"},
            "classified": {"t": "truncated", "v": "unsupported"},
        }
        logs = [event for event in agent._events if event["type"] == "log"]
        assert logs[0]["message"] == (
            "<expression-error:redacted> <expression-error:redacted>"
        )
        assert not agent._aggregate_events()
        assert any(
            event.get("probeId") == "prb_redacted_metric"
            and event.get("type") == "status"
            and event.get("detail")
            == "invalid-metric: secretAmount (redacted)"
            for event in agent._events
        )
        condition_state = agent._states["prb_redacted_condition"]
        assert condition_state.emitted == 0
        assert condition_state.in_flight == 0
        serialized = json.dumps(agent._events) + output.getvalue()
        assert "password-must-not-escape" not in serialized
        assert "configured-must-not-escape" not in serialized
    finally:
        agent._uninstall_monitoring()


def test_malformed_compiled_expression_is_rejected_before_arming() -> None:
    with pytest.raises(ValueError, match="unsupported node type"):
        Probe.parse(
            probe(
                "prb_malformed_expression",
                "snapshot",
                conditionExpression={
                    "source": "danger()",
                    "ast": {"type": "call", "name": "danger"},
                },
            ),
            "service",
        )


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
        assert agent._ingest_payload([])["agentStatus"] == {
            "state": "red",
            "reasonCode": "pause_budget",
            "limits": {
                "maxProbeHitsPerSecond": 10.0,
                "maxProbePauseMsPerSecond": 0.0,
                "safetyCooldownMs": 0,
                "maxTelemetryBytesPerSecond": 204_800.0,
            },
            "detail": "1 active locations; 0 dropped hits",
        }
        assert fake_monitoring.event_calls[-1] == 0
        agent._drain_queue()
        assert any(
            event.get("status") == "suspended" for event in agent._events
        )

        agent._maybe_rearm(time.monotonic() + 1)
        agent._drain_queue()

        assert agent.agent_state == "green"
        assert "reasonCode" not in agent._ingest_payload([])["agentStatus"]
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
        "agentId": agent.agent_id,
        "commitSha": "abcdef1234567890",
        "commitSource": "config",
        "capabilities": [
            "log-levels-v1",
            "expression-ast-v1",
            "frame-locals-v1",
            "safety-report-v1",
        ],
        "agentStatus": {
            "state": "green",
            "limits": {
                "maxProbeHitsPerSecond": 10.0,
                "maxProbePauseMsPerSecond": 20.0,
                "safetyCooldownMs": 10_000,
                "maxTelemetryBytesPerSecond": 204_800.0,
            },
            "detail": "0 active locations; 0 dropped hits",
        },
        "events": [],
    }


def test_broker_requests_include_project_and_environment_headers(
    fake_monitoring: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LIVEPROBE_PROJECT_ID", "ignored-project")
    monkeypatch.setenv("LIVEPROBE_ENVIRONMENT", "ignored-environment")
    agent = LiveProbe(
        service_id="service",
        broker_url="https://broker.example",
        api_key="test-key",
        commit_sha="abcdef1234567890",
        project_id="acquireiq",
        environment="production",
        monitoring=fake_monitoring,
    )
    captured: list[urllib.request.Request] = []

    class Response:
        def __enter__(self) -> Response:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def read(self) -> bytes:
            return b"{}"

    def urlopen(
        request: urllib.request.Request, *, timeout: float
    ) -> Response:
        assert timeout == agent.limits.request_timeout
        captured.append(request)
        return Response()

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    agent._request_json("GET", "/v1/services")

    assert len(captured) == 1
    headers = {key.lower(): value for key, value in captured[0].header_items()}
    assert headers["authorization"] == "Bearer test-key"
    assert headers["liveprobe-project"] == "acquireiq"
    assert headers["liveprobe-environment"] == "production"


def test_commit_sha_is_required(fake_monitoring: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LIVEPROBE_COMMIT_SHA", raising=False)
    monkeypatch.delenv("GIT_COMMIT", raising=False)

    with pytest.raises(ValueError, match="commit_sha is required"):
        LiveProbe(
            service_id="service",
            broker_url="http://127.0.0.1:1",
            monitoring=fake_monitoring,
        )


def test_canonical_safety_limits_use_environment_and_validate_aliases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LIVEPROBE_MAX_PROBE_HITS_PER_SECOND", "12")
    monkeypatch.setenv("LIVEPROBE_MAX_PROBE_PAUSE_MS_PER_SECOND", "25")
    monkeypatch.setenv("LIVEPROBE_SAFETY_COOLDOWN_MS", "2500")
    monkeypatch.setenv("LIVEPROBE_MAX_TELEMETRY_BYTES_PER_SECOND", "4096")

    assert Limits.from_mapping(None) == Limits(
        hits_per_sec=12.0,
        pause_budget_ms=25.0,
        cooldown_seconds=2.5,
        bandwidth_kb_per_sec=4.0,
    )
    assert Limits.from_mapping(
        {
            "maxProbeHitsPerSecond": 20,
            "hitsPerSec": 20,
            "maxTelemetryBytesPerSecond": 2048,
            "bandwidthKbPerSec": 2,
        }
    ).hits_per_sec == 20
    with pytest.raises(ValueError, match="conflicts"):
        Limits.from_mapping(
            {"maxProbeHitsPerSecond": 20, "hitsPerSec": 10}
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


def test_probe_on_missing_line_reports_error_not_armed(
    fake_monitoring: Any,
) -> None:
    output = io.StringIO()
    agent = make_agent(fake_monitoring, output=output)
    agent._install_monitoring()
    try:
        agent._reconcile([probe("prb_dead", "snapshot", line=999_999)])
        agent._drain_queue()

        statuses = [
            event for event in agent._events if event["type"] == "status"
        ]
        assert [event["status"] for event in statuses] == ["error"]
        assert statuses[0]["detail"] == "line-not-found: test_runtime.py:999999"
        assert "[liveprobe] PROBE ARMED" not in output.getvalue()
    finally:
        agent._uninstall_monitoring()


def test_probe_on_missing_file_reports_error_not_armed(
    fake_monitoring: Any,
) -> None:
    agent = make_agent(fake_monitoring)
    agent._install_monitoring()
    try:
        agent._reconcile(
            [
                {
                    **probe("prb_nofile", "snapshot"),
                    "file": "does/not/exist.py",
                }
            ]
        )
        agent._drain_queue()

        statuses = [
            event for event in agent._events if event["type"] == "status"
        ]
        assert [event["status"] for event in statuses] == ["error"]
        assert statuses[0]["detail"] == "line-not-found: does/not/exist.py:700"
    finally:
        agent._uninstall_monitoring()


def test_unresolved_probe_errors_once_then_arms_when_target_appears(
    fake_monitoring: Any,
) -> None:
    agent = make_agent(fake_monitoring)
    agent._install_monitoring()
    try:
        definition = {
            **probe("prb_late", "snapshot"),
            "file": "imported/late.py",
        }
        agent._reconcile([definition])
        agent._reconcile([definition])
        agent._drain_queue()

        # The same failure is reported once, not on every poll.
        assert [
            event["status"]
            for event in agent._events
            if event["type"] == "status"
        ] == ["error"]

        # Once the module resolves, the next poll flips the probe to armed.
        import liveprobe.runtime as runtime

        real_resolve = runtime._resolve_probe_target
        runtime._resolve_probe_target = lambda file, line: None
        try:
            agent._reconcile([definition])
            agent._drain_queue()
        finally:
            runtime._resolve_probe_target = real_resolve

        assert [
            event["status"]
            for event in agent._events
            if event["type"] == "status"
        ] == ["error", "armed"]
    finally:
        agent._uninstall_monitoring()


def test_counter_stays_exact_when_the_hit_budget_is_exhausted(
    fake_monitoring: Any,
) -> None:
    agent = make_agent(fake_monitoring, limits={"maxProbeHitsPerSecond": 1})
    agent._install_monitoring()
    try:
        agent._reconcile([probe("prb_hot", "counter", hit_limit=10_000)])
        agent._drain_queue()
        # Drain the token the bucket starts full with.
        trigger(agent)

        for _ in range(500):
            trigger(agent)
        agent._drain_queue()

        counters = [
            event for event in agent._aggregate_events()
            if event["type"] == "counter"
        ]
        assert counters == [
            {
                "probeId": "prb_hot",
                "type": "counter",
                "ts": counters[0]["ts"],
                "delta": 501,
            }
        ]
    finally:
        agent._uninstall_monitoring()


def test_rate_limited_counter_retires_at_its_hit_limit(
    fake_monitoring: Any,
) -> None:
    agent = make_agent(fake_monitoring, limits={"maxProbeHitsPerSecond": 1})
    agent._install_monitoring()
    try:
        agent._reconcile([probe("prb_small", "counter", hit_limit=3)])
        agent._drain_queue()

        for _ in range(20):
            trigger(agent)
        agent._drain_queue()

        counters = [
            event for event in agent._aggregate_events()
            if event["type"] == "counter"
        ]
        assert counters[0]["delta"] == 3
        assert any(
            event.get("status") == "hit-limit-reached"
            for event in agent._events
        )
    finally:
        agent._uninstall_monitoring()
