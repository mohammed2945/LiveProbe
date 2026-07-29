#!/usr/bin/env python3
"""Run the zero-token LiveProbe gate against every PRAXIS source variant.

This gate deliberately checks only capabilities that can be established on the
evaluation host without deploying the benchmark: exact source identity, Python
parsing, analyzer indexing, boundary classification, graph construction, and
legal probe/action generation. Runtime correlation is a separate remote gate.
"""

from __future__ import annotations

import argparse
import ast
import json
import subprocess
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
EVALUATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(
    0, str(REPOSITORY_ROOT / "python" / "analyzer" / "src")
)

from liveprobe_analysis.cache import AnalysisCache  # noqa: E402
from liveprobe_analysis.investigation import InvestigationEngine  # noqa: E402
from liveprobe_analysis.model import (  # noqa: E402
    InvestigationCriterion,
    ValueObservation,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source-root",
        type=Path,
        default=REPOSITORY_ROOT / ".eval-cache" / "praxis-sources",
        help="directory containing one reproducible Git checkout per incident",
    )
    parser.add_argument(
        "--contract",
        type=Path,
        default=EVALUATION_ROOT / "liveprobe-compatibility.json",
    )
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def git(root: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", *arguments],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def criterion_line(
    source: str, function_name: str, return_name: str
) -> int:
    tree = ast.parse(source)
    functions = [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == function_name
    ]
    if len(functions) != 1:
        raise AssertionError(
            f"expected one {function_name} function, found {len(functions)}"
        )
    returns = [
        node
        for node in ast.walk(functions[0])
        if isinstance(node, ast.Return)
        and isinstance(node.value, ast.Name)
        and node.value.id == return_name
    ]
    if len(returns) != 1:
        raise AssertionError(
            f"expected one 'return {return_name}', found {len(returns)}"
        )
    return int(returns[0].lineno)


def boundary_signature(call: Any) -> str:
    return f"{call.boundary_kind}:{call.boundary_detail or ''}"


def is_response_get(target: str) -> bool:
    receiver, separator, method = target.rpartition(".")
    return (
        bool(separator)
        and method == "get"
        and receiver.rsplit(".", 1)[-1].endswith("response")
    )


def encoded_value(watch_path: str) -> dict[str, Any]:
    if watch_path.endswith(
        ("ids", "products", "product_ids", "prod_list", "filtered_products")
    ):
        return {"t": "seq", "v": []}
    return {"t": "str", "v": "compatibility-check"}


def assert_legal_bundle(
    state: dict[str, Any],
    view: dict[str, Any],
) -> tuple[int, int, list[str]]:
    bundle = view.get("probe_bundle")
    if not isinstance(bundle, dict) or not bundle.get("sites"):
        raise AssertionError("investigation produced no initial probe sites")
    for site in bundle["sites"]:
        site_id = str(site["site_id"])
        node_id = str(site["node_id"])
        if site_id not in state["sites"]:
            raise AssertionError(f"probe site {site_id} is not registered")
        node = state["graph_nodes"].get(node_id)
        if node is None:
            raise AssertionError(
                f"probe site {site_id} does not reference a canonical node"
            )
        if (
            node.get("file") != site["file"]
            or node.get("probe_line") != site["line"]
        ):
            raise AssertionError(
                f"probe site {site_id} is not on its canonical probe line"
            )
        if not site.get("watch_paths"):
            raise AssertionError(f"probe site {site_id} has no watch paths")
    return (
        len(bundle["sites"]),
        len(state["graph_nodes"]),
        list(state.get("coverage_notes", ())),
    )


def record_mechanical_occurrence(
    engine: InvestigationEngine,
    view: dict[str, Any],
    incident_id: str,
) -> dict[str, Any]:
    bundle = view["probe_bundle"]
    observations = []
    for index, site in enumerate(bundle["sites"], start=1):
        observations.append(
            ValueObservation(
                observation_id=f"compat-{incident_id}-{index}",
                site_id=str(site["site_id"]),
                occurrence_id=f"trace:compat-{incident_id}",
                hit_index=1,
                values={
                    str(path): encoded_value(str(path))
                    for path in site["watch_paths"]
                },
                sequence_index=index,
                service_instance="static-compatibility-gate",
            )
        )
    return engine.record_evidence(
        str(view["investigation_id"]), observations
    )


def inspect_incident(
    incident_id: str,
    expected: dict[str, Any],
    contract: dict[str, Any],
    source_base: Path,
    cache_base: Path,
) -> dict[str, Any]:
    root = (source_base / incident_id).resolve()
    metadata_path = root / "source-metadata.json"
    source_path = root / str(contract["source_file"])
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    source = source_path.read_text(encoding="utf-8")
    compile(source, str(source_path), "exec")

    if metadata.get("incident_id") != incident_id:
        raise AssertionError("source metadata incident does not match")
    repository_toplevel = Path(
        git(root, "rev-parse", "--show-toplevel")
    ).resolve()
    if repository_toplevel != root:
        raise AssertionError(
            f"source inherited Git root {repository_toplevel}, expected {root}"
        )
    commit = git(root, "rev-parse", "HEAD")
    if commit != metadata.get("git_commit"):
        raise AssertionError("source metadata commit does not match Git HEAD")
    if (
        git(
            root,
            "status",
            "--porcelain",
            "--",
            str(contract["source_file"]),
        )
        != ""
    ):
        raise AssertionError("tracked incident source is not clean")

    cache_path = cache_base / f"{incident_id}.sqlite3"
    with AnalysisCache(root, cache_path) as cache:
        prepare = cache.prepare(commit)
        fragments = cache.load_fragments(commit)
        summaries = cache.load_summaries(commit)

    calls = [call for fragment in fragments for call in fragment.calls]
    routes = [route for fragment in fragments for route in fragment.routes]
    signatures = [boundary_signature(call) for call in calls]
    for required in expected["required_boundaries"]:
        if not any(signature.startswith(required) for signature in signatures):
            raise AssertionError(
                f"missing required boundary {required}; saw "
                f"{sorted(set(signatures))}"
            )
    false_http = [
        call.target
        for call in calls
        if call.boundary_kind == "http"
        and (
            call.target == "os.environ.get"
            or is_response_get(call.target)
        )
    ]
    if false_http:
        raise AssertionError(
            f"local mapping/environment reads classified as HTTP: {false_http}"
        )
    if not any(
        route.method == "RPC" and route.path == "ListRecommendations"
        for route in routes
    ):
        raise AssertionError("gRPC server route ListRecommendations not found")

    criterion = contract["criterion"]
    line = criterion_line(
        source,
        str(criterion["function"]),
        str(criterion["return_name"]),
    )
    engine = InvestigationEngine(str(root), str(cache_path))
    view = engine.start(
        InvestigationCriterion(
            repository_root=str(root),
            commit=commit,
            service_id=str(criterion["service_id"]),
            file=str(contract["source_file"]),
            line=line,
            symptom="PRAXIS compatibility criterion",
            watch_path=str(criterion["watch_path"]),
            failure_class=str(criterion["failure_class"]),
            expected_type=str(criterion["expected_type"]),
            probe_budget=int(criterion["probe_budget"]),
        )
    )
    with AnalysisCache(root, cache_path) as cache:
        initial_state = cache.load_investigation(
            str(view["investigation_id"])
        )
    probe_sites, graph_nodes, coverage_notes = assert_legal_bundle(
        initial_state, view
    )

    evidence_view = record_mechanical_occurrence(
        engine, view, incident_id
    )
    with AnalysisCache(root, cache_path) as cache:
        evidence_state = cache.load_investigation(
            str(view["investigation_id"])
        )
    active_ids = set(evidence_state.get("active_action_ids", ()))
    for action in evidence_view.get("actions", ()):
        action_id = str(action["action_id"])
        branch = evidence_state["branches"].get(action_id)
        if (
            branch is None
            or branch.get("status") != "AVAILABLE"
            or action_id not in active_ids
        ):
            raise AssertionError(
                f"public action {action_id} is not an active legal action"
            )

    kinds = Counter(call.boundary_kind for call in calls)
    detail_counts = Counter(
        call.boundary_detail
        for call in calls
        if call.boundary_kind != "local"
    )
    return {
        "incident_id": incident_id,
        "source_variant": metadata.get("source_variant"),
        "git_commit": commit,
        "source_lines": len(source.splitlines()),
        "prepare": prepare,
        "functions": len(summaries),
        "calls": len(calls),
        "boundary_kinds": dict(sorted(kinds.items())),
        "boundary_details": {
            str(key): value
            for key, value in sorted(
                detail_counts.items(), key=lambda item: str(item[0])
            )
        },
        "routes": sorted(
            {f"{route.method} {route.path}" for route in routes}
        ),
        "criterion": {
            "file": contract["source_file"],
            "line": line,
            "watch_path": criterion["watch_path"],
        },
        "graph_nodes": graph_nodes,
        "probe_sites": probe_sites,
        "actions_after_typed_occurrence": len(
            evidence_view.get("actions", ())
        ),
        "deferred_actions_preserved": int(
            evidence_view.get("decision_context", {})
            .get("deferred", {})
            .get("count", 0)
        ),
        "coverage_notes": sorted(set(coverage_notes)),
    }


def main() -> None:
    args = parse_args()
    started = time.perf_counter()
    contract = json.loads(args.contract.read_text(encoding="utf-8"))
    if contract.get("schema_version") != (
        "liveprobe-praxis-compatibility/v1"
    ):
        raise SystemExit("unsupported compatibility contract")
    source_root = args.source_root.resolve()
    results = []
    failures = []
    with tempfile.TemporaryDirectory(
        prefix="liveprobe-praxis-compat-"
    ) as temporary:
        cache_base = Path(temporary)
        for incident_id, expected in contract["incidents"].items():
            try:
                results.append(
                    inspect_incident(
                        str(incident_id),
                        expected,
                        contract,
                        source_root,
                        cache_base,
                    )
                )
            except Exception as error:
                failures.append(
                    {
                        "incident_id": str(incident_id),
                        "error": f"{type(error).__name__}: {error}",
                    }
                )
    report = {
        "schema_version": "liveprobe-praxis-compatibility-report/v1",
        "generated_at": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
        ),
        "gate": "static_zero_token",
        "benchmark_result": False,
        "source_root": str(source_root),
        "contract": str(args.contract.resolve()),
        "duration_ms": round((time.perf_counter() - started) * 1000, 3),
        "passed": len(failures) == 0,
        "incidents_checked": len(results),
        "failures": failures,
        "incidents": results,
        "limitations": [
            "No PRAXIS cluster was deployed by this gate.",
            "Runtime probe deployment, replay, and trace correlation require the remote runtime gate.",
            "Unknown third-party clients are surfaced conservatively; static classification is not claimed to be exhaustive.",
        ],
    }
    encoded = json.dumps(report, indent=2) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    sys.stdout.write(encoded)
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
