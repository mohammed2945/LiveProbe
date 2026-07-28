# Adaptive graph+dossier architecture comparison

This is the benchmark for the newest LiveProbe investigation loop. It is
separate from `ride_sharing_tracks.py`, which only asks whether a static
probe-selection policy retained a labeled origin.

The benchmark starts from a wrong quote in the real RideRush gateway. The
mechanism is not present in the initial expanded graph. An adaptive
investigation must:

1. capture matched passing and failing requests in the gateway;
2. choose to follow the pricing response producer without pruning alternatives;
3. deploy a new frontier in pricing and replay;
4. distinguish the earliest divergent producer from downstream arithmetic;
5. reveal its hammock only after that selection;
6. deploy verification probes and complete localization.

The comparison baseline eagerly expands every statically reachable upstream
function before its first capture. Both methods use the same incident, exact
source revision, passing and failing request bodies, ten-probe per-round
budget, correlation mechanism, and verification requirement.

## Authorization boundary

External graph+dossier transmission for this experiment has standing user
authorization. `--decision-mode=codex` therefore runs without a separate
approval flag. The old `--allow-external-dossiers` flag remains a compatible
no-op.

Each policy gets one persistent Codex session per investigation. Its first
turn receives source-free structural graph state and current runtime dossiers.
Later turns receive graph deltas and only that replay's dossiers. Source is
revealed once, in the final bounded mechanism hammock.

## Current production-style result

Both policies localized and verified the real `surge_poison` fault:

```text
services/pricing/app.py:74
surge = 50.0 if is_active("surge_poison") else float(config["surge"])
```

| Metric | New: adaptive lazy graph | Old: eager full graph |
| --- | ---: | ---: |
| Correctly localized and verified | 3/3 | 3/3 |
| Correlated replay rounds | 3 | 2 |
| Total deployed probes | 25 | 20 |
| Functions expanded | 2 | 3 |
| Final graph nodes | 18 | 20 |
| Model calls per run | 2 | 2 |
| Mean decision-packet bytes per run | 44,250 | 43,189 |
| Mean input tokens per run | 67,271 | 66,635 |
| Mean newly processed input tokens per run | 61,297 | 60,662 |
| Mean model time per run | 14,457 ms | 12,350 ms |
| Median end-to-end wall time | 16,748 ms | 14,036 ms |

This small case favors eager expansion. It saves one recurrence, five probe
deployments, and about 2.7 seconds of end-to-end time. Adaptive expansion
avoids the unrelated `_refresh_rate` function, but that saving is too small to
repay an additional runtime round.

That result is important: the newest architecture is not automatically the
default winner. Its intended advantage appears only when the complete
upstream graph has enough branches or functions to exceed the safe probe or
context budget. This one-branch gateway-to-pricing example does not establish
that crossover.

### What happened to the earlier ~81k token concern

The initial persistent-session implementation still spent a model turn
choosing the only legal upstream action. It consumed roughly 15.3k, 39.0k,
and 66.5k input tokens across three turns—about 121k total—even though the
graph packets were smaller.

That call is now deterministically elided when exactly one legal tracing
action exists. The final adaptive run uses two model turns, averages 67.3k
input tokens, and is therefore below the earlier ~81k figure. It is only about
636 raw input tokens above eager despite using an extra replay round.

The remaining cost is still dominated by the Codex agent envelope and
reprocessed persistent conversation: the two adaptive turns are about 21.1k
and 46.2k input tokens, while their product packets are only about 32.6 KB and
11.6 KB. Packet minimization and billed-input minimization remain different
problems. In production, LiveProbe should return this evidence to the existing
AI-SRE session rather than launch a nested Codex agent solely for ranking.

## Side-by-side dry trace

### New adaptive loop

```text
Manifestation
  gateway request_ride returns pricing["quote"] at line 83

Initial deterministic expansion
  expanded functions: gateway.request_ride only
  graph: 7 nodes
  legal upstream action: FOLLOW_PATH → pricing.quote

Replay round 1
  probes: 5 gateway sites
  passing quote: 37.8
  failing quote: 1718.5
  useful divergence: gateway pricing response at line 52

Decision
  FOLLOW_PATH → pricing.quote is the only legal tracing action
  selected deterministically; no model packet or model call
  no other path is deleted

Lazy expansion
  expanded functions: gateway.request_ride, pricing.quote
  graph: 18 nodes
  _refresh_rate remains collapsed

Replay round 2
  probes: 10 gateway/pricing sites
  rate and distance agree
  surge/amount/quote diverge
  first model packet: full 18-node source-free graph + current dossiers
  packet size: about 32,624 bytes

Decision
  INSPECT_MECHANISM → pricing line 74
  line 75 amount is retained as a downstream consequence

Late hammock reveal
  source shows surge_poison selecting 50.0
  mechanism/verification packet: about 11,626 bytes

Replay round 3
  focused verification probes execute on a failing request

Result
  LOCALIZED and verified
```

### Old eager graph+dossier loop

```text
Manifestation
  same gateway line, symptom, revision, and value

Deterministic eager expansion before evidence
  expand pricing.quote
  discover and expand durable writer _refresh_rate
  expanded functions: 3
  graph: 20 nodes

Replay round 1
  probes: 10 across the complete eager frontier
  passing quote: 37.8
  failing quote: 1718.5
  surge/amount divergence is already visible
  source-free graph+dossier packet: about 32,272 bytes

Decision
  INSPECT_MECHANISM → pricing line 74

Late hammock reveal
  mechanism/verification packet: about 10,917 bytes

Replay round 2
  verification probes execute on a failing request

Result
  LOCALIZED and verified
```

## What the earlier methods showed

The older source-only experiment remains useful but is not merged into the
runtime totals above:

| Source-only policy, four cases | Origin retained | Calls | Input tokens | Model time |
| --- | ---: | ---: | ---: | ---: |
| Deterministic static frontier | 4/4 | 0 | 0 | 0 |
| LLM per MAY hammock | 4/4 | 7 | 87,608 | 28.84 s |
| One LLM frontier-ranking call | 4/4 | 4 | 57,325 | 31.73 s |
| Controlled PRAXIS-like traversal | 2/4 | 7 | 91,874 | 31.03 s |

Those numbers reject source-only LLM pruning, but they do not answer whether
the newest adaptive runtime loop beats eager graph+dossier investigation. The
new benchmark is designed to answer that narrower question.

## Gaps the dry run exposed

- Passing and failing executions need different correlation IDs but the same
  business trace value. The first harness version changed both and falsely
  marked `trace_id` suspicious. The benchmark now separates them.
- Resending all earlier dossiers made the adaptive second packet larger than
  necessary. The persistent session now receives only the current failing
  occurrence and remembers prior decisions itself.
- The first three-run model benchmark scored only 2/3 for each method because
  the dossier exposed agent-local hit sequences without their clock domain.
  The model compared gateway sequence 4 with pricing sequence 14 as if they
  were global. Dossiers now retain `sequence_scope` internally but omit
  incomparable counters from the model packet; cross-service order comes from
  causal edges.
- A divergent return at a resolved boundary is not yet a root-cause location.
  The deterministic action generator now withholds mechanism adjudication at
  that call site while an upstream producer path remains available.
- Waiting until a trace appeared anywhere allowed the gateway batch to race
  ahead of pricing. The harness now requires both correlation IDs in every
  represented service and three stable polling intervals before judging.
- Two probe sites can map to the same displayed gateway source location, so
  dossiers still contain a duplicate location. This is correct but noisy and
  should be coalesced for model presentation.
- The current case has only one meaningful cross-service choice. It cannot
  establish the graph-size crossover where lazy expansion should win.
- Three repetitions are enough to expose obvious protocol bugs, not enough to
  establish production accuracy confidence intervals.
- The benchmark covers one semantic-value fault. Durable-history, alias-heavy,
  concurrent, contract, and absence incidents need separate cases.
- The PRAXIS row above is a controlled source-hierarchy baseline, not a full
  reproduction of PRAXIS and not an actual-runtime comparison.

## Running it

Local harness validation, with no external model call:

```sh
make ride-adaptive-comparison
```

Run three real model repetitions. This makes up to fifteen external model
turns: three adaptive decisions and two eager decisions per repetition.

```sh
node demo/ride-analysis/adaptive-comparison.mjs \
  --decision-mode=codex \
  --repetitions=3
```

The JSON artifact is written to the ignored
`demo/ride-analysis/results/latest-adaptive-comparison.json`.
