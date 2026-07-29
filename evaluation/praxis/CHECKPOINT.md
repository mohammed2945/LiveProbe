# PRAXIS Evaluation Checkpoint

## Clean restart checkpoint — 2026-07-29

Branch `praxis-eval` is pushed through commit `2c3e6d0`. This is a safe
pre-paid pause point:

- no campaign, tripwire, PRAXIS runner, or Codex model process is running;
- the official incident-401 fault is removed and recommendation is back on
  `ghcr.io/open-telemetry/demo:2.0.1-recommendation`;
- Prometheus has no firing alerts;
- the broker reports zero active probe locations; and
- every failed campaign/setup attempt recorded zero model calls and zero
  provider tokens.

The reusable Linux environment remains running so a workstation restart does
not discard the Kind cluster:

```text
GCP project:  liveprobeeval
VM:           liveprobe-praxis-eval
zone:         us-east1-b
machine:      n2-custom-32-65536
disk:         250 GB pd-balanced
repo:         /home/veer/LightProbe
artifact:     /home/veer/LightProbe/.eval-cache/praxis/438709b4b4b43467ec384de8ee398b2cc75f2e495a57514fd57784021af7814f
source panel: /home/veer/LightProbe/.eval-cache/praxis-sources
```

Persistent VM sessions that should still exist after reconnecting:

```text
cloud-provider
ingress-forward
broker-forward
```

The VM continues to incur compute charges while running. Do not delete it; the
user will explicitly say when deletion is allowed.

### What the live correctness pass found and fixed

The pre-model gates correctly prevented paid calls while surfacing real
large-codebase/runtime integration gaps. The pushed fixes now cover:

- runtime source-path discovery with exact locked-source hash verification;
- explicit non-production auth mode for the isolated evaluation broker;
- timezone-qualified ClickHouse snapshot windows;
- local Kind image rollout via `imagePullPolicy: IfNotPresent`;
- a `.pth` bootstrap that coexists with OpenTelemetry's own
  `sitecustomize`;
- the actual failing recommendation HTTP route;
- a reachable post-`ListProducts` boundary criterion across all 16 source
  variants; and
- enough tripwire hit allowance to preserve the pre-registered replay under
  background load.

The latest static gate passed all 16 variants. Incident 401 now builds a legal
probe at `recommendation_server.py:96` for `cat_response`. In the real cluster
that probe arms, captures exact-execution snapshots, preserves the deferred
frontier, and runs in the real application process.

### Exact remaining blocker

The replay base currently points at port `8080`, which is a port-forward to the
ingress controller used for Prometheus and ClickHouse. Astronomy Shop has no
Ingress rule there, so the replay receives HTTP 404 and never reaches
`frontend-proxy`. The application service is
`otel-demo/frontend-proxy:8080`.

This is the next action after reconnecting:

1. Start a separate persistent VM forward:

   ```sh
   tmux new-session -d -s frontend-forward \
     'kubectl -n otel-demo port-forward service/frontend-proxy 8081:8080'
   ```

2. Verify the clean service through
   `http://127.0.0.1:8081/api/recommendations?productIds=0PUK6V6EV0`.
3. Change the campaign, collector, and runtime-tripwire replay defaults from
   port `8080` to `8081`. Change the registered snapshot recipe from
   `/api/products/...` to the trace-proven
   `/api/recommendations?productIds=...` route.
4. Add/update contract coverage, run the 27 evaluation contracts and the
   16-variant static compatibility gate, commit, and push.
5. Run the real zero-token incident-401 runtime tripwire with automatic fault
   cleanup. Do not open the paid gate until it emits a `status: passed`
   artifact containing correlated snapshots, typed dossiers, judgments, and
   preserved alternatives.
6. Start a fresh campaign directory (next suggested name:
   `/home/veer/praxis-campaign-smoke-gpt54-r6`) using `gpt-5.4`, low
   reasoning, all four arms, seed 10, and
   `--replay-base-url=http://127.0.0.1:8081`.
7. Generate the deterministic report, copy the campaign artifacts locally,
   update the results README with real time/token comparisons, push, then stop
   (but do not delete) the VM.

Previous setup attempts under `praxis-campaign-smoke-gpt54-r2` through `r5`
are retained as zero-call harness failures and must not be reported as
leaderboard outcomes.

---

Checkpoint date: 2026-07-28
Branch: `praxis-eval`
Status: implementation and all local zero-token validation complete. The first
real four-arm smoke is ready but requires a conforming Linux host.

## Completed in the final correctness pass

- Boundary scoring now derives terminal expectations from `scenarios.json`.
  Direct-code cases require `LOCALIZED`; external-boundary cases accept either
  an evidence-backed `HANDOFF` or `LOCALIZED`. Root identity, location,
  propagation, and evidence requirements are unchanged.
- The incident-405 fixture proves the distinction: normal/PRAXIS return
  `LOCALIZED`, while graph/raw LiveProbe return `HANDOFF`; all four pass the
  same common scorer.
- Added a standard-library-only released-PRAXIS artifact gate. It validates
  `RCAAgentV2`, fair-adapter patch points, code-enhanced configuration,
  `INCIDENT_NUMBER` selection, and every Recommendation program graph/default
  anchor for incidents 401–416.
- Corrected fair PRAXIS execution to run from `praxis-ae`, select the requested
  incident even if a stale `/tmp/current_incident.env` exists, and import
  safely without requiring provider credentials that the replaced backend
  never uses.
- Added an exact release-import gate before image or cluster mutation.
- Added a deterministic zero-model PRAXIS-loop tripwire. Along with the full
  LiveProbe runtime tripwire, it must pass on incident 401 before any paid arm.
- Expanded remote preflight to require the released PRAXIS Python dependency
  set.

## Latest verified zero-token result

```text
required local gates:       31/31 passed
Python analyzer tests:      41 passed
MCP server tests:           22 passed
evaluation contracts:       20/20 passed
LiveProbe source panel:      16/16 variants passed
PRAXIS artifact checks:     36/36 passed
PRAXIS incident graphs:     16/16 graphs and anchors passed
fixture tripwire:           12/12 cases, 0 model calls
static graph size:          19–23 nodes per criterion
canonical initial sites:    30 total
static compatibility wall:  2.36 s
```

Total benchmark model calls so far: **0**.

Generated artifacts:

- `evaluation/praxis/results/local-validation.json`
- `evaluation/praxis/results/liveprobe-compatibility.json`
- `evaluation/praxis/results/praxis-artifact-compatibility.json`
- `evaluation/praxis/results/fixture.json`
- `evaluation/praxis/results/official-oracle.json` (scorer-only)
- `evaluation/praxis/results/remote-preflight.json`
- `evaluation/praxis/results/README.md`

Only `results/README.md` is intentionally tracked; raw validation and oracle
artifacts are ignored.

## Locked local inputs

```text
artifact root:
.eval-cache/praxis/438709b4b4b43467ec384de8ee398b2cc75f2e495a57514fd57784021af7814f

offline archive:
/private/tmp/codex-praxis-plan.sPspm9/dsn26-praxis-ae.zip

artifact SHA-256:
438709b4b4b43467ec384de8ee398b2cc75f2e495a57514fd57784021af7814f

extracted source panel:
.eval-cache/praxis-sources/401 through 416
```

## Current blocker

The current machine is intentionally rejected before cluster mutation or paid
execution:

```text
platform:                    Darwin
CPUs:                        8
memory:                      16 GiB
Kind:                        missing
Helm 3.18.4:                 missing
released PRAXIS Python deps: incomplete
```

The real campaign requires Linux, at least 16 CPUs, 32 GiB RAM, Docker, Kind,
kubectl, Go, Python 3.12 with the released dependency set, and exactly Helm
3.18.4.

## Exact next action

On a conforming host, import/extract the locked artifact, then use a fresh,
empty campaign directory:

```sh
make praxis-eval-gates \
  PRAXIS_ARTIFACT_ROOT=/path/from/fetch-artifact \
  PRAXIS_ARTIFACT_ARCHIVE=/path/to/dsn26-praxis-ae.zip

make praxis-eval-smoke \
  PRAXIS_ARTIFACT_ROOT=/path/from/fetch-artifact \
  PRAXIS_CAMPAIGN_ROOT=/path/to/new-empty/campaign-smoke \
  PRAXIS_MODEL=gpt-5.4-mini \
  PRAXIS_ALLOW_PAID_MODEL=1

node evaluation/praxis/src/report.mjs \
  --campaign=/path/to/new-empty/campaign-smoke/campaign.json
```

Smoke scope: incident 401, seed 10, all four arms, low reasoning, a
30,000-token ceiling per arm, and a three-minute wall limit per arm. Do not
start pilot or claim tiers until this four-run smoke is complete and scored.

## Worktree caution

The worktree contains pre-existing user changes. Preserve unrelated demo,
editor, and documentation files. Evaluation work under `evaluation/praxis/`,
the analyzer boundary changes, and `skills/liveprobe-raw-investigation/` are
intentional implementation work. Do not commit or push unless the user asks.
