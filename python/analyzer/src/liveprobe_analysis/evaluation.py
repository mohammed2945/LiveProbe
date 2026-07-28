"""Comparable probe-frontier policies for LiveProbe architecture experiments."""

from __future__ import annotations

import json
import hashlib
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol, Sequence

from .model import AnalysisPlan, Hammock, ProbeCandidate


@dataclass(frozen=True, slots=True)
class CandidateContext:
    candidate_id: str
    file: str
    line: int
    certainty: str
    reason: str
    watch_paths: tuple[str, ...]
    hammock_id: str
    hammock_kind: str
    hammock_source: str

    @classmethod
    def from_plan(
        cls, plan: AnalysisPlan, candidate: ProbeCandidate
    ) -> CandidateContext:
        hammocks = {item.hammock_id: item for item in plan.hammocks}
        hammock = hammocks[candidate.hammock_id]
        return cls(
            candidate_id=candidate.candidate_id,
            file=candidate.file,
            line=candidate.line,
            certainty=candidate.certainty,
            reason=candidate.reason,
            watch_paths=candidate.watch_paths,
            hammock_id=hammock.hammock_id,
            hammock_kind=hammock.kind,
            hammock_source=hammock.source[:8_000],
        )


@dataclass(frozen=True, slots=True)
class ModelUsage:
    calls: int = 0
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    elapsed_ms: int = 0

    def __add__(self, other: ModelUsage) -> ModelUsage:
        return ModelUsage(
            calls=self.calls + other.calls,
            input_tokens=self.input_tokens + other.input_tokens,
            cached_input_tokens=(
                self.cached_input_tokens + other.cached_input_tokens
            ),
            output_tokens=self.output_tokens + other.output_tokens,
            reasoning_tokens=self.reasoning_tokens + other.reasoning_tokens,
            elapsed_ms=self.elapsed_ms + other.elapsed_ms,
        )


@dataclass(frozen=True, slots=True)
class Selection:
    candidate_ids: tuple[str, ...]
    rationale: str
    usage: ModelUsage = ModelUsage()


class DecisionModel(Protocol):
    def select(
        self,
        *,
        incident: str,
        candidates: Sequence[CandidateContext],
        max_candidates: int,
    ) -> Selection: ...


@dataclass(frozen=True, slots=True)
class PolicyResult:
    policy: str
    selected_candidate_ids: tuple[str, ...]
    decisions: tuple[Selection, ...]
    usage: ModelUsage

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def deterministic_policy(plan: AnalysisPlan) -> PolicyResult:
    selected = tuple(candidate.candidate_id for candidate in plan.frontier)
    return PolicyResult(
        policy="deterministic",
        selected_candidate_ids=selected,
        decisions=(),
        usage=ModelUsage(),
    )


def per_may_hammock_policy(
    plan: AnalysisPlan,
    model: DecisionModel,
    *,
    incident: str,
) -> PolicyResult:
    """Keep MUST candidates and ask once per uncertain hammock.

    The deterministic engine has already expanded the complete conservative
    slice. The model is allowed to remove probes only at MAY frontiers; it
    cannot erase MUST flow or invent code locations.
    """

    selected = {
        candidate.candidate_id
        for candidate in plan.frontier
        if candidate.certainty == "MUST"
    }
    may_by_hammock: dict[str, list[ProbeCandidate]] = {}
    for candidate in plan.frontier:
        if candidate.certainty != "MUST":
            may_by_hammock.setdefault(candidate.hammock_id, []).append(candidate)

    decisions: list[Selection] = []
    usage = ModelUsage()
    for hammock_id in sorted(may_by_hammock):
        candidates = may_by_hammock[hammock_id]
        contexts = [
            CandidateContext.from_plan(plan, candidate)
            for candidate in candidates
        ]
        decision = model.select(
            incident=incident,
            candidates=contexts,
            max_candidates=len(contexts),
        )
        allowed = {candidate.candidate_id for candidate in candidates}
        unknown = set(decision.candidate_ids) - allowed
        if unknown:
            raise ValueError(
                f"model selected candidates outside MAY hammock: {sorted(unknown)}"
            )
        selected.update(decision.candidate_ids)
        decisions.append(decision)
        usage += decision.usage

    return PolicyResult(
        policy="llm_per_may_hammock",
        selected_candidate_ids=tuple(
            candidate.candidate_id
            for candidate in plan.frontier
            if candidate.candidate_id in selected
        ),
        decisions=tuple(decisions),
        usage=usage,
    )


def single_frontier_policy(
    plan: AnalysisPlan,
    model: DecisionModel,
    *,
    incident: str,
    probe_budget: int,
) -> PolicyResult:
    contexts = [
        CandidateContext.from_plan(plan, candidate)
        for candidate in plan.frontier
    ]
    decision = model.select(
        incident=incident,
        candidates=contexts,
        max_candidates=min(probe_budget, len(contexts)),
    )
    allowed = {candidate.candidate_id for candidate in plan.frontier}
    unknown = set(decision.candidate_ids) - allowed
    if unknown:
        raise ValueError(
            f"model selected candidates outside frontier: {sorted(unknown)}"
        )
    if len(decision.candidate_ids) > probe_budget:
        raise ValueError("model exceeded the probe budget")
    return PolicyResult(
        policy="llm_single_frontier",
        selected_candidate_ids=decision.candidate_ids,
        decisions=(decision,),
        usage=decision.usage,
    )


def praxis_hammock_policy(
    plan: AnalysisPlan,
    model: DecisionModel,
    *,
    incident: str,
    max_calls: int = 6,
) -> PolicyResult:
    """Controlled PRAXIS-like hierarchy traversal for local comparison.

    This deliberately uses hammock source without runtime value dossiers.  It
    is a methodology baseline, not a reproduction of PRAXIS's complete
    observability and service-localization system.
    """

    by_parent: dict[str | None, list[Hammock]] = {}
    for hammock in plan.hammocks:
        by_parent.setdefault(hammock.parent_id, []).append(hammock)
    frontier = sorted(
        by_parent.get(None, ()),
        key=lambda value: (value.file if hasattr(value, "file") else "", value.start_line),
    )
    decisions: list[Selection] = []
    usage = ModelUsage()
    selected: Hammock | None = None
    for _ in range(max_calls):
        if not frontier:
            break
        identifiers = {
            f"hctx_{hashlib.sha256(hammock.hammock_id.encode()).hexdigest()[:24]}": hammock
            for hammock in frontier
        }
        contexts = [
            CandidateContext(
                candidate_id=identifier,
                file=next(
                    (
                        candidate.file
                        for candidate in plan.frontier
                        if candidate.function_id == hammock.function_id
                    ),
                    plan.criterion.file,
                ),
                line=hammock.start_line,
                certainty="UNKNOWN",
                reason="PRAXIS-like hierarchical hammock traversal",
                watch_paths=(),
                hammock_id=hammock.hammock_id,
                hammock_kind=hammock.kind,
                hammock_source=hammock.source[:8_000],
            )
            for identifier, hammock in identifiers.items()
        ]
        decision = model.select(
            incident=incident,
            candidates=contexts,
            max_candidates=1,
        )
        if not decision.candidate_ids:
            decisions.append(decision)
            usage += decision.usage
            break
        identifier = decision.candidate_ids[0]
        if identifier not in identifiers:
            raise ValueError("model selected a hammock outside the hierarchy")
        selected = identifiers[identifier]
        decisions.append(decision)
        usage += decision.usage
        children = sorted(
            by_parent.get(selected.hammock_id, ()),
            key=lambda value: (value.start_line, value.end_line),
        )
        if not children:
            break
        frontier = children

    selected_candidates: tuple[str, ...] = ()
    if selected is not None:
        selected_candidates = tuple(
            candidate.candidate_id
            for candidate in plan.frontier
            if candidate.function_id == selected.function_id
            and selected.start_line <= candidate.line <= selected.end_line + 1
        )
    return PolicyResult(
        policy="praxis_hammock_traversal",
        selected_candidate_ids=selected_candidates,
        decisions=tuple(decisions),
        usage=usage,
    )


class CodexDecisionModel:
    """Run one isolated, structured Codex decision without repository tools."""

    def __init__(
        self,
        repository: Path,
        *,
        model: str | None = None,
        timeout_seconds: int = 120,
    ) -> None:
        self.repository = repository.resolve()
        self.model = model
        self.timeout_seconds = timeout_seconds

    def select(
        self,
        *,
        incident: str,
        candidates: Sequence[CandidateContext],
        max_candidates: int,
    ) -> Selection:
        if not candidates or max_candidates <= 0:
            return Selection((), "No candidates were available.")
        candidate_ids = [candidate.candidate_id for candidate in candidates]
        schema = {
            "type": "object",
            "properties": {
                "selected_candidate_ids": {
                    "type": "array",
                    "items": {"type": "string", "enum": candidate_ids},
                    "maxItems": max_candidates,
                },
                "rationale": {"type": "string"},
            },
            "required": ["selected_candidate_ids", "rationale"],
            "additionalProperties": False,
        }
        prompt = (
            "You are selecting a small probe frontier for a production "
            "debugging experiment. Use only the supplied incident and hammock "
            "contexts. Do not use tools or inspect the repository. Static MAY "
            "means possible, not false: retain a MAY candidate whenever it "
            "could plausibly carry the offending value. Prefer probes that "
            "separate competing origins or observe a value after it is "
            "defined. Never invent IDs.\n\n"
            f"Incident:\n{incident}\n\n"
            f"Probe budget: {max_candidates}\n\n"
            "Candidates:\n"
            + json.dumps(
                [asdict(candidate) for candidate in candidates],
                indent=2,
            )
        )
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="liveprobe-model-") as temp:
            temp_path = Path(temp)
            schema_path = temp_path / "schema.json"
            output_path = temp_path / "answer.json"
            schema_path.write_text(json.dumps(schema), encoding="utf-8")
            command = [
                "codex",
                "exec",
                "--ignore-user-config",
                "--ignore-rules",
                "--ephemeral",
                "--json",
                "--sandbox",
                "read-only",
                "--cd",
                str(self.repository),
                "--config",
                'web_search="disabled"',
                "--config",
                "agents.enabled=false",
                "--config",
                "mcp_servers={}",
                "--output-schema",
                str(schema_path),
                "--output-last-message",
                str(output_path),
            ]
            if self.model:
                command.extend(["--model", self.model])
            command.append(prompt)
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
            )
            if completed.returncode != 0:
                raise RuntimeError(
                    "Codex decision failed: "
                    + (completed.stderr or completed.stdout)[-2_000:]
                )
            answer = json.loads(output_path.read_text(encoding="utf-8"))

        usage_raw: dict[str, int] = {}
        for line in completed.stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "turn.completed" and isinstance(
                event.get("usage"), dict
            ):
                usage_raw = {
                    key: int(value)
                    for key, value in event["usage"].items()
                    if isinstance(value, int)
                }
        selected = tuple(str(value) for value in answer["selected_candidate_ids"])
        if len(selected) != len(set(selected)):
            raise ValueError("model returned duplicate candidate IDs")
        if not set(selected) <= set(candidate_ids):
            raise ValueError("model returned a candidate ID outside the prompt")
        if len(selected) > max_candidates:
            raise ValueError("model exceeded the probe budget")
        return Selection(
            candidate_ids=selected,
            rationale=str(answer["rationale"]),
            usage=ModelUsage(
                calls=1,
                input_tokens=usage_raw.get("input_tokens", 0),
                cached_input_tokens=usage_raw.get("cached_input_tokens", 0),
                output_tokens=usage_raw.get("output_tokens", 0),
                reasoning_tokens=usage_raw.get("reasoning_output_tokens", 0),
                elapsed_ms=round((time.monotonic() - started) * 1_000),
            ),
        )


def hammock_for_candidate(
    hammocks: Sequence[Hammock], candidate: ProbeCandidate
) -> Hammock:
    for hammock in hammocks:
        if hammock.hammock_id == candidate.hammock_id:
            return hammock
    raise KeyError(candidate.hammock_id)
