# LiveProbe Client Setup

This guide is for a team connecting an application and an MCP-capable AI
client to an existing LiveProbe broker. It does not cover deploying the broker.

## 1. Get connection details

The current internal test deployment uses:

- `BROKER_URL`: `https://liveprobe.tryastrea.tech`
- Runtime `LIVEPROBE_API_KEY`: obtain a key created for the exact `serviceId`
- MCP `LIVEPROBE_API_KEY`: obtain the current operator key separately

Do not commit either key to an application repository or paste it into issues,
logs, or recordings. A service key cannot list services, manage probes, or act
as another service. The current MCP operator key can manage all internal-test
resources and must not be placed in the target application. Public traffic
terminates TLS at the Google Cloud load balancer, and HTTP redirects to HTTPS.
The VM origin accepts broker traffic only from Google's load-balancer and
health-check ranges. External port `7070` is not published; it is only the
broker container's internal port.

The public HTTPS endpoint is suitable for internal integration testing with
these bearer credentials. Human identities and tenant isolation are still
required before unrelated customers share the broker.

```sh
export BROKER_URL="https://liveprobe.tryastrea.tech"
export LIVEPROBE_API_KEY="<service-key-provided-separately>"
export GIT_COMMIT="$(git rev-parse HEAD)"
```

`GIT_COMMIT` must be the commit that built the deployed application, not
necessarily the current local checkout. Every agent refuses to start without a
7-64 character hexadecimal commit ID.

Verify network access and credentials before changing the application:

```sh
curl --fail --silent --show-error "$BROKER_URL/healthz"
curl --fail --silent --show-error "$BROKER_URL/readyz"
curl --fail --silent --show-error \
  -H "Authorization: Bearer $LIVEPROBE_API_KEY" \
  "$BROKER_URL/v1/ping"
```

Each command should return `{"ok":true}`. A `401` means the API key is invalid
or revoked. A connection timeout usually means the broker address or network
allowlist is wrong.

## 2. Install one runtime agent

Install the agent that matches the target service. Use a stable, unique
`serviceId` for each deployable service, such as `payments-api` or
`billing-worker`.

### Node.js 20+

Install the published ESM package:

```sh
npm install @doomslayer2945/liveprobe-node@0.1.1
```

Start it during application startup and stop it during graceful shutdown:

```ts
import { LiveProbe } from "@doomslayer2945/liveprobe-node";

const liveProbe = await LiveProbe.start({
  serviceId: "payments-api",
  brokerUrl: process.env.BROKER_URL!,
  apiKey: process.env.LIVEPROBE_API_KEY,
  commitSha: process.env.GIT_COMMIT,
  environment: process.env.NODE_ENV ?? "development",
  sourceMapDir: process.env.LIVEPROBE_SOURCE_MAP_DIR,
  distLocation: process.env.LIVEPROBE_DIST_LOCATION ?? "dist",
  appRoot: process.env.LIVEPROBE_APP_ROOT,
});

// Call this from the application's existing shutdown path.
await liveProbe.stop();
```

For TypeScript or bundled JavaScript, emit external source maps and deploy the
`.js.map` files with the application. For `tsc`, the relevant settings are:

```json
{
  "compilerOptions": {
    "sourceMap": true,
    "inlineSourceMap": false
  }
}
```

Point the agent at the deployed map directory:

```sh
export LIVEPROBE_SOURCE_MAP_DIR="/app/dist"
export LIVEPROBE_DIST_LOCATION="dist"
```

Use `LIVEPROBE_APP_ROOT` when the service lives below a monorepo root, for
example `services/payments`. The broker translates original source locations,
such as `src/payments.ts:61`, to generated V8 locations. The agent strips
embedded `sourcesContent` before uploading maps.

### Python 3.12+

Python uses `sys.monitoring`, so Python 3.12 or newer is required.

```sh
python -m pip install liveprobe==0.1.1
```

Start one process-wide agent from the application's lifecycle hook:

```python
import os
import liveprobe

agent = liveprobe.start(
    service_id="billing-worker",
    broker_url=os.environ["BROKER_URL"],
    api_key=os.environ.get("LIVEPROBE_API_KEY"),
    commit_sha=os.environ.get("GIT_COMMIT"),
    environment=os.environ.get("ENVIRONMENT", "development"),
)

# Call this from the framework's existing shutdown hook.
liveprobe.stop()
```

There is no Python source-map loader. Probe files must match a runtime-known
`.py` path or an unambiguous suffix of it. Deploy the same source layout used
to build and run the service.

### JVM bridge, Java 17+

The JVM integration is a zero-dependency JDI sidecar, not a `-javaagent`. The
artifact is `io.liveprobe:liveprobe-bridge:0.1.1` in the private GitHub Maven
registry for this repository.

Authenticate Maven with a GitHub token that has `read:packages` and access to
the repository. One option is GitHub CLI:

```sh
gh auth login
gh auth refresh --scopes read:packages
export GITHUB_ACTOR="$(gh api user --jq .login)"
export GITHUB_TOKEN="$(gh auth token)"
```

Add this server entry to `~/.m2/settings.xml`:

```xml
<settings>
  <servers>
    <server>
      <id>github</id>
      <username>${env.GITHUB_ACTOR}</username>
      <password>${env.GITHUB_TOKEN}</password>
    </server>
  </servers>
</settings>
```

Download the bridge into the local Maven repository:

```sh
mvn dependency:get \
  -Dartifact=io.liveprobe:liveprobe-bridge:0.1.1 \
  -DremoteRepositories=github::default::https://maven.pkg.github.com/mohammed2945/LightProbe
```

Compile the target with line-number and local-variable metadata (`javac -g`).
Start it with JDWP bound to loopback or an equivalent private network:

```sh
java \
  -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005 \
  -jar application.jar
```

Run the bridge beside the target:

```sh
java --add-modules jdk.jdi \
  -jar "$HOME/.m2/repository/io/liveprobe/liveprobe-bridge/0.1.1/liveprobe-bridge-0.1.1.jar" \
  --service inventory-service \
  --attach 127.0.0.1:5005 \
  --broker "$BROKER_URL" \
  --commit "$GIT_COMMIT"
```

The bridge reads `LIVEPROBE_API_KEY` from its environment. Never expose JDWP
to the public internet. JVM probes use source-path suffix matching and require
the target's `LineNumberTable`; local capture also requires its
`LocalVariableTable`.

## 3. Configure the MCP tools

The MCP server runs locally over stdio and requires Node.js 20 or newer. The
package does not need to be installed globally.

Confirm that npm can resolve it:

```sh
npx -y @doomslayer2945/liveprobe-mcp@0.1.1 --help
```

For Cursor or another client that accepts the common `mcpServers` JSON shape,
add this configuration:

```json
{
  "mcpServers": {
    "liveprobe": {
      "command": "npx",
      "args": [
        "-y",
        "@doomslayer2945/liveprobe-mcp@0.1.1",
        "--broker-url",
        "https://liveprobe.tryastrea.tech"
      ],
      "env": {
        "LIVEPROBE_API_KEY": "<operator-key-provided-separately>"
      }
    }
  }
}
```

Restart the MCP client after editing its configuration. Then run these tools
in order:

1. `ping_broker` verifies the URL and bearer key.
2. `list_services` confirms that the runtime agent is heartbeating and reports
   its service ID and deployed `commitSha`.
3. `get_safety_overview` confirms the current runtime safety state.

A useful first prompt is:

> Ping the LiveProbe broker, list online services, and show the safety
> overview. Do not create a probe yet.

## 4. Use the MCP tools

The server exposes ten tools:

| Tool | Purpose |
| --- | --- |
| `ping_broker` | Check authenticated broker connectivity. |
| `list_services` | List agents, commits, heartbeat state, and caveats. |
| `get_safety_overview` | Show per-service safety state and probe counts. |
| `set_snapshot_probe` | Capture bounded locals, watch paths, and stack data. |
| `set_log_probe` | Add a temporary log with `${dot.path}` placeholders. |
| `set_counter_probe` | Count executions of a source line. |
| `set_metric_probe` | Aggregate a numeric dot path at a source line. |
| `list_probes` | Inspect probe definitions and status. |
| `get_probe_data` | Read retained evidence, optionally long-polling for it. |
| `remove_probe` | Remove a probe and uninstall it on the next agent poll. |

Before creating a probe:

1. Use the exact `serviceId` returned by `list_services`.
2. Use the deployed commit supplied by CI or the operator as `commit_hash`.
3. Confirm that it matches the agent-reported `commitSha`.
4. Inspect source from that exact revision and choose an executable one-based
   source line.
5. Prefer a one-hit snapshot or a counter on hot code. Keep the default TTL or
   make it shorter.
6. Read the evidence and call `remove_probe` when finished.

Example investigation prompt:

> List the online services and their commits. For `payments-api`, inspect the
> deployed revision, place a one-hit snapshot on the relevant executable line,
> wait up to 30 seconds for evidence, summarize only redacted values, and
> remove the probe afterward.

`commit_hash` and the agent-reported commit are audit metadata. They detect
obvious mismatches but are not cryptographic proof that loaded bytecode matches
the repository.

## 5. Troubleshooting

| Symptom | Check |
| --- | --- |
| MCP returns `unauthorized` | Confirm the MCP has the current operator key; restart the MCP client after changing it. |
| Agent returns `unauthorized` | Confirm its service key has not been revoked and was created for that service ID. |
| Broker is unreachable | Check `BROKER_URL`, `/healthz`, DNS resolution, and the calling service's outbound HTTPS access. |
| No services are listed | Confirm the agent started, can reach the broker, and has a valid deployed commit. |
| Service is offline | The broker has not received a heartbeat for more than 45 seconds. Inspect application or bridge logs. |
| Commit mismatch warning | Use the actual deployed revision; do not substitute local `HEAD`. |
| Probe is `line-not-found` | Use an executable line and a runtime-known source path or suffix. |
| Node TypeScript line is not found | Deploy external `.js.map` files and check `LIVEPROBE_SOURCE_MAP_DIR`, `LIVEPROBE_DIST_LOCATION`, and `LIVEPROBE_APP_ROOT`. |
| Python line is not found | Confirm Python 3.12+ and that the deployed `.py` path matches the probe suffix. |
| JVM line or locals are unavailable | Compile with `-g`, verify JDWP connectivity, and use the source path recorded in class metadata. |
| Agent reports red/suspended | Use `get_safety_overview`; reduce probe rate or wait for its cooldown before retrying. |
| Probe has no events | Confirm the line executes, the probe is armed, and its TTL or hit limit has not been reached. |

## 6. Test-environment safety

- Runtime agents can use individually revocable service keys. MCP users still
  share one operator key and there is no human identity or tenant isolation.
- Public traffic enters through the HTTPS load balancer. Direct broker origin
  ingress is restricted to Google's load-balancer and health-check ranges.
- Use TLS, VPN, or another trusted network path for non-demo data.
- Snapshots can capture values that the redaction rules do not recognize.
- Use short-lived, narrow probes and avoid broad watch paths.
- Node and JVM breakpoints can briefly pause an executing thread. Python line
  callbacks add work inside the target process.
- Never expose a JVM JDWP port publicly.
- Remove probes as soon as the investigation is complete.
