"""Golden precision/performance benchmark for the RideRush fault application."""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from liveprobe_analysis import AnalysisCriterion, AnalysisEngine
from liveprobe_analysis.cache import AnalysisCache
from liveprobe_analysis.engine import ProjectGraph


@dataclass(frozen=True)
class Case:
    name: str
    service: str
    file: str
    line: int
    watch_path: str
    expected_file: str
    expected_line: int
    expected_probe_line: int
    expected_edge: str
    max_slice_nodes: int


CASES = (
    Case(
        name="fare_corrupt_durable_hop",
        service="payments",
        file="services/payments/app.py",
        line=64,
        watch_path="fare_inputs.per_mile_rate",
        expected_file="services/pricing/app.py",
        expected_line=97,
        expected_probe_line=97,
        expected_edge="DURABLE_BOUNDARY",
        max_slice_nodes=80,
    ),
    Case(
        name="gateway_quote_http_hop",
        service="gateway",
        file="services/gateway/app.py",
        line=83,
        watch_path="pricing.quote",
        expected_file="services/pricing/app.py",
        expected_line=76,
        expected_probe_line=76,
        expected_edge="HTTP_BOUNDARY",
        max_slice_nodes=100,
    ),
    Case(
        name="module_memory_may",
        service="location",
        file="services/location/app.py",
        line=28,
        watch_path="_leak_chunks",
        expected_file="services/location/app.py",
        expected_line=45,
        expected_probe_line=46,
        expected_edge="MEMORY_MAY",
        max_slice_nodes=60,
    ),
    Case(
        name="surge_controlled_value",
        service="pricing",
        file="services/pricing/app.py",
        line=77,
        watch_path="quote",
        expected_file="services/pricing/app.py",
        expected_line=74,
        expected_probe_line=75,
        expected_edge="DATA",
        max_slice_nodes=40,
    ),
)


def main() -> None:
    parser = argparse.ArgumentParser()
    default_repo = (
        Path(__file__).resolve().parents[3].parent
        / "ride_sharing_probe_demo"
    )
    parser.add_argument("--repository", type=Path, default=default_repo)
    parser.add_argument("--commit")
    args = parser.parse_args()
    root = args.repository.resolve()
    if not (root / ".git").exists():
        raise SystemExit(f"RideRush checkout not found: {root}")

    import subprocess

    commit = args.commit or subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    with tempfile.TemporaryDirectory(prefix="liveprobe-ride-bench-") as temp:
        cache_path = str(Path(temp) / "analysis.sqlite3")
        engine = AnalysisEngine(str(root), cache_path)
        cold = engine.prepare(commit)
        warm = engine.prepare(commit)
        if float(cold["elapsedMs"]) > 5_000:
            raise AssertionError(f"cold indexing exceeded 5s: {cold}")
        if float(warm["elapsedMs"]) > 1_000:
            raise AssertionError(f"warm indexing exceeded 1s: {warm}")
        if int(cold["cacheBytes"]) > 50 * 1024 * 1024:
            raise AssertionError(f"analysis cache exceeded 50MiB: {cold}")

        with AnalysisCache(root, Path(cache_path)) as cache:
            graph = ProjectGraph(cache.load_fragments(commit))

        results: list[dict[str, object]] = []
        for case in CASES:
            started = time.perf_counter()
            plan = engine.analyze(
                AnalysisCriterion(
                    repository_root=str(root),
                    commit=commit,
                    service_id=case.service,
                    file=case.file,
                    line=case.line,
                    watch_path=case.watch_path,
                )
            )
            elapsed_ms = (time.perf_counter() - started) * 1_000
            locations = {
                (graph.nodes[node_id].file, graph.nodes[node_id].line)
                for node_id in plan.slice_node_ids
            }
            edge_kinds = {edge.kind for edge in plan.slice_edges}
            if (case.expected_file, case.expected_line) not in locations:
                raise AssertionError(
                    f"{case.name}: missing expected origin "
                    f"{case.expected_file}:{case.expected_line}; "
                    f"frontier={plan.frontier}"
                )
            if case.expected_edge not in edge_kinds:
                raise AssertionError(
                    f"{case.name}: missing {case.expected_edge}; "
                    f"got {sorted(edge_kinds)}"
                )
            frontier_locations = {
                (candidate.file, candidate.line)
                for candidate in plan.frontier
            }
            if (
                case.expected_file,
                case.expected_probe_line,
            ) not in frontier_locations:
                raise AssertionError(
                    f"{case.name}: expected probe frontier to include "
                    f"{case.expected_file}:{case.expected_probe_line}; "
                    f"got {sorted(frontier_locations)}"
                )
            if len(plan.slice_node_ids) > case.max_slice_nodes:
                raise AssertionError(
                    f"{case.name}: slice grew to {len(plan.slice_node_ids)} "
                    f"(limit {case.max_slice_nodes})"
                )
            if elapsed_ms > 1_000:
                raise AssertionError(
                    f"{case.name}: query exceeded 1s ({elapsed_ms:.1f}ms)"
                )
            results.append(
                {
                    "case": case.name,
                    "elapsedMs": round(elapsed_ms, 3),
                    "sliceNodes": len(plan.slice_node_ids),
                    "sliceEdges": len(plan.slice_edges),
                    "hammocks": len(plan.hammocks),
                    "frontier": [
                        {
                            "file": candidate.file,
                            "line": candidate.line,
                            "certainty": candidate.certainty,
                        }
                        for candidate in plan.frontier
                    ],
                }
            )

        print(
            json.dumps(
                {
                    "repository": str(root),
                    "commit": commit,
                    "cold": cold,
                    "warm": warm,
                    "cases": results,
                },
                indent=2,
            )
        )


if __name__ == "__main__":
    main()
