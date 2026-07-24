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
  npx -y @doomslayer2945/liveprobe-mcp@0.3.0 \
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
        "@doomslayer2945/liveprobe-mcp@0.3.0",
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

The package exposes twenty-three tools: four probe setters, `list_services`,
`list_probes`, `get_probe_data`, `remove_probe`, `ping_broker`,
`get_safety_overview`, `list_audit_events`, project/environment/service
catalog management tools, and the self-service
`create_service_credential`, `list_service_credentials`, and
`revoke_service_credential` tools. All Clerk organization members have the
same pilot permissions within their organization. Tool failures return
structured JSON guidance for bad credentials, insufficient roles, unknown
services, missing probes, and an unreachable broker.

Operational tools accept `project_id` and `environment_id`. Use the same
project/environment pair as the target runtime agent. This allows the same
`service_id` to run independently in environments such as `staging` and
`production`; probes, events, service status, and safety data never cross that
routing boundary.

`list_services` and `get_safety_overview` distinguish `managed-runtime` from
`native-ebpf` services. Native entries include agent-reported executable
`buildIds`, instance counts, safe capability intersections, and native-specific
limitations. `sourceCommit`/MCP `commit_hash` remains user-supplied source and
audit metadata; a native `buildId` identifies the executable actually observed
by the host agent. MCP creates only logical probes and never registers agents,
constructs physical sites, or communicates with the BPF loader.

Run `npx -y @doomslayer2945/liveprobe-mcp@0.3.0 --help` for CLI options.
