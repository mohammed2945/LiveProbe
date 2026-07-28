#!/usr/bin/env python3
"""Compare three LiveProbe probe-selection policies on identical RideRush slices."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from liveprobe_analysis import AnalysisCriterion, AnalysisEngine
from liveprobe_analysis.evaluation import (
    CodexDecisionModel,
    ModelUsage,
    deterministic_policy,
    per_may_hammock_policy,
    praxis_hammock_policy,
    single_frontier_policy,
)


@dataclass(frozen=True, slots=True)
class Case:
    name: str
    incident: str
    service: str
    file: str
    line: int
    watch_path: str
    expected_file: str
    expected_probe_line: int


CASES = (
    Case(
        name="fare_corrupt_durable_hop",
        incident=(
            "Payments fails while multiplying fare inputs after pricing silently "
            "accepted a malformed durable configuration value."
        ),
        service="payments",
        file="services/payments/app.py",
        line=64,
        watch_path="fare_inputs.per_mile_rate",
        expected_file="services/pricing/app.py",
        expected_probe_line=97,
    ),
    Case(
        name="gateway_quote_http_hop",
        incident=(
            "Gateway returns a wrong quote. Trace routing identifies the quote "
            "response as the offending value crossing the pricing HTTP boundary."
        ),
        service="gateway",
        file="services/gateway/app.py",
        line=83,
        watch_path="pricing.quote",
        expected_file="services/pricing/app.py",
        expected_probe_line=76,
    ),
    Case(
        name="module_memory_may",
        incident=(
            "Location latency grows with a module-level collection. Aliasing and "
            "shared mutation are conservative MAY flow."
        ),
        service="location",
        file="services/location/app.py",
        line=28,
        watch_path="_leak_chunks",
        expected_file="services/location/app.py",
        expected_probe_line=46,
    ),
    Case(
        name="surge_controlled_value",
        incident=(
            "Pricing emits an implausible quote only when the surge fault branch "
            "is active; the quote value is control-dependent."
        ),
        service="pricing",
        file="services/pricing/app.py",
        line=77,
        watch_path="quote",
        expected_file="services/pricing/app.py",
        expected_probe_line=75,
    ),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    default_repo = (
        Path(__file__).resolve().parents[3].parent / "ride_sharing_probe_demo"
    )
    parser.add_argument("--repository", type=Path, default=default_repo)
    parser.add_argument("--commit")
    parser.add_argument("--model")
    parser.add_argument("--probe-budget", type=int, default=5)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--deterministic-only",
        action="store_true",
        help="Validate the dataset without making model calls.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = args.repository.resolve()
    commit = args.commit or subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    output = args.output or (
        Path(__file__).resolve().parents[3]
        / "demo/ride-analysis/results/latest-tracks.json"
    )
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="liveprobe-tracks-") as temp:
        engine = AnalysisEngine(str(root), str(Path(temp) / "analysis.sqlite3"))
        prepared = engine.prepare(commit)
        model = CodexDecisionModel(
            root, model=args.model, timeout_seconds=args.timeout
        )
        cases: list[dict[str, object]] = []
        totals: dict[str, dict[str, int]] = {}
        for case in CASES:
            plan = engine.analyze(
                AnalysisCriterion(
                    repository_root=str(root),
                    commit=commit,
                    service_id=case.service,
                    file=case.file,
                    line=case.line,
                    watch_path=case.watch_path,
                    probe_budget=args.probe_budget,
                )
            )
            policies = [deterministic_policy(plan)]
            if not args.deterministic_only:
                policies.extend(
                    [
                        per_may_hammock_policy(
                            plan, model, incident=case.incident
                        ),
                        single_frontier_policy(
                            plan,
                            model,
                            incident=case.incident,
                            probe_budget=args.probe_budget,
                        ),
                        praxis_hammock_policy(
                            plan,
                            model,
                            incident=case.incident,
                        ),
                    ]
                )
            candidate_by_id = {
                candidate.candidate_id: candidate
                for candidate in plan.frontier
            }
            expected_ids = {
                candidate.candidate_id
                for candidate in plan.frontier
                if candidate.file == case.expected_file
                and candidate.line == case.expected_probe_line
            }
            if not expected_ids:
                raise AssertionError(
                    f"{case.name}: deterministic frontier lacks expected probe"
                )
            policy_rows = []
            for policy in policies:
                hit = bool(expected_ids & set(policy.selected_candidate_ids))
                aggregate = totals.setdefault(
                    policy.policy,
                    {
                        "cases": 0,
                        "expectedOriginHits": 0,
                        "selectedProbes": 0,
                        "modelCalls": 0,
                        "inputTokens": 0,
                        "cachedInputTokens": 0,
                        "outputTokens": 0,
                        "reasoningTokens": 0,
                        "modelElapsedMs": 0,
                    },
                )
                aggregate["cases"] += 1
                aggregate["expectedOriginHits"] += int(hit)
                aggregate["selectedProbes"] += len(policy.selected_candidate_ids)
                aggregate["modelCalls"] += policy.usage.calls
                aggregate["inputTokens"] += policy.usage.input_tokens
                aggregate["cachedInputTokens"] += (
                    policy.usage.cached_input_tokens
                )
                aggregate["outputTokens"] += policy.usage.output_tokens
                aggregate["reasoningTokens"] += policy.usage.reasoning_tokens
                aggregate["modelElapsedMs"] += policy.usage.elapsed_ms
                policy_rows.append(
                    {
                        **policy.to_dict(),
                        "expectedOriginSelected": hit,
                        "selected": [
                            {
                                "candidateId": identifier,
                                "file": candidate_by_id[identifier].file,
                                "line": candidate_by_id[identifier].line,
                                "certainty": candidate_by_id[
                                    identifier
                                ].certainty,
                            }
                            for identifier in policy.selected_candidate_ids
                        ],
                    }
                )
            cases.append(
                {
                    "case": asdict(case),
                    "sliceNodes": len(plan.slice_node_ids),
                    "frontierSize": len(plan.frontier),
                    "policies": policy_rows,
                }
            )

    for aggregate in totals.values():
        cases_count = aggregate["cases"]
        aggregate["originRecallPermille"] = round(
            1_000 * aggregate["expectedOriginHits"] / cases_count
        )
    result = {
        "status": "passed",
        "repository": str(root),
        "commit": commit,
        "requestedModel": args.model or "codex-default",
        "prepared": prepared,
        "totals": totals,
        "cases": cases,
        "elapsedMs": round((time.monotonic() - started) * 1_000),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
