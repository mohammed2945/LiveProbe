#!/usr/bin/env python3
"""Measure the request cost of 1, 5, and 10 active snapshot sites."""

from __future__ import annotations

import argparse
import inspect
import io
import json
import statistics
import sys
import time
from pathlib import Path
from typing import Callable

from liveprobe.runtime import LiveProbe


def target(seed: int) -> float:
    payload = {"amount": float(seed), "rate": 2.45, "surge": 1.0}
    checkpoint_1 = payload["amount"] + 1
    checkpoint_2 = checkpoint_1 * payload["rate"]
    checkpoint_3 = checkpoint_2 + payload["surge"]
    checkpoint_4 = checkpoint_3 * 1.01
    checkpoint_5 = checkpoint_4 + 2
    checkpoint_6 = checkpoint_5 * 0.99
    checkpoint_7 = checkpoint_6 + 3
    checkpoint_8 = checkpoint_7 * 1.02
    checkpoint_9 = checkpoint_8 + 4
    checkpoint_10 = checkpoint_9 * 0.98
    return checkpoint_10


class _Events:
    LINE = sys.monitoring.events.LINE


class _Monitoring:
    DEBUGGER_ID = sys.monitoring.DEBUGGER_ID
    DISABLE = sys.monitoring.DISABLE
    events = _Events()

    use_tool_id = staticmethod(sys.monitoring.use_tool_id)
    register_callback = staticmethod(sys.monitoring.register_callback)
    set_events = staticmethod(sys.monitoring.set_events)
    restart_events = staticmethod(sys.monitoring.restart_events)
    free_tool_id = staticmethod(sys.monitoring.free_tool_id)


def checkpoint_lines() -> list[int]:
    source, start = inspect.getsourcelines(target)
    return [
        start + offset
        for offset, text in enumerate(source)
        if text.lstrip().startswith("checkpoint_")
    ]


def percentile(values: list[int], fraction: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((len(ordered) - 1) * fraction))
    return ordered[index] / 1_000


def samples(run: Callable[[], object], rounds: int) -> list[int]:
    values: list[int] = []
    for _ in range(rounds):
        started = time.perf_counter_ns()
        run()
        values.append(time.perf_counter_ns() - started)
    return values


def measure_baseline(rounds: int, trials: int) -> dict[str, float]:
    results = [samples(lambda: target(23), rounds) for _ in range(trials)]
    return {
        "p50Us": round(
            statistics.median(
                statistics.median(trial) / 1_000 for trial in results
            ),
            3,
        ),
        "p99Us": round(
            statistics.median(percentile(trial, 0.99) for trial in results),
            3,
        ),
    }


def measure_sites(sites: int, rounds: int, trials: int) -> dict[str, float]:
    trial_p50: list[float] = []
    trial_p99: list[float] = []
    lines = checkpoint_lines()[:sites]
    for trial in range(trials):
        agent = LiveProbe(
            service_id="probe-bundle-benchmark",
            broker_url="http://127.0.0.1:1",
            commit_sha="b" * 40,
            monitoring=_Monitoring(),
            limits={
                "hitsPerSec": 1_000_000,
                "pauseBudgetMs": 1_000_000,
                "queueSize": max(4096, sites * rounds + 100),
                "stackFrameDepth": 1,
            },
            output=io.StringIO(),
        )
        agent._install_monitoring()
        try:
            agent._reconcile(
                [
                    {
                        "id": f"prb_bundle_{sites}_{trial}_{index}",
                        "serviceId": "probe-bundle-benchmark",
                        "type": "snapshot",
                        "file": Path(__file__).name,
                        "line": line,
                        "watchPaths": ["payload.amount", "payload.rate"],
                        "hitLimit": rounds + 10,
                        "ttlSeconds": 1800,
                        "version": 1,
                        "createdBy": "benchmark",
                    }
                    for index, line in enumerate(lines)
                ]
            )
            values = samples(lambda: target(23), rounds)
        finally:
            agent._uninstall_monitoring()
        trial_p50.append(statistics.median(values) / 1_000)
        trial_p99.append(percentile(values, 0.99))
    return {
        "p50Us": round(statistics.median(trial_p50), 3),
        "p99Us": round(statistics.median(trial_p99), 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, default=500)
    parser.add_argument("--trials", type=int, default=5)
    parser.add_argument("--assert-max-p99-ms", type=float)
    args = parser.parse_args()
    if args.rounds < 100 or args.trials < 3:
        parser.error("rounds must be >= 100 and trials >= 3")

    baseline = measure_baseline(args.rounds, args.trials)
    cases = []
    for sites in (1, 5, 10):
        result = measure_sites(sites, args.rounds, args.trials)
        cases.append(
            {
                "sites": sites,
                **result,
                "p99AddedUs": round(result["p99Us"] - baseline["p99Us"], 3),
            }
        )
    output = {"baseline": baseline, "cases": cases}
    print(json.dumps(output, indent=2))
    if (
        args.assert_max_p99_ms is not None
        and cases[-1]["p99Us"] > args.assert_max_p99_ms * 1_000
    ):
        print(
            "10-site p99 exceeded "
            f"{args.assert_max_p99_ms:g} ms safety gate",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
