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

The package exposes fourteen tools: four probe setters, `list_services`,
`list_probes`, `get_probe_data`, `remove_probe`, `ping_broker`,
`get_safety_overview`, `list_audit_events`, and the self-service
`create_service_credential`, `list_service_credentials`, and
`revoke_service_credential` tools. All Clerk organization members have the
same pilot permissions within their organization. Tool failures return
structured JSON guidance for bad credentials, insufficient roles, unknown
services, missing probes, and an unreachable broker.

Run `npx -y @doomslayer2945/liveprobe-mcp@0.1.1 --help` for CLI options.
