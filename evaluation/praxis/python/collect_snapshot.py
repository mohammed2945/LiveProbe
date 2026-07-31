#!/usr/bin/env python3
"""Capture one immutable PRAXIS/Astronomy Shop observability snapshot.

The collector reads only public incident signals: Prometheus alerts/metrics,
ClickHouse spans, Kubernetes logs/events/resources, and topology derivable from
those signals. Fault-injection roles and ground truth are never opened.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


TRACE_RE = re.compile(
    r"(?:trace[_-]?id|traceId)[\"'=:\s]+([0-9a-fA-F]{16,32})"
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--incident-id", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--detected-at")
    parser.add_argument("--window-minutes", type=int, default=10)
    parser.add_argument(
        "--window-start",
        help=(
            "Absolute ISO start of the evidence window. Prefer this over "
            "--window-minutes: a fixed lookback sweeps in whatever ran before "
            "this incident. Campaign r13 soaked each incident for only 36-164s "
            "inside a 10-minute window, so 92-94%% of every snapshot was the "
            "previous incident, and incident 407's snapshot carried incident "
            "401's traceback."
        ),
    )
    parser.add_argument("--namespace", default="otel-demo")
    parser.add_argument("--services", required=True)
    parser.add_argument("--prometheus-url", default="http://localhost:8080")
    parser.add_argument(
        "--clickhouse-url", default="http://localhost:8080/clickhouse"
    )
    parser.add_argument("--clickhouse-table", default="otel_demo_traces")
    parser.add_argument("--trace-limit", type=int, default=3)
    parser.add_argument("--span-limit", type=int, default=5000)
    parser.add_argument("--log-limit-per-service", type=int, default=500)
    parser.add_argument(
        "--replay-base-url", default="http://localhost:8081"
    )
    return parser.parse_args()


def utc(value: str | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.astimezone(timezone.utc)


def iso(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def evidence_id(prefix: str, value: Any) -> str:
    digest = hashlib.sha256(
        json.dumps(value, sort_keys=True, default=str).encode()
    ).hexdigest()[:20]
    return f"{prefix}_{digest}"


def http_json(url: str, query: dict[str, str] | None = None):
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    request = urllib.request.Request(
        url, headers={"Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"HTTP {error.code} from {error.url}: {body[:4000]}"
        ) from error


def kubectl_json(args: list[str]):
    result = subprocess.run(
        ["kubectl", *args],
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"kubectl {' '.join(args)} failed: {result.stderr[-2000:]}"
        )
    return json.loads(result.stdout)


def kubectl_logs(
    namespace: str,
    service: str,
    start: datetime,
    limit: int,
):
    selectors = [
        f"app.kubernetes.io/component={service}",
        f"app.kubernetes.io/name={service}",
    ]
    output = ""
    for selector in selectors:
        result = subprocess.run(
            [
                "kubectl",
                "logs",
                "-n",
                namespace,
                "-l",
                selector,
                "--all-containers=true",
                f"--since-time={iso(start)}",
                "--timestamps=true",
                f"--tail={limit}",
            ],
            text=True,
            capture_output=True,
            timeout=120,
            check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            output = result.stdout
            break
    records = []
    for line in output.splitlines()[-limit:]:
        timestamp, _, message = line.partition(" ")
        if not message:
            message = timestamp
            timestamp = iso(start)
        trace = TRACE_RE.search(message)
        severity = "ERROR" if re.search(r"\b(error|exception|failed)\b", message, re.I) else "INFO"
        record = {
            "timestamp": timestamp,
            "service": service,
            "severity": severity,
            "trace_id": trace.group(1).lower() if trace else None,
            "message": message[:16000],
        }
        record["evidence_id"] = evidence_id("log", record)
        records.append(record)
    return records


def prometheus_alerts(base_url: str):
    payload = http_json(
        f"{base_url.rstrip('/')}/prometheus/api/v1/alerts"
    )
    alerts = []
    for item in payload.get("data", {}).get("alerts", []):
        if str(item.get("state", "")).lower() not in {"alerting", "firing"}:
            continue
        labels = item.get("labels", {})
        annotations = item.get("annotations", {})
        alert = {
            "name": labels.get("alertname", "Alert"),
            "service": labels.get(
                "service_name", labels.get("service", "unknown")
            ),
            "state": item.get("state"),
            "severity": labels.get("severity"),
            "description": annotations.get("description", ""),
            "active_at": item.get("activeAt"),
        }
        alert["evidence_id"] = evidence_id("alert", alert)
        alerts.append(alert)
    return alerts


def clickhouse_spans(
    url: str,
    table: str,
    start: datetime,
    end: datetime,
    limit: int,
):
    safe_table = re.fullmatch(r"[A-Za-z0-9_]+", table)
    if safe_table is None:
        raise ValueError("ClickHouse table contains unsafe characters")
    query = f"""
SELECT
  TraceId, SpanId, ParentSpanId, ServiceName, SpanName, SpanKind,
  Timestamp, Duration, StatusCode, StatusMessage, SpanAttributes
FROM {table}
WHERE Timestamp >= parseDateTime64BestEffort('{start.isoformat()}', 9)
  AND Timestamp <= parseDateTime64BestEffort('{end.isoformat()}', 9)
ORDER BY Timestamp DESC
LIMIT {int(limit)}
FORMAT JSON
""".strip()
    return http_json(url, {"query": query}).get("data", [])


def normalize_traces(rows: list[dict[str, Any]], trace_limit: int):
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        trace_id = str(row.get("TraceId", "")).lower()
        if trace_id:
            grouped[trace_id].append(row)
    traces = []
    for trace_id, spans in grouped.items():
        has_error = any(
            str(span.get("StatusCode", "")).lower()
            not in {"", "0", "ok", "unset", "status_code_unset"}
            or bool(span.get("StatusMessage"))
            for span in spans
        )
        if not has_error:
            continue
        spans.sort(key=lambda item: str(item.get("Timestamp", "")))
        normalized = []
        for span in spans:
            duration = span.get("Duration", 0)
            try:
                duration_ms = float(duration) / 1_000_000
            except (TypeError, ValueError):
                duration_ms = 0
            normalized.append(
                {
                    "span_id": str(span.get("SpanId", "")).lower(),
                    "parent_span_id": (
                        str(span.get("ParentSpanId", "")).lower() or None
                    ),
                    "service": span.get("ServiceName", "unknown"),
                    "operation": span.get("SpanName", "unknown"),
                    "status": span.get("StatusCode", "UNSET"),
                    "status_message": span.get("StatusMessage"),
                    "duration_ms": duration_ms,
                    "attributes": span.get("SpanAttributes", {}),
                }
            )
        started = str(spans[0].get("Timestamp"))
        trace = {
            "trace_id": trace_id,
            "started_at": started,
            "duration_ms": max(
                (item["duration_ms"] for item in normalized), default=0
            ),
            "status": "ERROR",
            "spans": normalized,
        }
        trace["evidence_id"] = evidence_id("trace", trace)
        traces.append(trace)
    traces.sort(
        key=lambda item: (item["started_at"], item["duration_ms"]),
        reverse=True,
    )
    return traces[:trace_limit]


def trace_summaries(traces: list[dict[str, Any]]):
    summaries = []
    for trace in traces:
        services = []
        for span in trace["spans"]:
            if span["service"] not in services:
                services.append(span["service"])
        summary = {
            "trace_id": trace["trace_id"],
            "root_service": services[0] if services else "unknown",
            "root_operation": (
                trace["spans"][0]["operation"]
                if trace["spans"]
                else "unknown"
            ),
            "status": trace["status"],
            "error_path": services,
        }
        summary["evidence_id"] = evidence_id("trace_summary", summary)
        summaries.append(summary)
    return summaries


def prometheus_metric(
    base_url: str,
    service: str,
    name: str,
    query: str,
    start: datetime,
    end: datetime,
):
    payload = http_json(
        f"{base_url.rstrip('/')}/prometheus/api/v1/query_range",
        {
            "query": query,
            "start": str(start.timestamp()),
            "end": str(end.timestamp()),
            "step": "30",
        },
    )
    points = []
    for series in payload.get("data", {}).get("result", []):
        for timestamp, value in series.get("values", []):
            try:
                points.append(
                    [iso(datetime.fromtimestamp(float(timestamp), timezone.utc)), float(value)]
                )
            except (TypeError, ValueError):
                continue
    metric = {
        "service": service,
        "name": name,
        "unit": "ratio" if "rate" in name else "count",
        "query": query,
        "points": points,
    }
    metric["evidence_id"] = evidence_id("metric", metric)
    return metric


def capture_resources(namespace: str):
    payload = kubectl_json(
        [
            "get",
            "deployment,service,pod,configmap,statefulset",
            "-n",
            namespace,
            "-o",
            "json",
        ]
    )
    resources = []
    deployments = []
    for item in payload.get("items", []):
        metadata = item.get("metadata", {})
        resource = {
            "namespace": metadata.get("namespace", namespace),
            "kind": item.get("kind", "Unknown"),
            "name": metadata.get("name", "unknown"),
            "state": {
                "labels": metadata.get("labels", {}),
                "annotations": metadata.get("annotations", {}),
                "resource_version": metadata.get("resourceVersion"),
                "spec": item.get("spec", {}),
                "status": item.get("status", {}),
                "data": item.get("data", {}),
            },
        }
        resource["evidence_id"] = evidence_id("resource", resource)
        resources.append(resource)
        if item.get("kind") == "Deployment":
            deployment = {
                "service": metadata.get("labels", {}).get(
                    "app.kubernetes.io/component", metadata.get("name")
                ),
                "deployed_at": metadata.get("creationTimestamp"),
                "revision": metadata.get("annotations", {}).get(
                    "deployment.kubernetes.io/revision",
                    metadata.get("resourceVersion"),
                ),
                "change_summary": "current deployment state captured",
            }
            deployment["evidence_id"] = evidence_id(
                "deployment", deployment
            )
            deployments.append(deployment)
    return resources, deployments


def capture_events(namespace: str, start: datetime, end: datetime):
    """Namespace events inside the incident's own window.

    Unwindowed events leak across incidents just as spans do: a rollout event
    naming a previous incident's image tells the agent which other faults have
    been staged on this cluster. Campaign r13 carried up to four foreign
    incident images this way, and the leakage survived the span-window fix
    because events were never filtered at all.
    """
    payload = kubectl_json(
        ["get", "events", "-n", namespace, "-o", "json"]
    )
    events = []
    for item in payload.get("items", []):
        involved = item.get("involvedObject", {})
        stamp = (
            item.get("eventTime")
            or item.get("lastTimestamp")
            or item.get("metadata", {}).get("creationTimestamp")
        )
        if stamp:
            try:
                observed = utc(stamp)
            except ValueError:
                observed = None
            # Keep an unparseable stamp rather than silently dropping evidence;
            # drop anything demonstrably outside this incident's window.
            if observed is not None and not (start <= observed <= end):
                continue
        event = {
            "timestamp": stamp,
            "namespace": involved.get("namespace", namespace),
            "kind": involved.get("kind", "Unknown"),
            "name": involved.get("name", "unknown"),
            "reason": item.get("reason"),
            "message": item.get("message", ""),
            "type": item.get("type"),
        }
        event["evidence_id"] = evidence_id("event", event)
        events.append(event)
    return events


def topology(traces, resources):
    nodes = {}
    edges = {}
    for trace in traces:
        span_by_id = {span["span_id"]: span for span in trace["spans"]}
        for span in trace["spans"]:
            nodes[span["service"]] = {
                "id": span["service"],
                "kind": "Service",
                "namespace": "otel-demo",
            }
            parent = span_by_id.get(span["parent_span_id"])
            if parent and parent["service"] != span["service"]:
                edge = {
                    "from": parent["service"],
                    "to": span["service"],
                    "kind": "TRACE_CALL",
                }
                edges[_canonical(edge)] = edge
    for resource in resources:
        key = f"{resource['kind']}/{resource['name']}"
        nodes.setdefault(
            key,
            {
                "id": key,
                "kind": resource["kind"],
                "namespace": resource["namespace"],
            },
        )
    return {"nodes": list(nodes.values()), "edges": list(edges.values())}


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def main():
    args = parse_args()
    detected = utc(args.detected_at)
    start = (
        utc(args.window_start)
        if args.window_start
        else detected - timedelta(minutes=args.window_minutes)
    )
    if start >= detected:
        raise SystemExit(
            f"window start {iso(start)} is not before detection {iso(detected)}"
        )
    services = [item.strip() for item in args.services.split(",") if item.strip()]
    alerts = prometheus_alerts(args.prometheus_url)
    rows = clickhouse_spans(
        args.clickhouse_url,
        args.clickhouse_table,
        start,
        detected,
        args.span_limit,
    )
    traces = normalize_traces(rows, args.trace_limit)
    logs = []
    for service in services:
        logs.extend(
            kubectl_logs(
                args.namespace,
                service,
                start,
                args.log_limit_per_service,
            )
        )
    metrics = []
    for service in services:
        escaped = service.replace('"', '\\"')
        metrics.append(
            prometheus_metric(
                args.prometheus_url,
                service,
                "request_error_rate",
                (
                    "sum(rate(traces_span_metrics_calls_total"
                    f'{{service_name="{escaped}",status_code="STATUS_CODE_ERROR"}}[5m]))'
                ),
                start,
                detected,
            )
        )
        metrics.append(
            prometheus_metric(
                args.prometheus_url,
                service,
                "request_rate",
                (
                    "sum(rate(traces_span_metrics_calls_total"
                    f'{{service_name="{escaped}"}}[5m]))'
                ),
                start,
                detected,
            )
        )
    resources, deployments = capture_resources(args.namespace)
    events = capture_events(args.namespace, start, detected)
    snapshot = {
        "schema_version": "observability-snapshot/v1",
        "snapshot_id": f"praxis-{args.incident_id}-{detected.strftime('%Y%m%dT%H%M%S')}",
        "revision": "pending",
        "incident_id": str(args.incident_id),
        "detected_at": iso(detected),
        "window": {"start": iso(start), "end": iso(detected)},
        "synthetic": False,
        "bootstrap": {
            "alerts": alerts,
            "failing_trace_summaries": trace_summaries(traces),
        },
        "logs": logs,
        "traces": traces,
        "metrics": metrics,
        "events": events,
        "resources": resources,
        "deployments": deployments,
        "topology": topology(traces, resources),
        "replay_recipes": [
            {
                "recipe_id": "astronomy-recommendations",
                "description": "Replay the failing Astronomy Shop recommendation request",
                "expected_root_service": "frontend",
                "enabled": True,
                "method": "GET",
                "path": "/api/recommendations?productIds=0PUK6V6EV0",
                "base_url": args.replay_base_url,
            }
        ],
    }
    snapshot["revision"] = f"sha256:{hashlib.sha256(_canonical(snapshot).encode()).hexdigest()}"
    Path(args.output).write_text(json.dumps(snapshot, indent=2) + "\n")


if __name__ == "__main__":
    main()
