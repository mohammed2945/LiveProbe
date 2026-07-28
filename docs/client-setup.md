# LiveProbe Client Setup

This guide is for a team connecting an application and an MCP-capable AI
client to an existing LiveProbe broker. It does not cover deploying the broker.

## 1. Get connection details

The current internal test deployment uses:

- `BROKER_URL`: `https://liveprobe.tryastrea.tech`
- Runtime `LIVEPROBE_API_KEY`: obtain a key created for the exact `serviceId`
- A Clerk account invited to the client's LiveProbe workspace

Do not commit the service key to an application repository or paste it into
issues, logs, or recordings. A service key cannot list services, manage probes,
or act as another service. Human MCP access uses Clerk instead of exposing an
shared admin key. Public traffic
terminates TLS at the Google Cloud load balancer, and HTTP redirects to HTTPS.
The VM origin accepts broker traffic only from Google's load-balancer and
health-check ranges. External port `7070` is not published; it is only the
broker container's internal port.

The public HTTPS endpoint is suitable for internal integration testing. The
broker uses Clerk organizations for human tenant isolation and browser login.
Shared admin keys are reserved for local fallback and break-glass use.

Native host agents use a separate credential class. An administrator creates
one through `POST /v1/native-credentials`, binding the exact `agentId`, tenant,
project, environment, and explicit service allowlist. Store the one-time
`lp_native_...` value in the host secret manager and expose it only as
`LIVEPROBE_NATIVE_CREDENTIAL`. It cannot access MCP, human control-plane, or
managed-runtime routes.

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

Node.js, Python, and the JVM use an in-process agent installed as a normal
dependency. Rust and C++ instead use a host-level eBPF agent that attaches to
the deployed executable, so those services are not rebuilt against a LiveProbe
library and the install is per host rather than per application.

### Node.js 20+

Install the published ESM package:

```sh
npm install @doomslayer2945/liveprobe-node@0.3.0
```

Start it during application startup and stop it during graceful shutdown:

```ts
import { LiveProbe } from "@doomslayer2945/liveprobe-node";

const liveProbe = await LiveProbe.start({
  serviceId: "payments-api",
  brokerUrl: process.env.BROKER_URL!,
  apiKey: process.env.LIVEPROBE_API_KEY,
  commitSha: process.env.GIT_COMMIT,
  projectId: process.env.LIVEPROBE_PROJECT_ID,
  environment: process.env.LIVEPROBE_ENVIRONMENT,
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
python -m pip install liveprobe==0.3.0
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
    project_id=os.environ.get("LIVEPROBE_PROJECT_ID"),
    environment=os.environ.get("LIVEPROBE_ENVIRONMENT"),
)

# Call this from the framework's existing shutdown hook.
liveprobe.stop()
```

There is no Python source-map loader. Probe files must match a runtime-known
`.py` path or an unambiguous suffix of it. Deploy the same source layout used
to build and run the service.

### JVM bridge, Java 17+

The JVM integration is a zero-dependency JDI sidecar, not a `-javaagent`. The
artifact is `io.liveprobe:liveprobe-bridge:0.3.0` in the private GitHub Maven
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
  -Dartifact=io.liveprobe:liveprobe-bridge:0.3.0 \
  -DremoteRepositories=github::default::https://maven.pkg.github.com/mohammed2945/LiveProbe
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
export LIVEPROBE_PROJECT_ID="inventory"
export LIVEPROBE_ENVIRONMENT="production"
java --add-modules jdk.jdi \
  -jar "$HOME/.m2/repository/io/liveprobe/liveprobe-bridge/0.3.0/liveprobe-bridge-0.3.0.jar" \
  --service inventory-service \
  --attach 127.0.0.1:5005 \
  --broker "$BROKER_URL" \
  --commit "$GIT_COMMIT"
```

The bridge reads `LIVEPROBE_API_KEY` from its environment. Never expose JDWP
to the public internet. JVM probes use source-path suffix matching and require
the target's `LineNumberTable`; local capture also requires its
`LocalVariableTable`.

### Rust and C++ on Linux x86-64

There is no package to add to your build. A host-level agent attaches eBPF
uprobes to the binary you already deployed, so your service is untouched and
never links against LiveProbe. That makes this a **per-host install**, not a
per-service dependency: set it up once on a machine and it covers every
compiled service running there.

Two processes run per host, and the split between them is the security
boundary:

| Process | Runs as | Job |
| --- | --- | --- |
| `liveprobe-bpf-loader` | root | Loads the BPF program and attaches uprobes. The only privileged part. |
| `liveprobe-native-agent` | `liveprobe` | Talks to the broker and streams evidence. No BPF privileges. |

They communicate over a root-owned Unix socket. **Never give the agent or your
application `CAP_BPF` or `CAP_SYS_ADMIN`** — that split is what stops a
compromised agent from loading arbitrary kernel programs.

#### Debug info you need

Probes are placed at source lines, so two things must survive your build:

| What | Why | Check |
| --- | --- | --- |
| DWARF | Maps source lines to addresses and names locals | `readelf --sections app \| grep debug_info` |
| GNU build ID | Identifies which exact binary is running | `readelf --notes app \| grep 'Build ID:'` |

A stripped binary cannot be probed. Optimized release builds are fine, and
inlined code resolves to its inlined site. If you ship stripped binaries, keep
the separate debug files and point `symbolDirectories` at them, or serve them
from a `debuginfod`.

#### Setup

Linux x86-64 only. Roughly ten minutes on a fresh host. Only step 2 differs
between the two toolchains; everything else is identical. The documentation
site splits them into a page each if you would rather read only your own:
[Rust](https://docs.liveprobe.tryastrea.tech/docs/rust) and
[C++](https://docs.liveprobe.tryastrea.tech/docs/cpp).

**1. Check the kernel.**

```sh
uname -m                                   # x86_64
test -r /sys/kernel/btf/vmlinux && echo "BTF ok"
mountpoint -q /sys/kernel/tracing ||
  sudo mount -t tracefs tracefs /sys/kernel/tracing
sudo test -e /sys/kernel/tracing/uprobe_events && echo "uprobes ok"
```

Most current distribution kernels pass. Containers usually do not, so run the
agent on the host.

**2. Build your service with debug info.**

Rust — keep debug info in the release profile. Cargo emits a build ID by
default; `strip = false` is what keeps it and the DWARF. Use
`"language": "rust"` in step 5.

```toml
# Cargo.toml
[profile.release]
debug = 2
strip = false
```

C++ — compile with `-g` and ask the linker for a build ID, which is not always
on by default. Use `"language": "cpp"` in step 5.

```sh
g++ -std=c++20 -O2 -g -fno-omit-frame-pointer \
  -Wl,--build-id=sha1 main.cpp -o my-service
```

Either way, confirm it on the artefact you actually deploy:

```sh
readelf --notes ./my-service | grep 'Build ID:'
```

**3. Install the agent.** No published package yet, so build both binaries from
the repository on a machine matching the target host. Needs Rust 1.88+.

```sh
sudo apt-get install -y --no-install-recommends \
  build-essential pkg-config clang llvm lld bpftool \
  libbpf-dev libelf-dev zlib1g-dev dwarves

make native-release
sudo make native-install
```

This installs both binaries to `/usr/local/bin` and creates `/etc/liveprobe`.
Override with `NATIVE_PREFIX`, or stage a package with `DESTDIR`.

**4. Create the unprivileged account.**

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin liveprobe
sudo install -d -o root -g liveprobe -m 0750 /run/liveprobe
```

**5. Get a credential.** Native agents use their own credential rather than
your operator key, and it is shown once. The returned `apiKey` carries an
`lp_native_` prefix, is stored only as a hash, and is restricted to the listed
service IDs.

```sh
umask 077
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{"agentId":"native-host-1","allowedServiceIds":["my-service"],"label":"Prod host 1"}' \
  "${BROKER_URL}/v1/native-credentials"
```

**6. Write the config.** Save this as `/etc/liveprobe/native-agent.json`. Use
the real executable path, not a symlink or wrapper script.

```json
{
  "agentId": "native-host-1",
  "brokerUrl": "https://liveprobe.tryastrea.tech",
  "loaderSocket": "/run/liveprobe/loader.sock",
  "services": [
    { "serviceId": "my-service", "language": "rust", "executablePath": "/opt/app/bin/my-service" }
  ],
  "redactKeys": ["tenantSecret"],
  "redactValues": [],
  "symbolDirectories": ["/usr/lib/debug"],
  "debuginfodUrl": null,
  "symbolCacheDirectory": null
}
```

Revoke a credential with `DELETE /v1/native-credentials/<credential-id>`; list
non-secret metadata with `GET /v1/native-credentials`. These routes require the
broker's PostgreSQL durable store and return `503 credential_store_unavailable`
without it.

**7. Start the loader, then the agent.**

```sh
# Loader first. The trailing paths are the allowlist -- it will attach to
# nothing else, so add a service here to probe it.
sudo /usr/local/bin/liveprobe-bpf-loader \
  /run/liveprobe/loader.sock \
  "$(id -u liveprobe)" "$(id -g liveprobe)" \
  /opt/app/bin/my-service

# Then the agent, as the unprivileged account.
sudo -u liveprobe env \
  LIVEPROBE_NATIVE_CREDENTIAL="lp_native_<secret>" \
  /usr/local/bin/liveprobe-native-agent /etc/liveprobe/native-agent.json
```

Both are long-running host daemons, so in production run them under systemd
with the loader ordered first, and load the credential from an
`EnvironmentFile` only root can read.

#### 8. Verify

```sh
curl --fail --silent \
  -H "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  "${BROKER_URL}/v1/services" | jq '.'
```

Your `serviceId` appears once the agent registers and finds a running process.
Now place a probe from your MCP client.

#### Troubleshooting

| Symptom | Fix |
| --- | --- |
| `no such user: liveprobe` | Run step 4. |
| Service never appears | No running process matches `executablePath`, or it differs from the loader allowlist. |
| Probe stays pending | No DWARF for that line. The binary was stripped or built without `-g` / `debug = 2`. |
| Loader refuses a path | That executable was not in the allowlist the loader started with. |
| Permission denied on the socket | `/run/liveprobe` ownership does not match the UID/GID passed to the loader. |

Native probes are read-only: capture never writes to target memory, and a probe
that hits its limit detaches instead of silently re-arming.

## 3. Configure the MCP tools

For the hosted service, no SDK package or API key is needed for MCP. Add:

```json
{
  "mcpServers": {
    "liveprobe": {
      "url": "https://liveprobe.tryastrea.tech/mcp"
    }
  }
}
```

Choose **Login** in the MCP client, complete Clerk sign-in in the browser, and
select the workspace you were invited to. The client refreshes its OAuth token
automatically. Restart the MCP client if it does not detect the new server.

### Local stdio fallback

The MCP server runs locally over stdio and requires Node.js 20 or newer. The
package does not need to be installed globally.

Confirm that npm can resolve it:

```sh
npx -y @doomslayer2945/liveprobe-mcp@0.4.0 --help
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
        "@doomslayer2945/liveprobe-mcp@0.4.0",
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

### Create an agent credential

For the pilot, every member of a Clerk organization has the same LiveProbe
permissions within that organization. Complete the project catalog before
deploying the runtime agent:

1. Call `create_project` with a stable lowercase `project_id`.
2. Call `create_environment` for environments such as `staging` and
   `production`.
3. Call `register_service` once for each repository/application. The same
   service ID is reused when that service is deployed to multiple environments.
4. Call `create_service_credential` with the project, environment, registered
   service ID, and a descriptive label.
5. Store the returned `apiKey` in the service's secret manager or deployment
   environment. The plaintext key is shown only in the create response.
6. Configure the agent with `LIVEPROBE_API_KEY`, `BROKER_URL`,
   `LIVEPROBE_PROJECT_ID`, `LIVEPROBE_ENVIRONMENT`, and the required
   `LIVEPROBE_COMMIT_SHA`.
7. Use `list_service_credentials` later to review key prefixes and status.
8. Use `revoke_service_credential` to disable a key that is no longer needed.

Credentials are scoped to one organization, project, environment, and service.
Pass the same `project_id` and `environment_id` to MCP operational tools. The
broker can therefore keep `inventory/production` and `inventory/staging`
separate even when both deployments use the same service ID.
Archiving a project, environment, or service revokes its affected active
credentials while retaining probe and audit history. Removing a person from
the Clerk organization removes their human access, but does not otherwise
change active agent keys.

## 4. Use the MCP tools

The server exposes twenty-three tools:

| Tool | Purpose |
| --- | --- |
| `ping_broker` | Check authenticated broker connectivity. |
| `list_services` | List agents, commits, heartbeat state, and caveats. |
| `get_safety_overview` | Show per-service safety state and probe counts. |
| `list_audit_events` | List control-plane changes in the selected organization. |
| `list_projects` / `create_project` / `archive_project` | Manage project identities. |
| `list_environments` / `create_environment` / `archive_environment` | Manage project deployment environments. |
| `list_registered_services` / `register_service` / `archive_service` | Manage project-level service identities. |
| `create_service_credential` | Create a per-service agent key; the plaintext key is returned once. |
| `list_service_credentials` | List credential metadata and revocation state without secrets. |
| `revoke_service_credential` | Revoke an agent key in your organization. |
| `set_snapshot_probe` | Capture bounded locals, watch paths or safe expressions, and optional locals for up to eight stack frames. |
| `set_log_probe` | Add a temporary `debug`, `info`, `warn`, or `error` log with `${dot.path}` or safe `${expression}` placeholders. |
| `set_counter_probe` | Count executions of a source line. |
| `set_metric_probe` | Aggregate a numeric dot path or safe numeric expression at a source line. |
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
| MCP returns `unauthorized` | Reconnect the hosted MCP account, or confirm the local fallback has the current shared key. |
| MCP returns `forbidden` | Confirm the active Clerk workspace and role; audit and service-credential management require admin. |
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

- Runtime agents use individually revocable service keys. Hosted MCP users sign
  in through Clerk and are isolated by active organization with admin,
  operator, or viewer permissions. The shared internal-scope admin key is only
  a break-glass fallback.
- Public traffic enters through the HTTPS load balancer. Direct broker origin
  ingress is restricted to Google's load-balancer and health-check ranges.
- Use TLS, VPN, or another trusted network path for non-demo data.
- Snapshots can capture values that the redaction rules do not recognize.
- Use short-lived, narrow probes and avoid broad watch paths.
- Node and JVM breakpoints can briefly pause an executing thread. Python line
  callbacks add work inside the target process.
- `get_safety_overview` returns canonical reason codes and only the limits each
  runtime actually enforces. Do not interpret an omitted limit as a measured
  process-health signal.
- Never expose a JVM JDWP port publicly.
- Remove probes as soon as the investigation is complete.
