# RideRush data-flow evaluation

This directory validates the new deterministic analysis workflow separately
from the older investor demo's manually chosen manifestation probe.

## Unknown-first investigation run

`e2e-investigation.mjs` exercises the active MCP workflow against real
RideRush gateway and pricing processes:

1. start from the gateway's inflated quote manifestation;
2. capture only correlated failing executions;
3. close the unique gateway-to-pricing dependency path statically;
4. probe one bounded value-focused graph cut without requiring a hypothesis;
5. inspect the localized surge-selection statements;
6. submit a `surge_poison` candidate with concrete predicted observations;
7. confirm it on one later failing replay and complete `LOCALIZED`.

The run performs no passing execution and does not mutate the application.

```sh
make ride-investigation-e2e
```

The result is written to
`demo/ride-analysis/results/latest-investigation-e2e.json`.

## Four-method model benchmark

[`FOUR_METHOD_BENCHMARK.md`](./FOUR_METHOD_BENCHMARK.md) documents the
controlled comparison of:

1. normal Codex over logs/traces and the repository;
2. PRAXIS-style source hierarchy traversal;
3. a raw ReAct + LiveProbe loop without a graph;
4. the unknown-first graph + LiveProbe architecture.

The benchmark uses exact-line localization, failing-only replays, rotated
method order, token accounting, per-turn timeouts, and a shared RideRush
commit. Run the no-model oracle validation with:

```sh
make ride-four-method-benchmark
```

Run three real model repetitions with:

```sh
make ride-four-method-benchmark-codex
```

The corrected trace audit, implemented graph improvements, measured gates,
and residual work are in
[`GRAPH_LIVEPROBE_IMPROVEMENTS.md`](./GRAPH_LIVEPROBE_IMPROVEMENTS.md).

## Historical adaptive architecture comparison

The real multi-round lazy graph+dossier comparison against eager full-graph
investigation is documented in
[`ADAPTIVE_ARCHITECTURE_COMPARISON.md`](./ADAPTIVE_ARCHITECTURE_COMPARISON.md).
It uses the authorized persistent-session graph-delta protocol and records
the full side-by-side trace and real model costs.

The detailed pre-improvement RideRush execution, model payload, and
payload-bloat audit are documented separately in
[`CURRENT_ARCHITECTURE_PACKET_TRACE.md`](./CURRENT_ARCHITECTURE_PACKET_TRACE.md).
That document also explains why the existing V1/PRAXIS numbers are not a
valid same-bed comparison.

## Failure-class matrix

| Class | Current scenario | Success criterion |
| --- | --- | --- |
| 1 — type/shape | Real RideRush payments request | Mechanical violation and durable-boundary handoff in one round |
| 2 — domain/range | Generated negative-inventory analyzer test | Numeric minimum violation is mechanical |
| 3 — contract | Generated rejected-status analyzer test | Evidence remains `UNKNOWN` and validated exploration frontiers remain available |
| 4 — semantic value | Real gateway → pricing failing-only replay | Adaptive expansion plus candidate confirmation localizes the surge line |
| 5 — absence/control | Generated missing-email analyzer test | Honest `INSUFFICIENT`; no value probes are deployed |

The active RideRush runtime harness exercises class 4. Classes 1–3 and 5 have
deterministic analyzer coverage; absence remains explicitly unsupported.

## Legacy local probe/refinement run

`e2e.mjs` starts the real LiveProbe broker and current Python SDK, imports the
sibling RideRush `services/payments/app.py`, and supplies deterministic local
responses for its database reads. It then exercises the same product handlers
used by MCP:

1. index the exact RideRush commit;
2. slice backward from `payments/app.py:65`;
3. deploy the generated frontier as real snapshot probes;
4. send one explicitly correlated failing request;
5. classify captured values with the numeric fare contract;
6. refine and repeat;
7. remove every probe and terminate both local processes.

The application source is not copied or rewritten. The deterministic data
source supplies `tax_multiplier="US-CA:1.0825"` so the test does not require
Supabase or cloud credentials.

Build the TypeScript packages first, then run:

```sh
npm --prefix packages/mcp-server run build
npm --prefix packages/broker run build
node demo/ride-analysis/e2e.mjs
```

The result is written to the ignored
`demo/ride-analysis/results/latest-e2e.json`.

## Four policy tracks

`ride_sharing_tracks.py` compares identical analyzer plans under:

1. `deterministic`: deploy the bounded deterministic frontier;
2. `llm_per_may_hammock`: preserve every MUST candidate and ask the model once
   for each MAY hammock;
3. `llm_single_frontier`: ask the model once to choose from the complete
   deterministic frontier;
4. `praxis_hammock_traversal`: controlled hierarchical hammock-only traversal
   without runtime values. This is a methodology baseline, not a reproduction
   of PRAXIS's complete system.

The LLM never invents locations or modifies the slice. Each response is
schema-constrained to candidate IDs supplied by the analyzer.

Validate the dataset without external model calls:

```sh
PYTHONPATH=python/analyzer/src python3.12 \
  python/analyzer/experiments/ride_sharing_tracks.py \
  --repository ../ride_sharing_probe_demo \
  --deterministic-only
```

Run all tracks:

```sh
PYTHONPATH=python/analyzer/src python3.12 \
  python/analyzer/experiments/ride_sharing_tracks.py \
  --repository ../ride_sharing_probe_demo
```

The full run invokes the locally authenticated Codex CLI. It sends the incident
text and bounded hammock source shown in the generated prompt to the configured
model service. Tools, MCP servers, web search, repository writes, and agent
delegation are disabled for those calls. Pass `--model` to pin a model instead
of using the Codex default. The result is written to the ignored
`demo/ride-analysis/results/latest-tracks.json` unless `--output` is supplied.

## Historical schema-14 external-model experiment

The following driver is retained to reproduce the earlier matched-value,
hammock-reveal experiment:

```sh
PYTHONPATH=python/analyzer/src python3.12 \
  python/analyzer/experiments/runtime_guided_model.py \
  --repository ../ride_sharing_probe_demo
```

It uses the pre-v15 decision schema and deterministic matched value fixtures;
it is not a supported entry point for the current analyzer. The supported
runtime path is `make ride-investigation-e2e`, which exercises the unknown-first
MCP workflow with failing executions only.

In the July 2026 compact-packet run, the model selected the exact surge
definition, described the 50× mechanism, and advanced to `VERIFYING`. The
19.0KB ranking packet plus 9.8KB mechanism continuation used two calls and
33,002 input tokens. The earlier uncompressed continuation used 44,672, so
factoring the follow-up reduced input by 26%. These totals include the roughly
12k-token standalone Codex session prefix on each ephemeral experiment call;
that prefix is owned by the external AI-SRE environment, not emitted by
LiveProbe.

The July 2026 controlled run preserved the expected origin in 4/4 cases for
the deterministic and both frontier policies. The PRAXIS-like local traversal
preserved it in 2/4. It used seven model calls and about 91.9k input tokens,
while the deterministic policy used no model calls. These four static-policy
tracks are separate from the new runtime-guided investigation E2E above.
