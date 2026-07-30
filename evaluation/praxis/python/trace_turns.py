#!/usr/bin/env python3
"""Attribute a run's token cost to the tool responses that caused it.

The campaign already knows what a run cost in aggregate (``new_input_tokens``
plus ``output_tokens``, the rollout-weighted total) and what every individual
tool response cost in bytes. What it could not say is *which* tool response
preceded which token jump. This script joins the two.

Two input paths, in descending order of fidelity:

``event``
    The raw Codex ``--json`` stream persisted beside the ledger by
    ``agent-runner.mjs`` (``*.events.jsonl.gz``). Codex emits a ``token_count``
    event after every model sampling request, carrying both
    ``info.total_token_usage`` (cumulative) and ``info.last_token_usage`` (that
    request alone). Deltas between consecutive ``token_count`` events are exact,
    and the ``item.completed`` entries between them name the tool outputs that
    entered the context in between. When a stream has no ``token_count`` events
    the run's single ``turn.completed`` aggregate is used instead and steps are
    reconstructed from item order, which is exact in ordering and estimated in
    tokens.

``ledger``
    Ledger JSONL only. Every campaign before this script existed is in this
    bucket, because the event stream was parsed for aggregates and thrown away.
    Model steps are recovered by clustering ``tool_call`` timestamps: tools
    issued by one assistant message land within milliseconds of each other,
    while the next step is separated by model latency. Tokens are then
    apportioned across tool responses by byte share. Ordering and bytes are
    measured; the token column is explicitly an estimate and is labelled as one
    everywhere it appears.

Nothing here is scoring code and nothing here feeds a headline metric. It reads
artifacts after the fact (``PRE_REGISTRATION.md`` rule 7: no threshold moves).

Usage::

    trace_turns.py --run-dir results/artifacts/praxis-campaign-r12/incident-410
    trace_turns.py --ledger run.jsonl --events run.events.jsonl.gz
    trace_turns.py --run-dir <campaign> --format json --output trace.json
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
from datetime import datetime
from pathlib import Path

SCHEMA_VERSION = "praxis-turn-trace/v1"

# Only used for the coarse "how many tokens is this payload" reading in the
# ledger-only path. Deliberately a single documented constant rather than a
# tuned parameter: it is a unit conversion for a diagnostic, not a threshold.
BYTES_PER_TOKEN = 4.0

# Tool calls issued by one assistant message are appended to the ledger within
# milliseconds of each other; the next model step costs whole seconds of
# provider latency. Anything under this gap is treated as the same step.
DEFAULT_STEP_GAP_MS = 1_000

# The event stream and the ledger both contain prompt and response text or its
# hashes. A path under one of these names is evaluation-side forensic data and
# is never an agent-visible artifact.
LEDGER_SUFFIX = ".jsonl"
EVENT_SUFFIX = ".events.jsonl.gz"


# --------------------------------------------------------------------------
# Loading


def read_jsonl(path: Path) -> list[dict]:
    """Read JSONL, tolerating the non-JSON diagnostics Codex writes to stdout."""
    opener = gzip.open if path.suffix == ".gz" else open
    records = []
    with opener(path, "rt", encoding="utf8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                records.append(value)
    return records


def parse_timestamp(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def discover_runs(root: Path) -> list[tuple[Path, Path | None]]:
    """Find (ledger, event stream) pairs under a run, incident or campaign dir."""
    pairs = []
    for ledger in sorted(root.rglob(f"*{LEDGER_SUFFIX}")):
        if ledger.name.endswith((EVENT_SUFFIX, ".events.jsonl", ".gz")):
            continue
        events = Path(str(ledger)[: -len(LEDGER_SUFFIX)] + EVENT_SUFFIX)
        if not events.exists():
            plain = Path(str(ledger)[: -len(LEDGER_SUFFIX)] + ".events.jsonl")
            events = plain if plain.exists() else None
        pairs.append((ledger, events))
    return pairs


# --------------------------------------------------------------------------
# Ledger


def split_ledger(records: list[dict]) -> tuple[list[dict], list[dict], dict]:
    """Split a ledger into ordered tool calls, model calls, and run identity."""
    tools, models = [], []
    identity: dict = {}
    for index, record in enumerate(records):
        if not identity:
            identity = {
                key: record.get(key)
                for key in ("run_id", "arm", "incident_id", "seed", "model")
                if record.get(key) is not None
            }
        kind = record.get("kind")
        if kind == "tool_call":
            tools.append(
                {
                    "order": index,
                    "epoch": parse_timestamp(record.get("timestamp")),
                    "timestamp": record.get("timestamp"),
                    "server": record.get("server") or "unknown",
                    "tool": record.get("tool") or "unknown",
                    "response_bytes": int(record.get("response_bytes") or 0),
                    # The observability store records a status only on failure;
                    # the LiveProbe proxy always records one.
                    "status": record.get("status") or "completed",
                    "evidence_ids": len(record.get("evidence_ids") or []),
                }
            )
        elif kind == "model_call":
            models.append(record)
    # Multiple writers append to one file, so file order is not time order.
    tools.sort(key=lambda item: (item["epoch"] is None, item["epoch"], item["order"]))
    return tools, models, identity


def aggregate_usage(models: list[dict]) -> dict:
    total = {
        "model_calls": 0,
        "model_samples": 0,
        "input_tokens": 0,
        "cached_input_tokens": 0,
        "new_input_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "model_ms": 0,
        # Counted from Codex items, so this includes shell commands, which never
        # reach the ledger. The difference against the ledger's own tool_call
        # count is the size of the ledger's blind spot.
        "tool_calls": 0,
    }
    for record in models:
        usage = record.get("usage") or {}
        for key in total:
            total[key] += int(usage.get(key) or 0)
    total["weighted_tokens"] = total["new_input_tokens"] + total["output_tokens"]
    return total


def cluster_steps(tools: list[dict], gap_ms: int) -> list[list[dict]]:
    """Group tool calls into the model step that issued them."""
    steps: list[list[dict]] = []
    for call in tools:
        if not steps:
            steps.append([call])
            continue
        previous = steps[-1][-1]
        if (
            call["epoch"] is None
            or previous["epoch"] is None
            or (call["epoch"] - previous["epoch"]) * 1_000.0 < gap_ms
        ):
            steps[-1].append(call)
        else:
            steps.append([call])
    return steps


# --------------------------------------------------------------------------
# Event stream


def extract_token_samples(events: list[dict]) -> list[dict]:
    """Per-sampling-request usage from Codex ``token_count`` events."""
    samples = []
    for index, event in enumerate(events):
        if event.get("type") != "token_count":
            continue
        info = event.get("info") or {}
        total = info.get("total_token_usage") or {}
        last = info.get("last_token_usage") or {}
        if not total and not last:
            continue
        samples.append(
            {
                "event_index": index,
                "cum_input_tokens": int(total.get("input_tokens") or 0),
                "cum_cached_input_tokens": int(total.get("cached_input_tokens") or 0),
                "cum_output_tokens": int(total.get("output_tokens") or 0),
                "cum_reasoning_tokens": int(total.get("reasoning_output_tokens") or 0),
                "sample_input_tokens": int(last.get("input_tokens") or 0),
                "sample_cached_input_tokens": int(last.get("cached_input_tokens") or 0),
                "sample_output_tokens": int(last.get("output_tokens") or 0),
                "sample_reasoning_tokens": int(last.get("reasoning_output_tokens") or 0),
                "context_window": info.get("model_context_window"),
            }
        )
    return samples


TOOL_ITEM_TYPES = {
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
    "tool_call",
}


def describe_item(item: dict) -> dict | None:
    """Name an ``item.completed`` payload without copying its text content."""
    item_type = str(item.get("type") or item.get("item_type") or "")
    if item_type not in TOOL_ITEM_TYPES:
        return None
    if item_type == "mcp_tool_call":
        server = item.get("server") or "mcp"
        tool = item.get("tool") or "unknown"
    elif item_type == "command_execution":
        server = "shell"
        # First token of the command only: enough to identify it, no arguments.
        command = item.get("command") or ""
        if isinstance(command, list):
            command = " ".join(str(part) for part in command)
        tool = re.split(r"[\s;|&]", str(command).strip())[0] or "sh"
        tool = Path(tool).name
    else:
        server = "codex"
        tool = item_type
    return {
        "server": str(server),
        "tool": str(tool),
        "status": str(item.get("status") or "completed"),
        "item_type": item_type,
    }


def event_turn_usage(events: list[dict]) -> dict:
    usage: dict = {}
    turns = 0
    for event in events:
        if event.get("type") == "turn.completed":
            turns += 1
            if event.get("usage"):
                usage = event["usage"]
    input_tokens = int(usage.get("input_tokens") or 0)
    cached = int(usage.get("cached_input_tokens") or 0)
    return {
        "completed_turns": turns,
        "input_tokens": input_tokens,
        "cached_input_tokens": cached,
        "new_input_tokens": max(0, input_tokens - cached),
        "output_tokens": int(usage.get("output_tokens") or 0),
        "reasoning_tokens": int(usage.get("reasoning_output_tokens") or 0),
    }


def trace_from_events(events: list[dict], tools: list[dict]) -> dict | None:
    """Exact per-sample attribution, when the stream reports per-sample usage."""
    samples = extract_token_samples(events)
    if not samples:
        return None

    # Tool items completed between sample k-1 and sample k are exactly the
    # payloads that grew the prompt sample k paid for.
    boundaries = [sample["event_index"] for sample in samples]
    # One extra bucket for items completed after the final sample: their output
    # never entered any prompt, so no measured token delta can be charged to it.
    buckets: list[list[dict]] = [[] for _ in range(len(samples) + 1)]
    cursor = 0
    for index, event in enumerate(events):
        if event.get("type") != "item.completed":
            continue
        item = event.get("item")
        if not isinstance(item, dict):
            continue
        described = describe_item(item)
        if described is None:
            continue
        while cursor < len(boundaries) and index > boundaries[cursor]:
            cursor += 1
        if cursor < len(buckets):
            buckets[cursor].append(described)

    # The ledger is the only place response sizes exist; match its ordered tool
    # calls onto the event items in order. Shell commands never reach the
    # ledger, so match by name where possible and leave bytes null otherwise.
    ledger_queue = list(tools)

    def attribute(bucket: list[dict]) -> list[dict]:
        attributed = []
        for item in bucket:
            match = None
            for position, call in enumerate(ledger_queue):
                if call["tool"] == item["tool"]:
                    match = ledger_queue.pop(position)
                    break
            attributed.append(
                {
                    **item,
                    "response_bytes": match["response_bytes"] if match else None,
                }
            )
        return attributed

    rows = []
    previous = None
    for index, sample in enumerate(samples):
        attributed = attribute(buckets[index])
        response_bytes = sum(
            item["response_bytes"] or 0 for item in attributed
        )
        row = {
            "turn": index + 1,
            "usage_source": "token_count",
            "cum_input_tokens": sample["cum_input_tokens"],
            "cum_cached_input_tokens": sample["cum_cached_input_tokens"],
            "cum_output_tokens": sample["cum_output_tokens"],
            "cum_reasoning_tokens": sample["cum_reasoning_tokens"],
            "cum_weighted_tokens": (
                sample["cum_input_tokens"]
                - sample["cum_cached_input_tokens"]
                + sample["cum_output_tokens"]
            ),
            "d_input_tokens": sample["cum_input_tokens"]
            - (previous["cum_input_tokens"] if previous else 0),
            "d_cached_input_tokens": sample["cum_cached_input_tokens"]
            - (previous["cum_cached_input_tokens"] if previous else 0),
            "d_output_tokens": sample["cum_output_tokens"]
            - (previous["cum_output_tokens"] if previous else 0),
            "sample_input_tokens": sample["sample_input_tokens"],
            "sample_output_tokens": sample["sample_output_tokens"],
            "preceding_tools": attributed,
            "preceding_tool_response_bytes": response_bytes,
            "largest_preceding_tool": (
                max(
                    attributed,
                    key=lambda item: item["response_bytes"] or 0,
                )["tool"]
                if attributed
                else None
            ),
            "estimated": False,
        }
        row["d_new_input_tokens"] = max(
            0, row["d_input_tokens"] - row["d_cached_input_tokens"]
        )
        row["d_weighted_tokens"] = row["d_new_input_tokens"] + row["d_output_tokens"]
        rows.append(row)
        previous = sample
    trailing = attribute(buckets[-1])
    return {
        "method": "event_stream_token_count",
        "turns": rows,
        "trailing_tools": trailing,
        "trailing_tool_response_bytes": sum(
            item["response_bytes"] or 0 for item in trailing
        ),
    }


def trace_from_ledger(
    tools: list[dict],
    usage: dict,
    gap_ms: int,
    method: str,
) -> dict:
    """Byte-share attribution over timestamp-clustered model steps."""
    steps = cluster_steps(tools, gap_ms)
    total_bytes = sum(call["response_bytes"] for call in tools)
    new_input = usage.get("new_input_tokens", 0)

    rows = []
    cumulative_bytes = 0
    first_epoch = next(
        (call["epoch"] for call in tools if call["epoch"] is not None), None
    )
    previous_epoch = None
    for index, step in enumerate(steps):
        step_bytes = sum(call["response_bytes"] for call in step)
        cumulative_bytes += step_bytes
        epoch = next((call["epoch"] for call in step if call["epoch"]), None)
        share = (step_bytes / total_bytes) if total_bytes else 0.0
        rows.append(
            {
                "turn": index + 1,
                "usage_source": method,
                "offset_ms": (
                    round((epoch - first_epoch) * 1_000)
                    if epoch is not None and first_epoch is not None
                    else None
                ),
                "gap_ms": (
                    round((epoch - previous_epoch) * 1_000)
                    if epoch is not None and previous_epoch is not None
                    else None
                ),
                "tools": [
                    {
                        "server": call["server"],
                        "tool": call["tool"],
                        "response_bytes": call["response_bytes"],
                        "status": call["status"],
                    }
                    for call in step
                ],
                "tool_count": len(step),
                "response_bytes": step_bytes,
                "cum_response_bytes": cumulative_bytes,
                # Two independent readings of the same bytes. The first is a
                # unit conversion; the second distributes the run's measured
                # non-cached input across tool payloads by size. Neither is a
                # measurement of this step's tokens.
                "est_new_input_tokens_by_size": round(
                    step_bytes / BYTES_PER_TOKEN
                ),
                "est_new_input_tokens_by_share": round(new_input * share),
                "share_of_response_bytes": round(share, 4),
                "estimated": True,
            }
        )
        if epoch is not None:
            previous_epoch = epoch
    return {"method": method, "turns": rows}


def per_tool_table(tools: list[dict], usage: dict) -> list[dict]:
    grouped: dict[tuple[str, str], dict] = {}
    for call in tools:
        key = (call["server"], call["tool"])
        entry = grouped.setdefault(
            key,
            {
                "server": call["server"],
                "tool": call["tool"],
                "calls": 0,
                "response_bytes": 0,
                "max_response_bytes": 0,
                "failed": 0,
                "evidence_ids": 0,
            },
        )
        entry["calls"] += 1
        entry["response_bytes"] += call["response_bytes"]
        entry["max_response_bytes"] = max(
            entry["max_response_bytes"], call["response_bytes"]
        )
        entry["evidence_ids"] += call["evidence_ids"]
        if call["status"] not in ("completed", "ok"):
            entry["failed"] += 1

    total_bytes = sum(entry["response_bytes"] for entry in grouped.values())
    new_input = usage.get("new_input_tokens", 0)
    rows = []
    for entry in grouped.values():
        share = (entry["response_bytes"] / total_bytes) if total_bytes else 0.0
        rows.append(
            {
                **entry,
                "mean_response_bytes": round(
                    entry["response_bytes"] / entry["calls"]
                ),
                "share_of_response_bytes": round(share, 4),
                "est_new_input_tokens_by_size": round(
                    entry["response_bytes"] / BYTES_PER_TOKEN
                ),
                "est_new_input_tokens_by_share": round(new_input * share),
            }
        )
    rows.sort(key=lambda row: -row["response_bytes"])
    return rows


# --------------------------------------------------------------------------
# Assembly


def trace_run(ledger_path: Path, events_path: Path | None, gap_ms: int) -> dict:
    records = read_jsonl(ledger_path)
    tools, models, identity = split_ledger(records)
    usage = aggregate_usage(models)

    events: list[dict] = []
    event_usage: dict | None = None
    trace: dict | None = None
    if events_path is not None and events_path.exists():
        events = read_jsonl(events_path)
        event_usage = event_turn_usage(events)
        trace = trace_from_events(events, tools)
        if trace is None:
            # Stream present but no per-sample usage in it: ordering is exact,
            # tokens are not, so fall back to the byte-share estimator and say so.
            trace = trace_from_ledger(
                tools, usage, gap_ms, "event_stream_turn_aggregate"
            )

    if trace is None:
        trace = trace_from_ledger(tools, usage, gap_ms, "ledger_only")

    turns = trace["turns"]
    if trace["method"] == "event_stream_token_count":
        jump_key = "d_weighted_tokens"
    else:
        jump_key = "response_bytes"
    jumps = sorted(turns, key=lambda row: -row.get(jump_key, 0))

    return {
        "schema_version": SCHEMA_VERSION,
        "ledger": str(ledger_path),
        "event_stream": str(events_path) if events_path else None,
        "identity": identity,
        "method": trace["method"],
        "attribution_is_estimated": trace["method"] != "event_stream_token_count",
        "usage": usage,
        "event_stream_usage": event_usage,
        "event_count": len(events),
        "step_gap_ms": gap_ms,
        "tool_calls": len(tools),
        "total_response_bytes": sum(call["response_bytes"] for call in tools),
        "reconstructed_turns": len(turns),
        # The ledger cannot see model steps that issued no tool call (the final
        # answer, and any pure-reasoning step), so the reconstruction is a lower
        # bound on model_samples. A large divergence means the gap threshold is
        # merging or splitting steps and the trace should not be trusted.
        "model_samples_reported": usage.get("model_samples", 0),
        "tool_calls_reported": usage.get("tool_calls", 0),
        # Codex shell reads of the source checkout are model-visible context that
        # no MCP ledger ever sees. Only the event stream can attribute them.
        "tool_calls_invisible_to_ledger": max(
            0, usage.get("tool_calls", 0) - len(tools)
        ),
        "turns": turns,
        "largest_jumps": [row["turn"] for row in jumps[:5]],
        # Tool responses that arrived after the last model sample: real cost to
        # produce, but never re-read by the model, so charged to nothing.
        "trailing_tools": trace.get("trailing_tools", []),
        "trailing_tool_response_bytes": trace.get("trailing_tool_response_bytes", 0),
        "per_tool": per_tool_table(tools, usage),
    }


# --------------------------------------------------------------------------
# Rendering


def render_tools(names: list[str], limit: int = 6) -> str:
    """Keep the table readable; --format json carries the full list."""
    if not names:
        return "-"
    if len(names) <= limit:
        return ", ".join(names)
    return ", ".join(names[:limit]) + f", +{len(names) - limit} more"


def render(report: dict, top: int) -> str:
    identity = report["identity"]
    usage = report["usage"]
    out: list[str] = []
    label = " ".join(
        f"{key}={value}"
        for key, value in identity.items()
        if key in ("arm", "incident_id", "seed")
    )
    out.append("=" * 100)
    out.append(f"{identity.get('run_id', report['ledger'])}  {label}")
    out.append(f"  ledger        {report['ledger']}")
    out.append(f"  event stream  {report['event_stream'] or '(absent)'}")
    out.append(
        f"  method        {report['method']}"
        + ("   [TOKEN COLUMNS ARE ESTIMATES]" if report["attribution_is_estimated"] else "")
    )
    out.append(
        f"  measured      weighted={usage['weighted_tokens']} "
        f"new_input={usage['new_input_tokens']} "
        f"cached_input={usage['cached_input_tokens']} "
        f"output={usage['output_tokens']} "
        f"model_samples={usage['model_samples']} "
        f"model_ms={usage['model_ms']}"
    )
    out.append(
        f"  reconstructed {report['reconstructed_turns']} turns from "
        f"{report['tool_calls']} ledger tool calls "
        f"({report['total_response_bytes']} response bytes, "
        f"gap>={report['step_gap_ms']}ms)"
    )
    if report["tool_calls_invisible_to_ledger"]:
        out.append(
            f"  blind spot    {report['tool_calls_invisible_to_ledger']} of "
            f"{report['tool_calls_reported']} tool calls are shell/file items "
            "with no ledger record; their bytes are unattributed"
        )
    if report["attribution_is_estimated"]:
        out.append(
            "  est_tok~      measured new_input apportioned by response-byte "
            "share; it over-attributes, since prompt, guidance and reasoning "
            "also consume input"
        )
    out.append("")

    if report["method"] == "event_stream_token_count":
        header = (
            f"{'turn':>4} {'cum_in':>9} {'cum_cache':>10} {'cum_out':>8} "
            f"{'d_new_in':>9} {'d_out':>7} {'d_weight':>9} {'bytes':>9}  tools"
        )
        out.append(header)
        out.append("-" * len(header))
        for row in report["turns"]:
            tools = render_tools(
                [
                    f"{item['server']}.{item['tool']}"
                    + (
                        f"({item['response_bytes']}B)"
                        if item["response_bytes"] is not None
                        else ""
                    )
                    for item in row["preceding_tools"]
                ]
            )
            out.append(
                f"{row['turn']:>4} {row['cum_input_tokens']:>9} "
                f"{row['cum_cached_input_tokens']:>10} "
                f"{row['cum_output_tokens']:>8} "
                f"{row['d_new_input_tokens']:>9} {row['d_output_tokens']:>7} "
                f"{row['d_weighted_tokens']:>9} "
                f"{row['preceding_tool_response_bytes']:>9}  {tools}"
            )
    else:
        header = (
            f"{'turn':>4} {'t+ms':>8} {'gap_ms':>7} {'n':>3} {'bytes':>9} "
            f"{'cum_bytes':>10} {'est_tok~':>9} {'share':>7}  tools"
        )
        out.append(header)
        out.append("-" * len(header))
        for row in report["turns"]:
            tools = render_tools(
                [
                    f"{item['server']}.{item['tool']}({item['response_bytes']}B)"
                    for item in row["tools"]
                ]
            )
            out.append(
                f"{row['turn']:>4} "
                f"{'' if row['offset_ms'] is None else row['offset_ms']:>8} "
                f"{'' if row['gap_ms'] is None else row['gap_ms']:>7} "
                f"{row['tool_count']:>3} {row['response_bytes']:>9} "
                f"{row['cum_response_bytes']:>10} "
                f"{row['est_new_input_tokens_by_share']:>9} "
                f"{row['share_of_response_bytes'] * 100:>6.1f}%  {tools}"
            )

    out.append("")
    if report["trailing_tools"]:
        out.append(
            f"  after the last sample: {len(report['trailing_tools'])} tool "
            f"responses ({report['trailing_tool_response_bytes']}B) never "
            "re-entered the prompt"
        )
    out.append(f"  biggest jumps at turns: {report['largest_jumps']}")
    out.append("")
    header = (
        f"{'server':<16} {'tool':<46} {'calls':>5} {'bytes':>10} {'mean':>8} "
        f"{'max':>9} {'share':>7} {'est_tok~':>9}"
    )
    out.append(header)
    out.append("-" * len(header))
    for row in report["per_tool"][:top]:
        out.append(
            f"{row['server']:<16} {row['tool']:<46} {row['calls']:>5} "
            f"{row['response_bytes']:>10} {row['mean_response_bytes']:>8} "
            f"{row['max_response_bytes']:>9} "
            f"{row['share_of_response_bytes'] * 100:>6.1f}% "
            f"{row['est_new_input_tokens_by_share']:>9}"
        )
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Per-turn token attribution for a PRAXIS evaluation run.",
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--run-dir",
        type=Path,
        help="run, incident or campaign directory to search for ledgers",
    )
    source.add_argument("--ledger", type=Path, help="a single ledger JSONL")
    parser.add_argument(
        "--events",
        type=Path,
        help="event stream for --ledger (default: sibling *.events.jsonl.gz)",
    )
    parser.add_argument(
        "--step-gap-ms",
        type=int,
        default=DEFAULT_STEP_GAP_MS,
        help=(
            "ledger-only mode: gap above which two tool calls belong to "
            f"different model steps (default {DEFAULT_STEP_GAP_MS})"
        ),
    )
    parser.add_argument("--format", choices=("table", "json"), default="table")
    parser.add_argument("--top", type=int, default=15)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    if args.ledger is not None:
        events = args.events
        if events is None:
            candidate = Path(
                str(args.ledger)[: -len(LEDGER_SUFFIX)] + EVENT_SUFFIX
            )
            events = candidate if candidate.exists() else None
        pairs = [(args.ledger, events)]
    else:
        pairs = discover_runs(args.run_dir)

    if not pairs:
        print("no ledger JSONL found", file=sys.stderr)
        return 1

    reports = []
    for ledger, events in pairs:
        try:
            reports.append(trace_run(ledger, events, args.step_gap_ms))
        except (OSError, ValueError) as error:
            print(f"{ledger}: {error}", file=sys.stderr)

    if not reports:
        return 1

    if args.format == "json":
        text = json.dumps(
            {"schema_version": SCHEMA_VERSION, "runs": reports}, indent=2
        )
    else:
        text = "\n".join(render(report, args.top) for report in reports)
    if args.output:
        args.output.write_text(text + "\n")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
