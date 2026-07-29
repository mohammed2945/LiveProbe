"""Runtime adapters for the controlled PRAXIS comparison.

This module does not copy or modify PRAXIS source. The fair launcher imports the
released artifact, then replaces its external collectors and LLM factory with
these snapshot-backed implementations before constructing RCAAgentV2.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _sha256(value: Any) -> str:
    encoded = value if isinstance(value, str) else _canonical(value)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class Snapshot:
    def __init__(self, path: str, ledger_path: str | None = None):
        self.path = Path(path).resolve()
        self.ledger_path = (
            Path(ledger_path).resolve() if ledger_path is not None else None
        )
        self.data = json.loads(self.path.read_text())
        if self.data.get("schema_version") != "observability-snapshot/v1":
            raise ValueError("unsupported observability snapshot")
        self.nodes = {
            node["id"]: {
                **node,
                "name": node["id"],
                "namespace": node.get("namespace", "otel-demo"),
            }
            for node in self.data["topology"]["nodes"]
        }

    def record_tool(
        self,
        tool: str,
        arguments: Any,
        response: Any,
        *,
        status: str = "completed",
    ):
        if self.ledger_path is None:
            return
        serialized = json.dumps(response, sort_keys=True, default=str)
        record = {
            "schema_version": "liveprobe-eval-ledger/v1",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "run_id": os.environ.get("EVAL_RUN_ID", "praxis-fair"),
            "arm": "praxis",
            "incident_id": self.data["incident_id"],
            "seed": int(os.environ.get("SEED", "0")),
            "model": os.environ.get("EVAL_MODEL", "unknown"),
            "kind": "tool_call",
            "server": "praxis_internal",
            "tool": tool,
            "arguments_sha256": _sha256(arguments),
            "response_sha256": _sha256(serialized),
            "response_bytes": len(serialized.encode("utf-8")),
            "status": status,
        }
        with self.ledger_path.open("a") as ledger:
            ledger.write(json.dumps(record) + "\n")

    def logs_for(self, name: str) -> list[dict[str, Any]]:
        return [item for item in self.data["logs"] if item.get("service") == name]

    def metrics_for(self, name: str) -> list[dict[str, Any]]:
        return [item for item in self.data["metrics"] if item.get("service") == name]

    def resources_for(self, name: str) -> list[dict[str, Any]]:
        return [
            item
            for item in self.data["resources"]
            if item.get("name") == name or item.get("state", {}).get("service") == name
        ]


class SnapshotDriverSession:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def run(self, *_args, **_kwargs):
        return []


class SnapshotDriver:
    def session(self):
        return SnapshotDriverSession()


class SnapshotGraphTraversal:
    snapshot: Snapshot

    def __init__(self, *_args, **_kwargs):
        self.driver = SnapshotDriver()

    def close(self):
        return None

    def search(
        self,
        name: str | None = None,
        kind: str | None = None,
        namespace: str | None = None,
        limit: int = 10,
        **_kwargs,
    ):
        values = list(self.snapshot.nodes.values())
        if name is not None:
            values = [item for item in values if item.get("name") == name]
        if kind is not None:
            values = [
                item
                for item in values
                if str(item.get("kind", "")).lower() == str(kind).lower()
            ]
        if namespace is not None:
            values = [
                item for item in values if item.get("namespace") == namespace
            ]
        return values[:limit]

    def get_node_by_id(self, entity_id: str):
        return self.snapshot.nodes.get(entity_id)


class SnapshotAlertsTool:
    snapshot: Snapshot

    def __init__(self, *_args, **_kwargs):
        pass

    def get_alerts_with_entity_ids(self):
        result = []
        for alert in self.snapshot.data["bootstrap"]["alerts"]:
            service = alert.get("service", "unknown")
            result.append(
                {
                    "labels": {
                        "alertname": alert.get("name", "Alert"),
                        "service_name": service,
                        "namespace": "otel-demo",
                        "severity": alert.get("severity", "warning"),
                    },
                    "annotations": {
                        "description": alert.get("description", "")
                    },
                    "state": alert.get("state", "firing"),
                    "entity_id": service,
                    "evidence_id": alert.get("evidence_id"),
                }
            )
        return result


@dataclass
class SnapshotHealth:
    name: str
    health_score: float
    type: str = "Service"
    metadata: dict[str, Any] | None = None
    related_entities: list[str] | None = None


class SnapshotHealthTool:
    snapshot: Snapshot

    def __init__(self, *_args, **_kwargs):
        pass

    def get_health_list(self, *_args, **_kwargs):
        services = []
        for summary in self.snapshot.data["bootstrap"]["failing_trace_summaries"]:
            for service in summary.get("error_path", []):
                if service not in services:
                    services.append(service)
        return [
            SnapshotHealth(
                name=service,
                health_score=0.0,
                metadata={"source": "immutable_snapshot"},
                related_entities=[],
            )
            for service in services[:3]
        ]


class SnapshotLeafRCA:
    snapshot: Snapshot

    def __init__(self, *_args, **_kwargs):
        pass

    def _run(self, *_args, **_kwargs):
        summaries = self.snapshot.data["bootstrap"]["failing_trace_summaries"]
        return json.dumps(
            {
                "summary": {
                    "total_error_traces": len(summaries),
                    "unique_primary_failures": len(summaries),
                },
                "primary_failures": summaries,
            }
        )


class SnapshotTraceErrorTree:
    snapshot: Snapshot

    def __init__(self, *_args, **_kwargs):
        pass

    def get_error_tree_analysis(self, *_args, **_kwargs):
        patterns = []
        for trace in self.snapshot.data["traces"]:
            flow = [
                {
                    "prefix": "  " * index,
                    "line": f"{span.get('service')}::{span.get('operation')} [{span.get('status')}]",
                }
                for index, span in enumerate(trace.get("spans", []))
            ]
            patterns.append(
                {
                    "pattern_summary": {
                        "total_error_count": 1,
                        "error_rate": 1.0,
                        "root_service": trace.get("spans", [{}])[-1].get(
                            "service", "unknown"
                        ),
                        "root_operation": trace.get("spans", [{}])[-1].get(
                            "operation", "unknown"
                        ),
                        "error_status_distribution": {
                            trace.get("status", "ERROR"): 1
                        },
                        "latency_statistics": {
                            "median_ms": trace.get("duration_ms", 0),
                            "p95_ms": trace.get("duration_ms", 0),
                            "p99_ms": trace.get("duration_ms", 0),
                        },
                    },
                    "example_traces": [
                        {
                            "span_count": len(trace.get("spans", [])),
                            "trace_tree_flow": flow,
                        }
                    ],
                    "tree_structure": {},
                }
            )
        return {
            "summary": {
                "total_patterns": len(patterns),
                "analysis_timestamp": self.snapshot.data["detected_at"],
            },
            "error_patterns": patterns,
        }


class SnapshotServiceInteraction:
    snapshot: Snapshot

    def __init__(self, *_args, **_kwargs):
        pass

    def build_context(self, *_args, **_kwargs):
        return {
            "interactions": self.snapshot.data["topology"]["edges"],
            "source": "immutable_snapshot",
        }


class SnapshotJaeger:
    snapshot: Snapshot

    def __init__(self, *_args, **_kwargs):
        pass

    def get_calls(self, *_args, **_kwargs):
        return self.snapshot.data["topology"]["edges"]

    def get_raw_spans_for_pfsp(self, *_args, **_kwargs):
        spans = []
        for trace in self.snapshot.data["traces"]:
            for span in trace.get("spans", []):
                spans.append({**span, "trace_id": trace.get("trace_id")})
        return {"spans": spans}


class SnapshotDataGatherer:
    snapshot: Snapshot

    def __init__(self, namespace="otel-demo", context=None, graph_client=None):
        self.namespace = namespace
        self.context = context
        self.graph_client = graph_client
        self.max_log_lines = 40

    def _execute_kubectl_command(self, _command: str):
        return "immutable snapshot adapter: live kubectl disabled"

    def get_all_entities(self, namespace=None):
        return [
            node
            for node in self.snapshot.nodes.values()
            if namespace is None or node.get("namespace") == namespace
        ]

    def get_all_entities_by_types(self, entity_types, namespace=None):
        allowed = {
            str(value).lower()
            for value in (
                entity_types if isinstance(entity_types, list) else [entity_types]
            )
        }
        return [
            node
            for node in self.get_all_entities(namespace)
            if str(node.get("kind", "")).lower() in allowed
        ]

    def build_contextual_analysis(
        self,
        entity_id: str,
        data_cache=None,
        entity_kind: str | None = None,
        entity_name: str | None = None,
        stack_only: bool = False,
    ):
        node = self.snapshot.nodes.get(entity_id) or {
            "id": entity_id,
            "name": entity_name or entity_id,
            "kind": entity_kind or "Unknown",
            "namespace": self.namespace,
        }
        name = node.get("name", entity_name or entity_id)
        incoming = []
        outgoing = []
        for edge in self.snapshot.data["topology"]["edges"]:
            if edge.get("to") == entity_id:
                incoming.append(
                    {
                        "id": edge.get("from"),
                        "name": edge.get("from"),
                        "type": self.snapshot.nodes.get(
                            edge.get("from"), {}
                        ).get("kind", "Service"),
                        "namespace": self.namespace,
                    }
                )
            if edge.get("from") == entity_id:
                outgoing.append(
                    {
                        "id": edge.get("to"),
                        "name": edge.get("to"),
                        "type": self.snapshot.nodes.get(
                            edge.get("to"), {}
                        ).get("kind", "Service"),
                        "namespace": self.namespace,
                    }
                )
        stack_report = {
            "physical": {},
            "controller": {},
            "immediate_connections": {},
            "service_interactions": {
                "incoming": incoming,
                "outgoing": outgoing,
                "summary": {
                    "incoming_calls": len(incoming),
                    "outgoing_calls": len(outgoing),
                },
            },
        }
        if stack_only:
            return stack_report
        logs = self.snapshot.logs_for(name)[-self.max_log_lines :]
        return {
            "entity_report": {
                "focal_entity": {
                    "id": entity_id,
                    "name": name,
                    "type": node.get("kind", entity_kind or "Unknown"),
                    "namespace": node.get("namespace", self.namespace),
                },
                "stack_report": stack_report,
                "observability_data": {
                    "focal_entity_details": {
                        "logs": logs,
                        "metrics": self.snapshot.metrics_for(name),
                        "resources": self.snapshot.resources_for(name),
                        "events": self.snapshot.data["events"],
                        "deployments": [
                            item
                            for item in self.snapshot.data["deployments"]
                            if item.get("service") == name
                        ],
                    },
                    "service_interaction_context": {
                        "immediate_callers": incoming,
                        "immediate_targets": outgoing,
                        "extended_callers": [],
                        "extended_targets": [],
                    },
                    "infrastructure_context": {
                        "immediate_parent": None,
                        "immediate_children": [],
                    },
                },
            },
            "data_cache": data_cache or {},
        }


class CodexCLIBackend:
    """Tool-free Codex CLI transport with provider-reported usage accounting."""

    def __init__(
        self,
        model: str,
        seed: int,
        ledger_path: str,
        token_budget: int,
        timeout_seconds: int,
    ):
        self.model = model
        self.seed = seed
        self.ledger_path = Path(ledger_path)
        self.token_budget = token_budget
        self.timeout_seconds = timeout_seconds
        self.weighted_tokens = 0
        self.call_index = 0

    @staticmethod
    def _usage(events):
        raw = {}
        completed = []
        for event in events:
            if event.get("type") == "turn.completed" and event.get("usage"):
                raw = event["usage"]
            if event.get("type") == "item.completed":
                completed.append(event.get("item", {}))
        input_tokens = int(raw.get("input_tokens", 0))
        cached = int(raw.get("cached_input_tokens", 0))
        return {
            "model_calls": 1,
            "model_samples": 1,
            "retries": 0,
            "input_tokens": input_tokens,
            "cached_input_tokens": cached,
            "new_input_tokens": max(0, input_tokens - cached),
            "output_tokens": int(raw.get("output_tokens", 0)),
            "reasoning_tokens": int(raw.get("reasoning_output_tokens", 0)),
            "tool_calls": 0,
            "tool_response_bytes": 0,
        }

    def inference(self, system_prompt: str, input: str, **_kwargs):
        remaining_tokens = self.token_budget - self.weighted_tokens
        if remaining_tokens < 1:
            raise RuntimeError(
                "PRAXIS LLM weighted token budget exhausted before call"
            )
        self.call_index += 1
        prompt = (
            f"{system_prompt}\n\n{input}\n\n"
            "Return only the requested answer. Do not call tools."
        )
        reminder_tokens = []
        for value in (
            remaining_tokens // 3,
            remaining_tokens // 6,
            remaining_tokens // 15,
        ):
            if (
                0 < value < remaining_tokens
                and value not in reminder_tokens
            ):
                reminder_tokens.append(value)
        reminder_config = json.dumps(reminder_tokens, separators=(",", ":"))
        with tempfile.TemporaryDirectory(prefix="praxis-codex-") as temporary:
            answer_path = Path(temporary) / "answer.txt"
            started = time.perf_counter()
            result = subprocess.run(
                [
                    "codex",
                    "exec",
                    "--strict-config",
                    "--ignore-user-config",
                    "--ignore-rules",
                    "--ephemeral",
                    "--skip-git-repo-check",
                    "--json",
                    "--sandbox",
                    "read-only",
                    "--cd",
                    temporary,
                    "--model",
                    self.model,
                    "--config",
                    'model_reasoning_effort="low"',
                    "--config",
                    'web_search="disabled"',
                    "--config",
                    "agents.enabled=false",
                    "--config",
                    "mcp_servers={}",
                    "--config",
                    "features.rollout_budget.enabled=true",
                    "--config",
                    (
                        "features.rollout_budget.limit_tokens="
                        f"{remaining_tokens}"
                    ),
                    "--config",
                    (
                        "features.rollout_budget."
                        "reminder_at_remaining_tokens="
                        f"{reminder_config}"
                    ),
                    "--output-last-message",
                    str(answer_path),
                    "-",
                ],
                input=prompt,
                text=True,
                capture_output=True,
                timeout=self.timeout_seconds,
                check=False,
            )
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            events = []
            for line in result.stdout.splitlines():
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            usage = self._usage(events)
            usage["model_ms"] = elapsed_ms
            self.weighted_tokens += (
                usage["new_input_tokens"] + usage["output_tokens"]
            )
            record = {
                "schema_version": "liveprobe-eval-ledger/v1",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "run_id": os.environ.get("EVAL_RUN_ID", "praxis-fair"),
                "arm": "praxis",
                "incident_id": os.environ.get("EVAL_INCIDENT_ID", "unknown"),
                "seed": self.seed,
                "model": self.model,
                "kind": "model_call",
                "phase": f"praxis_internal_{self.call_index}",
                "prompt_sha256": _sha256(prompt),
                "response_sha256": (
                    _sha256(answer_path.read_text())
                    if answer_path.exists()
                    else None
                ),
                "status": "completed" if result.returncode == 0 else "failed",
                "provider_reported": bool(
                    any(
                        event.get("type") == "turn.completed"
                        and event.get("usage")
                        for event in events
                    )
                ),
                "usage_scope": "single_tool_free_codex_call",
                "model_sample_count_source": "exact_process_call",
                "usage": usage,
            }
            with self.ledger_path.open("a") as ledger:
                ledger.write(json.dumps(record) + "\n")
            if self.weighted_tokens > self.token_budget:
                raise RuntimeError(
                    f"PRAXIS LLM weighted token budget exceeded: "
                    f"{self.weighted_tokens} > {self.token_budget}"
                )
            if result.returncode != 0 or not answer_path.exists():
                # `codex exec --json` writes its event stream, including error
                # events, to stdout and often exits non-zero with an empty
                # stderr. Reporting stderr alone then yields "Codex backend
                # failed (1): " with no cause, which is what campaign r11
                # incident 401 produced. Fall back to stdout, and say so when
                # the process succeeded but wrote no answer.
                detail = result.stderr.strip() or result.stdout.strip()
                reason = (
                    f"exit {result.returncode}"
                    if result.returncode != 0
                    else f"exit 0 but no answer written to {answer_path}"
                )
                raise RuntimeError(
                    f"Codex backend failed ({reason}): "
                    f"{detail[-4000:] or '<no stderr or stdout captured>'}"
                )
            return answer_path.read_text()

    def function_calling_inference(
        self, system_prompt: str, input: str, tools=None
    ):
        return self.inference(system_prompt, input)


class ContractBackend:
    """Deterministic zero-model backend for the pre-paid PRAXIS tripwire."""

    def __init__(self):
        self.call_index = 0

    def inference(self, system_prompt: str, input: str, **_kwargs):
        self.call_index += 1
        prompt = f"{system_prompt}\n{input}".lower()
        if "return your selection as a json array" in prompt:
            return json.dumps(
                [
                    {
                        "name": "recommendation",
                        "type": "Service",
                        "namespace": "otel-demo",
                        "reason_for_selection": (
                            "Deterministic adapter contract selection."
                        ),
                    }
                ]
            )
        if '"code_context_insights"' in prompt:
            return json.dumps(
                {
                    "code_context_insights": (
                        "Incident-specific code context loaded successfully."
                    ),
                    "incident_investigation_direction_suggestions": (
                        "Continue with the recommendation entity."
                    ),
                    "conjectured_root_causes": [
                        "Contract-only recommendation hypothesis"
                    ],
                    "citations": [],
                }
            )
        if (
            "select an exploration action for the next step" in prompt
            or '"next_action"' in prompt
        ):
            return json.dumps(
                {
                    "next_action": "COMPLETE",
                    "block_id": None,
                    "explanation": "Contract traversal reached a terminal block.",
                    "code_insight_summary": {
                        "insight_gained": (
                            "The incident-specific program graph was loaded."
                        ),
                        "narrative": (
                            "This response validates PRAXIS program-analysis "
                            "plumbing without making a benchmark diagnosis."
                        ),
                    },
                }
            )
        if "entity_judgment" in prompt:
            return json.dumps(
                {
                    "entity_judgment": {
                        "judgment": "PRIMARY_FAILURE",
                        "reason": (
                            "Deterministic contract judgment for adapter "
                            "control-flow validation."
                        ),
                        "identified_facts": [
                            "Snapshot-backed entity data was available."
                        ],
                        "symptoms": "Contract-only symptom.",
                    },
                    "investigation_summary": {
                        "executive_summary": (
                            "The adapter traversed one snapshot-backed entity."
                        ),
                        "investigation_narrative": (
                            "This is not a model or accuracy result."
                        ),
                        "critical_insights": [],
                        "current_findings": {},
                        "next_steps_recommendation": [],
                    },
                }
            )
        if "forced_primary_failures" in prompt:
            return json.dumps(
                {
                    "forced_primary_failures": [
                        {
                            "entity_name": "recommendation",
                            "entity_id": "recommendation",
                            "confidence": 0.0,
                            "reasoning": "Contract-only fallback.",
                        }
                    ],
                    "summary": "Contract fallback.",
                    "reasoning": "No model was called.",
                }
            )
        if "root_cause_analysis" in prompt:
            return json.dumps(
                {
                    "incident_summary": "Contract-only PRAXIS report.",
                    "root_cause_analysis": [
                        {
                            "root_cause_entity": "recommendation",
                            "reason": "Adapter contract validation.",
                            "failure_propagation": {
                                "description": "Contract-only path.",
                                "chain": [],
                            },
                        }
                    ],
                    "exonerated_entities": [],
                    "remediation_recommendations": [],
                }
            )
        if "resolving a previously deferred entity" in prompt:
            return json.dumps(
                {
                    "judgment": "PRIMARY_FAILURE",
                    "confidence": 0.0,
                    "reason": "Contract-only deferred resolution.",
                }
            )
        return "{}"

    def function_calling_inference(
        self, system_prompt: str, input: str, tools=None
    ):
        return self.inference(system_prompt, input)


def _instrument_tool_calls(cls, names: list[str]):
    for method_name in names:
        original = getattr(cls, method_name)
        if getattr(original, "_liveprobe_ledgered", False):
            continue

        def wrapped(self, *args, __original=original, __name=method_name, **kwargs):
            arguments = {"args": args, "kwargs": kwargs}
            try:
                result = __original(self, *args, **kwargs)
            except Exception as error:
                self.snapshot.record_tool(
                    f"{self.__class__.__name__}.{__name}",
                    arguments,
                    {"error": str(error)},
                    status="failed",
                )
                raise
            self.snapshot.record_tool(
                f"{self.__class__.__name__}.{__name}",
                arguments,
                result,
            )
            return result

        wrapped._liveprobe_ledgered = True
        setattr(cls, method_name, wrapped)


def install_snapshot_adapters(
    snapshot_path: str, ledger_path: str | None = None
):
    snapshot = Snapshot(snapshot_path, ledger_path)
    instrumented = {
        SnapshotGraphTraversal: ["search", "get_node_by_id"],
        SnapshotAlertsTool: ["get_alerts_with_entity_ids"],
        SnapshotHealthTool: ["get_health_list"],
        SnapshotLeafRCA: ["_run"],
        SnapshotTraceErrorTree: ["get_error_tree_analysis"],
        SnapshotServiceInteraction: ["build_context"],
        SnapshotJaeger: ["get_calls", "get_raw_spans_for_pfsp"],
        SnapshotDataGatherer: [
            "_execute_kubectl_command",
            "get_all_entities",
            "get_all_entities_by_types",
            "build_contextual_analysis",
        ],
    }
    for cls, methods in instrumented.items():
        _instrument_tool_calls(cls, methods)
    for cls in [
        SnapshotGraphTraversal,
        SnapshotAlertsTool,
        SnapshotHealthTool,
        SnapshotLeafRCA,
        SnapshotTraceErrorTree,
        SnapshotServiceInteraction,
        SnapshotJaeger,
        SnapshotDataGatherer,
    ]:
        cls.snapshot = snapshot
    return snapshot
