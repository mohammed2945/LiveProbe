# LiveProbe GCP demo operator guide

This is the supported hosted MVP topology. It deploys one GCE VM containing
the broker, the Node/Python/JVM demo services, their traffic generators, and
the private JVM bridge. The database can be either VM-local Postgres for the
least expensive demo or Cloud SQL for a durable pilot. MCP clients can use the
hosted OAuth endpoint or run the package locally with a break-glass key. An
optional global HTTPS load balancer provides a Google-managed certificate and
redirects public HTTP to HTTPS.

This remains a pilot deployment. Every `/v1/*` request requires a bearer
credential. Operators can authenticate through Clerk Organizations when Clerk
is configured; the rotatable shared key remains a break-glass path. Cloud SQL
deployments can issue individually revocable keys restricted to one agent
service. Clerk organizations are isolated as broker tenants with admin,
operator, and viewer authorization. The broker remains a single instance.

## Topology

```text
Cursor/Codex -- stdio --> @doomslayer2945/liveprobe-mcp
                           |
                           | HTTPS + Authorization: Bearer <key>
                           v
Global HTTPS LB :443 --> GCE :80 --> broker --> Cloud SQL Auth Proxy --> Cloud SQL
                                      ^
                                      |
                         Node/Python agents + JVM JDI bridge
```

Before HTTPS activation, SSH and the broker port are restricted to the detected
operator IPv4 `/32`, or to an explicit `CLIENT_CIDR` between `/24` and `/32`.
Activation removes direct broker ingress and permits port 80 only from Google's
load-balancer and health-check ranges. SSH remains restricted to the operator.
Application ports are bound to VM loopback. JDWP stays on a Docker
`internal: true` network and is never published.

## Prerequisites

- A billing-enabled GCP project
- `gcloud`, authenticated to an account that can manage Compute Engine
- Node.js 20+ and npm on the operator machine
- A clean Git working tree containing the revision to deploy
- Published `@doomslayer2945/liveprobe-mcp@0.1.1`
- A strong `LIVEPROBE_API_KEY` retained by the operator
- A separate 64-character hex `POSTGRES_PASSWORD` retained by the operator
- For Clerk auth: a Clerk backend secret key and the exact frontend origin
- For HTTPS: a DNS hostname and permission to create its `A` record

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

Generate both credentials once and store them in your password manager. The
first deployment creates Secret Manager resources and seeds their first
versions. Later deployments read those versions and do not require either
plaintext value in the command environment.

```sh
export LIVEPROBE_API_KEY="$(openssl rand -hex 32)"
export POSTGRES_PASSWORD="$(openssl rand -hex 32)"
# Optional until the Clerk frontend exists:
export CLERK_SECRET_KEY="<Clerk Dashboard backend secret key>"
export CLERK_AUTHORIZED_PARTIES="https://app.tryastrea.tech"
# Required for hosted MCP browser login:
export CLERK_PUBLISHABLE_KEY="<Clerk production pk_live_ key>"
export CLERK_FRONTEND_API_URL="https://clerk.liveprobe.tryastrea.tech"
export HTTPS_DOMAIN="liveprobe.tryastrea.tech"
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
| Secrets | Secret Manager: broker API keys, Postgres password, and Clerk secret key when Clerk is enabled |

Set `CLIENT_IP` for a specific `/32`, or `CLIENT_CIDR` for a narrowly scoped
NAT pool. They are mutually exclusive. Other supported resource overrides are
defined in `deploy/gcp/lib/common.sh`.

```sh
PROJECT_ID="<PROJECT_ID>" \
  CLIENT_CIDR="68.65.169.128/28" \
  deploy/gcp/deploy.sh
```

The script enables Compute Engine and Secret Manager, grants the runtime
service account access to only the deployment secrets, reserves or reuses
the static address, creates or updates firewall rules, creates or reuses the
VM, uploads the committed archive, builds the Compose stack, and waits for
every service to be healthy. The VM retrieves secret payloads through its
metadata identity; plaintext values are not placed in the SSH command. The
script prints the broker URL, deployed SHA, and an MCP JSON template containing
`<LIVEPROBE_API_KEY>`. Retrieve the key from Secret Manager only when securely
configuring a client; deployment logs never print the live key.

### Cloud SQL database

Set `DATABASE_BACKEND=cloud-sql` to provision and use a managed PostgreSQL 16
database. New instances use the Enterprise edition with two vCPUs, 7.5 GiB of
memory, regional high availability, 20 GiB SSD storage with bounded automatic
growth, 14 automated backups, seven days of point-in-time recovery logs,
deletion protection, encrypted connector-only access, and Query Insights.
This is materially more expensive than the local database. For temporary
testing, `CLOUD_SQL_AVAILABILITY_TYPE=zonal` removes cross-zone failover.

```sh
PROJECT_ID="<PROJECT_ID>" \
  DATABASE_BACKEND=cloud-sql \
  CLOUD_SQL_AVAILABILITY_TYPE=regional \
  deploy/gcp/deploy.sh
```

The provisioners create a dedicated `liveprobe-runtime` service account with
`roles/cloudsql.client` plus accessor grants on only the two deployment
secrets, attach it to the VM with the `cloud-platform` scope, and run the pinned
Cloud SQL Auth Proxy inside the private Compose network. The database has a
public IP but rejects direct database connections; all connections must use a
Cloud SQL connector. Existing instances must already be PostgreSQL 16 in the
selected region.

Cloud SQL starts with a fresh `liveprobe` database. Switching an existing
deployment does not copy data from the VM-local Postgres volume. Export and
restore that data before cutover when it must be retained.

Supported overrides are `CLOUD_SQL_INSTANCE`, `CLOUD_SQL_DATABASE`,
`CLOUD_SQL_USER`, `CLOUD_SQL_AVAILABILITY_TYPE`,
`RUNTIME_SERVICE_ACCOUNT`, and `LIVEPROBE_DB_POOL_SIZE`.

### Secrets and API-key rotation

GCP deployment defaults to `SECRETS_BACKEND=secret-manager`. The broker key
ring, database password, and optional Clerk backend key are stored in separate
secrets. Secret payloads are still materialized in root-readable
`/etc/liveprobe/deployment.env` because Docker Compose needs them, but Secret
Manager is the source of truth and the runtime service account has no
project-wide secret accessor role. Set `CLERK_AUTHORIZED_PARTIES` on every
Clerk-enabled deployment; the default Clerk secret ID is
`liveprobe-demo-clerk-secret-key` and can be overridden with
`CLERK_SECRET_KEY_SECRET`.

To rotate the shared API key without disconnecting every client at once:

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/rotate-api-key.sh begin
PROJECT_ID="<PROJECT_ID>" DATABASE_BACKEND=cloud-sql \
  CLOUD_SQL_AVAILABILITY_TYPE=zonal deploy/gcp/deploy.sh
```

Securely distribute the printed new key and update every MCP/operator process
plus any legacy agent still using the shared key. Per-service agent keys are
unaffected. During this window, the broker accepts the new key and the
immediately previous key. Once migration is complete:

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/rotate-api-key.sh finish
PROJECT_ID="<PROJECT_ID>" DATABASE_BACKEND=cloud-sql \
  CLOUD_SQL_AVAILABILITY_TYPE=zonal deploy/gcp/deploy.sh
```

The second deployment removes acceptance of the previous key. Never start a
second rotation while an overlap is active. Use `SECRETS_BACKEND=environment`
only for recovery or non-GCP development.

### Per-service agent credentials

Keep the shared key out of customer runtime processes. With Cloud SQL enabled,
an operator can create a revocable key for one exact service ID:

```sh
umask 077
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{"serviceId":"payments-api","label":"Payments production"}' \
  "https://liveprobe.tryastrea.tech/v1/service-credentials" \
  > service-credential.json
```

The response contains the plaintext `apiKey` once. Deliver it through the
customer's secret-management channel and use it as `LIVEPROBE_API_KEY` only in
that service's agent process. List non-secret metadata with
`GET /v1/service-credentials`. Revoke a key with:

```sh
curl --fail --silent --show-error -X DELETE \
  -H "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  "https://liveprobe.tryastrea.tech/v1/service-credentials/<credential-id>"
```

Service credentials can call ping and the agent routes for their assigned
service. They cannot list services, inspect evidence, or create/remove probes.

### HTTPS and TLS

Deploy the VM first. Then create the global external Application Load Balancer,
reserved IPv4 address, Google-managed certificate, TLS 1.2 `MODERN` policy,
HTTP-to-HTTPS redirect, health check, and backend firewall rule:

```sh
HTTPS_DOMAIN="probe.example.com" \
  PROJECT_ID="<PROJECT_ID>" \
  deploy/gcp/provision-https.sh
```

The command is idempotent and prints the required DNS record. Create that exact
`A` record at the domain's DNS provider. Direct HTTP remains available during
certificate provisioning, so this step does not interrupt the existing broker.
Rerun the provisioner to inspect certificate status.

Once the status is `ACTIVE`, perform the guarded cutover:

```sh
LIVEPROBE_API_KEY="<existing-shared-key>" \
  HTTPS_DOMAIN="probe.example.com" \
  PROJECT_ID="<PROJECT_ID>" \
  CLIENT_IP="<operator-public-ip>" \
  deploy/gcp/activate-https.sh
```

Activation requires DNS to resolve to the reserved load-balancer address. It
checks `/healthz`, `/readyz`, and authenticated `/v1/ping` over HTTPS before
closing direct ingress, repeats readiness and authentication checks afterward,
and prints the HTTPS MCP configuration. It also records the hostname in VM
metadata, so later `deploy.sh`, `status.sh`, and `refresh-firewall.sh` runs keep
HTTPS mode even when `HTTPS_DOMAIN` is omitted.

Do not point MCP clients at the load-balancer IP. The managed certificate is
valid for the configured hostname, and clients must use
`https://probe.example.com` (with the actual hostname).

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
        "https://probe.example.com"
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

Redeploy without passing plaintext secrets; the deployer reads the current
Secret Manager versions. Deployment releases are immutable directories under
`/opt/liveprobe/releases`;
`/opt/liveprobe/current` points to the active committed revision. Database
state survives Compose replacement in either database mode.

Run a manual backup before upgrades. Local mode creates an off-VM custom-format
dump in the ignored `backups/` directory with owner-only permissions. Cloud SQL
mode creates an on-demand managed backup in addition to its automated backups
and point-in-time recovery logs.

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/backup.sh
pg_restore --list backups/liveprobe-YYYYMMDDTHHMMSSZ.dump
```

For Cloud SQL, run a non-destructive point-in-time recovery drill before
storing important client data:

```sh
PROJECT_ID="<PROJECT_ID>" \
DATABASE_BACKEND=cloud-sql \
  deploy/gcp/recovery-drill.sh
```

The drill first verifies that a successful managed backup exists. It then
clones the production instance from five minutes earlier into a uniquely named
temporary instance, validates the complete LiveProbe schema, default tenant
scope, representative service and audit data, and the immutable audit trigger,
then deletes the temporary instance. Production traffic and the source database
are never redirected or modified. The temporary instance incurs Cloud SQL
charges only while the drill is running.

To refresh SSH access after changing networks without redeploying:

```sh
PROJECT_ID="<PROJECT_ID>" CLIENT_IP="<operator-public-ip>" \
  deploy/gcp/refresh-firewall.sh
```

### Monitoring and alerts

For the Cloud SQL and HTTPS topology, provision the production monitoring
baseline with one or more operations email addresses:

```sh
PROJECT_ID="<PROJECT_ID>" \
DATABASE_BACKEND=cloud-sql \
ALERT_EMAILS="oncall@example.com,platform@example.com" \
  deploy/gcp/provision-monitoring.sh
```

`ALERT_EMAILS` accepts one to five comma-separated addresses; whitespace is
trimmed and duplicate addresses are rejected. `ALERT_EMAIL` remains a
single-address compatibility fallback. The command is idempotent. It installs
and verifies the Google Cloud Ops Agent,
grants the VM's dedicated runtime service account only log-writer and
metric-writer permissions, and creates or updates:

- a global HTTPS uptime check for `/readyz`, including response-content and TLS
  validation;
- email notification channels for every configured recipient;
- a load-balancer 5xx logs-based metric;
- alerts for readiness failures from at least two checker regions, sustained VM
  CPU and filesystem pressure, Cloud SQL storage, and PostgreSQL connections
  above 80% of the live `max_connections` value;
- a disabled HTTPS 5xx policy retained for later use when deployments have
  rolling capacity instead of a single broker container.

Rerun the command after changing the VM, Cloud SQL tier, HTTPS backend, or
notification recipient. Alert policies notify on incident open and close and
auto-close stale incidents after seven days. Use a group mailbox rather than a
personal address once an operations rotation exists.

Before HTTPS activation, if outbound port 80 is blocked, create an SSH tunnel:

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

For a live HTTPS check after activation:

```sh
curl --fail "https://probe.example.com/healthz"
curl --fail "https://probe.example.com/readyz"
curl --fail \
  -H "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  "https://probe.example.com/v1/services"
curl --fail \
  -H "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  "https://probe.example.com/v1/safety"
```

`/healthz` and `/readyz` are intentionally unauthenticated and expose no
secrets. Readiness returns `503` when Postgres cannot be reached. All `/v1/*`
routes reject missing or incorrect keys with `401`.

## Production path

The single-VM topology is suitable for controlled internal testing after
regular off-VM backups are scheduled. Before storing important evidence or
opening access beyond a narrow operator network, complete these items in order:

1. Use `DATABASE_BACKEND=cloud-sql`, run `recovery-drill.sh` to verify a managed
   backup and point-in-time recovery, and migrate any retained local data before
   cutover.
2. Activate the provided HTTPS load-balancer path with a domain and verify that
   direct broker ingress has been removed.
3. Rotate the initial shared key, distribute it outside source control, and
   periodically disable obsolete Secret Manager versions.
4. Run `provision-monitoring.sh` and verify the Ops Agent, `/readyz` uptime
   check, load-balancer 5xx alert, VM CPU/disk alerts, and Cloud SQL
   storage/connection alerts deliver to the intended notification channel.
5. Build immutable images in CI, scan them, push them to Artifact Registry, and
   deploy pinned digests with a tested rollback procedure.
6. Define retention for probe events, expired probes, source maps, and backups.
   Keep one broker replica until cross-instance long-poll notification and
   shared coordination are implemented.
7. Verify Clerk role assignments, remove routine use of the shared break-glass
   key, and issue a separate service credential per deployed service. Human
   identity, tenant isolation, and append-only control-plane audit events are
   implemented; define audit/event retention and external export before
   regulated use.

## Destroy and cost control

The VM, disk, static address, Cloud SQL instance, backups, and traffic can
incur charges. Use the same overrides used at deployment:

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/destroy.sh
```

The script stops Compose when possible and deletes the VM and auto-delete disk,
the deployment's regional and global addresses, HTTPS load-balancer resources,
and managed firewall rules. It does not alter unrelated firewall rules, delete
the GCP project, or delete a Cloud SQL instance. Cloud SQL deletion protection
remains enabled so database destruction requires a separate explicit
administrative action.

## Security boundaries

- The demo contains deterministic fake data only.
- The shared bearer key is a break-glass admin credential for the internal
  tenant. Routine human access should use Clerk, and each agent should use a
  separately revocable service credential.
- Secret Manager is the source of truth, but Docker Compose still requires
  secret payloads in root-readable `/etc/liveprobe/deployment.env` on the VM.
- Before HTTPS activation, HTTP is unencrypted. Use a trusted path or an SSH
  tunnel and do not carry non-demo data.
- TLS protects network transport after activation. Clerk tokens provide human
  identity, role authorization, and organization tenant scope; the shared key
  intentionally bypasses those human boundaries for break-glass operation.
- Node and JVM breakpoints can briefly pause an executing thread. Python line
  callbacks add target-process work. Read-only does not mean zero impact.
- Redaction and bounded serialization are defense in depth, not proof that an
  unknown secret cannot be captured.
- Never expose JDWP or the demo application ports to the internet.
