> Reference client moved to ride_sharing_probe_demo.

# LiveProbe

LiveProbe is an experimental, AI-native live debugger. An MCP server gives an
AI client a small diagnostic tool surface; a broker coordinates short-lived
probes; and runtime agents collect bounded snapshots, dynamic logs, counters,
or metrics from a running Node.js, Python, or JVM process.

This repository is a development prototype, not a production observability
service. Published client packages are
`@doomslayer2945/liveprobe-mcp@0.1.1`,
`@doomslayer2945/liveprobe-node@0.1.1`, `liveprobe==0.1.1`, and
`io.liveprobe:liveprobe-bridge:0.1.1`.

For application teams connecting to an existing broker, start with the
**[client setup guide](docs/client-setup.md)**. It covers credentials,
connectivity, SDK installation, source maps, JVM debugging, MCP configuration,
tool usage, and troubleshooting.

## Architecture

```text
AI client -- stdio MCP --> MCP server -- HTTP --> broker + durable store
                                                  |       |        |
                                            Node SDK  Python SDK  Java JDI bridge
                                                  |       |        |
                                             payment   billing   inventory
```

The MCP process never connects directly to a target runtime. Agents poll the
broker for probe definitions and send sanitized events back. In the Docker
demo, the Java bridge and inventory JDWP socket share a separate
`internal: true` network. The bridge joins only that internal network, the
diagnostic port is not published, and the broker is present on both networks
to relay probe definitions and evidence.

## Prerequisites and setup

- Node.js 20+ (CI uses Node 24)
- pnpm at the version in `package.json#packageManager`
- Python 3.12+ and `venv`
- JDK 17+ and Maven 3.9+
- Docker with Compose v2 for the all-language demo

```sh
corepack enable
corepack install
pnpm install --frozen-lockfile
npm --prefix demo/payment-service ci

python3.12 -m venv python/sdk/.venv
python/sdk/.venv/bin/python -m pip install \
  -e "python/sdk[test]" \
  -r demo/billing-worker/requirements.txt

make test
```

## Language quickstarts

### Node.js

Build the SDK and start the broker:

```sh
pnpm --filter @doomslayer2945/liveprobe-node run build
pnpm --filter @liveprobe/broker run build
pnpm --filter @liveprobe/broker start
```

Start and stop the agent with application lifecycle:

```ts
import { LiveProbe } from "@doomslayer2945/liveprobe-node";

const agent = await LiveProbe.start({
  serviceId: "payments",
  brokerUrl: "http://127.0.0.1:7070",
  apiKey: process.env.LIVEPROBE_API_KEY,
  commitSha: process.env.GIT_COMMIT,
  environment: "development",
});

process.once("SIGTERM", () => void agent.stop());
```

The complete Express integration is in `demo/payment-service`.

### Python

Python uses PEP 669 `sys.monitoring` and therefore requires Python 3.12+:

```python
import liveprobe

agent = liveprobe.start(
    service_id="billing",
    broker_url="http://127.0.0.1:7070",
    api_key="dev-liveprobe-key",
    commit_sha="abcdef1234567890",
    environment="development",
)

# During orderly application shutdown:
liveprobe.stop()
```

The complete FastAPI integration is in `demo/billing-worker`.

### JVM

Build the zero-dependency bridge and a target with line/local-variable debug
metadata:

```sh
make -C java/bridge jar
make -C demo/inventory-service package

BUG=on PORT=8082 java \
  -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005 \
  -jar demo/inventory-service/target/inventory-service.jar
```

In another terminal:

```sh
export LIVEPROBE_API_KEY="dev-liveprobe-key"
java --add-modules jdk.jdi -jar java/bridge/build/liveprobe-bridge.jar \
  --service inventory-service \
  --attach 127.0.0.1:5005 \
  --broker http://127.0.0.1:7070 \
  --commit abcdef1234567890
```

Keep JDWP on loopback or an equivalent private boundary. Never publish the
demo's diagnostic port.

## MCP configuration

For a host-run broker and built MCP package, configure a stdio server in your
MCP client (replace `/absolute/path/to/LightProbe`):

```json
{
  "mcpServers": {
    "liveprobe": {
      "command": "node",
      "args": [
        "/absolute/path/to/LightProbe/packages/mcp-server/dist/index.js"
      ],
      "env": {
        "BROKER_URL": "http://127.0.0.1:7070",
        "LIVEPROBE_API_KEY": "dev-liveprobe-key"
      }
    }
  }
}
```

The server exposes ten tools: service/probe listing, four probe setters,
retained-data retrieval, removal, authenticated connectivity, and a safety
overview. Creating or removing a probe changes diagnostic instrumentation even
though it does not intentionally change application variables.

### Diagnostic workflow

1. List services and select the deployment to investigate.
2. Obtain the deployed commit SHA from the user. If it is not already known,
   ask before creating any probe; do not infer it from local `HEAD` or claim to
   discover it from the runtime.
3. When the repository and revision are available locally, validate and inspect
   that exact revision before choosing a source path and line:

   ```sh
   git cat-file -e "${DEPLOYED_COMMIT}^{commit}"
   git show "${DEPLOYED_COMMIT}:path/to/source-file"
   ```

4. Pass the 7-64 character hexadecimal SHA as `commit_hash` to any MCP
   set-probe tool. The MCP server normalizes it, retains it as probe audit
   metadata, and warns when it differs from the commit reported by the agent.
5. Read the evidence and remove the probe when finished.

The agent-reported commit and operator-provided commit are metadata, not
cryptographic proof that the target bytecode exactly matches that revision.

## Environment matrix

| Variable | Used by | Purpose |
| --- | --- | --- |
| `LIVEPROBE_API_KEY` | broker, MCP, agents | Shared bearer token for all `/v1/*` broker calls. |
| `DATABASE_URL` | broker | Enables Postgres durable state. If unset, `LIVEPROBE_STATE_FILE` JSON fallback is used. |
| `LIVEPROBE_STATE_FILE` | broker | Local/dev JSON fallback state file. |
| `BROKER_URL` | MCP, agents | HTTP origin for the broker. |
| `LIVEPROBE_COMMIT_SHA` / `GIT_COMMIT` | agents | Required deployed commit SHA reported on every ingest. |
| `LIVEPROBE_SOURCE_MAP_DIR` | Node agent | Directory containing generated `.map` files. |
| `LIVEPROBE_DIST_LOCATION` | Node agent | Generated output path segment, default `dist`. |
| `LIVEPROBE_APP_ROOT` | Node agent | Optional monorepo subdirectory prefixed to uploaded map paths. |

Node agents upload external source maps once per service commit after removing
embedded source content. The broker resolves source paths and lines to generated
V8 locations. Python and JVM probes require a runtime-known path suffix; JVM
targets must include debug line/local-variable metadata.

## GCP single-VM demo

> **Demo only:** this is a fake-data, single-instance HTTP deployment. Broker
> calls require one shared bearer key, but there is no per-user authorization,
> tenant isolation, or TLS. It is not a production topology.

The accepted GCE path places the broker, three intentionally buggy services,
their traffic generators, and the JVM bridge on one VM. Only the broker and SSH
are opened externally, and each managed firewall rule is restricted to the
operator's detected public IPv4 `/32` or one explicit `/24` through `/32` NAT
pool. The external broker defaults to HTTP port `80`; the local Docker demo
still defaults to `7070`. The MCP server runs locally through the published npm
package.

You need a billing-enabled GCP project, Docker, Node.js 20+, npm, and the Google
Cloud CLI. On macOS, install it if needed and authenticate first:

```sh
brew install --cask google-cloud-sdk
exec -l "$SHELL"
gcloud auth login
gcloud config set project "<PROJECT_ID>"
```

The deployer rejects tracked modifications and untracked files because it
archives the clean local `HEAD`. Commit every intended change, confirm
`git status --short` is empty, make sure
`@doomslayer2945/liveprobe-mcp@0.1.1` is available from npm, set a strong
shared key, and deploy:

```sh
LIVEPROBE_API_KEY="$(openssl rand -hex 32)" \
  PROJECT_ID="<PROJECT_ID>" deploy/gcp/deploy.sh
```

For the current Stanford visitor Wi-Fi NAT pool and healthy demo, use exactly:

```sh
LIVEPROBE_API_KEY="<existing-shared-key>" \
  PROJECT_ID=totemic-studio-502902-u2 \
  CLIENT_CIDR=68.65.169.128/28 \
  deploy/gcp/deploy.sh
```

`CLIENT_CIDR` configures the inbound GCP firewall rules; it cannot alter or
bypass Stanford's outbound campus firewall. The observed network blocks
outbound TCP `7070` but reaches the current broker on port `80`. If port `80`
is also blocked, use the SSH-tunnel fallback in the operator guide and point
the local MCP process at the tunnel.

The default `e2-standard-4` VM, 40 GB balanced disk, premium static IPv4
address, and network traffic can incur charges until destroyed. The complete
operator runbook covers npm publication, resources and defaults, the exact
Cursor configuration, demo prompts, evidence, troubleshooting, redeployment,
and cleanup:

**[GCP single-VM demo operator guide](deploy/gcp/README.md)**

## All-language Docker demo

```sh
make demo
```

This builds prerequisites, starts the broker, all three applications, their
traffic generators, and the local-only Java bridge, then prints an exact stdio
MCP JSON configuration containing the absolute Compose path and this first
prompt:

> List the live services, then investigate the failing free-tier payments,
> legacy billing renewals, and inventory reservations. Use one-hit snapshot
> probes, report only redacted evidence, and remove every probe when finished.

Host HTTP ports default to broker `7070`, payments `8080`, billing `8081`, and
inventory `8082`. Override them with `BROKER_PORT`, `PAYMENT_PORT`,
`BILLING_PORT`, or `INVENTORY_PORT`. Broker records persist in the named
`postgres-data` volume; JSON snapshots remain a fallback only when
`DATABASE_URL` is unset.

```sh
make demo-down
```

`demo-down` preserves broker state. Use Docker Compose's explicit volume
removal only when you intend to erase it.

## Verification and audits

```sh
make test
make redaction-audit
make readonly-audit
make bench
make e2e-node
make e2e-python
make e2e-jvm
```

- `redaction-audit` runs the shared serializer fixtures through TypeScript,
  Python, and Java. It clearly reports a Java skip when a local JDK 17+
  toolchain is unavailable.
- `readonly-audit` scans only runtime source directories for known target
  mutation/evaluation APIs and self-tests both forbidden and allowed examples.
  Its own pattern definitions are outside the scan roots, so the command does
  not report itself.
- Each e2e gate starts a real broker and the corresponding runtime integration.
  The JVM gate attaches JDI only over loopback.

## Security and read-only scope

"Read-only" is narrowly about target application values: current agents read
locals/properties and do not intentionally evaluate arbitrary target
expressions, assign locals/fields, invoke target methods, redefine classes, or
force returns. It does **not** mean zero runtime impact. Node and JVM
breakpoints briefly pause an executing thread; Python line callbacks execute
in the target process; probe installation changes debugger/monitoring state;
and MCP create/remove operations mutate broker control-plane state.

Serialization is bounded by depth, property, array, string, and stack limits.
Default secret-key patterns and configured exact secret values are redacted,
and the shared fixtures verify ordering and cross-language output. This is a
defense-in-depth filter, not a DLP guarantee: an unrecognized secret can still
be captured. Keep probe scope narrow, use one-hit/short-TTL probes, review
custom watch paths, and remove probes promptly.

All `/v1/*` broker routes require the shared `LIVEPROBE_API_KEY`; `/healthz`
and `/readyz` are unauthenticated liveness and database-readiness routes. This
is authentication without user-level
authorization, key rotation, tenant isolation, or TLS. Restrict network access
and terminate TLS before any use beyond a controlled demo. The internal
Compose network reduces JVM diagnostic exposure but is not a substitute for
production network policy.

## Benchmarks

Observed development-machine results are recorded honestly below. They are
microbenchmarks, not service-level latency claims.

| Runtime / scenario | Observed p99 | Observed p99 delta |
| --- | ---: | ---: |
| Node baseline | 0.355 ms | baseline |
| Node counter bookkeeping | 0.188 ms | not interpreted |
| Node consumed snapshot path | 0.160 ms | not interpreted |
| Python disabled LINE location | not retained | +3.39% |

The lower Node bookkeeping timings are benchmark noise/JIT effects and must not
be interpreted as a speedup. The active inspector breakpoint pause is
deliberately excluded: V8 pauses before reporting a breakpoint, so this
benchmark cannot characterize active-probe tail latency. Run `make bench` on
the deployment hardware for current numbers.

## Known production limitations

- Shared-key authentication only; no RBAC, tenant isolation, TLS termination,
  key rotation, or immutable audit-log retention.
- Postgres mutations are transactional and durable, but the deployment is
  single-instance and unreplicated. JSON snapshots are a local/dev fallback.
- No high availability, backpressure service, fleet rollout controller, or
  compatibility guarantees for private package APIs.
- Source paths, generated JavaScript line mappings, and JVM debug metadata must
  match the deployed artifact.
- Active probes add runtime work and can affect tail latency; the safety limits
  reduce impact but cannot eliminate it.
- Redaction is configuration-dependent and cannot prove that arbitrary secrets
  are absent.
- The Docker demo is local development infrastructure, not a hardened
  deployment topology.

## Troubleshooting

- **`pnpm` version mismatch:** run `corepack install`; it reads the pinned
  `packageManager` field.
- **Python is skipped or rejected:** verify `python3.12 --version`, recreate
  `python/sdk/.venv`, and reinstall the test extra.
- **Java probe never arms:** compile with line and local-variable tables (`-g`),
  use a source-path suffix known to the target, and verify JDK 17+ on both
  sides.
- **Bridge cannot attach:** ensure JDWP is listening, the address is loopback
  for host runs, and no other debugger owns the socket.
- **Compose startup is unhealthy:** inspect `docker compose -f
  demo/docker-compose.yml logs`; inventory health requires `/bin/bash` from the
  existing Temurin image.
- **MCP client cannot start Docker configuration:** run `make demo` again and
  copy the newly printed absolute-path JSON exactly.
- **Stale demo evidence:** `make demo-down`, then explicitly remove the
  `liveprobe-demo_postgres-data` volume only if data loss is intended.

## Prior art and license

LiveProbe builds on ideas established by live-debugging products such as
Lightrun and Rookout, runtime debugger APIs (V8 Inspector, PEP 669, and JDI),
and the Model Context Protocol. This is a credit for concepts and ecosystem
work, not a claim of affiliation.

LiveProbe is released under the MIT License. See [LICENSE](LICENSE).
