# PRAXIS × LiveProbe evaluation

This evaluation compares four AI-SRE capability profiles on the source-available
PRAXIS Astronomy Shop incidents 401–416:

| Arm | Repository | Metrics/logs/traces | Replay | Raw LiveProbe | LiveProbe graph | PRAXIS graph |
| --- | --- | --- | --- | --- | --- | --- |
| Normal coding SRE | Yes | Yes | Yes | No | No | No |
| PRAXIS fair adapter | No | Same snapshot | No | No | No | Yes |
| Graph + LiveProbe | Yes | Yes | Yes | Yes | Yes | No |
| Raw LiveProbe | Yes | Yes | Yes | Yes | No | No |

The cost-controlled decision model defaults to `gpt-5.4-mini` with low
reasoning. Paid execution always requires an explicit second opt-in.

## Evidence delivery

Each controlled run uses one immutable incident snapshot captured after the
fault raises a new alert. The coding arms receive a small bootstrap envelope,
then query logs, traces, metrics, Kubernetes state/events, deployment history,
topology, and a pre-registered replay through a read-only MCP server. This
matches a real incident better than putting the entire telemetry corpus in the
initial prompt, while ensuring every arm sees the same fixed evidence revision.

The fair PRAXIS adapter preserves PRAXIS's prompts, exploration graph, and
traversal loop but backs its collectors with the same snapshot. This is the
controlled leaderboard arm. The released native PRAXIS launcher remains
available as a separate reproduction track; it is not mixed into cost claims
because its own live collectors, graph context, and model accounting are not
identical to the controlled coding-agent arms.

No agent can read benchmark ground truth. The official oracle is generated
from the locked released artifact only after every selected model attempt has
finished, then used by the scorer.

## Campaign lifecycle

For each incident the campaign:

1. requires a hash-verified PRAXIS artifact and an empty results directory;
2. verifies the released PRAXIS adapter interface, dependency/import contract,
   and every selected incident-specific program graph and anchor;
3. passes the static 16-variant LiveProbe compatibility gate;
4. builds instrumented images carrying the exact extracted Git commit and
   verifies the deployed source SHA-256;
5. injects the official fault and waits for a newly firing alert;
6. captures one real immutable evidence snapshot;
7. requires incident 401 to pass both the runtime LiveProbe tripwire and a
   deterministic run through the released PRAXIS loop before any paid call;
8. runs the selected arms in deterministic randomized order;
9. gives each coding arm a clean tracked-only clone, with no source metadata or
   fault label;
10. resets the broker before and after every LiveProbe arm;
11. removes the fault and waits for its alerts to clear before the next
    incident;
12. preserves every failed setup/arm attempt in the denominator; and
13. builds the scorer-only oracle and scores after all model attempts.

The LiveProbe tripwire checks the full path: exact runtime source heartbeat,
criterion-to-graph construction, canonical legal frontier, probe deployment,
W3C trace-correlated replay, typed captured values, mechanical/`UNKNOWN`
judgments, active legal actions, and preserved deferred alternatives. The
zero-model PRAXIS tripwire verifies snapshot-backed collectors, exploration
graph traversal, and incident-specific code context through its released
reasoning loop.

## Local zero-token validation

Import an already downloaded artifact through the lock verifier, then extract
the 16 exact source variants:

```sh
node evaluation/praxis/scripts/fetch-artifact.mjs \
  --offline-archive /path/to/dsn26-praxis-ae.zip

make praxis-eval-extract \
  PRAXIS_ARTIFACT_ROOT=/path/from/fetch-artifact
```

Run every local gate and regenerate the report:

```sh
make praxis-eval-gates \
  PRAXIS_ARTIFACT_ROOT=/path/from/fetch-artifact \
  PRAXIS_ARTIFACT_ARCHIVE=/path/to/dsn26-praxis-ae.zip

make praxis-eval-report
```

The current measured local result is in
[`results/README.md`](results/README.md). At the latest run:

- 31/31 required zero-token gates passed;
- 41 analyzer tests passed;
- 22 MCP server tests passed;
- 20/20 evaluation contract tests passed;
- 36/36 released-PRAXIS compatibility checks passed, including all 16
  incident-specific program graphs and anchors;
- all 16 source variants passed static graph/boundary/probe compatibility;
- the deterministic fixture tripwire passed 12/12 cases with zero model calls;
- the static panel produced 19–23 graph nodes per criterion and 30 canonical
  initial probe sites in 2.36 seconds.

These are pipeline checks, not model benchmark results.

## Remote smoke campaign

The released artifact requires Linux, at least 16 CPU cores, at least 32 GiB
RAM, Docker, Kind, kubectl, Python 3.12 with the released dependency set, Go,
and exactly Helm 3.18.4.

Check the host and inspect the no-mutation plan:

```sh
make praxis-eval-preflight

make praxis-eval-plan \
  PRAXIS_ARTIFACT_ROOT=/path/from/fetch-artifact
```

Use a fresh, empty results directory for the paid smoke:

```sh
make praxis-eval-smoke \
  PRAXIS_ARTIFACT_ROOT=/path/from/fetch-artifact \
  PRAXIS_CAMPAIGN_ROOT=/path/to/empty/campaign-smoke \
  PRAXIS_MODEL=gpt-5.4-mini \
  PRAXIS_ALLOW_PAID_MODEL=1
```

The smoke tier is incident 401, seed 10, all four arms, a 30,000-token
per-arm ceiling, and a three-minute per-arm wall limit. Pilot and claim tiers
are available directly through `src/campaign.mjs`; do not start them until the
smoke produces a complete scored artifact.

After a campaign, point the deterministic report at its result:

```sh
node evaluation/praxis/src/report.mjs \
  --campaign=/path/to/campaign-smoke/campaign.json
```

The report includes RCI/RCL/RCR/combined accuracy, median wall/model/runtime
time, exact provider-reported input/cached/new/output/reasoning tokens, agent
turns, model-sample counts or documented lower bounds, tool calls by server,
replays, deployed probes/watches, correlated evidence collections, failures,
and timeouts.

## Important interpretation constraints

- Synthetic fixtures never enter leaderboard accuracy.
- Static compatibility does not claim runtime support for every possible
  third-party client; unknown clients are surfaced conservatively.
- Probe evidence is hard only for its correlated occurrence. A matching-trace
  log is near-hard; uncorrelated telemetry and deploy history are soft priors.
- Raw LiveProbe locations are agent-selected. Graph + LiveProbe locations are
  canonical analyzer actions.
- Direct-code incidents require `LOCALIZED`. External-boundary incidents accept
  an evidence-backed `HANDOFF` or `LOCALIZED`, but both still require the
  official root identity, location, propagation path, and evidence IDs.
- A completed internal leaderboard using a model alias is not a public,
  reproducible claim until the model snapshot is pinned.
