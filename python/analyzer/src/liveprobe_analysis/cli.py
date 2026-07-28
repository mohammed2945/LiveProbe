"""JSON command-line bridge used by the TypeScript MCP server."""

from __future__ import annotations

import json
import sys
import traceback

from .engine import AnalysisEngine
from .investigation import InvestigationEngine
from .model import (
    AnalysisCriterion,
    CandidateAssessment,
    CandidateMechanism,
    CandidatePrediction,
    InvestigationCriterion,
    InvestigationDecision,
    ValueObservation,
)


def execute(raw: object) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise ValueError("command must be a JSON object")
    command = raw.get("command")
    repository_root = raw.get("repositoryRoot")
    if not isinstance(repository_root, str) or not repository_root:
        raise ValueError("repositoryRoot is required")
    cache_path = raw.get("cachePath")
    if cache_path is not None and not isinstance(cache_path, str):
        raise ValueError("cachePath must be a string")
    engine = AnalysisEngine(repository_root, cache_path)
    investigation_engine = InvestigationEngine(repository_root, cache_path)
    if command == "prepare":
        commit = raw.get("commit")
        if not isinstance(commit, str):
            raise ValueError("commit is required")
        return {"ok": True, "result": engine.prepare(commit)}
    if command == "analyze":
        criterion_raw = raw.get("criterion")
        if not isinstance(criterion_raw, dict):
            raise ValueError("criterion is required")
        watch_path = criterion_raw.get("watchPath")
        expression = criterion_raw.get("expression")
        if watch_path is not None and not isinstance(watch_path, str):
            raise ValueError("criterion.watchPath must be a string")
        if expression is not None and not isinstance(expression, str):
            raise ValueError("criterion.expression must be a string")
        if watch_path is not None and expression is not None:
            raise ValueError("provide watchPath or expression, not both")
        criterion = AnalysisCriterion(
            repository_root=repository_root,
            commit=str(criterion_raw["commit"]),
            service_id=str(criterion_raw["serviceId"]),
            file=str(criterion_raw["file"]),
            line=int(criterion_raw["line"]),
            watch_path=watch_path,
            expression=expression,
            probe_budget=int(criterion_raw.get("probeBudget", 5)),
            source_roots=tuple(
                str(value) for value in criterion_raw.get("sourceRoots", [])
            ),
            ownership_map=tuple(
                (
                    str(value["sourceRoot"]),
                    str(value["serviceId"]),
                )
                for value in criterion_raw.get("ownershipMap", [])
            ),
        )
        return {"ok": True, "result": engine.analyze(criterion).to_dict()}
    if command == "get":
        plan_id = raw.get("planId")
        if not isinstance(plan_id, str):
            raise ValueError("planId is required")
        return {"ok": True, "result": engine.get_plan(plan_id).to_dict()}
    if command == "refine":
        plan_id = raw.get("planId")
        if not isinstance(plan_id, str):
            raise ValueError("planId is required")
        assessments_raw = raw.get("assessments", [])
        if not isinstance(assessments_raw, list):
            raise ValueError("assessments must be an array")
        assessments = [
            CandidateAssessment(
                candidate_id=str(value["candidateId"]),
                classification=value["classification"],
                occurrence_id=value.get("occurrenceId"),
                reason=value.get("reason"),
            )
            for value in assessments_raw
        ]
        return {
            "ok": True,
            "result": engine.refine(plan_id, assessments).to_dict(),
        }
    if command == "start_investigation":
        criterion_raw = raw.get("criterion")
        if not isinstance(criterion_raw, dict):
            raise ValueError("criterion is required")
        watch_path = criterion_raw.get("watchPath")
        expression = criterion_raw.get("expression")
        if watch_path is not None and not isinstance(watch_path, str):
            raise ValueError("criterion.watchPath must be a string")
        if expression is not None and not isinstance(expression, str):
            raise ValueError("criterion.expression must be a string")
        if watch_path is not None and expression is not None:
            raise ValueError("provide watchPath or expression, not both")
        criterion = InvestigationCriterion(
            repository_root=repository_root,
            commit=str(criterion_raw["commit"]),
            service_id=str(criterion_raw["serviceId"]),
            file=str(criterion_raw["file"]),
            line=int(criterion_raw["line"]),
            symptom=str(criterion_raw["symptom"]),
            watch_path=watch_path,
            expression=expression,
            failure_class=criterion_raw.get("failureClass", "semantic"),
            expected_type=criterion_raw.get("expectedType"),
            minimum=(
                None
                if criterion_raw.get("minimum") is None
                else float(criterion_raw["minimum"])
            ),
            maximum=(
                None
                if criterion_raw.get("maximum") is None
                else float(criterion_raw["maximum"])
            ),
            minimum_exclusive=bool(
                criterion_raw.get("minimumExclusive", False)
            ),
            maximum_exclusive=bool(
                criterion_raw.get("maximumExclusive", False)
            ),
            probe_budget=int(criterion_raw.get("probeBudget", 5)),
            source_roots=tuple(
                str(value) for value in criterion_raw.get("sourceRoots", [])
            ),
            ownership_map=tuple(
                (
                    str(value["sourceRoot"]),
                    str(value["serviceId"]),
                )
                for value in criterion_raw.get("ownershipMap", [])
            ),
        )
        return {"ok": True, "result": investigation_engine.start(criterion)}
    if command == "get_investigation":
        investigation_id = raw.get("investigationId")
        if not isinstance(investigation_id, str):
            raise ValueError("investigationId is required")
        return {
            "ok": True,
            "result": investigation_engine.get(
                investigation_id,
                since_revision=(
                    None
                    if raw.get("sinceRevision") is None
                    else int(raw["sinceRevision"])
                ),
                focus_traversal_id=raw.get("focusTraversalId"),
            ),
        }
    if command == "record_evidence":
        investigation_id = raw.get("investigationId")
        if not isinstance(investigation_id, str):
            raise ValueError("investigationId is required")
        observations_raw = raw.get("observations", [])
        if not isinstance(observations_raw, list):
            raise ValueError("observations must be an array")
        observations = [
            ValueObservation(
                observation_id=str(value["observationId"]),
                site_id=str(value["siteId"]),
                occurrence_id=str(value["occurrenceId"]),
                hit_index=int(value.get("hitIndex", 1)),
                values=dict(value.get("values", {})),
                sequence_index=(
                    None
                    if value.get("sequenceIndex") is None
                    else int(value["sequenceIndex"])
                ),
                timestamp=value.get("timestamp"),
                service_instance=value.get("serviceInstance"),
                capture_status=value.get("captureStatus", "complete"),
            )
            for value in observations_raw
        ]
        return {
            "ok": True,
            "result": investigation_engine.record_evidence(
                investigation_id, observations
            ),
        }
    if command == "decide_investigation":
        investigation_id = raw.get("investigationId")
        if not isinstance(investigation_id, str):
            raise ValueError("investigationId is required")
        decision_raw = raw.get("decision")
        if not isinstance(decision_raw, dict):
            raise ValueError("decision is required")
        candidate_raw = decision_raw.get("candidateMechanism")
        candidate = None
        if candidate_raw is not None:
            if not isinstance(candidate_raw, dict):
                raise ValueError(
                    "decision.candidateMechanism must be an object"
                )
            candidate = CandidateMechanism(
                statement=str(candidate_raw["statement"]),
                anchor_node_ids=tuple(
                    str(value)
                    for value in candidate_raw.get("anchorNodeIds", ())
                ),
                traversal_id=str(candidate_raw["traversalId"]),
                predictions=tuple(
                    CandidatePrediction(
                        probe_candidate_id=str(
                            prediction["probeCandidateId"]
                        ),
                        watch_path=str(prediction["watchPath"]),
                        operator=prediction["operator"],
                        expected_value=prediction.get("expectedValue"),
                    )
                    for prediction in candidate_raw.get("predictions", ())
                ),
            )
        decision = InvestigationDecision(
            action_ids=tuple(
                str(value)
                for value in decision_raw.get("actionIds", [])
            ),
            based_on_revision=(
                None
                if decision_raw.get("basedOnRevision") is None
                else int(decision_raw["basedOnRevision"])
            ),
            exploration_question=decision_raw.get("explorationQuestion"),
            candidate_mechanism=candidate,
            evidence_refs=tuple(
                str(value)
                for value in decision_raw.get("evidenceRefs", [])
            ),
        )
        return {
            "ok": True,
            "result": investigation_engine.decide(
                investigation_id, decision
            ),
        }
    if command == "get_investigation_result":
        investigation_id = raw.get("investigationId")
        if not isinstance(investigation_id, str):
            raise ValueError("investigationId is required")
        return {
            "ok": True,
            "result": investigation_engine.result(investigation_id),
        }
    raise ValueError(f"unsupported command {command!r}")


def main() -> None:
    raw_text = sys.stdin.read()
    try:
        raw = json.loads(raw_text)
        response = execute(raw)
    except Exception as error:
        response = {
            "ok": False,
            "error": {
                "type": type(error).__name__,
                "message": str(error),
            },
        }
        if "--debug" in sys.argv:
            response["error"]["traceback"] = traceback.format_exc()
    sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
    if not response["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
