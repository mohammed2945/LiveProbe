# Graph + LiveProbe performance improvement record

This document is the implementation handoff for making the unknown-first
graph + LiveProbe architecture materially faster and smaller without
special-casing the RideRush `surge_poison` incident.

It records:

- the corrected four-method measurements;
- the exact model, repository, graph, probe, and replay traces;
- the general implementation defects those traces exposed;
- the target architecture and correctness invariants;
- the implementation order and performance gates.

The PRAXIS + LiveProbe hybrid is deliberately not being added. The objective
is one clean, efficient graph + LiveProbe implementation.

## Implementation outcome

The `improvements` branch now implements the trace-backed changes in this
record. The common failing-only value-fault path is:

```text
deterministic static closure
  -> one value-focused exploration replay
  -> one bounded mechanism/candidate model call
  -> one narrow confirmation replay
  -> deterministic completion
```

The real RideRush E2E localizes the exact pricing statement with no passing
execution and no mutation:

| Metric | Result |
| --- | ---: |
| Investigation rounds | 2 |
| Failing executions | 2 |
| Total probes in E2E | 6 |
| Investigation elapsed | 2.75 s |
| Status | `LOCALIZED` |

The external-model four-arm smoke run produced:

| Method | Wall | Raw input | Samples |
| --- | ---: | ---: | ---: |
| Normal Codex | 17.96 s | 47,225 | 3 |
| PRAXIS-style | 23.15 s | 36,441 | 3 |
| ReAct + LiveProbe | 45.25 s | 90,873 | 5 |
| Graph + LiveProbe | 8.94 s | 12,763 | 1 |

The graph arm used two replays, five benchmark-counted probes, zero tool
calls, and a 6,124-byte explicit prompt plus output schema. Relative to the
documented pre-improvement graph median, that is approximately 12.7x fewer
input tokens and 6.1x less wall time.

The four-arm comparison has one controlled repetition. A separate graph-only
three-repetition validation localized 3/3 with one sample, two replays, and
five probes every time; it measured 12,764 mean input tokens and 8.38 seconds
median wall time. This validates the graph path's execution shape, but the
full multi-method comparison still needs repeated and adversarial cases. The
exact current comparison and accounting caveats are in
`FOUR_METHOD_BENCHMARK.md`.

### Changes now in the implementation

- Static source expansion no longer increments the runtime round or requests
  a replay.
- Unique value-producing chains, including cross-service HTTP producers,
  close deterministically before the first probe batch.
- Full branch state remains recoverable, while only at most six active
  non-dominated actions are exposed.
- Decision focus is rebuilt around the current evidence-bearing nodes and
  runtime traversals instead of the original downstream manifestation.
- Calls carry `VALUE_PRODUCER`, `CONTROL_GUARD`, `ACTIVATION_SOURCE`, or
  `HISTORICAL_STATE_PRODUCER` contribution roles.
- Control guards remain available for later adjudication but do not force
  value traversal before mechanism inspection.
- Probe cuts use tracked paths, minimal dot-path antichains, capture-capable
  locals, same-location watch merging, and incremental coverage.
- Evidence dossiers, coverage, and causal-path state update incrementally.
- Exploration and mechanism briefs use short aliases, bounded evidence, and
  phase-specific schemas.
- Graph model decisions use fresh self-contained calls rather than resumed
  coding-agent history.
- Benchmark accounting measures actual model samples and token deltas and
  retains partial timeout usage.
- Fixed probe-cleanup delay was removed; broker probe creation and reads are
  already issued concurrently.
- Bounded mechanism cuts reserve space for directly witnessed producers
  before neighboring provenance, preventing source limits from hiding the
  exact statements that generated captured values.

### Residual work

A persistent warmed analyzer worker and event-streamed occurrence completion
remain possible infrastructure optimizations. They are not on the current
critical path: in the measured graph run, model time was 7.45 of 8.94 seconds
and the two request replays took 89 ms. Adding a new worker lifecycle now
would increase operational complexity while leaving the dominant cost
unchanged. Revisit it after the multi-case suite profiles sustained concurrent
investigations.

## The original token comparison was invalid

Codex reports cumulative thread usage after each resumed turn. The benchmark
treated each cumulative total as an incremental total and added them.

For example, one graph run was reported as:

```text
14,932 + 35,401 + 60,896 + 91,531 = 202,760 input tokens
```

The first three values were already included in `91,531`; the true session
total was 91,531.

The benchmark's call count also measured outer `codex exec` invocations, not
actual model samples. A normal Codex run labeled as one call actually sampled
three times around two repository tool calls.

The corrected trace-level measurements are:

| Method | Actual model samples | Repository calls | Mean true input tokens | Median wall |
| --- | ---: | ---: | ---: | ---: |
| Normal Codex | 3 | 2 | 45,828 | 18.3 s |
| PRAXIS-style | 3 | 0 | 36,528 | 16.7 s |
| ReAct + LiveProbe | 4–5 | 2 | 74,516* | 40.9 s* |
| Graph + LiveProbe | 4–7 | 0 | 153,932 | 54.6 s |

`*` ReAct values include only its two completed runs. The timed-out run had
already consumed 27,265 input tokens and made two repository calls, but the
harness discarded that partial usage.

The graph arm remains inefficient after correcting the accounting, but its
mean was about 154k rather than the previously reported 464k.

## What each method actually did

Normal Codex:

```text
model
  -> read CONTRACT + search quote/surge code
model
  -> read pricing/gateway/fault implementation
model
  -> diagnose line 74
```

PRAXIS-style:

```text
select pricing
  -> select quote()
  -> inspect selected function and diagnose
```

Raw ReAct + LiveProbe:

```text
read repository using two shell calls
  -> plan probes
  -> one or two failing replays
  -> diagnose
```

The graph arm varied between:

```text
shortest:
  follow HTTP producer
  -> probe amount
  -> inspect amount mechanism
  -> submit candidate
  -> confirmation

longest:
  follow HTTP producer
  -> probe amount
  -> probe surge
  -> follow is_active
  -> probe is_active
  -> inspect is_active
  -> submit candidate
  -> confirmation
```

## General implementation defects

### 1. Static expansion incorrectly requires a replay

`FOLLOW_PATH` expands already-indexed source structure, but the investigation
engine marks it as requiring runtime evidence. Every function or service
expansion therefore becomes:

```text
LLM decision -> graph expansion -> deploy probes -> replay -> LLM decision
```

Static expansion and runtime observation must be separate transitions.

### 2. Preserving branches became retransmitting branches

After the pricing hop, the model received 28 actions. After expanding
`is_active`, it received 37.

The final mechanism packet still contained 36 actions even though only
`CONFIRM_CANDIDATE` mattered:

```text
total mechanism context: 12.8 KB
irrelevant action list:    7.5 KB
actual mechanism context:  1.9 KB
```

Alternatives should remain recoverable in internal state. They should not all
remain on the active model frontier.

### 3. The model sees stale downstream focus

After probing pricing, packet truncation still prioritized gateway regions
nearest the original manifestation. The current pricing assignment could be
absent from the retained region projection.

Model focus must center on:

```text
current runtime traversal
current evidence-bearing frontier
immediate producers and consumers
```

Deferred alternatives need only a count and compact reason until reactivated.

### 4. Control inputs are mistaken for value producers

The engine withholds mechanism inspection whenever any `FOLLOW_PATH` leaves a
node. At pricing line 74, `is_active()` produces a boolean guard. It does not
produce the value 50; the conditional assignment creates that value.

The broad producer rule therefore forces unnecessary traversal through
feature flags, fallbacks, validators, permission checks, and circuit breakers.

The graph must distinguish:

```text
VALUE_PRODUCER
CONTROL_GUARD
ACTIVATION_SOURCE
HISTORICAL_STATE_PRODUCER
```

An unresolved value producer may block localization. A control contributor
must not.

### 5. Probe bundles ignore tracked value ports

The initial graph replay captured:

```text
client
client.get
headers
ride
pricing_response
pricing_response.json
pricing
pricing.quote
```

Only the quote and its boundary provenance mattered. Later bundles captured
both `config` and `config.surge`, repeatedly redeployed manifestation sites,
and probed `is_active` without being able to capture its return value.

Probe planning must use tracked region inputs and outputs, capture the minimal
dot-path antichain, validate runtime capture capability, and avoid previously
covered exploration paths.

### 6. Evidence processing is cumulative and repetitive

Every evidence update rebuilds all dossiers and causal paths from all prior
observations. Packets repeat IDs, occurrences, causal paths, and old values.
This will become quadratic as an investigation grows.

Evidence must be appended and indexed incrementally, grouped by site, and
deduplicated by traversal, node, path, occurrence, and hit.

### 7. No-tool decisions use a complete coding-agent session

The graph arm disables tools but still receives coding-agent instructions,
skills and plugin material, tool schemas, changing output schemas, and the
complete resumed conversation.

The graph's per-turn input growth was approximately:

```text
15k -> 20k -> 25k -> 30k -> 35k -> 39k -> 43k
```

Investigation memory belongs in the product's structured state. Model calls
should receive one compact, self-contained decision brief instead of resumed
chat history.

### 8. Analyzer and broker orchestration repeat process and data work

Every analyzer operation starts a new Python process, reloads summaries,
loads and rewrites a growing investigation JSON document, and rebuilds public
views. Probe readiness and data are polled repeatedly, and cleanup includes a
fixed wait.

A persistent warmed analyzer worker, revision-cached projections, incremental
state, bulk broker operations, and event-driven occurrence completion should
replace this loop.

## Target architecture

```text
failure occurrence
    |
    v
deterministic static closure
(no model, no replay)
    |
    v
small active causal cut
    |
    v
one cost-bounded probe batch
    |
    v
compact witnessed value spine
    |
    +-- one unique mechanism --> bounded source reveal
    |
    +-- genuine ambiguity ----> one structured LLM choice
    |
    v
one mechanism/candidate call
    |
    v
one narrow confirmation replay
    |
    v
verified localization
```

The normal value-fault path should use one exploration occurrence, one model
call, and one confirmation occurrence. Genuine ambiguity may require a second
model call.

## Correctness invariants

Performance changes must not:

- use fault names, constants, multiplication, or incident-specific source
  rules;
- infer whether an unknown value is semantically good or bad;
- let the model invent source, probe, traversal, or prediction IDs;
- delete unchosen branches;
- treat a MAY edge as witnessed execution;
- compare process-local sequence numbers across services;
- complete without the mechanism predictions and manifestation appearing in
  one later explicitly correlated occurrence;
- hide incomplete capture or graph coverage.

All deterministic elision must be justified by topology, provenance role,
runtime coverage, capture capability, or strict action dominance.

## Implementation order

1. Repair benchmark token/sample accounting and retain partial timeout usage.
2. Split graph transitions into static expansion, observation, mechanism
   reveal, and confirmation.
3. Compute deterministic static closure before the first probe deployment.
4. Add active/deferred/dominated/observed action lifecycle and serialize only
   the small non-dominated frontier.
5. Center decision projections on the current runtime traversal and
   evidence-bearing nodes.
6. Build minimal tracked-path probe cuts and incremental evidence coverage.
7. Distinguish value production from control and activation provenance.
8. Emit phase-specific exploration and mechanism briefs with short aliases.
9. Replace resumed coding-agent context with compact product-owned model
   context where the configured model transport supports it.
10. Warm and persist analyzer state, then batch and stream broker operations.
11. Re-run the four-method benchmark and a multi-case adversarial suite.

## Required performance gates

Against the corrected current graph median:

| Metric | Pre-improvement | Required target | Smoke result |
| --- | ---: | ---: | ---: |
| Input tokens | 161,997 | <= 15–20k | 12,764 |
| Model samples | 6 | 1 typical, <= 2 p95 | 1 |
| Replays | 6 | 2 typical, including confirmation | 2 |
| Exploration decision brief | 11–15 KB | <= 3 KB | 2.94 KB |
| Mechanism decision brief | 12.8 KB | <= 5 KB | 4.51 KB |
| Wall time | 54.6 s | <= 10–12 s | 8.38 s median |
| Exact verified localization | 3/3 | no regression | 3/3 |

The eventual suite gate is at least 2x lower median tokens and wall time than
normal Codex while matching or exceeding exact-localization accuracy.

The suite must include renamed identifiers, misleading traces, multiple
plausible services, control guards, durable state, aliases, concurrency, and
absence/control-flow cases so that the implementation cannot succeed through
RideRush-specific optimization.
