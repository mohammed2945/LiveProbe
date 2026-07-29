#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from fair_praxis_adapter import (
    CodexCLIBackend,
    ContractBackend,
    SnapshotAlertsTool,
    SnapshotDataGatherer,
    SnapshotGraphTraversal,
    SnapshotHealthTool,
    SnapshotJaeger,
    SnapshotLeafRCA,
    SnapshotServiceInteraction,
    SnapshotTraceErrorTree,
    install_snapshot_adapters,
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-root", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ledger", required=True)
    parser.add_argument("--model", default="gpt-5.4-mini")
    parser.add_argument("--seed", type=int, default=10)
    parser.add_argument("--token-budget", type=int, default=250000)
    parser.add_argument("--model-timeout-seconds", type=int, default=180)
    parser.add_argument(
        "--contract-backend",
        action="store_true",
        help="run the released PRAXIS loop with deterministic zero-model replies",
    )
    return parser.parse_args()


def _identity(value):
    normalized = str(value or "").strip().lower().replace("_", "-")
    for suffix in ("-service-1", "-service", "-pod-1", "-pod"):
        if normalized.endswith(suffix):
            normalized = normalized[: -len(suffix)]
    return normalized


def _trace_evidence(snapshot, cause, effect):
    cause_id = _identity(cause)
    effect_id = _identity(effect)
    evidence = []
    for trace in snapshot.data.get("traces", []):
        spans = trace.get("spans", [])
        by_id = {
            str(span.get("span_id")): span
            for span in spans
            if span.get("span_id")
        }
        supports = False
        for span in spans:
            parent = by_id.get(str(span.get("parent_span_id")))
            if parent is None:
                continue
            if (
                _identity(span.get("service")) == cause_id
                and _identity(parent.get("service")) == effect_id
            ):
                supports = True
                break
        if supports and trace.get("evidence_id"):
            evidence.append(str(trace["evidence_id"]))
    for summary in snapshot.data.get("bootstrap", {}).get(
        "failing_trace_summaries", []
    ):
        path = [_identity(value) for value in summary.get("error_path", [])]
        if any(
            path[index] == effect_id and path[index + 1] == cause_id
            for index in range(max(0, len(path) - 1))
        ) and summary.get("evidence_id"):
            evidence.append(str(summary["evidence_id"]))
    return list(dict.fromkeys(evidence))


def _propagation_from_graph(root, graph, snapshot):
    edges = []
    current = root
    visited = set()
    while current and str(current.get("id")) not in visited:
        visited.add(str(current.get("id")))
        parent = graph.get(current.get("parent_id"))
        if parent is None:
            break
        cause = str(current.get("name") or current.get("id"))
        effect = str(parent.get("name") or parent.get("id"))
        edges.append(
            {
                "from": cause,
                "to": effect,
                "evidence_ids": _trace_evidence(
                    snapshot, cause, effect
                ),
                "explanation": "PRAXIS exploration-graph lineage",
            }
        )
        current = parent
    if edges:
        return edges

    root_name = _identity(root.get("name") or root.get("id"))
    for summary in snapshot.data.get("bootstrap", {}).get(
        "failing_trace_summaries", []
    ):
        path = [str(value) for value in summary.get("error_path", [])]
        normalized = [_identity(value) for value in path]
        if root_name not in normalized:
            continue
        root_index = normalized.index(root_name)
        for index in range(root_index, 0, -1):
            cause = path[index]
            effect = path[index - 1]
            evidence_ids = _trace_evidence(snapshot, cause, effect)
            if not evidence_ids and summary.get("evidence_id"):
                evidence_ids = [str(summary["evidence_id"])]
            edges.append(
                {
                    "from": cause,
                    "to": effect,
                    "evidence_ids": evidence_ids,
                    "explanation": (
                        "causal direction inferred from the failing trace path"
                    ),
                }
            )
        break
    return edges


def normalize_result(result, snapshot):
    graph = result.get("exploration_graph", {})
    roots = [
        entity for entity in graph.values() if entity.get("is_root_cause") is True
    ]
    roots.sort(
        key=lambda item: (
            str(item.get("reason_root_cause", "")).startswith("[FORCED]"),
            -int(item.get("depth", 0) or 0),
            str(item.get("name", item.get("id", ""))),
        )
    )
    if not roots:
        return {
            "status": "INSUFFICIENT",
            "root_cause": {
                "entity": "unknown",
                "kind": "Unknown",
            },
            "mechanism": (
                str(result.get("final_report", "")).strip()
                or "PRAXIS did not identify a root-cause mechanism."
            ),
            "propagation": [],
            "remediation": (
                str(result.get("final_report", "")).strip()
                or "No remediation was produced."
            ),
            "confidence": 0.0,
        }
    root = roots[0]
    root_name = str(root.get("name") or root.get("id") or "unknown")
    root_kind = str(root.get("type") or "Unknown")
    reason = str(root.get("reason_root_cause", "")).strip()
    final_report = str(result.get("final_report", "")).strip()
    return {
        "status": "LOCALIZED",
        "root_cause": {
            "entity": root_name,
            "kind": root_kind,
            "service": root_name if root_kind.lower() == "service" else None,
            "namespace": root.get("namespace"),
        },
        "mechanism": reason or final_report or "PRAXIS selected this entity.",
        "propagation": _propagation_from_graph(root, graph, snapshot),
        "remediation": final_report or "No explicit remediation was produced.",
        # PRAXIS does not expose a calibrated numeric confidence. This fixed
        # adapter value avoids inventing model certainty while satisfying the
        # common result schema; confidence is not part of the accuracy score.
        "confidence": 0.5 if result.get("rca_concluded", False) else 0.25,
    }


def main():
    args = parse_args()
    artifact = Path(args.artifact_root).resolve()
    source = artifact / "praxis-ae" / "src"
    if not source.exists():
        raise SystemExit(f"PRAXIS source not found under {artifact}")
    internal_output = (
        Path(args.output).resolve().parent
        / f"praxis-internal-{args.seed}"
    )
    internal_output.mkdir(parents=True, exist_ok=True)
    os.environ["STRUCTURED_UNSTRUCTURED_OUTPUT_DIRECTORY_PATH"] = str(
        internal_output
    )
    os.environ["TAP_AGENT_TIMESTAMP"] = (
        f"{os.environ.get('EVAL_INCIDENT_ID', 'unknown')}-{args.seed}"
    )
    sys.path.insert(0, str(source))
    snapshot = install_snapshot_adapters(args.snapshot, args.ledger)
    # The released backend module reads API_KEY at import time even though this
    # fair adapter replaces that backend before RCA starts. Use an explicit
    # inert value so Codex CLI authentication remains the only model
    # credential used by this arm.
    os.environ["API_KEY"] = "fair-adapter-no-provider-call"
    os.environ["MODEL"] = args.model
    os.environ["SEED"] = str(args.seed)
    os.environ["INCIDENT_NUMBER"] = str(snapshot.data["incident_id"])

    import praxis.agent.rca_langgraph_v2 as rca
    import praxis.configs.code_context_config as code_context_config
    import praxis.tools.trace_gatherer.jaeger.clickhouse as jaeger

    # The release checks /tmp/current_incident.env before INCIDENT_NUMBER.
    # Point that optional selector at an absent run-local path so stale state
    # from another benchmark attempt cannot select the wrong program graph.
    code_context_config.AGENT_BENCHMARK_INC_ENV = str(
        internal_output / "no-current-incident.env"
    )
    rca.Neo4jGraphTraversal = SnapshotGraphTraversal
    rca.PrometheusAlertsTool = SnapshotAlertsTool
    rca.SpanCausalRCA = SnapshotHealthTool
    rca.TraceCausalRCA = SnapshotHealthTool
    rca.LeafRCA = SnapshotLeafRCA
    rca.TraceErrorTreeTool = SnapshotTraceErrorTree
    rca.ServiceInteractionErrorTool = SnapshotServiceInteraction
    rca.DataGatherer = SnapshotDataGatherer
    jaeger.JaegerAggsCustomTool = SnapshotJaeger
    backend = (
        ContractBackend()
        if args.contract_backend
        else CodexCLIBackend(
            model=args.model,
            seed=args.seed,
            ledger_path=args.ledger,
            token_budget=args.token_budget,
            timeout_seconds=args.model_timeout_seconds,
        )
    )
    rca.get_llm_backend_for_tools = lambda: backend

    os.environ["PRAXIS_MAX_LOG_LINES"] = "40"
    os.environ["EVAL_INCIDENT_ID"] = snapshot.data["incident_id"]
    os.environ["EVAL_MODEL"] = args.model
    agent = rca.RCAAgentV2(
        namespace="otel-demo",
        neo4j_uri="snapshot://immutable",
        neo4j_user="snapshot",
        neo4j_password="snapshot",
    )
    raw = agent.run_rca()
    output = {
        "schema_version": "liveprobe-praxis-fair-raw/v1",
        "incident_id": snapshot.data["incident_id"],
        "model": args.model,
        "seed": args.seed,
        "contract_backend": args.contract_backend,
        "benchmark_result": not args.contract_backend,
        "deterministic_inference_steps": (
            backend.call_index if args.contract_backend else None
        ),
        "normalized": normalize_result(raw, snapshot),
        "normalization": {
            "adapter": "praxis-exploration-graph/v1",
            "explored_entity_count": len(raw.get("exploration_graph", {})),
            "rca_concluded": bool(raw.get("rca_concluded", False)),
        },
        "raw": raw,
    }
    Path(args.output).write_text(json.dumps(output, indent=2, default=str) + "\n")


if __name__ == "__main__":
    main()
