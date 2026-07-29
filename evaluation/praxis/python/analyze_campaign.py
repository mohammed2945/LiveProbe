#!/usr/bin/env python3
"""Analyse a four-arm campaign: accuracy as a gate, efficiency as the headline.

Campaign r10 showed token cost tracks the number of model turns, not the
context size, so turn count is reported beside tokens everywhere.

Three things this deliberately does NOT do:

* It does not recompute ``combined_pass_at_1``. That number is whatever
  ``scoreDiagnosis`` recorded, so it stays comparable across campaigns.
* ``localization_correct`` is reported separately and is never folded into
  ``combined_pass_at_1`` (``PRE_REGISTRATION.md``, C3).
* ``log_names_fault`` is a measured covariate, not a selection criterion. An
  incident whose logs already name the faulty line is one where LiveProbe
  cannot add anything, and those incidents stay in the set.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
from collections import defaultdict
from pathlib import Path

ARM_LABELS = {
    "normal_coding_sre": "Normal coding SRE",
    "praxis": "PRAXIS (fair adapter)",
    "graph_liveprobe": "Graph + LiveProbe",
    "raw_liveprobe": "Raw LiveProbe",
}
ARM_ORDER = ["normal_coding_sre", "praxis", "graph_liveprobe", "raw_liveprobe"]


def weighted_tokens(usage: dict) -> int:
    """Rollout-weighted tokens: non-cached input plus output, both weight 1.0."""
    return int(usage.get("new_input_tokens", 0)) + int(
        usage.get("output_tokens", 0)
    )


def localization_correct(answer: dict, truth: dict) -> bool | None:
    """Did the answer point at a line the fault injection actually touched?

    Returns None when the arm reported no code position at all and the
    incident does not accept an external resource, so "did not localize" is
    not silently scored as "localized wrongly".
    """
    root = answer.get("root_cause") or {}
    file_value = str(root.get("file") or "")
    line_value = root.get("line")

    if truth.get("accepts_external_resource"):
        named = {
            str(root.get("resource") or "").strip().lower(),
            str(root.get("entity") or "").strip().lower(),
        }
        if any("neo4j" in value for value in named if value):
            return True

    if not file_value or line_value is None:
        return None
    if not file_value.replace("\\", "/").endswith(truth["file"]):
        return False
    return int(line_value) in set(truth["target_lines"])


def log_names_fault(snapshot_path: Path, truth: dict) -> bool:
    """Do the incident's own logs already name the faulty file and line?

    When they do, any arm that reads logs gets the answer for free and the
    incident cannot distinguish the arms.
    """
    if not snapshot_path.exists():
        return False
    text = snapshot_path.read_text(errors="replace")
    if truth["file"] not in text:
        return False
    return any(
        re.search(rf"line {line}\b", text) for line in truth["target_lines"]
    )


def summarize(values: list[float]) -> dict:
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "median": round(statistics.median(values), 1),
        "mean": round(statistics.fmean(values), 1),
        "min": round(min(values), 1),
        "max": round(max(values), 1),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign", required=True, type=Path)
    parser.add_argument("--fault-locations", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    campaign = json.loads(args.campaign.read_text())
    truths = json.loads(args.fault_locations.read_text())["incidents"]
    root = args.campaign.parent

    covariates = {}
    for incident_id, truth in truths.items():
        snapshot = (
            root / f"incident-{incident_id}" / f"incident-{incident_id}.snapshot.json"
        )
        covariates[incident_id] = {
            "stratum": truth["stratum"],
            "target_line_count": truth["target_line_count"],
            "log_names_fault": log_names_fault(snapshot, truth),
        }

    per_arm: dict[str, list[dict]] = defaultdict(list)
    rows = []
    for result in campaign.get("results", []):
        incident_id = str(result["incident_id"])
        truth = truths.get(incident_id)
        if truth is None:
            continue
        answer = result.get("answer") or {}
        score = result.get("score") or {}
        usage = result.get("usage") or {}
        row = {
            "incident": incident_id,
            "seed": result.get("seed"),
            "arm": result["arm"],
            "stratum": truth["stratum"],
            "log_names_fault": covariates[incident_id]["log_names_fault"],
            "status": answer.get("status"),
            "entity": (answer.get("root_cause") or {}).get("entity"),
            "kind": (answer.get("root_cause") or {}).get("kind"),
            "file": (answer.get("root_cause") or {}).get("file"),
            "line": (answer.get("root_cause") or {}).get("line"),
            "rci": score.get("rci_pass_at_1"),
            "rcl": score.get("rcl_pass_at_1"),
            "rcr": score.get("rcr_pass_at_1"),
            "terminal": score.get("terminal_correct"),
            "evidence": score.get("evidence_backed"),
            "combined": score.get("combined_pass_at_1"),
            "localization_correct": localization_correct(answer, truth),
            "weighted_tokens": weighted_tokens(usage),
            "cached_input_tokens": usage.get("cached_input_tokens", 0),
            "model_samples": usage.get("model_samples", 0),
            "tool_calls": usage.get("tool_calls", 0),
            "wall_ms": result.get("wall_ms", 0),
        }
        rows.append(row)
        per_arm[result["arm"]].append(row)

    arms = {}
    for arm in ARM_ORDER:
        entries = per_arm.get(arm, [])
        if not entries:
            continue
        correct = [entry for entry in entries if entry["combined"]]
        localized = [
            entry for entry in entries if entry["localization_correct"] is True
        ]
        total_tokens = sum(entry["weighted_tokens"] for entry in entries)
        total_wall = sum(entry["wall_ms"] for entry in entries)
        arms[arm] = {
            "label": ARM_LABELS.get(arm, arm),
            "runs": len(entries),
            "combined_pass": len(correct),
            "combined_rate": round(len(correct) / len(entries), 3),
            "localized": len(localized),
            "localization_rate": round(len(localized) / len(entries), 3),
            "rci_pass": sum(1 for entry in entries if entry["rci"]),
            "rcr_pass": sum(1 for entry in entries if entry["rcr"]),
            "total_weighted_tokens": total_tokens,
            "total_wall_ms": total_wall,
            "weighted_tokens": summarize(
                [entry["weighted_tokens"] for entry in entries]
            ),
            "model_samples": summarize(
                [entry["model_samples"] for entry in entries]
            ),
            "wall_ms": summarize([entry["wall_ms"] for entry in entries]),
            # The headline. None when the arm never got one right, because a
            # cost-per-success is meaningless without a success.
            "weighted_tokens_per_correct": (
                round(total_tokens / len(correct)) if correct else None
            ),
            "wall_ms_per_correct": (
                round(total_wall / len(correct)) if correct else None
            ),
            "weighted_tokens_per_localized": (
                round(total_tokens / len(localized)) if localized else None
            ),
        }

    cells: dict[str, dict] = defaultdict(dict)
    for key in ("direct_code", "boundary_configuration"):
        for arm in ARM_ORDER:
            entries = [
                entry
                for entry in per_arm.get(arm, [])
                if entry["stratum"] == key
            ]
            if entries:
                cells[key][arm] = cell_summary(entries)
    for flag in (True, False):
        label = "log_names_fault" if flag else "log_silent"
        for arm in ARM_ORDER:
            entries = [
                entry
                for entry in per_arm.get(arm, [])
                if entry["log_names_fault"] is flag
            ]
            if entries:
                cells[label][arm] = cell_summary(entries)

    report = {
        "schema_version": "praxis-campaign-analysis/v1",
        "campaign": str(args.campaign),
        "incident_covariates": covariates,
        "arms": arms,
        "cells": dict(cells),
        "rows": sorted(rows, key=lambda row: (row["incident"], row["arm"])),
    }
    text = json.dumps(report, indent=2)
    if args.output:
        args.output.write_text(text + "\n")
    print(text)


def cell_summary(entries: list[dict]) -> dict:
    correct = [entry for entry in entries if entry["combined"]]
    localized = [
        entry for entry in entries if entry["localization_correct"] is True
    ]
    total_tokens = sum(entry["weighted_tokens"] for entry in entries)
    return {
        "runs": len(entries),
        "combined_pass": len(correct),
        "localized": len(localized),
        "median_weighted_tokens": round(
            statistics.median([entry["weighted_tokens"] for entry in entries])
        ),
        "median_wall_ms": round(
            statistics.median([entry["wall_ms"] for entry in entries])
        ),
        "median_model_samples": round(
            statistics.median([entry["model_samples"] for entry in entries])
        ),
        "weighted_tokens_per_correct": (
            round(total_tokens / len(correct)) if correct else None
        ),
    }


if __name__ == "__main__":
    main()
