#!/usr/bin/env python3

"""Validate the exact released PRAXIS interfaces used by the fair adapter.

This checker deliberately uses only the Python standard library. It can run
before the released PRAXIS dependencies, cluster, or any model credentials are
used. It validates structure and incident-specific program-analysis assets;
the deterministic adapter tripwire remains the runtime contract check.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path
from typing import Any


EVALUATION_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INCIDENTS = tuple(str(value) for value in range(401, 417))
REQUIRED_RCA_PATCH_SYMBOLS = {
    "DataGatherer",
    "LeafRCA",
    "Neo4jGraphTraversal",
    "PrometheusAlertsTool",
    "ServiceInteractionErrorTool",
    "SpanCausalRCA",
    "TraceCausalRCA",
    "TraceErrorTreeTool",
    "get_llm_backend_for_tools",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--incidents",
        default=",".join(DEFAULT_INCIDENTS),
        help="comma-separated incident IDs (default: 401-416)",
    )
    return parser.parse_args()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def assignment_value(tree: ast.AST, name: str) -> Any:
    values: list[Any] = []
    for node in getattr(tree, "body", []):
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        if not any(
            isinstance(target, ast.Name) and target.id == name
            for target in targets
        ):
            continue
        try:
            values.append(ast.literal_eval(node.value))
        except (ValueError, TypeError):
            values.append(None)
    return values[-1] if values else None


def module_symbols(tree: ast.AST) -> set[str]:
    symbols: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            symbols.add(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                symbols.add(alias.asname or alias.name.split(".")[-1])
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    symbols.add(target.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            symbols.add(node.target.id)
    return symbols


def class_methods(tree: ast.AST, class_name: str) -> set[str]:
    for node in getattr(tree, "body", []):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            return {
                child.name
                for child in node.body
                if isinstance(
                    child,
                    (ast.FunctionDef, ast.AsyncFunctionDef),
                )
            }
    return set()


def block_ids(document: Any) -> set[str]:
    result: set[str] = set()
    pending = [document]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            if value.get("block_id") is not None:
                result.add(str(value["block_id"]))
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    return result


def run_checks(artifact_root: Path, incidents: list[str]) -> dict[str, Any]:
    praxis_root = artifact_root / "praxis-ae"
    checks: list[dict[str, Any]] = []

    def record(name: str, passed: bool, detail: Any = None) -> bool:
        item: dict[str, Any] = {"name": name, "passed": bool(passed)}
        if detail is not None:
            item["detail"] = detail
        checks.append(item)
        return bool(passed)

    scenarios_path = EVALUATION_ROOT / "scenarios.json"
    rca_path = praxis_root / "src/praxis/agent/rca_langgraph_v2.py"
    code_agent_path = praxis_root / "src/praxis/agent/code_mini_agent.py"
    variants_path = (
        praxis_root / "src/praxis/configs/variants_ablation_config.py"
    )
    code_config_path = (
        praxis_root / "src/praxis/configs/code_context_config.py"
    )
    bookkeeping_path = (
        praxis_root
        / "examples/technology_codebase/technology_bookkeeping.json"
    )
    required_files = [
        scenarios_path,
        rca_path,
        code_agent_path,
        variants_path,
        code_config_path,
        bookkeeping_path,
    ]
    record(
        "required_release_files",
        all(path.is_file() for path in required_files),
        {
            "missing": [
                str(path.relative_to(artifact_root))
                if path.is_relative_to(artifact_root)
                else str(path)
                for path in required_files
                if not path.is_file()
            ]
        },
    )

    parsed_python: dict[Path, ast.AST] = {}
    for path in [rca_path, code_agent_path, variants_path, code_config_path]:
        if not path.is_file():
            continue
        try:
            parsed_python[path] = ast.parse(path.read_text())
            record(f"python_ast:{path.name}", True)
        except (OSError, SyntaxError) as error:
            record(f"python_ast:{path.name}", False, str(error))

    variants_tree = parsed_python.get(variants_path)
    if variants_tree is not None:
        record(
            "code_enhanced_rca_enabled",
            assignment_value(variants_tree, "CODE_ENHANCED_RCA") is True,
        )
        record(
            "llm_next_entity_selection_disabled",
            assignment_value(
                variants_tree,
                "LLM_BASED_NEXT_ENTITY_SELECTION",
            )
            is False,
        )

    rca_tree = parsed_python.get(rca_path)
    if rca_tree is not None:
        methods = class_methods(rca_tree, "RCAAgentV2")
        record(
            "rca_agent_v2_runtime_interface",
            {"__init__", "run_rca"}.issubset(methods),
            {"methods": sorted(methods)},
        )
        symbols = module_symbols(rca_tree)
        missing_symbols = sorted(REQUIRED_RCA_PATCH_SYMBOLS - symbols)
        record(
            "fair_adapter_patch_symbols",
            not missing_symbols,
            {"missing": missing_symbols},
        )

    code_tree = parsed_python.get(code_agent_path)
    if code_tree is not None:
        methods = class_methods(code_tree, "CodeMiniAgent")
        record(
            "code_mini_agent_interface",
            {
                "use_existing_analysis",
                "construct_code_context",
                "traverse_code_graph",
            }.issubset(methods),
            {"methods": sorted(methods)},
        )
        code_source = code_agent_path.read_text()
        record(
            "incident_number_selects_program_analysis",
            'os.getenv("INCIDENT_NUMBER")' in code_source
            and "key.startswith(incident_id)" in code_source
            and '["output_filename"]' in code_source
            and '["default_anchor_block_id"]' in code_source,
        )

    config_tree = parsed_python.get(code_config_path)
    if config_tree is not None:
        record(
            "artifact_benchmark_mode_enabled",
            assignment_value(config_tree, "AGENT_BENCHMARK_MODE") is True,
        )
        record(
            "technology_bookkeeping_path_compatible",
            assignment_value(config_tree, "TECHNOLOGY_BOOKKEEPING_JSON")
            == "examples/technology_codebase/technology_bookkeeping.json",
        )

    try:
        scenarios = json.loads(scenarios_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        scenarios = None
        record("scenario_manifest_json", False, str(error))
    else:
        record("scenario_manifest_json", True)

    try:
        bookkeeping = json.loads(bookkeeping_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        bookkeeping = None
        record("technology_bookkeeping_json", False, str(error))
    else:
        record(
            "technology_bookkeeping_json",
            isinstance(bookkeeping, list),
        )

    scenario_by_id: dict[str, dict[str, Any]] = {}
    if isinstance(scenarios, dict):
        scenario_by_id = {
            str(item["id"]): item
            for item in scenarios.get("incidents", [])
            if isinstance(item, dict) and item.get("id") is not None
        }
    manifest_panel = {
        incident_id
        for incident_id, scenario in scenario_by_id.items()
        if scenario.get("four_arm") is True
    }
    record(
        "scenario_panel_401_416",
        manifest_panel == set(DEFAULT_INCIDENTS),
        {"panel": sorted(manifest_panel)},
    )
    unknown_incidents = sorted(set(incidents) - set(DEFAULT_INCIDENTS))
    record(
        "selected_incidents_supported",
        not unknown_incidents,
        {"unsupported": unknown_incidents},
    )

    recommendation = None
    if isinstance(bookkeeping, list):
        recommendation = next(
            (
                item
                for item in bookkeeping
                if isinstance(item, dict)
                and str(item.get("name", "")).casefold()
                == "recommendation"
            ),
            None,
        )
    record(
        "recommendation_technology_entry",
        recommendation is not None
        and recommendation.get("language") == "python",
    )

    incident_reports: dict[str, dict[str, Any]] = {}
    if recommendation is not None:
        output_base = recommendation.get("code_analysis_output_path")
        modifiers = recommendation.get("code_analysis_benchmark_modifier")
        record(
            "recommendation_analysis_configuration",
            isinstance(output_base, str)
            and bool(output_base)
            and isinstance(modifiers, dict),
        )
        if isinstance(output_base, str) and isinstance(modifiers, dict):
            for incident_id in incidents:
                matches = [
                    (key, value)
                    for key, value in modifiers.items()
                    if key.startswith(f"{incident_id}-")
                    and isinstance(value, dict)
                ]
                item: dict[str, Any] = {
                    "modifier_matches": len(matches),
                }
                if len(matches) == 1:
                    modifier_key, modifier = matches[0]
                    output_filename = modifier.get("output_filename")
                    anchor_id = modifier.get("default_anchor_block_id")
                    item.update(
                        {
                            "modifier_key": modifier_key,
                            "output_filename": output_filename,
                            "default_anchor_block_id": anchor_id,
                        }
                    )
                    expected_variant = scenario_by_id.get(
                        incident_id,
                        {},
                    ).get("source_variant")
                    item["source_variant_matches"] = (
                        isinstance(output_filename, str)
                        and Path(output_filename).parent.name
                        == expected_variant
                    )
                    if isinstance(output_filename, str):
                        graph_path = (
                            praxis_root / output_base / output_filename
                        ).resolve()
                        inside_release = graph_path.is_relative_to(
                            praxis_root.resolve()
                        )
                        item["inside_release"] = inside_release
                        item["exists"] = graph_path.is_file()
                        if inside_release and graph_path.is_file():
                            try:
                                graph = json.loads(graph_path.read_text())
                            except (OSError, json.JSONDecodeError) as error:
                                item["json_error"] = str(error)
                            else:
                                ids = block_ids(graph)
                                item.update(
                                    {
                                        "json_valid": True,
                                        "symbol_table_present": (
                                            isinstance(graph, dict)
                                            and isinstance(
                                                graph.get("symbol_table"),
                                                dict,
                                            )
                                        ),
                                        "block_count": len(ids),
                                        "anchor_present": str(anchor_id) in ids,
                                        "bytes": graph_path.stat().st_size,
                                        "sha256": file_sha256(graph_path),
                                    }
                                )
                item["passed"] = (
                    item.get("modifier_matches") == 1
                    and item.get("source_variant_matches") is True
                    and item.get("inside_release") is True
                    and item.get("exists") is True
                    and item.get("json_valid") is True
                    and item.get("symbol_table_present") is True
                    and item.get("block_count", 0) > 0
                    and item.get("anchor_present") is True
                )
                incident_reports[incident_id] = item
                record(
                    f"incident_program_analysis:{incident_id}",
                    item["passed"],
                    {
                        key: value
                        for key, value in item.items()
                        if key not in {"sha256"}
                    },
                )

            default_modifier = modifiers.get("default")
            default_ok = False
            default_detail: dict[str, Any] = {}
            if isinstance(default_modifier, dict):
                default_filename = default_modifier.get("output_filename")
                default_anchor = default_modifier.get(
                    "default_anchor_block_id"
                )
                default_detail = {
                    "output_filename": default_filename,
                    "default_anchor_block_id": default_anchor,
                }
                if isinstance(default_filename, str):
                    default_path = (
                        praxis_root / output_base / default_filename
                    ).resolve()
                    if (
                        default_path.is_relative_to(praxis_root.resolve())
                        and default_path.is_file()
                    ):
                        try:
                            default_graph = json.loads(
                                default_path.read_text()
                            )
                        except (OSError, json.JSONDecodeError) as error:
                            default_detail["json_error"] = str(error)
                        else:
                            default_ids = block_ids(default_graph)
                            default_ok = (
                                isinstance(default_graph, dict)
                                and isinstance(
                                    default_graph.get("symbol_table"),
                                    dict,
                                )
                                and str(default_anchor) in default_ids
                            )
                            default_detail["anchor_present"] = (
                                str(default_anchor) in default_ids
                            )
            record(
                "default_program_analysis",
                default_ok,
                default_detail,
            )

    compatible = all(item["passed"] for item in checks)
    return {
        "schema_version": "liveprobe-praxis-artifact-compatibility/v1",
        "artifact_root": str(artifact_root),
        "selected_incidents": incidents,
        "compatible": compatible,
        "summary": {
            "checks": len(checks),
            "checks_passed": sum(
                1 for item in checks if item["passed"]
            ),
            "incident_assets": len(incident_reports),
            "incident_assets_passed": sum(
                1
                for item in incident_reports.values()
                if item.get("passed") is True
            ),
        },
        "checks": checks,
        "incidents": incident_reports,
    }


def main() -> int:
    args = parse_args()
    incidents = [
        value.strip()
        for value in args.incidents.split(",")
        if value.strip()
    ]
    if not incidents:
        raise SystemExit("--incidents must select at least one incident")
    report = run_checks(Path(args.artifact_root).resolve(), incidents)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "compatible": report["compatible"],
                **report["summary"],
                "output": str(output),
            },
            indent=2,
        )
    )
    return 0 if report["compatible"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
