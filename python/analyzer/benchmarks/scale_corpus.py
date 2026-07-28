#!/usr/bin/env python3
"""Measure lazy-investigation behavior on generated large Python repositories."""

from __future__ import annotations

import argparse
import json
import resource
import subprocess
import tempfile
import time
from pathlib import Path

from liveprobe_analysis.cache import AnalysisCache
from liveprobe_analysis.investigation import InvestigationEngine
from liveprobe_analysis.model import InvestigationCriterion


def rss_mib() -> float:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS reports bytes; Linux reports KiB.
    return value / (1024 * 1024) if value > 10_000_000 else value / 1024


def generate(root: Path, functions: int) -> tuple[str, int]:
    per_file = 100
    last_line = 0
    for start in range(0, functions, per_file):
        values = ["from __future__ import annotations", ""]
        for index in range(start, min(functions, start + per_file)):
            if index == 0:
                values.extend(
                    [
                        "def flow_0(value):",
                        "    result = value",
                        "    return result",
                        "",
                    ]
                )
            else:
                values.extend(
                    [
                        f"def flow_{index}(value):",
                        f"    result = flow_{index - 1}(value)",
                        "    return result",
                        "",
                    ]
                )
            if index == functions - 1:
                last_line = len(values) - 1
        (root / f"service_{start // per_file:04d}.py").write_text(
            "\n".join(values),
            encoding="utf-8",
        )
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(
        ["git", "config", "user.email", "scale@example.com"],
        cwd=root,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Scale Corpus"],
        cwd=root,
        check=True,
    )
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(["git", "commit", "-qm", "scale corpus"], cwd=root, check=True)
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    return commit, last_line


def run_case(functions: int) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix=f"liveprobe-scale-{functions}-") as raw:
        root = Path(raw)
        commit, line = generate(root, functions)
        cache_path = root / "analysis.sqlite3"
        before_rss = rss_mib()
        with AnalysisCache(root, cache_path) as cache:
            cold = cache.prepare(commit)
            warm = cache.prepare(commit)
        engine = InvestigationEngine(str(root), str(cache_path))
        started = time.perf_counter()
        view = engine.start(
            InvestigationCriterion(
                repository_root=str(root),
                commit=commit,
                service_id="scale",
                file=f"service_{(functions - 1) // 100:04d}.py",
                line=line,
                watch_path="result",
                symptom="generated terminal result is wrong",
            )
        )
        query_ms = (time.perf_counter() - started) * 1000
        cache_mib = cache_path.stat().st_size / (1024 * 1024)
        rss_delta = max(0.0, rss_mib() - before_rss)
        if float(warm["elapsedMs"]) > 1_000:
            raise AssertionError(f"warm prepare exceeded 1s: {warm}")
        if query_ms > 1_000:
            raise AssertionError(f"investigation query exceeded 1s: {query_ms}")
        if cache_mib > 250:
            raise AssertionError(f"cache exceeded 250 MiB: {cache_mib}")
        if rss_delta > 512:
            raise AssertionError(f"query RSS exceeded 512 MiB: {rss_delta}")
        if int(view["stats"]["packetBytes"]) > 48 * 1024:
            raise AssertionError("decision packet exceeded 48 KiB")
        if int(view["stats"]["fragmentsLoaded"]) != 1:
            raise AssertionError("initial investigation eagerly loaded bodies")
        return {
            "functions": functions,
            "coldMs": cold["elapsedMs"],
            "warmMs": warm["elapsedMs"],
            "queryMs": round(query_ms, 3),
            "cacheMiB": round(cache_mib, 3),
            "peakRssDeltaMiB": round(rss_delta, 3),
            "summariesLoaded": view["stats"]["summariesLoaded"],
            "fragmentsLoaded": view["stats"]["fragmentsLoaded"],
            "packetBytes": view["stats"]["packetBytes"],
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--functions",
        type=int,
        nargs="+",
        default=[1_000, 5_000, 10_000],
    )
    args = parser.parse_args()
    print(
        json.dumps(
            {"status": "passed", "cases": [run_case(value) for value in args.functions]},
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
