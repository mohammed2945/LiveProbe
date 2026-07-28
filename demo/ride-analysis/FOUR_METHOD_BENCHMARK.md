# Four-method SRE investigation benchmark

This benchmark compares four ways of localizing the same real RideRush fault.
It is an end-to-end comparison of the unknown-first graph architecture, not
yet a broad production-accuracy study.

The implementation is
[`four-method-benchmark.mjs`](./four-method-benchmark.mjs). The latest external
model artifact is written to the ignored
`results/latest-four-method-benchmark.json`; oracle harness validation uses
`results/latest-four-method-oracle.json`.

## Incident and exact success criterion

Every method receives the same failing incident:

```text
POST /request_ride
coordinates: (16,16) -> (22,24)
status: 200
observed quote: 1718.5

trace:
  gateway -> pricing GET /quote       200
  gateway -> matching POST /assign    200
  gateway -> trips POST /trips        200
```

There is no exception, matched passing execution, mutation control, or
good/bad value label. The hidden ground truth is:

```text
services/pricing/app.py:74
surge = 50.0 if is_active("surge_poison") else float(config["surge"])
```

A result succeeds only if it identifies line 74. Reporting line 75, where the
already-wrong surge is multiplied into the amount, is rejected as downstream
symptom localization.

## Methods

### Normal Codex SRE

The model receives the logs/traces and ordinary read-only coding-agent access
to the RideRush checkout. It receives no LiveProbe evidence, dependency graph,
or preselected source hierarchy.

### Controlled PRAXIS-style traversal

This is a methodology baseline, not a reproduction of the complete PRAXIS
system. The harness generates a source hierarchy:

```text
repository community/service
  -> function
    -> numbered function source
```

The model selects a community, then a function, and diagnoses from that leaf
source block. It receives no runtime probes or dependency graph.

### ReAct agent with raw LiveProbe

The model has ordinary read-only repository tools plus a raw iterative
LiveProbe loop:

```text
choose file/line/watch paths
  -> deploy probes
  -> replay the failing request
  -> receive raw captured values
  -> probe again or diagnose
```

It receives no analyzer, slice, graph, candidate regions, or validated
dependency actions.

### Unknown-first graph + LiveProbe

The graph method receives:

- a bounded, source-free decision brief;
- static regions and service-specific runtime traversals;
- only the small active validated frontier;
- failing-only LiveProbe evidence;
- a bounded source reveal during mechanism inspection;
- validated scalar prediction options;
- one fresh confirmation replay before completion.

Static source expansion is deterministic and does not force a replay. The
typical value-fault path uses one exploration occurrence, one mechanism model
call, and one confirmation occurrence.

## Accounting

The harness distinguishes:

- outer `codex exec` turns;
- actual model samples within those turns;
- repository/tool calls;
- raw input, cached input, and newly processed input;
- localization time and post-candidate verification time;
- runtime replay time;
- prompt text and output-schema bytes.

Resumed Codex usage is cumulative. The harness now converts cumulative totals
to per-turn deltas before summing them and retains partial output and usage on
timeouts. The earlier benchmark incorrectly summed cumulative totals and
counted outer turns as model calls.

All methods use the same RideRush commit, configured model, incident, exact
line criterion, and 120-second turn timeout. Shared service startup, incident
acquisition, source-hierarchy preparation, and warm graph indexing are
excluded from method wall time.

## Post-improvement controlled run

The July 27, 2026 external-model smoke run used one repetition:

```text
RideRush commit: c67ee35026aa12fe8a0335761c606355a695554c
Codex CLI:       0.145.0
model:           configured Codex default
```

All four methods localized the exact line:

| Method | Exact | Wall | Raw input | New input | Samples | Tool calls | Replays | Probes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Normal Codex | 1/1 | 17.96 s | 47,225 | 12,153 | 3 | 2 | 0 | 0 |
| PRAXIS-style | 1/1 | 23.15 s | 36,441 | 27,481 | 3 | 0 | 0 | 0 |
| ReAct + LiveProbe | 1/1 | 45.25 s | 90,873 | 44,537 | 5 | 2 | 2 | 2 |
| Graph + LiveProbe | 1/1 | 8.94 s | 12,763 | 12,763 | 1 | 0 | 2 | 5 |

For this run, graph + LiveProbe used:

- 3.70x fewer raw input tokens and 2.01x less wall time than normal Codex;
- 2.86x fewer raw input tokens and 2.59x less wall time than PRAXIS-style;
- 7.12x fewer raw input tokens and 5.06x less wall time than raw ReAct;
- one model sample rather than three to five;
- 6,124 bytes of explicit prompt plus schema;
- 89 ms in the two failing request replays;
- 8.27 seconds to propose the mechanism and 8.94 seconds to finish fresh
  runtime confirmation.

Normal Codex reported 35,072 cached input tokens, so its newly processed input
was slightly lower than the graph arm's fresh 12,763-token call. Raw input is
still the direct measure of total model context processed, while the separate
new-input column makes cache effects explicit.

This is a smoke comparison, not a statistically stable median. Run the
configured three repetitions before making broad performance claims.

The graph arm was also run alone for three repetitions to verify its new
execution shape without spending more calls on unchanged baselines:

| Exact | Median wall | Mean raw input | Samples/run | Replays/run | Probes/run |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 3/3 | 8.38 s | 12,764 | 1 | 2 | 5 |

All three runs used the same 6,124-byte explicit request and localized the
exact statement. Their wall times were 7.94, 10.35, and 8.38 seconds.

## Structural result

Before these improvements, the graph arm typically used six model samples,
six replays, about 26 probes, roughly 162k true input tokens, and 54.6 seconds.
The same path now uses:

```text
deterministic gateway -> pricing static closure
  -> three-site value-focused exploration cut
  -> one bounded mechanism reveal and model call
  -> two-site confirmation cut
  -> deterministic completion
```

The measured graph run used one sample, two replays, five probes, 12,763 input
tokens, and 8.94 seconds. The gains come from architectural dominance and
provenance rules, not incident-specific arithmetic or fault-name matching:

- static expansion is separated from observation;
- all branches remain in product state while only the active non-dominated
  frontier is serialized;
- focus follows current evidence and runtime traversals;
- control guards do not block value-mechanism inspection;
- probe sites use tracked value ports and minimal dot-path antichains;
- covered exploration paths are not redeployed;
- dossiers and causal paths update incrementally;
- graph decisions use compact self-contained briefs and short aliases rather
  than resumed coding-agent history.

The real failing-only E2E separately passed with two rounds, two failing
executions, no passing execution, no mutation, and six deployed probes. The
benchmark reports five because its confirmation wait and cleanup path counts
the deployed bundle slightly differently.

## What this result does not establish

One source-obvious semantic fault cannot establish production accuracy or
speed. The next suite must include:

- renamed or misleading identifiers;
- traces pointing toward the wrong service;
- multiple plausible upstream services and functions;
- durable state and aliases;
- concurrency or stale-state faults;
- absence and control-flow faults;
- cases where source inspection yields a plausible false explanation.

The suite-level gate remains at least 2x lower median raw input and wall time
than normal Codex while matching or exceeding exact verified localization.

## Running the benchmark

Validate the harness without external model calls:

```sh
make ride-four-method-benchmark
```

Run the configured three-repetition external comparison:

```sh
make ride-four-method-benchmark-codex
```

Or select methods and repetitions:

```sh
node demo/ride-analysis/four-method-benchmark.mjs \
  --decision-mode=codex \
  --repetitions=3 \
  --methods=normal_codex,praxis_style,react_liveprobe,graph_liveprobe
```

Use `--model=<model>` or `LIVEPROBE_BENCHMARK_MODEL` to pin a model.
