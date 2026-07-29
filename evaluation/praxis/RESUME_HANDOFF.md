# PRAXIS × LiveProbe evaluation resume handoff

Last updated: 2026-07-29  
Repository: `/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe`  
Branch: `praxis-eval`  
Pushed HEAD: `80f1263484e1a64fbf0c7a8ab694e6660961a58a`  
Status: the final four-arm smoke evaluation has **not** produced a valid
leaderboard yet. A tested local fix is uncommitted and must be pushed before
the next clean campaign.

Read this document completely before running commands. It is intended to be
self-contained for an agent with no prior conversation context.

## Objective

Evaluate LiveProbe as a tool used by a coding agent that is already working an
incident with metrics, logs, and distributed traces.

Observability answers where to begin: service, endpoint, failing occurrence,
trace ID, revision, and an initial `(file, line, value)` criterion. LiveProbe
then answers what ordinary observability cannot: the actual values on that
correlated request and where those values came from.

The controlled leaderboard has four arms:

1. `normal_coding_sre`
   - repository access;
   - immutable observability snapshot through MCP;
   - pre-registered replay;
   - no LiveProbe.
2. `praxis`
   - the released PRAXIS investigation loop and incident program graph;
   - the same immutable observability evidence through the fair adapter;
   - no LiveProbe.
3. `graph_liveprobe`
   - coding agent;
   - the same observability access;
   - graph-guided LiveProbe investigation tools and legal actions.
4. `raw_liveprobe`
   - coding agent;
   - the same observability access;
   - raw probe operations without the causal graph.

This is a controlled internal comparison, not a claim of exact native PRAXIS
performance. The fair PRAXIS adapter preserves PRAXIS's released reasoning
loop and code-enhanced graph while giving it the same frozen incident evidence
and model as the other arms.

The smoke scope is deliberately small:

- incident: `401`;
- seed: `10`;
- model: `gpt-5.4`;
- reasoning effort: `low`;
- one run per arm;
- hard budget: 50,000 rollout-weighted tokens per arm;
- coding-agent wall limit: three minutes per arm.

Do not describe an `n=1` smoke result as statistically meaningful. It is a
pipeline and directional-comparison result only.

## Evaluation rules that must remain true

- The official oracle is scorer-only and is generated/applied after model
  attempts. Never expose it in a model prompt or MCP result.
- All four controlled arms receive the same immutable incident snapshot.
- Both baseline and LiveProbe arms receive good, arm-appropriate guidance.
- Probe locations must come from LiveProbe legal actions and canonical graph
  nodes. The agent must not invent file/line/expression triples.
- A probe result correlated to the replay occurrence is hard evidence.
- A log with the matching trace ID is near-hard evidence, but a correlated
  probe wins on conflict.
- Logs, metrics, or deploy history without a trace ID are soft priors only.
- `UNKNOWN` must not be filled with a guess.
- Failed, timed-out, and insufficient attempts remain visible.
- Invalid infrastructure/setup attempts are excluded from leaderboard
  accuracy but reported separately as setup overhead.
- Do not raise the 50,000-token smoke cap without asking the user.
- Do not use `gpt-5.4-mini` for the real benchmark. The user explicitly chose
  full `gpt-5.4` with low reasoning.

## Token accounting

Provider-reported categories must all be reported:

- aggregate input tokens;
- cached input tokens;
- new input tokens (`input - cached`);
- output tokens;
- reasoning tokens;
- coding-agent outer turns;
- model-sample lower bound;
- wall/model/runtime time;
- tool calls and replay/probe operations.

The enforced Codex rollout budget uses:

```text
rollout-weighted tokens = non-cached input + output
```

Both default Codex weights are `1.0`. Cached input remains reported but does
not consume the rollout cap. Commit `80f1263` fixed the old harness, which
incorrectly rejected a completed Codex turn by adding every cached context
replay to the cap. The report now includes a separate rollout-weighted column.

## Completed implementation

Important pushed commits, newest first:

```text
80f1263 Align evaluation budget with Codex rollout accounting
356274c Set practical capped smoke budget
ffb5f4a Enforce Codex rollout budgets during evals
32ace6c Limit diagnosis schema to provider subset
efb8785 Make diagnosis schema provider-strict
6e4eb73 Honor UNKNOWN in runtime tripwire
b6f56f7 Add trace-targeted LiveProbe evaluation flow
```

The implemented pipeline includes:

- four explicit capability profiles and guidance prompts;
- immutable observability snapshots and a read-only observability MCP;
- pre-registered two-phase replay identities;
- trace-targeted LiveProbe occurrences;
- graph and raw LiveProbe MCP profiles;
- legal-action filtering and privacy-preserving operation ledgers;
- official-oracle isolation and common scoring;
- source extraction for PRAXIS incidents 401–416;
- static compatibility checks across all 16 source variants;
- exact runtime source/commit verification;
- HTTP, gRPC, and socket boundary checks;
- real incident injection/removal through the released artifact;
- a real LiveProbe runtime tripwire;
- a deterministic PRAXIS adapter tripwire;
- preemptive Codex rollout budgets;
- exact recovery of provider usage from failed-arm ledgers;
- generated time, reliability, token, and operation report tables.

Previously verified zero-token gates:

```text
evaluation contracts:       31 passed, 1 skipped before the latest fix
latest local contracts:      33 passed, 1 skipped
Python analyzer tests:       44/44 in an earlier complete run
repository package tests:    121 passed, 5 skipped in an earlier complete run
static source variants:      16/16
runtime LiveProbe tripwire:  passed on the real incident
PRAXIS adapter tripwire:     passed on the real incident
```

The laptop currently lacks `pnpm`, `corepack`, and local `pytest`, so the latest
change was validated with:

```sh
node --test evaluation/praxis/test/contracts.test.mjs
python3 -m py_compile \
  evaluation/praxis/python/fair_praxis_adapter.py \
  evaluation/praxis/python/fair_tap_agent.py
```

Result: 33 passed, 1 skipped; Python compilation passed.

## Current uncommitted fix

Four intended files are modified locally:

```text
evaluation/praxis/src/agent-runner.mjs
evaluation/praxis/src/campaign.mjs
evaluation/praxis/src/observability-mcp.mjs
evaluation/praxis/test/contracts.test.mjs
```

The changes fix two real defects exposed by campaign `r9`.

### Defect 1: noninteractive MCP approvals

Codex discovered observability tools but cancelled each call before dispatch:

```text
error: user cancelled MCP tool call
```

The observability server never received the call and wrote no ledger record.
This was not an observability-store failure: a direct mechanical call against
the exact r9 snapshot returned the full failing trace successfully.

Codex's per-MCP default approval mode is `auto`. Unannotated or mutating tools
can require interactive approval. `codex exec` has no interactive approver, so
those calls were cancelled.

The local fix:

- makes every configured evaluation MCP server `required=true`;
- sets
  `mcp_servers.<name>.default_tools_approval_mode="approve"` for this isolated,
  explicitly authorized evaluation;
- adds standard MCP annotations to the observability tools;
- marks read-only queries as read-only/idempotent/closed-world;
- marks the pre-registered replay as non-destructive but non-read-only,
  non-idempotent, and open-world.

Do not replace this with the broad
`--dangerously-bypass-approvals-and-sandbox` option. The per-server approval
mode is narrower, and the coding agent remains in a read-only filesystem
sandbox.

### Defect 2: broker restart readiness race

The campaign restarts the broker before and after every LiveProbe arm to
isolate state. `kubectl rollout status` and one `/v1/ping` could complete while
the local service port-forward was still moving from the old broker pod to the
new one. The model then called `list_services` during that gap and concluded
that LiveProbe was unavailable.

The local fix adds `waitForLiveProbeService(...)` after every pre-arm broker
reset. It retries `/v1/services` until the exact expected runtime identity is
present:

```text
serviceId = recommendation
commitSha = fe256c4d88507959b23df2a339469e400456458b
```

Only then may a LiveProbe arm start.

New contracts verify both the per-server approval configuration and exact
service/commit readiness.

## Worktree safety

The following are unrelated user changes. Preserve them and do not stage,
edit, delete, or commit them:

```text
demo/ride-analysis/README.md
.cursor/
.vscode/
demo/investor/
demo/ride-analysis/CURRENT_UNKNOWN_FIRST_ARCHITECTURE_TRACE.md
demo/ride-analysis/GRAPH_LIVEPROBE_INEFFICIENCIES_FIXED.md
```

Stage only the four evaluation files listed above, this handoff document, and
later intentional evaluation result/report files.

Never run `git reset --hard`, `git checkout --`, or broad cleanup commands.

## Remote Linux environment

```text
GCP project:       liveprobeeval
project number:    788878246315
VM:                liveprobe-praxis-eval
zone:              us-east1-b
machine:           n2-custom-32-65536
disk:              250 GB pd-balanced
remote repository: /home/veer/LightProbe
remote branch:     praxis-eval
remote HEAD:       80f1263 before the uncommitted fix is pushed
```

The VM continues to cost money while running. The user said not to delete it.
At successful completion, **stop but do not delete** the VM.

Persistent infrastructure tmux sessions:

```text
cloud-provider
ingress-forward       # localhost:8080, Prometheus/ClickHouse ingress
frontend-forward      # localhost:8081, application replay endpoint
broker-forward        # localhost:7070, self-restarting port-forward
```

Old idle diagnostic/campaign sessions may also exist:

```text
praxis-budget-tripwire-r1
praxis-budget-tripwire-r2
praxis-campaign-r7
praxis-campaign-r8
praxis-campaign-r9
```

No campaign, benchmark, PRAXIS, or Codex model process was running at the last
successful check.

The interrupted r9 incident-401 fault is still likely active because r9 was
stopped before campaign cleanup. Treat the cluster as dirty until mechanically
verified and cleaned.

Locked released artifact:

```text
/home/veer/LightProbe/.eval-cache/praxis/438709b4b4b43467ec384de8ee398b2cc75f2e495a57514fd57784021af7814f
```

Extracted source panel:

```text
/home/veer/LightProbe/.eval-cache/praxis-sources
```

Known clean coding-agent source clone:

```text
/home/veer/praxis-budget-source-r1
```

## Invalid attempts and setup overhead

Retain these values for the final README. They are not leaderboard runs.

### Schema preflight

```text
input:      8,173
output:        99
reasoning:     10
```

### r7

All three coding arms failed schema validation before a model call.

PRAXIS began before interruption:

```text
aggregate input: 22,405
cached input:     5,632
new input:       16,773
output:             914
reasoning:          130
model calls:          2
```

### r8

Graph+LiveProbe completed a Codex outer turn, but the old post-run budget check
incorrectly counted cached replayed context and rejected it:

```text
aggregate input: 394,854
cached input:    338,944
new input:        55,910
output:             3,109
reasoning:          1,211
model samples:  at least 17
tool calls:             16
model time:      85,787 ms
```

This attempt motivated preemptive rollout budgets and corrected weighted
accounting.

### 30k capped direct tripwire

The cap stopped Graph+LiveProbe during probe deployment with:

```text
shared rollout token budget exhausted
```

This proved preemptive enforcement but also proved that 30k was too small for
this graph workflow. Smoke was raised once to 50k. Do not raise it again
without user approval.

### 50k direct graph validation

The turn completed within the actual weighted cap:

```text
aggregate input: 377,888
cached input:    340,992
new input:        36,896
output:             3,192
reasoning:          1,513
weighted:          40,088
model samples:  at least 19
model time:      82,577 ms
```

The old ledger check incorrectly rejected it as `381080 > 50000`. Commit
`80f1263` fixed that mismatch.

### r9

r9 passed both pre-paid runtime tripwires, injected a real incident, collected
a valid immutable snapshot, and completed three coding arms. It is invalid
because observability MCP calls were cancelled for approval and the two
LiveProbe arms also hit the broker restart race.

Graph+LiveProbe:

```text
status:             INSUFFICIENT
aggregate input:    148,603
cached input:       126,464
new input:           22,139
output:               1,182
reasoning:              488
weighted:            23,321
wall/model time:  38,668 ms
```

Normal coding SRE:

```text
status:             HANDOFF, but based only on bootstrap/source
aggregate input:    154,428
cached input:       134,144
new input:           20,284
output:               2,471
reasoning:              740
weighted:            22,755
wall/model time:  63,968 ms
```

Raw LiveProbe:

```text
status:             INSUFFICIENT
aggregate input:    195,368
cached input:       176,128
new input:           19,240
output:               1,858
reasoning:              358
weighted:            21,098
wall/model time:  58,349 ms
```

PRAXIS was stopped before its first model call. Its ledger remained empty.

### MCP diagnostics after r9

Diagnostic 1 prohibited discovery, so no MCP call was attempted:

```text
input:       8,008
cached:          0
output:        168
reasoning:     121
weighted:    8,176
```

Diagnostic 2 permitted discovery and proved the call was cancelled before
server dispatch:

```text
input:      26,630
cached:     16,384
new input:  10,246
output:        243
reasoning:     101
weighted:   10,489
```

Diagnostic 3 also set global `approval=never`, but MCP's separate per-server
approval policy still cancelled the call:

```text
input:      26,619
cached:     24,064
new input:   2,555
output:        207
reasoning:      83
weighted:    2,762
```

The attempted diagnostic 4, which added
`default_tools_approval_mode="approve"`, was rejected by the outer Codex
control plane before execution because this session reached its tool-approval
usage limit. It spent no model tokens.

## Why work paused

The GCP project and VM were still available. The blocker was not GCP credit.

The outer Codex control plane rejected a further `gcloud compute ssh` tool
approval because the current coding-agent session hit its usage/approval
limit. It requested fresh explicit user authorization after disclosure.

A new coding-agent session with the user's resume prompt should first obtain
permission for `gcloud compute` commands, then continue below.

## Exact resume procedure

### 1. Inspect and validate the local fix

```sh
cd /Users/veer/Documents/StartUp/hackathon_stanford/LightProbe
git status --short --branch
git diff --check
git diff -- \
  evaluation/praxis/src/agent-runner.mjs \
  evaluation/praxis/src/campaign.mjs \
  evaluation/praxis/src/observability-mcp.mjs \
  evaluation/praxis/test/contracts.test.mjs
node --test evaluation/praxis/test/contracts.test.mjs
python3 -m py_compile \
  evaluation/praxis/python/fair_praxis_adapter.py \
  evaluation/praxis/python/fair_tap_agent.py
```

Expected Node result: 33 passed, 1 skipped.

### 2. Commit and push only intended files

Stage:

```text
evaluation/praxis/src/agent-runner.mjs
evaluation/praxis/src/campaign.mjs
evaluation/praxis/src/observability-mcp.mjs
evaluation/praxis/test/contracts.test.mjs
evaluation/praxis/RESUME_HANDOFF.md
```

Suggested commit:

```text
Make noninteractive MCP evaluation calls reliable
```

Push branch `praxis-eval`. Do not include unrelated demo/editor files.

### 3. Update and verify the VM

Read-only check first:

```sh
gcloud compute ssh liveprobe-praxis-eval \
  --project liveprobeeval \
  --zone us-east1-b \
  --command="cd /home/veer/LightProbe && git status --short --branch && git rev-parse HEAD"
```

The VM checkout was clean at the last pre-r9 update. If it is still clean:

```sh
gcloud compute ssh liveprobe-praxis-eval \
  --project liveprobeeval \
  --zone us-east1-b \
  --command="cd /home/veer/LightProbe && git pull --ff-only origin praxis-eval"
```

Run the 33 contracts and Python compilation on the VM.

### 4. Run the one-call MCP approval diagnostic

Use the retained r9 snapshot:

```text
/home/veer/praxis-campaign-smoke-gpt54-r9/incident-401/incident-401.snapshot.json
```

Run one tightly capped `gpt-5.4` Codex turn with only the observability MCP,
including:

```text
mcp_servers.observability.required=true
mcp_servers.observability.default_tools_approval_mode="approve"
```

From the VM, the complete diagnostic command is:

```sh
env PATH=/home/veer/LightProbe/.venv/bin:/usr/local/bin:/usr/bin:/bin \
codex exec \
  --strict-config \
  --ignore-user-config \
  --ignore-rules \
  --ephemeral \
  --skip-git-repo-check \
  --json \
  --sandbox read-only \
  --cd /home/veer/praxis-budget-source-r1 \
  --model gpt-5.4 \
  --config 'model_reasoning_effort="low"' \
  --config 'web_search="disabled"' \
  --config 'agents.enabled=false' \
  --config 'features.rollout_budget.enabled=true' \
  --config 'features.rollout_budget.limit_tokens=15000' \
  --config 'features.rollout_budget.reminder_at_remaining_tokens=[5000,2500,1000]' \
  --config 'mcp_servers.observability.command="/usr/local/bin/node"' \
  --config 'mcp_servers.observability.args=["/home/veer/LightProbe/evaluation/praxis/src/observability-mcp.mjs","--snapshot","/home/veer/praxis-campaign-smoke-gpt54-r9/incident-401/incident-401.snapshot.json","--ledger","/home/veer/praxis-observability-diagnostic-4.jsonl","--arm","normal_coding_sre","--run-id","observability-diagnostic-4","--seed","10","--model","gpt-5.4"]' \
  --config 'mcp_servers.observability.startup_timeout_sec=10' \
  --config 'mcp_servers.observability.tool_timeout_sec=60' \
  --config 'mcp_servers.observability.required=true' \
  --config 'mcp_servers.observability.default_tools_approval_mode="approve"' \
  'Discover the observability MCP get_trace tool if required, call it exactly once with trace_id ae8437d594740f98c0bfb8f9dbf51591, and then answer only whether the trace status is ERROR. Do not inspect repository files.'
```

Prompt it to discover and call `get_trace` exactly once with:

```text
ae8437d594740f98c0bfb8f9dbf51591
```

Success criteria:

- the raw Codex event reports the MCP call `status: completed`;
- the final answer says the trace status is `ERROR`;
- the diagnostic ledger contains one completed `get_trace` record;
- no “user cancelled MCP tool call” appears.

Keep this diagnostic capped at 15,000 rollout-weighted tokens. If it fails,
stop and inspect the raw event; do not start another full campaign.

### 5. Clean the interrupted r9 incident

First verify that no paid process is running:

```sh
ps -eo pid,etime,cmd | \
  grep -E 'campaign.mjs|benchmark.mjs|fair_tap_agent.py|codex exec' | \
  grep -v grep
```

Artifact shorthand in the following commands:

```text
/home/veer/LightProbe/.eval-cache/praxis/438709b4b4b43467ec384de8ee398b2cc75f2e495a57514fd57784021af7814f/itbench-lite-ae/sre
```

Change to that directory before running the playbooks:

```sh
cd /home/veer/LightProbe/.eval-cache/praxis/438709b4b4b43467ec384de8ee398b2cc75f2e495a57514fd57784021af7814f/itbench-lite-ae/sre
```

Run:

```sh
/home/veer/LightProbe/.venv/bin/ansible-playbook -v base.yaml \
  --tags pre_fault_removal
```

Then:

```sh
/home/veer/LightProbe/.venv/bin/ansible-playbook -v base.yaml \
  --tags incident_401 \
  --extra-vars debug=true \
  --extra-vars is_fault_removal=true \
  --extra-vars incident_number=401 \
  --extra-vars sample_application=otel_astronomy_shop
```

Verify:

- `deployment/recommendation` rolled out;
- image is `ghcr.io/open-telemetry/demo:2.0.1-recommendation`;
- `GET http://127.0.0.1:8081/api/recommendations?productIds=0PUK6V6EV0`
  returns HTTP 200;
- `GET http://127.0.0.1:7070/v1/probes` returns `{"probes":[]}`;
- Prometheus eventually returns no firing alerts.

Prometheus:

```text
http://127.0.0.1:8080/prometheus/api/v1/alerts
```

Do not inject a fresh incident until the old rolling alert window is empty.

### 6. Start a fresh r10 campaign

Use a new empty directory:

```text
/home/veer/praxis-campaign-smoke-gpt54-r10
```

If it already exists, do not overwrite it. Inspect it and choose the next
unused suffix.

Run in a persistent tmux session:

```sh
env PATH=/home/veer/LightProbe/.venv/bin:/usr/local/bin:/usr/bin:/bin \
node /home/veer/LightProbe/evaluation/praxis/src/campaign.mjs \
  --artifact-root=/home/veer/LightProbe/.eval-cache/praxis/438709b4b4b43467ec384de8ee398b2cc75f2e495a57514fd57784021af7814f \
  --source-root=/home/veer/LightProbe/.eval-cache/praxis-sources \
  --results-root=/home/veer/praxis-campaign-smoke-gpt54-r10 \
  --tier=smoke \
  --incidents=401 \
  --seeds=10 \
  --arms=normal_coding_sre,praxis,graph_liveprobe,raw_liveprobe \
  --model=gpt-5.4 \
  --python=/home/veer/LightProbe/.venv/bin/python \
  --namespace=otel-demo \
  --registry=liveprobe-praxis \
  --kind-cluster=kind-cluster \
  --broker-url=http://127.0.0.1:7070 \
  --prometheus-url=http://127.0.0.1:8080 \
  --clickhouse-url=http://127.0.0.1:8080/clickhouse \
  --replay-base-url=http://127.0.0.1:8081 \
  --alert-timeout-ms=600000 \
  --execute \
  --allow-paid-model
```

For incident 401/seed 10, deterministic order should be:

```text
graph_liveprobe
normal_coding_sre
raw_liveprobe
praxis
```

Monitor at least once per arm:

- active processes;
- campaign status and completed-arm list;
- per-arm ledgers;
- broker `/v1/services` and `/v1/probes`;
- Graph+LiveProbe legal-action/probe/replay/evidence sequence;
- weighted usage versus 50k.

Early Graph+LiveProbe success criteria:

- observability `get_trace` or equivalent calls complete and appear in ledger;
- `list_services` completes;
- returned service identity has the expected commit;
- the agent starts an investigation from the concrete criterion;
- deployed probe locations come from legal actions;
- replay identity is correlated;
- evidence collection returns typed values or an honest terminal result.

If the campaign hits another infrastructure defect, stop before spending on
the remaining arms, preserve partial usage, fix the defect, and use a new
campaign directory. Do not silently count a contaminated arm.

### 7. Score, report, and copy artifacts

Allow the campaign to generate/apply the scorer-only oracle only after all
model attempts.

Generate the deterministic report using:

```text
evaluation/praxis/src/report.mjs
```

Pass the real campaign file and the Linux VM's preflight/validation artifacts,
not the laptop's blocked Darwin preflight.

Copy the complete campaign directory to an ignored local result-artifact
directory with `gcloud compute scp --recurse`.

Update:

```text
evaluation/praxis/results/README.md
```

The final README must include:

- four-arm accuracy/scoring rows;
- exact answer status/root/location per arm;
- wall, model, and runtime time;
- all provider token categories;
- rollout-weighted tokens;
- model calls and sample lower bounds;
- observability/LiveProbe tool counts;
- replays, probes, watches, evidence collections, correlated occurrences;
- failures/timeouts;
- model, reasoning effort, incident, seed, budget;
- `n=1` caveat;
- invalid setup attempts and overhead listed above;
- a statement that r7/r8/r9 and diagnostics are excluded from leaderboard
  accuracy.

Do not imply that cached tokens were free. State only that they were reported
separately and did not consume the configured rollout-weighted cap.

### 8. Final verification and shutdown

Run the relevant local and VM tests again. Commit and push the final campaign
artifacts/report without unrelated user files.

Verify:

- no campaign, benchmark, PRAXIS, or Codex process;
- no active LiveProbe probes;
- incident 401 removed;
- recommendation uses the clean image;
- replay endpoint returns 200;
- Prometheus has no firing alerts.

Then stop, but do not delete, the VM:

```sh
gcloud compute instances stop liveprobe-praxis-eval \
  --project liveprobeeval \
  --zone us-east1-b
```

Report the final branch and commit, link the results README, state that the VM
was stopped, and repeat the `n=1` limitation.

## Completion checklist

- [ ] Local MCP approval/readiness fix reviewed and tests pass.
- [ ] Only intended files committed and pushed.
- [ ] VM fast-forwarded to the new commit.
- [ ] One-call observability MCP diagnostic passes.
- [ ] r9 fault removed and rolling alerts clear.
- [ ] Fresh r10 campaign finishes all four arms.
- [ ] No arm is contaminated by unavailable MCPs or broker races.
- [ ] Campaign is scored after attempts using the private oracle.
- [ ] Campaign artifacts copied locally.
- [ ] Results README includes accuracy, time, tokens, operations, caveats, and
      invalid-attempt overhead.
- [ ] Final tests pass.
- [ ] Final changes pushed on `praxis-eval`.
- [ ] Cluster is clean and broker has zero probes.
- [ ] VM stopped, not deleted.
