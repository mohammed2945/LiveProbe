# LiveProbe session handoff

Read this file before changing or benchmarking the current investigation
architecture.

## Current state

LiveProbe now implements a failing-only, unknown-first localization loop over
a canonical source dependence graph plus service-specific runtime traversals.
Static dependency expansion happens without replay or model calls. Runtime
probes observe a small value-focused causal cut. A bounded source reveal is
made only when the witnessed cut is ready for mechanism adjudication, and
completion requires the candidate's predicted values plus the manifestation
in one later explicitly correlated failing occurrence.

On the real RideRush gateway/pricing incident, the current path is:

```text
deterministic gateway -> pricing static closure
  -> one three-site exploration batch
  -> one bounded mechanism/candidate model call
  -> one two-site confirmation batch
  -> deterministic completion
```

The PRAXIS + LiveProbe hybrid is deliberately not implemented. The product
focus is one clean graph + LiveProbe architecture.

## Repository and worktree

```text
repository:
  /Users/veer/Documents/StartUp/hackathon_stanford/LightProbe

current branch:
  improvements

RideRush test repository:
  /Users/veer/Documents/StartUp/hackathon_stanford/ride_sharing_probe_demo

RideRush commit:
  c67ee35026aa12fe8a0335761c606355a695554c
```

The worktree is intentionally dirty and includes extensive user and current
agent changes plus unrelated files such as `.cursor/`, `.vscode/`, and
`demo/investor/`. Do not reset, discard, or overwrite unrelated changes.

## Important graph separation

`code-review-graph` is a repository-understanding MCP used by Codex to reason
about this codebase. It is not LiveProbe's customer-code graph.

```text
code-review-graph MCP
  helps Codex inspect this repository

LiveProbe analysis graph
  analyzes a customer's Python program and chooses runtime probes
```

Do not model the product graph after `.code-review-graph`.

## Product architecture

```text
failure manifestation
    |
    v
deterministic conservative static closure
    |
    v
small active causal cut
    |
    v
one cost-bounded probe batch and failing replay
    |
    v
compact witnessed value spine
    |
    +-- unique next transition --> deterministic action
    |
    +-- genuine ambiguity ------> structured model choice
    |
    v
bounded mechanism source reveal
    |
    v
candidate with observed scalar predictions
    |
    v
narrow confirmation replay
    |
    v
verified localization
```

Key invariants:

- Unknown semantic values remain `UNKNOWN`; no hidden good/bad labels.
- Deterministic decisions use topology, provenance, coverage, capture
  capability, or strict dominance—not fault names, constants, arithmetic, or
  domain guesses.
- The model selects only supplied actions, statements, traversals, and
  prediction options.
- Unchosen paths remain recoverable in internal state.
- Static expansion does not request a replay.
- A value-producing boundary may block source adjudication until its producer
  is explored; a control guard does not.
- MAY edges are not treated as witnessed execution.
- Cross-service process-local sequence numbers are not compared globally.
- Completion requires explicit correlation and fresh confirmation evidence.

## Current implementation

### Python analyzer

Main package:

```text
python/analyzer/src/liveprobe_analysis/
```

Important modules:

- `frontend.py`: Python AST/function/statement extraction, dependence
  relations, calls, routes, and durable accesses.
- `cache.py`: revision-aware persistent summaries, fragments, and
  investigation state.
- `investigation.py`: deterministic static closure, runtime traversals,
  active frontier, probe cuts, evidence, mechanism reveal, and confirmation.
- `model.py`: graph, call-role, probe, evidence, action, and candidate models.
- `engine.py`: earlier deterministic analysis-plan workflow.

The graph separates:

```text
canonical source identity
  one owner-neutral statement/function graph

runtime traversal identity
  service-specific path records that point into the source graph
```

Equivalent traversal contexts merge while preserving incoming-hop
provenance. Shared source can therefore be represented once and reached
independently by multiple service traversals. Probe sites carry authoritative
`service_id`, `traversal_ids`, and per-watch `path_node_ids`.

Implemented performance changes:

- unique local and HTTP value-producer chains close deterministically before
  the first replay;
- `FOLLOW_PATH` changes static state without incrementing the runtime round;
- only the active non-dominated frontier, capped at six actions, is exposed;
- deferred branch counts and kinds replace retransmission of every branch;
- focus is centered on latest evidence and active traversals;
- call contributions distinguish `VALUE_PRODUCER`, `CONTROL_GUARD`,
  `ACTIVATION_SOURCE`, and `HISTORICAL_STATE_PRODUCER`;
- control guards remain recoverable but do not force traversal before
  mechanism inspection;
- probe cuts use tracked region ports, minimal dot-path antichains,
  capture-capable locals, same-location merging, and coverage suppression;
- a watch path retains the exact producing static node even when runtime
  checkpoints merge;
- evidence dossiers, coverage, and causal paths update incrementally;
- mechanism cuts preserve directly witnessed producers before neighboring
  provenance when the source packet is bounded;
- exploration and mechanism briefs use short aliases and phase-specific
  schemas;
- graph model calls are fresh and self-contained rather than resumed coding
  agent chats.

The analyzer cache schema is version 16. Older call summaries are rebuilt so
the contribution-role field is never silently absent.

### Runtime, broker, and MCP

The Python SDK propagates explicit replay/trace occurrence IDs and
service-instance metadata. Investigation probes are deployed to the
service/traversal selected by the analyzer.

The MCP workflow is:

```text
prepare_repository_analysis
start_probe_investigation
get_investigation_context
deploy_investigation_probes
collect_investigation_evidence
apply_investigation_decision
get_investigation_result
```

Relevant code:

```text
python/sdk/src/liveprobe/
packages/broker/src/index.ts
packages/sdk-node/src/
packages/mcp-server/src/index.ts
```

Probe creation and data reads are concurrent. The benchmark no longer adds a
fixed cleanup sleep.

## Benchmark accounting

`demo/ride-analysis/benchmark-support.mjs` now:

- counts actual model sampling cycles separately from outer `codex exec`
  turns;
- counts repository/tool calls separately;
- converts cumulative resumed-thread usage into incremental turn deltas;
- retains partial JSONL, timing, and usage after timeout or failure;
- reports raw, cached, and newly processed input;
- reports localization and verification time;
- counts prompt text and output-schema bytes.

The graph arm uses a non-persistent model session because investigation memory
is owned by structured product state.

## Current measured results

Real failing-only E2E:

```text
status:                  LOCALIZED
passing executions:      0
failing executions:      2
rounds:                  2
total deployed probes:   6
investigation elapsed:   2.75 s
```

One external-model controlled smoke repetition:

| Method | Wall | Raw input | New input | Samples | Tools |
| --- | ---: | ---: | ---: | ---: | ---: |
| Normal Codex | 17.96 s | 47,225 | 12,153 | 3 | 2 |
| PRAXIS-style | 23.15 s | 36,441 | 27,481 | 3 | 0 |
| ReAct + LiveProbe | 45.25 s | 90,873 | 44,537 | 5 | 2 |
| Graph + LiveProbe | 8.94 s | 12,763 | 12,763 | 1 | 0 |

All four localized the exact root statement. Graph + LiveProbe used two
replays, five benchmark-counted probes, one model sample, and a 6,124-byte
explicit prompt plus schema.

Compared with the documented pre-improvement graph median, the new smoke run
used about 12.7x fewer input tokens and 6.1x less wall time. Compared with the
same-run normal Codex arm, it used 3.70x fewer raw input tokens and 2.01x less
wall time.

This is one repetition, not a stable population median. Run the configured
three-repetition comparison before making broad claims.

The graph arm was separately validated for three repetitions:

```text
exact localization:       3/3
median wall:               8.38 s
mean raw input:            12,764
model samples per run:     1
replays per run:           2
probes per run:            5
explicit request per run:  6,124 bytes
```

## Validation most recently confirmed

```text
python analyzer:
  37 tests passed

MCP server:
  typecheck passed
  17 tests passed

RideRush failing-only investigation:
  LOCALIZED

four-method oracle harness:
  all four arms passed

four-method external smoke:
  all four arms localized the exact line
```

Loopback integration and RideRush process tests require permission to bind
local ports.

## Documents

Read in this order:

1. `demo/ride-analysis/GRAPH_LIVEPROBE_IMPROVEMENTS.md`
   - original traces, general defects, implemented changes, gates, and
     post-improvement results.
2. `demo/ride-analysis/FOUR_METHOD_BENCHMARK.md`
   - current method contracts, accounting, comparison, and caveats.
3. `demo/ride-analysis/CURRENT_ARCHITECTURE_PACKET_TRACE.md`
   - detailed pre-improvement trace that motivated the optimization work.
4. `docs/liveprobe-investigation-loop-adversarial-review.md`
   - adversarial review of evidence and confirmation semantics.
5. `demo/ride-analysis/README.md`
   - commands and experiment inventory.

`adaptive-comparison.mjs` and
`python/analyzer/experiments/runtime_guided_model.py` preserve the earlier
differential workflow for provenance. They are not current product entry
points.

## Remaining work

The next correctness/performance step is a multi-case adversarial suite with
renamed identifiers, misleading traces, multiple plausible services, durable
state, aliases, concurrency, and absence/control-flow faults. The suite gate
is at least 2x lower median raw input and wall time than normal Codex while
matching or exceeding exact verified localization.

A persistent warmed analyzer worker and event-streamed occurrence completion
remain possible infrastructure optimizations. Do not add them merely to shave
the current benchmark: model time was 7.45 of the graph arm's 8.94 seconds and
the two request replays took 89 ms. Profile them under sustained concurrent
investigations before accepting the lifecycle complexity.
