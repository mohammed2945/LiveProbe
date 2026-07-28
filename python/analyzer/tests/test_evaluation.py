from __future__ import annotations

from dataclasses import replace

from liveprobe_analysis.evaluation import (
    CandidateContext,
    ModelUsage,
    Selection,
    deterministic_policy,
    per_may_hammock_policy,
    praxis_hammock_policy,
    single_frontier_policy,
)
from liveprobe_analysis.model import (
    AnalysisCriterion,
    AnalysisPlan,
    Hammock,
    ProbeCandidate,
)


class FakeModel:
    def __init__(self, selected: set[str]) -> None:
        self.selected = selected
        self.calls: list[tuple[str, ...]] = []

    def select(
        self,
        *,
        incident: str,
        candidates: list[CandidateContext],
        max_candidates: int,
    ) -> Selection:
        del incident
        ids = tuple(candidate.candidate_id for candidate in candidates)
        self.calls.append(ids)
        chosen = tuple(value for value in ids if value in self.selected)[
            :max_candidates
        ]
        return Selection(
            candidate_ids=chosen,
            rationale="fixture",
            usage=ModelUsage(calls=1, input_tokens=10, elapsed_ms=5),
        )


class FirstCandidateModel:
    def select(
        self,
        *,
        incident: str,
        candidates: list[CandidateContext],
        max_candidates: int,
    ) -> Selection:
        del incident
        selected = (
            (candidates[0].candidate_id,)
            if candidates and max_candidates > 0
            else ()
        )
        return Selection(
            candidate_ids=selected,
            rationale="first fixture candidate",
            usage=ModelUsage(calls=1, input_tokens=10, elapsed_ms=5),
        )


def plan() -> AnalysisPlan:
    criterion = AnalysisCriterion(
        repository_root="/repo",
        commit="a" * 40,
        service_id="svc",
        file="service.py",
        line=10,
        watch_path="value",
    )
    hammock = Hammock(
        hammock_id="hmk_may",
        function_id="func",
        kind="branch",
        entry_node="entry",
        exit_nodes=("exit",),
        node_ids=("entry", "exit"),
        start_line=1,
        end_line=5,
        parent_id=None,
        source="if uncertain:\n    value = source",
    )
    must_hammock = replace(hammock, hammock_id="hmk_must", kind="function")
    return AnalysisPlan(
        plan_id="inv_" + "1" * 24,
        criterion=criterion,
        slice_node_ids=("entry", "exit"),
        slice_edges=(),
        hammocks=(hammock, must_hammock),
        frontier=(
            ProbeCandidate(
                candidate_id="cand_" + "a" * 24,
                function_id="func",
                hammock_id="hmk_may",
                file="service.py",
                line=3,
                watch_paths=("value",),
                distance_from_sink=2,
                upstream_weight=1,
                reason="uncertain cut",
                certainty="MAY",
            ),
            ProbeCandidate(
                candidate_id="cand_" + "b" * 24,
                function_id="func",
                hammock_id="hmk_must",
                file="service.py",
                line=8,
                watch_paths=("result",),
                distance_from_sink=1,
                upstream_weight=1,
                reason="must cut",
                certainty="MUST",
            ),
        ),
        coverage_notes=(),
    )


def test_deterministic_policy_preserves_the_full_frontier() -> None:
    result = deterministic_policy(plan())
    assert len(result.selected_candidate_ids) == 2
    assert result.usage.calls == 0


def test_per_hammock_model_can_only_prune_may_candidates() -> None:
    fixture = plan()
    model = FakeModel(set())
    result = per_may_hammock_policy(fixture, model, incident="bad value")

    assert model.calls == [(fixture.frontier[0].candidate_id,)]
    assert result.selected_candidate_ids == (fixture.frontier[1].candidate_id,)
    assert result.usage.calls == 1


def test_single_frontier_model_gets_one_bounded_call() -> None:
    fixture = plan()
    model = FakeModel({fixture.frontier[0].candidate_id})
    result = single_frontier_policy(
        fixture,
        model,
        incident="bad value",
        probe_budget=1,
    )

    assert len(model.calls) == 1
    assert result.selected_candidate_ids == (fixture.frontier[0].candidate_id,)


def test_praxis_baseline_traverses_hammock_hierarchy_without_runtime_values() -> None:
    fixture = plan()
    # The controlled baseline uses generated hierarchy IDs, so choose the
    # first supplied context at each level.
    model = FirstCandidateModel()
    result = praxis_hammock_policy(
        fixture,
        model,
        incident="bad value",
        max_calls=3,
    )

    assert result.policy == "praxis_hammock_traversal"
    assert result.usage.calls >= 1
    assert result.usage.calls == 1
