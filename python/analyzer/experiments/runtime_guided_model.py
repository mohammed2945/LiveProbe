#!/usr/bin/env python3
"""Measure model action selection over a runtime-guided RideRush packet."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from liveprobe_analysis.cache import AnalysisCache
from liveprobe_analysis.investigation import InvestigationEngine
from liveprobe_analysis.model import (
    InvestigationCriterion,
    InvestigationDecision,
    ValueObservation,
)


@dataclass(frozen=True, slots=True)
class Usage:
    calls: int = 0
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    elapsed_ms: int = 0

    def __add__(self, other: Usage) -> Usage:
        return Usage(
            calls=self.calls + other.calls,
            input_tokens=self.input_tokens + other.input_tokens,
            cached_input_tokens=(
                self.cached_input_tokens + other.cached_input_tokens
            ),
            output_tokens=self.output_tokens + other.output_tokens,
            reasoning_tokens=self.reasoning_tokens + other.reasoning_tokens,
            elapsed_ms=self.elapsed_ms + other.elapsed_ms,
        )


def run_model(
    repository: Path,
    prompt: str,
    schema: dict[str, object],
    *,
    model: str | None,
    timeout: int,
) -> tuple[dict[str, Any], Usage]:
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="liveprobe-runtime-model-") as raw:
        temp = Path(raw)
        schema_path = temp / "schema.json"
        answer_path = temp / "answer.json"
        schema_path.write_text(json.dumps(schema), encoding="utf-8")
        command = [
            "codex",
            "exec",
            "--ignore-user-config",
            "--ignore-rules",
            "--ephemeral",
            "--json",
            "--sandbox",
            "read-only",
            "--cd",
            str(repository),
            "--config",
            'web_search="disabled"',
            "--config",
            "agents.enabled=false",
            "--config",
            "mcp_servers={}",
            "--output-schema",
            str(schema_path),
            "--output-last-message",
            str(answer_path),
        ]
        if model:
            command.extend(["--model", model])
        command.append(prompt)
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                "Codex decision failed: "
                + (completed.stderr or completed.stdout)[-2_000:]
            )
        answer = json.loads(answer_path.read_text(encoding="utf-8"))

    raw_usage: dict[str, int] = {}
    for line in completed.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "turn.completed" and isinstance(
            event.get("usage"), dict
        ):
            raw_usage = {
                key: int(value)
                for key, value in event["usage"].items()
                if isinstance(value, int)
            }
    return answer, Usage(
        calls=1,
        input_tokens=raw_usage.get("input_tokens", 0),
        cached_input_tokens=raw_usage.get("cached_input_tokens", 0),
        output_tokens=raw_usage.get("output_tokens", 0),
        reasoning_tokens=raw_usage.get("reasoning_output_tokens", 0),
        elapsed_ms=round((time.monotonic() - started) * 1_000),
    )


def serialized_value(path: str, failing: bool) -> dict[str, object]:
    leaf = path.rsplit(".", 1)[-1].lower()
    if leaf == "surge":
        return {"t": "num", "v": 50.0 if failing else 1.0}
    if leaf in {"amount", "quote"}:
        return {"t": "num", "v": 1718.5 if failing else 37.8}
    if leaf == "distance":
        return {"t": "num", "v": 10}
    if leaf in {"rate", "per_mile_rate"}:
        return {"t": "num", "v": 2.45}
    if leaf in {"x", "y", "dest_x", "dest_y"}:
        return {"t": "num", "v": 1}
    return {"t": "str", "v": "same-in-both-executions"}


def decision_packet(view: dict[str, object]) -> dict[str, object]:
    """Keep exactly the bounded packet an external AI SRE would receive."""

    return {
        "criterion": view["criterion"],
        "graph": view["graph"],
        "valueDossiers": view["value_dossiers"],
        "judgments": view["judgments"],
        "actions": view["actions"],
        "coverageNotes": view["coverage_notes"],
    }


def continuation_packet(
    view: dict[str, object],
    *,
    selected_action: str,
    prior_rationale: str,
) -> dict[str, object]:
    """Send only newly revealed context plus the previous decision."""

    return {
        "symptom": view["criterion"]["symptom"],
        "selectedActionId": selected_action,
        "priorRationale": prior_rationale,
        "mechanismContext": view["mechanism_context"],
        "actions": [
            action
            for action in view["actions"]
            if action["kind"] == "VERIFY_MECHANISM"
        ],
        "coverageNotes": view["coverage_notes"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    default_repository = (
        Path(__file__).resolve().parents[3].parent
        / "ride_sharing_probe_demo"
    )
    parser.add_argument("--repository", type=Path, default=default_repository)
    parser.add_argument("--commit")
    parser.add_argument("--model")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--deterministic-only", action="store_true")
    args = parser.parse_args()
    repository = args.repository.resolve()
    commit = args.commit or subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    output = args.output or (
        Path(__file__).resolve().parents[3]
        / "demo/ride-analysis/results/latest-runtime-guided-model.json"
    )
    started = time.monotonic()

    with tempfile.TemporaryDirectory(prefix="liveprobe-runtime-track-") as raw:
        cache_path = Path(raw) / "analysis.sqlite3"
        with AnalysisCache(repository, cache_path) as cache:
            prepared = cache.prepare(commit)
        engine = InvestigationEngine(str(repository), str(cache_path))
        view = engine.start(
            InvestigationCriterion(
                repository_root=str(repository),
                commit=commit,
                service_id="pricing",
                file="services/pricing/app.py",
                line=77,
                watch_path="quote",
                symptom="the customer quote is implausibly high",
                failure_class="semantic",
                probe_budget=8,
                source_roots=("services/pricing",),
            )
        )
        differential = next(
            action
            for action in view["actions"]
            if action["kind"] == "REQUEST_DIFFERENTIAL"
        )
        view = engine.decide(
            view["investigation_id"],
            InvestigationDecision(
                action_ids=(differential["action_id"],)
            ),
        )

        observations: list[ValueObservation] = []
        for site in view["probe_bundle"]["sites"]:
            for role, failing in (("passing", False), ("failing", True)):
                observations.append(
                    ValueObservation(
                        observation_id=(
                            f"obs_{role}_{site['site_id']}"
                        ),
                        site_id=site["site_id"],
                        occurrence_id=f"trace:runtime-model-{role}",
                        role=role,
                        hit_index=1,
                        sequence_index=int(site["line"]),
                        values={
                            path: serialized_value(path, failing)
                            for path in site["watch_paths"]
                        },
                        pair_id="identical-pricing-request",
                    )
                )
        view = engine.record_evidence(
            view["investigation_id"], observations
        )
        nodes = {
            node["node_id"]: node for node in view["graph"]["nodes"]
        }
        expected_actions = [
            action["action_id"]
            for action in view["actions"]
            if action["kind"] == "INSPECT_MECHANISM"
            and "surge =" in str(
                nodes.get(action.get("anchor_node_id"), {}).get("source", "")
            )
        ]
        if not expected_actions:
            raise AssertionError("runtime packet lacks the surge mechanism")

        usage = Usage()
        step_usage: list[dict[str, object]] = []
        selected_action: str | None = None
        rationale = "deterministic-only packet validation"
        mechanism: str | None = None
        first_packet_text = json.dumps(
            decision_packet(view), separators=(",", ":")
        )
        continuation_packet_bytes = 0
        if not args.deterministic_only:
            action_ids = [
                action["action_id"] for action in view["actions"]
            ]
            answer, first_usage = run_model(
                repository,
                (
                    "You are the AI SRE controlling LiveProbe. Runtime evidence "
                    "has already been captured from matched passing and failing "
                    "requests. Select exactly one supplied action. Prefer the "
                    "earliest divergent producer over downstream arithmetic. "
                    "Never invent an action ID and do not inspect the repository."
                    "\n\nDecision packet:\n"
                    + first_packet_text
                ),
                {
                    "type": "object",
                    "properties": {
                        "selected_action_id": {
                            "type": "string",
                            "enum": action_ids,
                        },
                        "rationale": {"type": "string"},
                    },
                    "required": ["selected_action_id", "rationale"],
                    "additionalProperties": False,
                },
                model=args.model,
                timeout=args.timeout,
            )
            usage += first_usage
            step_usage.append(
                {"step": "select-mechanism", **asdict(first_usage)}
            )
            selected_action = str(answer["selected_action_id"])
            rationale = str(answer["rationale"])
            view = engine.decide(
                view["investigation_id"],
                InvestigationDecision(action_ids=(selected_action,)),
            )
            verify_actions = [
                action["action_id"]
                for action in view["actions"]
                if action["kind"] == "VERIFY_MECHANISM"
            ]
            if selected_action in expected_actions and verify_actions:
                followup_text = json.dumps(
                    continuation_packet(
                        view,
                        selected_action=selected_action,
                        prior_rationale=rationale,
                    ),
                    separators=(",", ":"),
                )
                continuation_packet_bytes = len(followup_text.encode())
                answer, second_usage = run_model(
                    repository,
                    (
                        "Continue the same LiveProbe investigation. State a "
                        "specific mechanism supported by the revealed hammock "
                        "and select the supplied verification action. Do not "
                        "inspect the repository.\n\nUpdated decision packet:\n"
                        + followup_text
                    ),
                    {
                        "type": "object",
                        "properties": {
                            "selected_action_id": {
                                "type": "string",
                                "enum": verify_actions,
                            },
                            "mechanism": {"type": "string"},
                        },
                        "required": ["selected_action_id", "mechanism"],
                        "additionalProperties": False,
                    },
                    model=args.model,
                    timeout=args.timeout,
                )
                usage += second_usage
                step_usage.append(
                    {"step": "describe-and-verify", **asdict(second_usage)}
                )
                mechanism = str(answer["mechanism"])
                view = engine.decide(
                    view["investigation_id"],
                    InvestigationDecision(
                        action_ids=(str(answer["selected_action_id"]),),
                        mechanism=mechanism,
                    ),
                )

        if not args.deterministic_only and (
            selected_action not in expected_actions
            or view["phase"] != "VERIFYING"
            or not mechanism
        ):
            raise AssertionError(
                "model failed to select and verify the expected surge mechanism"
            )
        result = {
            "status": "passed",
            "repository": str(repository),
            "commit": commit,
            "prepared": prepared,
            "decisionPacketBytes": len(first_packet_text.encode()),
            "continuationPacketBytes": continuation_packet_bytes,
            "expectedActionIds": expected_actions,
            "selectedActionId": selected_action,
            "selectedExpectedMechanism": selected_action in expected_actions,
            "phase": view["phase"],
            "mechanism": mechanism,
            "rationale": rationale,
            "usage": asdict(usage),
            "stepUsage": step_usage,
            "elapsedMs": round((time.monotonic() - started) * 1_000),
        }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
