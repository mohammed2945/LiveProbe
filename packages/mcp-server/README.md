# LiveProbe MCP

MCP tools for connecting AI clients to a running LiveProbe broker. Hosted
deployments expose Streamable HTTP with Clerk OAuth; the npm package retains a
stdio mode for local development and break-glass operation.

## Hosted configuration

No package or API key is required on the user's machine. Add the hosted URL to
an OAuth-capable MCP client:

```json
{
  "mcpServers": {
    "liveprobe": {
      "url": "https://liveprobe.tryastrea.tech/mcp"
    }
  }
}
```

The client opens Clerk in the browser. The user signs in, selects a workspace,
and grants access. The MCP client owns access-token refresh and secure token
storage. LiveProbe receives the selected Clerk organization ID and uses it as
the tenant boundary.

## Local stdio fallback

```sh
LIVEPROBE_API_KEY="your-shared-key" \
  npx -y @doomslayer2945/liveprobe-mcp@0.1.1 \
  --broker-url http://HOST:7070
```

`--broker-url` takes precedence over `BROKER_URL`. If neither is supplied, the
server connects to `http://127.0.0.1:7070`.

`LIVEPROBE_API_KEY` must match the broker key. `ping_broker` uses an
authenticated endpoint, so it verifies both connectivity and credentials.

### Cursor stdio configuration

Add this server to your Cursor MCP configuration:

```json
{
  "mcpServers": {
    "liveprobe": {
      "command": "npx",
      "args": [
        "-y",
        "@doomslayer2945/liveprobe-mcp@0.1.1",
        "--broker-url",
        "http://HOST:7070"
      ],
      "env": {
        "LIVEPROBE_API_KEY": "your-shared-key"
      }
    }
  }
}
```

The package exposes 21 tools. The original probe/control surface and legacy
frontier workflow remain available. The runtime-guided investigation workflow
adds `start_probe_investigation`, `get_investigation_context`,
`deploy_investigation_probes`, `collect_investigation_evidence`,
`apply_investigation_decision`, and `get_investigation_result`.

The analysis commands run the separate operator-side `liveprobe-analysis`
Python package; target services never build or retain source graphs. The MCP
server does not call a model. An AI SRE reads the bounded investigation packet,
and selects only revision-scoped action IDs supplied by the analyzer.
Exploration requires no hypothesis. A structured candidate mechanism with
validated anchors and predicted probe observations is accepted only for the
final confirmation replay.

Every tool that returns an investigation view — `start_probe_investigation`,
`get_investigation_context`, `collect_investigation_evidence`, and
`apply_investigation_decision` — takes a `detail` argument. It defaults to
`compact`, which returns the decision surface (ids, phase, revision, legal
`actions`, `probe_bundle`, `value_dossiers`, `judgments`, `mechanism_context`,
`decision_context`, `decision_aliases`, `decision_log`, `stats`) and replaces
the structural `graph` with `graph_summary` counts. No tool accepts a graph
node, edge, projection or traversal record as an argument, so the compact view
is sufficient to drive an investigation to a terminal status; on a measured
three-module service it is 4.7 KB where the full view is 41 KB. Pass
`detail: "full"` to render or audit the graph itself, and use
`get_investigation_result` for the complete judgment and decision history.

`get_probe_data` returns `{probe, status, events, stacks?}`. Captured runtime
values are the product of the tool, so `variables`, `watches`, log messages,
counter and metric aggregates, `ts` and the whole `correlation` block are
returned verbatim on every occurrence. What it does not repeat is the part that
carries no evidence: the per-event `probeId` echo, since the response is for one
probe that `probe.id` already names; a `capture` block that reports no
truncation, since `watchValues` is a schema literal and `complete` is the
absence of a problem; and identical stacks, which are deduplicated into `stacks`
and referenced by `stackId`, so a genuinely different call path is still
reported. On 25 Python-SDK-shaped occurrences this is 30.2 KB where the raw
broker payload is 49.5 KB.

Captured occurrences are bounded by `max_events`, default 25, keeping the
newest — a replay is driven after arming, so the correlated occurrence is the
most recent. Status events are never capped, because `armed` and `error` are how
a caller learns a probe is live or was rejected. A response that dropped any
occurrence says so in `eventsOmitted`; re-request with a larger `max_events`,
or redeploy with `correlation_trace_id` so the runtime captures only the
occurrence under test.

`start_probe_investigation` accepts `ownership_map` entries mapping source
roots to deployed service IDs. The analyzer keeps canonical source regions
owner-neutral and carries those service IDs in separate runtime traversal
records. Probe bundles therefore contain an authoritative `service_id` and
their contributing `traversal_ids`; deployment does not infer a target service
from the probe file path.

For a source checkout:

```sh
python3.12 -m pip install ./python/analyzer
```

Set `LIVEPROBE_ANALYZER_PYTHON` when `python3.12` is not on the MCP server's
PATH. Set `LIVEPROBE_ANALYZER_PYTHONPATH` only for an unpackaged development
checkout. Tool failures return structured guidance for analysis, credentials,
roles, unknown services, missing probes, and broker connectivity.

Run `npx -y @doomslayer2945/liveprobe-mcp@0.1.1 --help` for CLI options.
