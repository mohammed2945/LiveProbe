from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from liveprobe_analysis.cache import AnalysisCache
from liveprobe_analysis.investigation import InvestigationEngine
from liveprobe_analysis.model import (
    CandidateMechanism,
    CandidatePrediction,
    InvestigationCriterion,
    InvestigationDecision,
    ValueObservation,
)


def make_repository(tmp_path: Path, source: str) -> tuple[Path, str]:
    (tmp_path / "service.py").write_text(source.lstrip(), encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(["git", "add", "service.py"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=tmp_path, check=True)
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    return tmp_path, commit


def record_initial_evidence(
    engine: InvestigationEngine,
    view: dict[str, object],
    observation_id: str,
    value: object = 1,
) -> dict[str, object]:
    bundle = view["probe_bundle"]
    assert isinstance(bundle, dict)
    return engine.record_evidence(
        str(view["investigation_id"]),
        [
            ValueObservation(
                observation_id=(
                    observation_id
                    if index == 0
                    else f"{observation_id}_{index + 1}"
                ),
                site_id=site["site_id"],
                occurrence_id=f"trace:{observation_id}",
                hit_index=1,
                values={
                    path: {"t": "num", "v": value}
                    for path in site["watch_paths"]
                },
            )
            for index, site in enumerate(bundle["sites"])
        ],
    )


def test_function_summary_keeps_relevant_ports_only(tmp_path: Path) -> None:
    root, commit = make_repository(
        tmp_path,
        """
def quote(user, trip, config):
    ignored = config.logging_level
    amount = trip.distance * config.per_mile_rate
    return {"amount": amount}
""",
    )
    cache_path = tmp_path / "analysis.sqlite3"
    with AnalysisCache(root, cache_path) as cache:
        cache.prepare(commit)
        summary = next(
            value
            for value in cache.load_summaries(commit)
            if value.qualified_name == "quote"
        )

    amount = next(
        value for value in summary.dependencies if value.output_path == "amount"
    )
    assert "trip.distance" in amount.input_paths
    assert "config.per_mile_rate" in amount.input_paths
    assert not any("logging_level" in value for value in amount.input_paths)
    assert not any(value.startswith("user") for value in amount.input_paths)


def test_runtime_traversals_merge_equivalent_contexts_and_split_services(
    tmp_path: Path,
) -> None:
    engine = InvestigationEngine(str(tmp_path), str(tmp_path / "unused.db"))
    state = {
        "investigation_id": "inv_context",
        "traversals": {},
        "active_traversal_ids": [],
    }
    gateway_id, created = engine._ensure_traversal(
        state,
        function_id="common.py:normalize",
        service_id="gateway",
        anchors=("return",),
        tracked=("value",),
        depth=2,
        parent_traversal_id="trv_gateway_parent_a",
        via_node_id="gateway_call_a",
    )
    assert created
    merged_id, created = engine._ensure_traversal(
        state,
        function_id="common.py:normalize",
        service_id="gateway",
        anchors=("return",),
        tracked=("value",),
        depth=3,
        parent_traversal_id="trv_gateway_parent_b",
        via_node_id="gateway_call_b",
    )
    assert not created
    assert merged_id == gateway_id
    assert set(
        state["traversals"][gateway_id]["parent_traversal_ids"]
    ) == {"trv_gateway_parent_a", "trv_gateway_parent_b"}
    assert len(state["traversals"][gateway_id]["incoming_hops"]) == 2

    pricing_id, created = engine._ensure_traversal(
        state,
        function_id="common.py:normalize",
        service_id="pricing",
        anchors=("return",),
        tracked=("value",),
        depth=2,
        parent_traversal_id="trv_pricing_parent",
        via_node_id="pricing_call",
    )
    assert created
    assert pricing_id != gateway_id


def test_investigation_loads_one_body_then_expands_selected_path(
    tmp_path: Path,
) -> None:
    root, commit = make_repository(
        tmp_path,
        """
def normalize(raw):
    cleaned = raw.replace(",", ".")
    return float(cleaned)

def fallback(raw):
    return 1.0 if raw is None else float(raw)

def fare(raw, backup):
    rate = normalize(raw)
    other = fallback(backup)
    amount = rate + other
    return amount
""",
    )
    cache_path = tmp_path / "analysis.sqlite3"
    with AnalysisCache(root, cache_path) as cache:
        cache.prepare(commit)
    engine = InvestigationEngine(str(root), str(cache_path))
    view = engine.start(
        InvestigationCriterion(
            repository_root=str(root),
            commit=commit,
            service_id="fare",
            file="service.py",
            line=12,
            watch_path="amount",
            symptom="amount is semantically wrong",
        )
    )

    assert view["stats"]["fragmentsLoaded"] == 1
    assert view["phase"] == "AWAITING_EVIDENCE"
    assert view["actions"] == []
    view = record_initial_evidence(engine, view, "obs_initial")
    follow = [
        action for action in view["actions"] if action["kind"] == "FOLLOW_PATH"
    ]
    assert len(follow) == 2
    chosen_function = follow[0]["function_id"]
    previous_round = view["round"]

    updated = engine.decide(
        view["investigation_id"],
        InvestigationDecision(
            action_ids=(follow[0]["action_id"],),
            based_on_revision=view["revision"],
        ),
    )

    assert updated["stats"]["expandedFunctions"] == 2
    assert updated["phase"] == "DECIDING"
    assert updated["round"] == previous_round
    assert updated["probe_bundle"] is None
    assert any(
        traversal["function_id"] == chosen_function
        for traversal in updated["graph"]["runtimeTraversals"]
    )
    assert any(
        entry["kind"] == "AI_SRE_DECISION"
        for entry in updated["decision_log"]
    )
    assert updated["graph"]["unresolvedBranches"] >= 1
    assert updated["decision_context"]["deferred"]["count"] >= 1


def test_control_guard_outside_focus_root_does_not_block_mechanism(
    tmp_path: Path,
) -> None:
    (tmp_path / "common").mkdir()
    (tmp_path / "services" / "pricing").mkdir(parents=True)
    (tmp_path / "common" / "faults.py").write_text(
        """
def is_active(name):
    active = name == "surge_poison"
    return active
""".lstrip(),
        encoding="utf-8",
    )
    (tmp_path / "services" / "pricing" / "app.py").write_text(
        """
from common.faults import is_active

def quote(config):
    surge = 50 if is_active("surge_poison") else config["surge"]
    return surge
""".lstrip(),
        encoding="utf-8",
    )
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=tmp_path, check=True)
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    cache_path = tmp_path / "analysis.sqlite3"
    with AnalysisCache(tmp_path, cache_path) as cache:
        cache.prepare(commit)
    engine = InvestigationEngine(str(tmp_path), str(cache_path))

    view = engine.start(
        InvestigationCriterion(
            repository_root=str(tmp_path),
            commit=commit,
            service_id="pricing-e2e",
            file="services/pricing/app.py",
            line=5,
            watch_path="surge",
            symptom="quote is implausibly high",
            source_roots=("services/pricing",),
            ownership_map=(("services/pricing", "pricing-e2e"),),
        )
    )
    with AnalysisCache(tmp_path, cache_path) as cache:
        quote = next(
            fragment
            for fragment in cache.load_fragments(commit)
            if fragment.qualified_name == "quote"
        )
    guard = next(
        call
        for call in quote.calls
        if call.target.endswith("is_active")
    )
    assert guard.contribution_role == "CONTROL_GUARD"
    view = record_initial_evidence(engine, view, "obs_import")
    assert view["stats"]["fragmentsLoaded"] == 1
    assert not any(
        action["kind"] == "FOLLOW_PATH"
        and "is_active" in str(action["function_id"])
        for action in view["actions"]
    )
    inspect = next(
        action
        for action in view["actions"]
        if action["kind"] == "INSPECT_MECHANISM"
    )
    updated = engine.decide(
        view["investigation_id"],
        InvestigationDecision(
            action_ids=(inspect["action_id"],),
            based_on_revision=view["revision"],
        ),
    )

    assert updated["phase"] == "MECHANISM"
    assert any(
        statement["line"] == 4
        for statement in updated["mechanism_context"]["statements"]
    )
    assert not any(
        edge["kind"] == "CALL_RETURN"
        for edge in updated["graph"]["edges"]
    )
    assert set(updated["graph"]["projections"]) == {
        "boundary",
        "function",
        "segment",
        "statement",
    }


def test_shared_source_function_has_distinct_runtime_traversals(
    tmp_path: Path,
) -> None:
    (tmp_path / "common").mkdir()
    for service in ("root", "gateway", "pricing"):
        (tmp_path / "services" / service).mkdir(parents=True)
    (tmp_path / "common" / "normalize.py").write_text(
        """
def normalize(raw):
    cleaned = float(raw)
    return cleaned
""".lstrip(),
        encoding="utf-8",
    )
    (tmp_path / "services" / "gateway" / "app.py").write_text(
        """
from common.normalize import normalize

@app.get("/gateway-value")
def gateway_value(raw):
    value = normalize(raw)
    return {"value": value}
""".lstrip(),
        encoding="utf-8",
    )
    (tmp_path / "services" / "pricing" / "app.py").write_text(
        """
from common.normalize import normalize

@app.get("/pricing-value")
def pricing_value(raw):
    value = normalize(raw)
    return {"value": value}
""".lstrip(),
        encoding="utf-8",
    )
    (tmp_path / "services" / "root" / "app.py").write_text(
        """
def aggregate(raw):
    gateway_response = httpx.get("http://gateway/gateway-value", params={"raw": raw})
    pricing_response = httpx.get("http://pricing/pricing-value", params={"raw": raw})
    gateway_value = gateway_response.json()
    pricing_value = pricing_response.json()
    result = gateway_value["value"] + pricing_value["value"]
    return result
""".lstrip(),
        encoding="utf-8",
    )
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=tmp_path, check=True)
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    cache_path = tmp_path / "analysis.sqlite3"
    with AnalysisCache(tmp_path, cache_path) as cache:
        cache.prepare(commit)
    engine = InvestigationEngine(str(tmp_path), str(cache_path))
    ownership = (
        ("services/root", "root-runtime"),
        ("services/gateway", "gateway-runtime"),
        ("services/pricing", "pricing-runtime"),
    )
    view = engine.start(
        InvestigationCriterion(
            repository_root=str(tmp_path),
            commit=commit,
            service_id="root-runtime",
            file="services/root/app.py",
            line=7,
            watch_path="result",
            symptom="aggregate is wrong",
            ownership_map=ownership,
        )
    )
    view = record_initial_evidence(engine, view, "obs_root")
    http_actions = [
        action
        for action in view["actions"]
        if action["kind"] == "FOLLOW_PATH"
        and action["boundary_kind"] == "http"
    ]
    assert {action["target_service_id"] for action in http_actions} == {
        "gateway-runtime",
        "pricing-runtime",
    }
    view = engine.decide(
        view["investigation_id"],
        InvestigationDecision(
            action_ids=tuple(
                action["action_id"] for action in http_actions
            ),
            based_on_revision=view["revision"],
        ),
    )
    assert view["round"] == 1
    assert view["probe_bundle"] is None

    normalize_region = next(
        region
        for region in view["graph"]["projections"]["function"]["regions"]
        if region["label"].endswith("normalize")
    )
    assert normalize_region["runtime_owner"] is None
    normalize_traversals = [
        traversal
        for traversal in view["graph"]["runtimeTraversals"]
        if traversal["function_id"]
        in normalize_region["member_function_ids"]
    ]
    assert {value["service_id"] for value in normalize_traversals} == {
        "gateway-runtime",
        "pricing-runtime",
    }
    assert len(
        {
            region["region_id"]
            for region in view["graph"]["projections"]["function"]["regions"]
            if region["label"].endswith("normalize")
        }
    ) == 1
    owner_regions = {
        region["runtime_owner"]: region
        for region in view["graph"]["projections"]["boundary"]["regions"]
        if region["kind"] == "OWNER"
    }
    assert normalize_region["region_id"] in owner_regions[
        "gateway-runtime"
    ]["child_region_ids"]
    assert normalize_region["region_id"] in owner_regions[
        "pricing-runtime"
    ]["child_region_ids"]
    probe_action = next(
        action
        for action in view["actions"]
        if action["kind"] == "PROBE_REGION"
    )
    view = engine.decide(
        view["investigation_id"],
        InvestigationDecision(
            action_ids=(probe_action["action_id"],),
            based_on_revision=view["revision"],
        ),
    )
    shared_sites = [
        site
        for site in view["probe_bundle"]["sites"]
        if site["function_id"] in normalize_region["member_function_ids"]
    ]
    assert {site["service_id"] for site in shared_sites} == {
        "gateway-runtime",
        "pricing-runtime",
    }


def test_mechanism_adjudication_waits_for_resolved_producer(
    tmp_path: Path,
) -> None:
    engine = InvestigationEngine(str(tmp_path), str(tmp_path / "unused.db"))
    state = {
        "graph_nodes": {
            "call": {
                "file": "consumer.py",
                "line": 12,
                "function_id": "consumer",
            }
        },
        "branches": {
            "follow": {
                "status": "AVAILABLE",
                "public": {"kind": "FOLLOW_PATH"},
                "meta": {"viaNode": "call"},
            }
        },
    }

    engine._add_mechanism_action(state, "call", "divergent result")
    assert list(state["branches"]) == ["follow"]

    state["branches"]["follow"]["status"] = "EXPANDED"
    engine._add_mechanism_action(state, "call", "divergent result")
    assert any(
        branch["public"]["kind"] == "INSPECT_MECHANISM"
        for branch in state["branches"].values()
    )


def test_mechanical_judgments_and_semantic_unknown_are_logged(
    tmp_path: Path,
) -> None:
    root, commit = make_repository(
        tmp_path,
        """
def fare(raw):
    amount = raw
    return amount
""",
    )
    cache_path = tmp_path / "analysis.sqlite3"
    with AnalysisCache(root, cache_path) as cache:
        cache.prepare(commit)
    engine = InvestigationEngine(str(root), str(cache_path))
    typed = engine.start(
        InvestigationCriterion(
            repository_root=str(root),
            commit=commit,
            service_id="fare",
            file="service.py",
            line=3,
            watch_path="amount",
            symptom="numeric multiplication failed",
            failure_class="type_shape",
            expected_type="numeric",
        )
    )
    site = typed["probe_bundle"]["sites"][0]
    typed = engine.record_evidence(
        typed["investigation_id"],
        [
            ValueObservation(
                observation_id="obs_type",
                site_id=site["site_id"],
                occurrence_id="trace:bad-type",
                hit_index=1,
                values={site["watch_paths"][0]: {"t": "str", "v": "2,45"}},
            )
        ],
    )
    assert any(
        value["basis"] == "MECHANICAL"
        and value["classification"] == "VIOLATES"
        for value in typed["judgments"]
    )

    semantic = engine.start(
        InvestigationCriterion(
            repository_root=str(root),
            commit=commit,
            service_id="fare",
            file="service.py",
            line=3,
            watch_path="amount",
            symptom="customer was charged the wrong amount",
            failure_class="semantic",
        )
    )
    assert not any(
        action["kind"] == "REQUEST_DIFFERENTIAL"
        for action in semantic["actions"]
    )
    site = semantic["probe_bundle"]["sites"][0]
    path = site["watch_paths"][0]
    semantic = engine.record_evidence(
        semantic["investigation_id"],
        [
            ValueObservation(
                observation_id="obs_bad",
                site_id=site["site_id"],
                occurrence_id="trace:bad",
                hit_index=1,
                values={path: {"t": "num", "v": 2310}},
            ),
            ValueObservation(
                observation_id="obs_bad_second",
                site_id=site["site_id"],
                occurrence_id="trace:bad",
                hit_index=2,
                values={path: {"t": "num", "v": 99}},
            ),
        ],
    )
    assert semantic["judgments"] == []
    assert all(
        dossier["interpretation"] == "UNKNOWN"
        for dossier in semantic["value_dossiers"]
    )
    assert {
        dossier["hit_index"] for dossier in semantic["value_dossiers"]
    } == {1, 2}


def test_unknown_actions_cannot_change_investigation(tmp_path: Path) -> None:
    root, commit = make_repository(
        tmp_path,
        """
def fare(raw):
    amount = raw
    return amount
""",
    )
    cache_path = tmp_path / "analysis.sqlite3"
    with AnalysisCache(root, cache_path) as cache:
        cache.prepare(commit)
    engine = InvestigationEngine(str(root), str(cache_path))
    view = engine.start(
        InvestigationCriterion(
            repository_root=str(root),
            commit=commit,
            service_id="fare",
            file="service.py",
            line=3,
            watch_path="amount",
            symptom="wrong amount",
        )
    )
    view = record_initial_evidence(engine, view, "obs_unknown_action")

    with pytest.raises(ValueError, match="unknown or unavailable"):
        engine.decide(
            view["investigation_id"],
            InvestigationDecision(
                action_ids=("act_not_supplied",),
                based_on_revision=view["revision"],
            ),
        )


def test_domain_range_predicate_is_mechanical(tmp_path: Path) -> None:
    root, commit = make_repository(
        tmp_path,
        """
def reserve(raw):
    remaining = raw
    return remaining
""",
    )
    cache_path = tmp_path / "analysis.sqlite3"
    with AnalysisCache(root, cache_path) as cache:
        cache.prepare(commit)
    engine = InvestigationEngine(str(root), str(cache_path))
    view = engine.start(
        InvestigationCriterion(
            repository_root=str(root),
            commit=commit,
            service_id="inventory",
            file="service.py",
            line=3,
            watch_path="remaining",
            symptom="inventory became negative",
            failure_class="domain_range",
            minimum=0,
        )
    )
    site = view["probe_bundle"]["sites"][0]
    view = engine.record_evidence(
        view["investigation_id"],
        [
            ValueObservation(
                observation_id="obs_negative",
                site_id=site["site_id"],
                occurrence_id="trace:negative",
                hit_index=1,
                values={
                    site["watch_paths"][0]: {"t": "num", "v": -1}
                },
            )
        ],
    )

    assert any(
        judgment["basis"] == "MECHANICAL"
        and judgment["classification"] == "VIOLATES"
        for judgment in view["judgments"]
    )


def test_contract_evidence_remains_unknown_and_opens_frontiers(
    tmp_path: Path,
) -> None:
    root, commit = make_repository(
        tmp_path,
        """
def normalize(raw):
    status = raw.upper()
    return status
""",
    )
    cache_path = tmp_path / "analysis.sqlite3"
    with AnalysisCache(root, cache_path) as cache:
        cache.prepare(commit)
    engine = InvestigationEngine(str(root), str(cache_path))
    view = engine.start(
        InvestigationCriterion(
            repository_root=str(root),
            commit=commit,
            service_id="orders",
            file="service.py",
            line=3,
            watch_path="status",
            symptom="downstream API rejected unknown status PENDNIG",
            failure_class="contract",
        )
    )
    site = view["probe_bundle"]["sites"][0]
    path = site["watch_paths"][0]
    view = engine.record_evidence(
        view["investigation_id"],
        [
            ValueObservation(
                observation_id="obs_contract",
                site_id=site["site_id"],
                occurrence_id="trace:contract",
                hit_index=1,
                values={path: {"t": "str", "v": "PENDNIG"}},
            )
        ],
    )
    assert view["value_dossiers"][0]["interpretation"] == "UNKNOWN"
    assert view["judgments"] == []
    assert any(
        action["kind"] in {"PROBE_REGION", "INSPECT_MECHANISM"}
        for action in view["actions"]
    )


def test_candidate_is_required_only_for_final_confirmation(
    tmp_path: Path,
) -> None:
    root, commit = make_repository(
        tmp_path,
        """
def fare(raw):
    amount = raw
    return amount
""",
    )
    cache_path = tmp_path / "analysis.sqlite3"
    with AnalysisCache(root, cache_path) as cache:
        cache.prepare(commit)
    engine = InvestigationEngine(str(root), str(cache_path))
    view = engine.start(
        InvestigationCriterion(
            repository_root=str(root),
            commit=commit,
            service_id="fare",
            file="service.py",
            line=3,
            watch_path="amount",
            symptom="wrong amount",
            probe_budget=5,
        )
    )
    view = record_initial_evidence(engine, view, "obs_explore", 2310)
    assert view["candidate_mechanism"] is None
    inspect = next(
        action
        for action in view["actions"]
        if action["kind"] == "INSPECT_MECHANISM"
    )
    view = engine.decide(
        view["investigation_id"],
        InvestigationDecision(
            action_ids=(inspect["action_id"],),
            based_on_revision=view["revision"],
            exploration_question="what determines amount?",
        ),
    )
    assert view["phase"] == "MECHANISM"
    context = view["mechanism_context"]
    candidate_site = context["probeCandidates"][0]
    confirm = next(
        action
        for action in view["actions"]
        if action["kind"] == "CONFIRM_CANDIDATE"
    )
    candidate = CandidateMechanism(
        statement="the observed assignment produces the wrong amount",
        anchor_node_ids=(context["anchorNodeId"],),
        traversal_id=context["traversalIds"][0],
        predictions=(
            CandidatePrediction(
                probe_candidate_id=candidate_site["site_id"],
                watch_path=candidate_site["watch_paths"][0],
                operator="eq",
                expected_value=2310,
            ),
        ),
    )
    view = engine.decide(
        view["investigation_id"],
        InvestigationDecision(
            action_ids=(confirm["action_id"],),
            based_on_revision=view["revision"],
            candidate_mechanism=candidate,
        ),
    )
    assert view["phase"] == "CONFIRMING"
    confirmation_site = next(
        site
        for site in view["probe_bundle"]["sites"]
        if site["site_id"] == candidate_site["site_id"]
    )
    assert confirmation_site["watch_paths"] == [
        candidate.predictions[0].watch_path
    ]
    observations = []
    for index, site in enumerate(view["probe_bundle"]["sites"], start=1):
        values = {
            path: {"t": "num", "v": 2310}
            for path in site["watch_paths"]
        }
        observations.append(
            ValueObservation(
                observation_id=f"obs_confirm_{index}",
                site_id=site["site_id"],
                occurrence_id="trace:confirmation",
                hit_index=1,
                values=values,
            )
        )
    view = engine.record_evidence(view["investigation_id"], observations)
    assert view["candidate_mechanism"]["status"] == "SUPPORTED"
    complete = next(
        action
        for action in view["actions"]
        if action["kind"] == "COMPLETE_LOCALIZATION"
    )
    view = engine.decide(
        view["investigation_id"],
        InvestigationDecision(
            action_ids=(complete["action_id"],),
            based_on_revision=view["revision"],
            evidence_refs=tuple(
                observation.observation_id for observation in observations
            ),
        ),
    )
    assert view["status"] == "LOCALIZED"
    assert view["candidate_mechanism"]["status"] == "CONFIRMED"


def test_stale_revision_and_packet_bloat_are_rejected(
    tmp_path: Path,
) -> None:
    root, commit = make_repository(
        tmp_path,
        """
def fare(raw):
    amount = raw
    return amount
""",
    )
    cache_path = tmp_path / "analysis.sqlite3"
    with AnalysisCache(root, cache_path) as cache:
        cache.prepare(commit)
    engine = InvestigationEngine(str(root), str(cache_path))
    started = engine.start(
        InvestigationCriterion(
            repository_root=str(root),
            commit=commit,
            service_id="fare",
            file="service.py",
            line=3,
            watch_path="amount",
            symptom="wrong amount",
        )
    )
    view = record_initial_evidence(
        engine,
        started,
        "obs_large",
        {"client": "x" * 20_000},
    )
    assert view["stats"]["decisionPacketBytes"] <= 16 * 1024
    assert all("source" not in node for node in view["graph"]["nodes"])
    with pytest.raises(ValueError, match="stale investigation decision"):
        engine.decide(
            view["investigation_id"],
            InvestigationDecision(
                action_ids=(),
                based_on_revision=started["revision"],
            ),
        )


def test_absence_failure_returns_explicit_insufficient(tmp_path: Path) -> None:
    root, commit = make_repository(
        tmp_path,
        """
def dispatch(event):
    sent = event is not None
    return sent
""",
    )
    cache_path = tmp_path / "analysis.sqlite3"
    with AnalysisCache(root, cache_path) as cache:
        cache.prepare(commit)
    engine = InvestigationEngine(str(root), str(cache_path))
    view = engine.start(
        InvestigationCriterion(
            repository_root=str(root),
            commit=commit,
            service_id="notifications",
            file="service.py",
            line=3,
            watch_path="sent",
            symptom="email was never sent",
            failure_class="absence",
        )
    )

    assert view["status"] == "INSUFFICIENT"
    assert view["phase"] == "INSUFFICIENT"
    assert not view["probe_bundle"]["sites"]
    assert view["actions"] == []
    assert any(
        "counter/control probes" in note for note in view["coverage_notes"]
    )
