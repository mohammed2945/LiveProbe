# LiveProbe MCP

Laptop-friendly stdio MCP server for connecting AI tools to a running
LiveProbe broker.

## Run with npx

```sh
LIVEPROBE_API_KEY="your-shared-key" \
  npx -y @doomslayer2945/liveprobe-mcp@0.1.1 \
  --broker-url http://HOST:7070
```

`--broker-url` takes precedence over `BROKER_URL`. If neither is supplied, the
server connects to `http://127.0.0.1:7070`.

`LIVEPROBE_API_KEY` must match the broker key. `ping_broker` uses an
authenticated endpoint, so it verifies both connectivity and credentials.

## Cursor configuration

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

The package exposes ten tools: four probe setters, `list_services`,
`list_probes`, `get_probe_data`, `remove_probe`, `ping_broker`, and
`get_safety_overview`. Tool failures return structured JSON guidance for bad
credentials, unknown services, missing probes, and an unreachable broker.

Run `npx -y @doomslayer2945/liveprobe-mcp@0.1.1 --help` for CLI options.
