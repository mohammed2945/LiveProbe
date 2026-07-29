#!/usr/bin/env python3
"""Derive fault-location ground truth from the artifact's own fault injection.

For each four-arm incident, diff its source variant against the artifact's
``faultfree`` variant of the same file. The lines the injection added or
changed, in the *variant's* line numbering, are the target set.

This ground truth is independent of LiveProbe: it comes from the injected
fault, not from any analyzer output. Deriving locations from
``liveprobe-compatibility.json``'s ``criterion`` field would be circular and
is forbidden by ``PRE_REGISTRATION.md``.

Scaffolding exclusion rule, fixed in advance and applied uniformly to every
incident: an injected line is excluded from the target set when it is blank, a
comment, a bare logging call, or a lone block keyword. These are added by the
injection but are not the defect. No incident-specific judgment is applied
anywhere in this script.

Output is scorer-side. It is never mounted into an agent working directory or
included in a snapshot, prompt, or MCP response.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import re
from pathlib import Path

EVALUATION_ROOT = Path(__file__).resolve().parent.parent

SOURCE_SUBPATH = (
    "praxis-ae/examples/technology_codebase/opentelemetry-demo/src/recommendation"
)
FAULTFREE_VARIANT = "faultfree"

# Scaffolding, not defect. Fixed before any r11 run.
SCAFFOLD_PATTERNS = (
    re.compile(r"^\s*$"),
    re.compile(r"^\s*#"),
    re.compile(r"^\s*(?:logger|logging)\s*\.\s*\w+\s*\("),
    re.compile(r"^\s*(?:try|else|except\s+Exception\s+as\s+e)\s*:\s*$"),
)


def is_scaffold(line: str) -> bool:
    return any(pattern.match(line) for pattern in SCAFFOLD_PATTERNS)


def load_variant_source(artifact_root: Path, variant: str) -> str:
    path = artifact_root / SOURCE_SUBPATH / variant / "analysis_processed.json"
    analysis = json.loads(path.read_text())
    symbols = list((analysis.get("symbol_table") or {}).values())
    if len(symbols) != 1:
        raise SystemExit(
            f"{path} must contain exactly one recommendation source module, "
            f"found {len(symbols)}"
        )
    blocks = symbols[0].get("module_hammock_blocks") or []
    whole = sorted(
        (block for block in blocks if block.get("start_line") == 1),
        key=lambda block: -block["end_line"],
    )
    if not whole or not isinstance(whole[0].get("code_snippet"), str):
        raise SystemExit(f"{path} did not contain a complete source block")
    return whole[0]["code_snippet"].rstrip() + "\n"


def enclosing_function(lines: list[str], line_number: int) -> str | None:
    """Nearest preceding def at column zero or as a method."""
    for index in range(line_number - 1, -1, -1):
        match = re.match(r"^\s*def\s+(\w+)\s*\(", lines[index])
        if match:
            return match.group(1)
    return None


def injected_lines(faultfree: list[str], variant: list[str]) -> list[int]:
    """1-indexed variant lines that the injection added or changed."""
    matcher = difflib.SequenceMatcher(None, faultfree, variant, autojunk=False)
    result: list[int] = []
    for tag, _, _, start, end in matcher.get_opcodes():
        if tag in ("replace", "insert"):
            result.extend(range(start + 1, end + 1))
    return result


def build(artifact_root: Path, output: Path) -> dict:
    scenarios = json.loads((EVALUATION_ROOT / "scenarios.json").read_text())
    faultfree = load_variant_source(artifact_root, FAULTFREE_VARIANT).split("\n")
    incidents: dict[str, dict] = {}

    for scenario in scenarios["incidents"]:
        if not scenario.get("four_arm"):
            continue
        variant = scenario["source_variant"]
        source = load_variant_source(artifact_root, variant)
        lines = source.split("\n")
        raw = injected_lines(faultfree, lines)
        target = [n for n in raw if not is_scaffold(lines[n - 1])]
        functions = sorted(
            {
                name
                for name in (enclosing_function(lines, n) for n in target)
                if name is not None
            }
        )
        incidents[str(scenario["id"])] = {
            "source_variant": variant,
            "stratum": scenario["stratum"],
            "file": "recommendation_server.py",
            "injected_lines": raw,
            "target_lines": target,
            "target_line_count": len(target),
            "target_functions": functions,
            # Boundary incidents have an external accepted root with no code
            # position; naming that resource is an equally correct
            # localization. Taken from the scenario manifest's root kind, not
            # from any per-incident judgment.
            "accepts_external_resource": scenario["root_kind"]
            in ("ServiceBoundary", "DeploymentConfiguration"),
        }

    document = {
        "schema_version": "praxis-fault-locations/v1",
        "scorer_only": True,
        "derivation": (
            "diff of each source_variant against the artifact faultfree "
            "variant, excluding blank, comment, bare-logging and lone "
            "block-keyword lines"
        ),
        "provenance": {
            "artifact_source_subpath": SOURCE_SUBPATH,
            "faultfree_sha256": hashlib.sha256(
                load_variant_source(artifact_root, FAULTFREE_VARIANT).encode()
            ).hexdigest(),
        },
        "incidents": incidents,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(document, indent=2) + "\n")
    return document


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    document = build(args.artifact_root.resolve(), args.output.resolve())
    summary = {
        incident_id: {
            "target_line_count": value["target_line_count"],
            "target_functions": value["target_functions"],
        }
        for incident_id, value in document["incidents"].items()
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
