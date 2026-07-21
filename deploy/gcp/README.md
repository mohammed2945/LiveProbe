# LiveProbe GCP demo operator guide

This is the supported hosted MVP topology. It deploys one GCE VM containing
Postgres, the broker, the Node/Python/JVM demo services, their traffic
generators, and the private JVM bridge. The MCP server runs on the operator's
computer and reaches the broker over HTTP.

This remains a demo deployment. Every `/v1/*` request requires a shared bearer
key, but there is no per-user authorization, key rotation, tenant isolation,
TLS termination, high availability, or replicated database.

## Topology

```text
Cursor/Codex -- stdio --> @doomslayer2945/liveprobe-mcp
                           |
                           | HTTP + Authorization: Bearer <key>
                           v
GCE :80 --> broker --> Postgres
              ^          ^
              |          |
       Node/Python agents + JVM JDI bridge
```

Only SSH and the broker port are exposed by this deployment. Both managed GCP
firewall rules are restricted to the detected operator IPv4 `/32`, or to an
explicit `CLIENT_CIDR` between `/24` and `/32`. Application ports are bound to
VM loopback. JDWP stays on a Docker `internal: true` network and is never
published.

## Prerequisites

- A billing-enabled GCP project
- `gcloud`, authenticated to an account that can manage Compute Engine
- Node.js 20+ and npm on the operator machine
- A clean Git working tree containing the revision to deploy
- Published `@doomslayer2945/liveprobe-mcp@0.1.1`
- A strong `LIVEPROBE_API_KEY` retained by the operator

```sh
gcloud auth login
gcloud config set project "<PROJECT_ID>"
npm view @doomslayer2945/liveprobe-mcp@0.1.1 version
git status --short
```

The deployer archives committed `HEAD`; it intentionally rejects modified or
untracked files. Agents report that exact SHA on every ingest and refuse to
start without it.

## Deploy

Generate the key once and store it in your password manager. Reuse the same
key for redeployments unless you intend to rotate every component together.

```sh
export LIVEPROBE_API_KEY="$(openssl rand -hex 32)"
PROJECT_ID="<PROJECT_ID>" deploy/gcp/deploy.sh
```

By default the deployment uses:

| Resource | Default |
| --- | --- |
| Region / zone | `us-central1` / `us-central1-a` |
| VM | `liveprobe-demo`, `e2-standard-4`, 40 GB balanced disk |
| Static address | `liveprobe-demo-ip` |
| Broker | external HTTP port `80` |
| Firewall rules | `liveprobe-demo-broker`, `liveprobe-demo-ssh` |
| Database | Postgres 16 in the `liveprobe-demo_postgres-data` volume |

Set `CLIENT_IP` for a specific `/32`, or `CLIENT_CIDR` for a narrowly scoped
NAT pool. They are mutually exclusive. Other supported resource overrides are
defined in `deploy/gcp/lib/common.sh`.

```sh
LIVEPROBE_API_KEY="<existing-shared-key>" \
  PROJECT_ID="<PROJECT_ID>" \
  CLIENT_CIDR="68.65.169.128/28" \
  deploy/gcp/deploy.sh
```

The script enables Compute Engine, reserves or reuses the static address,
creates or updates both firewall rules, creates or reuses the VM, uploads the
committed archive, builds the Compose stack, and waits for every service to be
healthy. It then prints the broker URL, deployed SHA, and exact MCP JSON. The
JSON includes `LIVEPROBE_API_KEY`; treat terminal output as sensitive.

## Configure MCP

Use the exact JSON printed by `deploy.sh`. Its shape is:

```json
{
  "mcpServers": {
    "liveprobe": {
      "command": "npx",
      "args": [
        "-y",
        "@doomslayer2945/liveprobe-mcp@0.1.1",
        "--broker-url",
        "http://BROKER_IP:80"
      ],
      "env": {
        "LIVEPROBE_API_KEY": "REDACTED_SHARED_KEY"
      }
    }
  }
}
```

After restarting the MCP client, call `ping_broker`, `list_services`, and
`get_safety_overview`. A healthy connected demo lists `payment-service`,
`billing-worker`, and `inventory-service`, all reporting the deployed commit.
The Node service also uploads its external source maps for that commit.

Suggested first diagnostic prompt:

> List the live services, then investigate the failing free-tier payments,
> legacy billing renewals, and inventory reservations. Use one-hit snapshot
> probes, report only redacted evidence, and remove every probe when finished.

Provide the SHA printed by `deploy.sh` when the MCP workflow asks for
`commit_hash`. A mismatch with the agent-reported SHA produces a warning; it is
not cryptographic bytecode attestation.

## Operate

Use the same project/resource overrides as deployment:

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/status.sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/logs.sh
```

Redeploy with the same `LIVEPROBE_API_KEY`. Deployment releases are immutable
directories under `/opt/liveprobe/releases`; `/opt/liveprobe/current` points to
the active committed revision. Postgres state survives Compose replacement in
its named volume.

To refresh firewall access after changing networks without redeploying:

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/refresh-firewall.sh
```

If outbound port 80 is blocked, create an SSH tunnel:

```sh
gcloud compute ssh liveprobe-demo \
  --project="<PROJECT_ID>" \
  --zone=us-central1-a \
  -- -N -L 7070:127.0.0.1:80
```

Point the local MCP server at `http://127.0.0.1:7070` and keep the same API
key.

## Verify

The deployment scripts have static and mocked command-construction tests:

```sh
deploy/gcp/test.sh
docker compose \
  -f demo/docker-compose.yml \
  -f deploy/gcp/docker-compose.gcp.yml \
  config --quiet
```

For a live check from an allowed client address:

```sh
curl --fail "http://BROKER_IP/healthz"
curl --fail \
  -H "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  "http://BROKER_IP/v1/services"
curl --fail \
  -H "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  "http://BROKER_IP/v1/safety"
```

`/healthz` is intentionally unauthenticated and exposes no secrets. All `/v1/*`
routes reject missing or incorrect keys with `401`.

## Destroy and cost control

The VM, disk, static address, and traffic incur charges until destroyed. Use
the same overrides used at deployment:

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/destroy.sh
```

The script stops Compose when possible and deletes the VM and auto-delete disk,
the two managed firewall rules, and the reserved regional static address. It
does not alter unrelated firewall rules or delete the GCP project.

## Security boundaries

- The demo contains deterministic fake data only.
- The bearer key is shared by operators and all agents; compromise requires a
  coordinated key rotation and redeployment.
- HTTP is unencrypted. Use a trusted path, an SSH tunnel, or add TLS before
  carrying any non-demo data.
- Node and JVM breakpoints can briefly pause an executing thread. Python line
  callbacks add target-process work. Read-only does not mean zero impact.
- Redaction and bounded serialization are defense in depth, not proof that an
  unknown secret cannot be captured.
- Never expose JDWP or the demo application ports to the internet.
