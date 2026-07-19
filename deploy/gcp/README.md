# GCP single-VM demo operator guide

> **Demo only:** this is a fake-data, single-instance HTTP deployment. It has no
> broker authentication, authorization, TLS, high availability, or production
> data controls. Do not use it as production infrastructure.

This guide deploys the accepted LiveProbe demo from
[`mohammed2945/LightProbe`](https://github.com/mohammed2945/LightProbe) to one
Google Compute Engine (GCE) VM. The deployment packages a clean local Git
`HEAD` with `git archive` and copies it with `gcloud compute scp`. It does not
clone GitHub on the VM and does not require GitHub credentials there.

## What runs where

```text
Cursor
  `-- stdio --> local npx @doomslayer2945/liveprobe-mcp@0.1.0
                   `-- unauthenticated HTTP --> GCE broker :80
                                                   |
                       +---------------------------+------------------+
                       |                           |                  |
                 Node SDK                    Python SDK         Java JDI bridge
              payment-service              billing-worker      inventory-service
```

The broker stores probe definitions, statuses, and retained sanitized evidence
in its Docker `broker-state` volume. It does **not** install a breakpoint in a
target. The Node and Python SDKs poll the broker and install or remove their
runtime instrumentation. The Java bridge polls the broker and installs or
removes JDI breakpoints in the inventory JVM over the internal diagnostic
network.

Only broker HTTP port `80` is published on the VM's external interface.
Payment, billing, and inventory HTTP ports bind to VM loopback. JDWP stays on
the internal Compose network and is never published to the host. The Compose
MCP profile is not started because Cursor runs the MCP server locally with
`npx`.

## Prerequisites

- A GCP project with billing enabled and permission to enable Compute Engine
  and manage instances, addresses, firewall rules, and SSH access.
- `git`, `curl`, Docker with Compose v2, Node.js 20 or newer, and npm.
- The Google Cloud CLI (`gcloud`). Install it before the first deployment if it
  is not already available.
- A clean checkout of this repository. If needed:

  ```sh
  git clone https://github.com/mohammed2945/LightProbe.git
  cd LightProbe
  ```

- Public npm availability of
  `@doomslayer2945/liveprobe-mcp@0.1.0`, which Cursor starts on the operator
  machine.

Docker is installed automatically on the VM. Local Docker is still useful for
the optional Compose configuration check and local demo.

## Install and authenticate `gcloud` on macOS

With Homebrew:

```sh
brew install --cask google-cloud-sdk
exec -l "$SHELL"
gcloud --version
```

Authenticate with the account that can manage the demo project. These scripts
use normal `gcloud` user credentials; Application Default Credentials are not
required.

```sh
gcloud auth login
gcloud config set project "<PROJECT_ID>"
gcloud auth list
gcloud config get-value project
gcloud billing projects describe "<PROJECT_ID>"
```

Confirm that the last command reports `billingEnabled: true`. The deploy script
enables `compute.googleapis.com`; your account must be allowed to enable that
service.

## Publish or verify the MCP npm package

The VM does not run this package. Cursor runs it locally, and the package then
connects to the VM's broker. npm package versions are immutable: if `0.1.0`
already exists, verify it and do not try to publish that version again.

Install dependencies and authenticate to npm:

```sh
corepack enable
corepack install
pnpm install --frozen-lockfile
pnpm --filter @doomslayer2945/liveprobe-mcp run test
npm login
npm whoami
npm view @doomslayer2945/liveprobe-mcp@0.1.0 version
```

If `npm view` prints `0.1.0`, skip publication. If it returns an npm `E404` and
you own the `@doomslayer2945` scope, build and publish from the package directory:

```sh
pnpm --filter @doomslayer2945/liveprobe-mcp run build
(cd packages/mcp-server && npm publish --access public)
npm view @doomslayer2945/liveprobe-mcp@0.1.0 version
npx -y @doomslayer2945/liveprobe-mcp@0.1.0 --help
```

An npm `E403` usually means the version already exists or the logged-in account
cannot publish to the scope. Resolve that before the demo; deployment can
succeed while Cursor later fails to start the MCP package.

## Prepare the commit to deploy

`deploy/gcp/deploy.sh` refuses to run if there is any tracked modification or
non-ignored untracked file. Every intended change must be committed because
`git archive` includes only the clean local `HEAD`. Remove or move unintended
artifacts; do not commit secrets or generated files just to make the tree
clean. Stage every intended path explicitly; the example below stages this
documentation change, so add any other intended paths before committing.

```sh
git status --short
git add README.md deploy/gcp/README.md
git commit -m "Prepare GCP demo"
git status --short
git rev-parse HEAD
```

The second `git status --short` must print nothing. Pushing to GitHub is good
operational hygiene, but the deploy script does not deploy from GitHub:

```sh
git push origin HEAD
```

Save the full SHA from `git rev-parse HEAD`. The deploy script prints the same
value after a successful deployment.

## Deploy

From the repository root, replace `<PROJECT_ID>` and run exactly:

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/deploy.sh
```

For the current Stanford visitor Wi-Fi NAT pool and demo project, the exact
command is:

```sh
PROJECT_ID=totemic-studio-502902-u2 CLIENT_CIDR=68.65.169.128/28 deploy/gcp/deploy.sh
```

The first deployment commonly takes several minutes because it creates the VM,
installs Docker and Node.js 24, installs the pinned pnpm version, restores
workspace dependencies, and builds every demo image. Deployment succeeds only
after every Compose service is healthy and the broker answers
`/v1/services`.

### Defaults and cost warning

The defaults are:

- region `us-central1` and zone `us-central1-a`
- VM `liveprobe-demo` with machine type `e2-standard-4`
- Ubuntu 24.04 on a 40 GB `pd-balanced` boot disk
- premium-tier regional external address `liveprobe-demo-ip`
- default VPC network and target tag `liveprobe-demo`
- broker port `80`
- broker firewall rule `liveprobe-demo-broker` for `tcp:80`
- SSH firewall rule `liveprobe-demo-ssh` for `tcp:22`
- the detected public client IPv4 `/32` as the source for both managed rules

**These resources cost money.** The VM, balanced disk, static external IPv4,
egress, and other GCP usage can incur charges. Prices vary by region and
account, so check the current GCP pricing calculator. Do not leave the demo
running after the presentation; use `destroy.sh`, not just a Compose stop.

Every default has an uppercase environment override. The supported deployment
settings are `PROJECT_ID`, `REGION`, `ZONE`, `VM_NAME`, `MACHINE_TYPE`,
`DISK_SIZE`, `STATIC_IP_NAME`, `FIREWALL_RULE`, `FIREWALL_SSH_RULE`, `NETWORK`,
`NETWORK_TAG`, `BROKER_PORT`, `CLIENT_IP`, `CLIENT_CIDR`, and `GCLOUD_BIN`.
Export the same non-default values before every deploy, status, log, firewall,
and destroy command.

### Resources created

The scripts enable the Compute Engine API and create or reuse:

- one regional premium static external IPv4 address
- two ingress firewall rules, one for the broker and one for SSH
- one standard GCE VM with an auto-delete boot disk and the demo network tag
- release directories under `/opt/liveprobe/releases/<COMMIT>` and the
  `/opt/liveprobe/current` symlink on that VM
- locally built Docker images, eight running Compose services, and the
  `broker-state` named volume on the VM

The services are the broker; three target services; three traffic generators;
and the Java bridge. `gcloud compute ssh` may also create or update the normal
SSH key material used by your GCP account configuration.

Redeploying reuses matching GCP resources, uploads the new clean `HEAD`, creates
a commit-named release if needed, repoints `/opt/liveprobe/current`, rebuilds
images, and restarts Compose. Older release directories remain on the VM until
the VM is destroyed.

### Source-IP firewall behavior

At deploy time, the scripts obtain the operator's public IPv4 from
`https://api.ipify.org`, with `https://checkip.amazonaws.com` as a fallback,
unless `CLIENT_IP` or `CLIENT_CIDR` is set. `CLIENT_IP` must be one bare IPv4
address, not a CIDR. The scripts convert it to `<IP>/32`.

For rotating NAT pools, set `CLIENT_CIDR` instead. It accepts exactly one IPv4
CIDR with a prefix from `/24` through `/32`, normalizes host bits to the network
address, and rejects hostnames, comma-separated lists, malformed values, and
broader ranges. `CLIENT_IP` and `CLIENT_CIDR` are mutually exclusive. The
deployer resolves this source once and applies the same normalized range to:

- `tcp:80` on `liveprobe-demo-broker`
- `tcp:22` on `liveprobe-demo-ssh`

If a VPN, office network, hotspot, or ISP changes the public IP, both broker and
SSH access stop until the rules are refreshed. The scripts do not modify or
delete unrelated GCP firewall rules. An existing broad rule on the same network
can still expose these ports, so inspect the project's other firewall rules.

These are inbound GCP VPC firewall rules. They cannot change or bypass a campus
network's outbound policy. Stanford visitor Wi-Fi was observed to block
outbound TCP `7070` while allowing the current broker at
`http://136.116.88.131:80`; its observed rotating NAT addresses
`68.65.169.130`, `.131`, `.132`, `.136`, and `.138` are covered by
`68.65.169.128/28`.

## Connect Cursor

Successful deployment prints the broker URL, the deployed SHA, and ready-to-use
JSON. Replace `<BROKER_IP>` below with that printed static address and add this
exact server configuration to Cursor's MCP settings:

```json
{
  "mcpServers": {
    "liveprobe": {
      "command": "npx",
      "args": [
        "-y",
        "@doomslayer2945/liveprobe-mcp@0.1.0",
        "--broker-url",
        "http://<BROKER_IP>:80"
      ]
    }
  }
}
```

The equivalent command is:

```sh
npx -y @doomslayer2945/liveprobe-mcp@0.1.0 \
  --broker-url "http://<BROKER_IP>:80"
```

`--broker-url` matches the published CLI and takes precedence over its
`BROKER_URL` environment fallback. Restart or reconnect the MCP server in
Cursor after changing the configuration.

### SSH-tunnel fallback

If the current network also blocks outbound port `80` but permits SSH, refresh
the managed source range and keep this tunnel running:

```sh
PROJECT_ID="<PROJECT_ID>" CLIENT_CIDR="<CLIENT_CIDR>" \
  deploy/gcp/refresh-firewall.sh
gcloud compute ssh liveprobe-demo \
  --project="<PROJECT_ID>" \
  --zone=us-central1-a \
  -- -N -L 7070:127.0.0.1:80
```

Point the local MCP process at `http://127.0.0.1:7070` while the tunnel is
open. This fallback carries broker HTTP inside SSH; it does not expose any
additional VM port or change the campus firewall.

## Commit-hash prompt workflow

The set-probe tools require a 7-64 character hexadecimal `commit_hash`. Use this
workflow:

1. Keep the `Deployed SHA to paste when asked` value printed by `deploy.sh`.
2. Tell Cursor not to infer a revision and to ask before creating the first
   probe.
3. When Cursor asks, paste the printed SHA.
4. Cursor should validate that object in the local repository and inspect
   source from that exact revision before choosing a source path and line:

   ```sh
   git cat-file -e "<DEPLOYED_SHA>^{commit}"
   git show "<DEPLOYED_SHA>:path/to/source-file"
   ```

5. Use one-hit, short-TTL probes, read the retained evidence, and remove every
   probe when the investigation finishes.

The MCP server normalizes `commit_hash` and sends it to the broker as
`sourceCommit`. **`sourceCommit` is user-supplied audit metadata. It does not
prove or verify which code the target runtime is executing.** The broker,
runtime SDKs, and Java bridge do not perform that verification.

## Day-of-demo runbook

### 1. Preflight

Run this at least 30 minutes before the presentation:

```sh
npm view @doomslayer2945/liveprobe-mcp@0.1.0 version
npx -y @doomslayer2945/liveprobe-mcp@0.1.0 --help
git status --short
PROJECT_ID="<PROJECT_ID>" CLIENT_CIDR="<CLIENT_CIDR>" \
  deploy/gcp/refresh-firewall.sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/status.sh
```

Expected results are npm version `0.1.0`, empty Git status, healthy Compose
services, a printed broker URL, and a full deployed SHA. Firewall refresh runs
first so a changed VPN, hotspot, office, or ISP address does not block the SSH
status check. Omit the `CLIENT_CIDR` assignment when the network has one stable
public IPv4; refresh then detects it and restores `/32` rules.

### 2. Start the guided investigation

Paste this first:

> Connect to LiveProbe and list the live services. Before creating any probe,
> ask me for the deployed commit SHA; do not infer it from local HEAD and do not
> claim to discover it from the runtime. Inspect source at that exact local
> revision. Use only one-hit snapshot probes with a TTL of at most 60 seconds,
> report only sanitized evidence, and remove every probe when finished.

When Cursor asks for the SHA, paste only the value printed by `deploy.sh` or
`status.sh`. Then paste:

> Investigate the failing free-tier payments, legacy billing renewals, and
> inventory reservations. Explain the cause of each from captured evidence,
> confirm traffic continues, and remove every probe when finished.

For a slower presentation, use one prompt per runtime:

> Investigate why free-tier requests fail in `payment-service`. Use the unique
> snapshot target in the exact deployed source, collect one sanitized snapshot,
> and remove the probe.

> Investigate why legacy renewals fail in `billing-worker`. Condition the
> one-hit snapshot on the legacy user, collect only the fields needed to explain
> the tax failure, and remove the probe.

> Investigate the stale-cache reservation bug in `inventory-service`. Capture
> the follower decision at the marked source line, prove the cached stock is
> stale relative to authoritative stock, and remove the probe.

### 3. Expected evidence

The exact probe IDs, timestamps, and line numbers vary with the build. The
diagnostic conclusions should be stable:

- **Node / `payment-service`:** `user.tier` is `free`, `balance` is `null`, and
  `pool.active` is `5`. The code converts the missing balance to zero and
  reports `InsufficientFunds` while premium and enterprise traffic continues.
- **Python / `billing-worker`:** `user.is_legacy` is `true` and `user.address`
  is `null` at the tax line. Address access fails for the legacy record while
  modern renewal traffic continues.
- **JVM / `inventory-service`:** `requestRole` is `follower`,
  `cachedStock > authoritativeStock`, and
  `requested > authoritativeStock && requested <= cachedStock`. The stack
  includes `InventoryService.java`; the stale cached value permits an invalid
  reservation.

`list_services` should identify Node, Python, and JVM services with recent
heartbeats. At the end, `list_probes` should show no investigation probes still
active because Cursor removed them.

## Operate and redeploy

Pass the same overrides used for deployment to every command. With defaults,
only `PROJECT_ID` is required:

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/status.sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/logs.sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/logs.sh --follow --tail 500
PROJECT_ID="<PROJECT_ID>" deploy/gcp/refresh-firewall.sh
```

`status.sh` shows Compose state, the deployed SHA marker, and the broker URL.
`logs.sh` defaults to the last 200 lines from all services. `--follow` streams
logs, and `--tail N` changes the retained line count.

To set an explicit new firewall source:

```sh
PROJECT_ID="<PROJECT_ID>" CLIENT_IP="<PUBLIC_IPV4>" \
  deploy/gcp/refresh-firewall.sh

PROJECT_ID="<PROJECT_ID>" CLIENT_CIDR="<PUBLIC_IPV4_CIDR>" \
  deploy/gcp/refresh-firewall.sh
```

Set only one of `CLIENT_IP` and `CLIENT_CIDR`. Omit both to redetect the current
public IPv4 and restore `/32` rules.

To redeploy a new revision, commit every intended change, confirm the tree is
clean, and run the same deployment command:

```sh
git status --short
PROJECT_ID="<PROJECT_ID>" deploy/gcp/deploy.sh
```

Save the newly printed SHA and give that value to Cursor for subsequent probes.

## Common failures

- **`required command not found: gcloud`:** install the Google Cloud CLI, start
  a new login shell, and verify `gcloud --version`.
- **Authentication, billing, API, or permission errors:** rerun
  `gcloud auth login`, verify the selected project, confirm billing is enabled,
  and use an account allowed to enable Compute Engine and manage the listed
  resources.
- **`deployment requires a clean Git working tree`:** inspect
  `git status --short`; commit every intended file and remove or move unintended
  non-ignored artifacts. The deployer will never include dirty working-tree
  content.
- **npm `E404` or Cursor cannot start the MCP server:** publish or verify
  `@doomslayer2945/liveprobe-mcp@0.1.0`, then run its `--help` command locally.
- **Broker or SSH stopped working after a network change:** refresh both
  managed firewall rules. If automatic public-IP detection is wrong, pass a
  bare IPv4 with `CLIENT_IP`, or pass one `/24` through `/32` NAT pool with
  `CLIENT_CIDR`. If outbound port `80` is blocked, use the SSH-tunnel fallback.
- **Existing VM external IP does not match the reserved IP:** the named VM and
  address are inconsistent. Inspect them in GCP; use matching resource-name
  overrides or destroy the demo resources before recreating them.
- **VM did not become reachable over SSH:** check both managed and unrelated
  VPC firewall rules, the current source IPv4, VM status, account SSH access,
  and organization policies.
- **Compose or post-start health checks fail:** run `status.sh` and `logs.sh`.
  The remote bootstrap already installs Node.js 24, the exact pinned pnpm
  version, Docker Compose, and builds the Node SDK before the images.
- **A probe reports `line-not-found` or never arms:** use the exact deployed
  revision, the runtime's source-path suffix, and the marked source line. Node
  executes generated JavaScript, Python uses `app.py`, and the JVM requires the
  packaged debug metadata. Changing `sourceCommit` metadata does not correct a
  wrong file or line.
- **The Java bridge cannot attach:** inspect inventory and `java-bridge` logs.
  JDWP must stay on the internal `jvm-diagnostics` network; do not expose port
  `5005` publicly.
- **Old definitions or evidence appear:** the broker volume persists across
  Compose restarts and redeploys. Remove probes through MCP. For a fully clean
  remote state, destroy and recreate the VM.

## Destroy and stop charges

Use the same overrides used at deployment:

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/destroy.sh
```

The script first tries to stop Compose, then deletes:

- the GCE VM and its auto-delete boot disk, including Docker images, releases,
  and the broker volume
- the managed broker and SSH firewall rules
- the reserved regional static external IPv4 address

It does not delete unrelated default firewall rules, disable the Compute Engine
API, alter the GitHub repository, or remove the npm package. Confirm in the GCP
console that the VM, named address, and both managed firewall rules are gone.
If you used non-default names, provide those same overrides to `destroy.sh`.
Deleting the VM is the required cost-cleanup step; stopping Compose alone leaves
the billable VM, disk, and address in place.

## Security boundaries

- The demo carries deterministic fake data only.
- Broker HTTP is unauthenticated and unencrypted. A source `/32` or narrowly
  scoped NAT CIDR reduces exposure but is not a substitute for identity, TLS,
  or a private network.
- Other GCP firewall rules can broaden access beyond the managed source range.
- Node and JVM breakpoints can briefly pause an executing thread, and Python
  line callbacks add target-process work. "Read-only" does not mean zero
  runtime impact.
- Redaction and bounded serialization are defense in depth, not proof that an
  unknown secret could never be captured.
- Keep probes narrow, one-hit, and short-lived; review watch paths and remove
  every probe promptly.
- Never publish JDWP, payment, billing, or inventory ports to the internet.

## Maintainer validation

The static and mocked command-construction tests do not call `gcloud`. They
cover SDK prerequisites, port-80 defaults, Cursor MCP JSON, strict CIDR
validation, and create/update/delete commands for both managed firewall rules:

```sh
deploy/gcp/test.sh
docker compose \
  -f demo/docker-compose.yml \
  -f deploy/gcp/docker-compose.gcp.yml \
  config --quiet
```
