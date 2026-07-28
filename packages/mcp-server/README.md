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
