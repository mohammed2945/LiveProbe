## Bottom line

The redesign has a better optimization target than the current implementation, but several soundness claims do not survive inspection.

The strongest surviving ideas are:

- Optimize for correlated executions, not an arbitrary probe count.
- Use explicit hypothesis coverage instead of `upstream_weight`.
- Prefer deterministic, inspectable predicate artifacts over repeated LLM judgments.
- Probe boundaries aggressively.
- Keep hammocks for mechanism adjudication, not value correctness.

The claims that fail are:

- Probes are effectively free.
- A wide round usually means “one round, done.”
- `GOOD → eliminate cone(n)` is sound over the current MAY graph.
- 15–25 transfer rules make most production verdicts mechanical.
- Recomputing a pure expression exonerates that expression.
- A wrong synthesized predicate will reliably expose itself by producing `|H| = 0`.
- Dependence-graph dominators are execution checkpoints.

No implementation changes were made during this review.

---

# Verdicts

## 1. “We optimized the wrong resource”

**Verdict: ACCEPT WITH MODIFICATION**

Rounds are generally scarcer than static candidate count, especially for rare production recurrence. But “probes are free” is false. The real runtime resource is:

```text
sum over probe sites:
    executions × pause/callback cost × capture size
```

One cold one-hit probe can be cheap. One probe inside a 100,000-iteration loop can be disastrous.

### What the current runtimes actually permit

| Runtime | Current default gates | What is measured |
|---|---|---|
| Python | 10 accepted probe hits/sec, 20ms callback time/sec, 200KB/sec, queue 4,096 | Only disabled-location overhead; no active multi-probe budget |
| Node | 10 breakpoint hits/sec, 200KB/sec, 50ms event-loop lag limit | Active breakpoint pause deliberately excluded |
| JVM | 10 breakpoint events/sec, 2,000-event queue, bounded serializer | No active breakpoint latency or bandwidth measurement |

These are configured defaults, not validated safe budgets.

The repository explicitly says the current benchmarks do not characterize active Node breakpoint latency, and records only a Python disabled-location result—not active snapshots. See [README.md](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/README.md:424).

More damningly, the RideRush E2E changes Python from:

```text
10 hits/sec     → 1,000
20ms callback   → 1,000ms
```

because six simultaneous probes can trigger the production safety cooldown. See [target.py](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/demo/ride-analysis/target.py:92).

Python also consumes the hit-rate token once per matching probe state, copies all locals, captures the stack, and later serializes the entire local-variable mapping—not merely the requested watch value. See [runtime.py](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/python/sdk/src/liveprobe/runtime.py:684) and [runtime.py](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/python/sdk/src/liveprobe/runtime.py:1066).

Node and JVM are worse on active hot paths because the thread has already stopped when the limiter sees the breakpoint:

- Node receives a paused event before checking its token bucket in [probe-manager.ts](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/packages/sdk-node/src/probe-manager.ts:151).
- JVM uses `SUSPEND_EVENT_THREAD` and reads every visible local before resuming in [Main.java](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/java/bridge/src/main/java/io/liveprobe/bridge/Main.java:567) and [Main.java](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/java/bridge/src/main/java/io/liveprobe/bridge/Main.java:688). This matches the official [JDI breakpoint model](https://docs.oracle.com/javase/8/docs/jdk/api/jpda/jdi/com/sun/jdi/request/BreakpointRequest.html).

PEP 669 makes inactive monitoring substantially cheaper than older tracing, but it does not make active callback and capture work free. [PEP 669](https://peps.python.org/pep-0669/)

### Correct objective

Use a lexicographic objective:

```text
1. Preserve recall and runtime safety.
2. Minimize expected future correlated executions.
3. Minimize dynamic capture cost within each execution.
4. Minimize model/token cost.
```

Do not use a fixed “number of probes” budget. Use a runtime-specific capture budget containing:

- expected executions per site;
- one-hit versus repeated-hit policy;
- estimated captured bytes;
- serializer complexity;
- callback/pause time;
- hotness confidence;
- language/runtime.

**Files that would change:** runtime cost telemetry in Python `LiveProbe._on_line`, Node `ProbeManager.handlePaused`, JVM `ProbeManager.capture`; planning policy in `AnalysisEngine._frontier`; round deployment in `deploy_probe_frontier`.

**Actual measured safe count today:** unknown for all three agents. The current repository cannot honestly provide one.

---

## 2. “Default to maximum evidence per round”

**Verdict: ACCEPT WITH MODIFICATION**

Wide probing should replace bisection for cold, single-hit, replayable paths. But the proposed strategy table is too optimistic.

### The RideRush result does not prove one-round localization

The actual E2E used:

```text
Round 1: 6 candidates
Round 2: 4 candidates
Final: EXONERATED
```

It took two rounds. See [latest-e2e.json](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/demo/ride-analysis/results/latest-e2e.json).

Round one found that adjustments were bad, but the decisive boundary probe immediately after the durable read was only installed in round two. The possible pricing writer also did not execute during the request.

Therefore:

```text
wide observed path ≠ complete causal history
```

A request can observe a bad durable value without executing the background writer that created it. A single replay cannot make that writer fire retroactively.

### “Temporal order” is not enough

`localHitSequence` is:

- process-local;
- global across requests/tasks in that process;
- not comparable between services;
- not a causal order for durable writes;
- not currently present in Node or JVM captures.

The earliest event in wall-clock order is not necessarily the origin. You need ordering along witnessed dependency edges, not merely timestamps or local hit sequence.

### Current crossover data

Under the proposed rough definition of `H`, the four RideRush static cases contain approximately:

| Case | Relevant graph nodes | Approximate hypotheses |
|---|---:|---:|
| Durable fare corruption | 13 | 12 |
| HTTP quote hop | 9 | 10 |
| Module memory | 5 | 4 |
| Surge/control case | 17 | 17 |

Across the complete 39-file RideRush repository, the largest current analyzer result I found had:

```text
89 relevant nodes
approximately 82 hypotheses
```

The current frontier implementation hard-caps itself at 10 probes regardless of the caller’s larger budget in [AnalysisEngine._frontier](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/python/analyzer/src/liveprobe_analysis/engine.py:741).

So even this compact fixture already has regimes where “probe everything” exceeds current defaults.

### Correct strategy

```text
Cold, one-hit sites whose predicted dynamic cost fits:
    probe all high-value after-definition sites and boundaries

Hot or repeated sites:
    use hit-1 snapshots, conditions, counters, or cuts

Background/durable writers:
    observe the consumer boundary first
    hand back a value contract or separately trigger the writer

Rare recurrence:
    maximize safe expected evidence, but never exceed runtime budget

No replay:
    prefer boundaries and high-coverage cuts, plus explicit no-hit controls
```

“Slice fits safe budget → one round, done” must become:

> If all property-relevant, executable sites fit the dynamic budget and the causal path occurs in the same execution, one round may localize the earliest observed bad boundary.

**Files that would change:** `AnalysisEngine._frontier`, MCP `deploy_probe_frontier`, runtime hit/cost reporting, and the RideRush E2E round policy.

---

## 3. “Hypothesis-set semantics should replace candidate scoring”

**Verdict: ACCEPT WITH MAJOR MODIFICATION**

An explicit ledger is much better than unexplained `distance_from_sink` and `upstream_weight`. But the proposed elimination rules are not sound over the current graph.

### The bitset implementation is feasible

Thousands of hypotheses are not inherently a bitset problem. Ten thousand hypotheses require roughly 1.25KB per uncompressed bitset.

The harder problems are:

- graph quality;
- cycles;
- meaning of a hypothesis;
- soundness of the verdict;
- dynamic-instance identity.

The proposed “topological order” does not work directly because the graph contains cycles from loops, module memory, and potentially durable relationships. It needs strongly connected component condensation or a monotone fixpoint.

The current graph construction can also explode before bitsets become relevant:

```text
module memory: writers × readers
durable state: writes × reads
```

See `ProjectGraph._compose_module_memory` and `_compose_durable_boundaries` in [engine.py](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/python/analyzer/src/liveprobe_analysis/engine.py:158).

### Definition nodes are not necessarily mutually exclusive hypotheses

Real failures can have:

- two contributing inputs;
- a bad transformation/operator rather than a bad input;
- a control decision;
- an activation condition;
- a race between writer and reader;
- a missing graph edge;
- multiple independent faults.

So `|H| = 1` only has its proposed meaning under a single-origin, closed-world assumption.

At minimum, `H` needs:

- transformation sites;
- boundary handback hypotheses;
- control predicates;
- an explicit `UNKNOWN_MODEL` hypothesis;
- potentially compound hypotheses for fan-in interactions.

### The elimination rules are only conditionally sound

The proposal says:

```text
GOOD(n) → eliminate cone(n)
BAD(n)  → eliminate H \ cone(n)
```

`GOOD(n) → eliminate cone(n)` is unsound when:

- an upstream bad value was normalized or masked before `n`;
- `n` observed a sibling field rather than the actual contributor;
- a MAY edge did not execute in this occurrence;
- the property changed meaning across a transformation;
- the captured Python object mutated after the callback;
- the real flow is absent from the graph.

The correct abstraction is:

```text
H := H ∩ compatible_hypotheses(site, dynamic_instance, observation)
```

The simple cone rules are a special case only when the transfer is known to preserve the property.

### Python captures are not presently hit-time immutable

The callback does:

```python
variables = dict(frame.f_locals)
```

That freezes the local mapping but not nested lists, dictionaries, model objects, or other references. Background serialization can therefore observe a later mutation. See [runtime.py](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/python/sdk/src/liveprobe/runtime.py:728).

Until requested values are frozen at callback time, a ledger keyed by `(site, hit_index)` is not trustworthy for mutable objects.

### Current occurrence handling is insufficient

`CandidateAssessment` stores `occurrence_id`, but `AnalysisEngine.refine` ignores it and merges all `good`/`bad` classifications into static node sets. See [model.py](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/python/analyzer/src/liveprobe_analysis/model.py:251) and [engine.py](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/python/analyzer/src/liveprobe_analysis/engine.py:397).

That cannot represent:

```text
hit 1 GOOD
hit 2 GOOD
hit 3 BAD
```

It also cannot safely combine passing and failing occurrences.

### Synthetic external hypotheses are valuable

They are not decoration. Without them, a bad value observed immediately after an HTTP/DB/config read would incorrectly converge on the read statement itself.

However, call them **ownership handback hypotheses**, not root causes. One boundary can hide:

- producer code;
- stale stored state;
- serialization;
- transport;
- wrong tenant/key;
- race/version mismatch.

### Scoring is not eliminated

The ledger replaces opaque state, not selection utility. Probe selection still needs:

```text
expected/worst-case hypothesis partition
÷ predicted runtime cost
× probability the site executes
```

So replace arbitrary scores with ledger-derived utility, not “no scoring.”

**Files that would change:** hypothesis and observation types in [model.py](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/python/analyzer/src/liveprobe_analysis/model.py:217), refinement and reachability in `engine.py`, occurrence schemas in MCP, and snapshot stability in the Python runtime.

---

## 4. “Backward property propagation makes most verdicts mechanical”

**Verdict: REJECT**

It can make a valuable subset mechanical. “Most verdicts” and “15–25 rules” are not supported.

The current cached representation does not retain an expression/operator IR. `_statement_dependencies` mostly records:

```text
definition → all variables used by the statement
```

with special handling for literal dictionaries. It loses whether the expression was addition, multiplication, conversion, comparison, overloaded operator, or library call. See [frontend.py](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/python/analyzer/src/liveprobe_analysis/frontend.py:205).

A property engine therefore requires a new expression representation, not a small addition to the existing edges.

### Coverage by class

| Class | Realistic deterministic coverage |
|---|---|
| 1. Type/shape | Good for direct operations, copies, literal fields, known schemas; not fully mechanical across arbitrary calls |
| 2. Domain/range | Good at the failing operator; backward propagation often becomes relational or disjunctive |
| 3. Contract | Good when a structured schema/constraint is available; weak when only an opaque error body exists |
| 4. Semantic wrong value | Usually not mechanical without an external expected value, formula, or matched passing execution |
| 5. Absence | Not a value-property problem; requires control reachability and no-hit semantics |

Examples of overstatement:

- `TypeError` at `subtotal * tax` does not alone prove which operand “must be numeric.” Runtime types or a contract are needed.
- `x * y >= 0` does not produce independent unary predicates for `x` and `y`; it is a relational/disjunctive condition.
- Requiring a timestamp to be “valid” depends on library formats and business timezone rules.
- `json()` does not universally mean a field must preserve a particular Python type; coercion and schema behavior matter.

### Where it stalls in the actual Python repositories

The current analyzer has no semantic model for:

- Pydantic `model_dump` and validators;
- `response.json()` beyond ordinary call flow;
- FastAPI middleware-to-handler flow;
- Supabase/PostgREST client behavior beyond literal pattern recognition;
- dynamic URL construction;
- decorators other than simple literal route decorators;
- `**kwargs` field mapping;
- overloaded operators;
- properties/descriptors;
- dynamically resolved calls;
- generated models and dependency injection.

CodeQL separates efficient local flow from substantially more expensive and query-specific global flow for exactly this reason; global flow needs carefully modeled sources, sinks, barriers, and library semantics. [CodeQL data-flow documentation](https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/)

### Correct restatement

> A small, explicitly supported property domain can mechanically classify many class-1 failures and selected class-2/3 failures. Unsupported transfers must return `UNKNOWN`, never fabricate a predicate.

“15–25 rules” may cover common AST syntax forms. It will not cover production semantics. Expect:

- dozens of structural rules;
- a growing registry of framework/library summaries;
- schemas and type information;
- explicit unknowns.

**Files that would change:** `FlowNode`/new expression IR in `model.py`, extraction in `PythonFrontend`, a new property-transfer module, cache schema version, and analyzer coverage notes.

---

## 5. “The LLM seam is predicate synthesis, not per-value judgment”

**Verdict: ACCEPT WITH MAJOR MODIFICATION**

The distinction is real and important:

```text
LLM proposes one inspectable artifact
deterministic machinery evaluates it repeatedly
```

That is more reproducible and auditable than asking the model whether every captured value “looks bad.”

The current E2E demonstrates how dangerous the present ad hoc alternative is. Its classifier says:

```text
contains "US-CA:1.0825" → bad
everything else captured → good
```

See [classifyOccurrence](/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe/demo/ride-analysis/e2e.mjs:98). That can create false GOOD verdicts for any different malformed value.

### Where the synthesis proposal is too optimistic

#### Class 4 often lacks enough context

From:

```text
customer was charged $2310, expected about $23
```

a model can propose a range. But it cannot reliably know whether:

- storage is cents while display is dollars;
- tax is inclusive;
- authorization and capture differ;
- partial capture is expected;
- currency has zero or three minor units;
- the customer’s expectation is itself wrong.

The model may need invoice lines, currency, pricing version, contract, and cohort metadata. Without them, the correct result is `INSUFFICIENT`, not an executable guess.

#### A stall is not only a property of code

For:

```python
normalize_rate(x)
```

the required input condition differs depending on whether the output must be:

```text
numeric
finite
between 0 and 1
expressed as a percentage
stable under rounding
```

The reusable artifact is a relational function summary, not a query-specific predicate.

A cache key must therefore include at least:

```text
function content hash
normalized requested output property
type/schema context
dependency/framework model version
synthesis model/prompt version
```

#### Wrong predicates can converge to a false singleton

Retraction at `|H| = 0` catches only contradictions that eliminate everything. A subtly wrong predicate can leave one innocent hypothesis and confidently terminate at `|H| = 1`.

Defeasible evidence must therefore remain provenance-bearing and non-destructive. Better options are:

- retain eliminated hypotheses with reason/confidence;
- branch hard and soft ledger views;
- require independent confirmation before terminal localization;
- re-evaluate the top result against the original symptom;
- validate synthesized predicates on known failing and passing examples.

### Differential capture: valuable, but not an automatic oracle

A passing request differs from a failing request for many legitimate reasons. Divergence can reflect:

- different customer;
- different tier/region;
- random identifier;
- timestamp;
- cache state;
- feature targeting;
- another control path.

Agreement also does not exonerate hidden state that was not captured.

Differential capture should be first-class only with:

- matched/cohort-compatible inputs;
- the same code revision and relevant configuration;
- outcome labels;
- aligned candidate IDs and control path;
- normalization for expected nondeterminism.

In controlled replay, this is achievable. In spontaneous production traffic, it requires future traffic after probes are armed, outcome classification, and matched sampling. The current system does not provide this for Node/JVM and does not retain a multi-occurrence ledger.

### Pure-expression re-evaluation is not exoneration

This proposal is wrong:

> If the observed output equals recomputation, only the inputs can be wrong.

If the code says:

```python
amount = subtotal * 100
```

when it should divide by 100, recomputation faithfully reproduces the bug. The expression site remains the defect.

Re-evaluation can detect runtime inconsistency or mutation:

```text
observed output ≠ expression(captured inputs)
```

It cannot prove semantic correctness.

Python “pure expression” classification is also unsafe around overloaded operators, descriptors, and getters. Initially restrict it to exact primitive types and allow-listed operators.

### Required predicate form

Do not let a model emit arbitrary Python. It should emit a versioned, inspectable DSL such as:

```json
{
  "op": "is_number",
  "path": "tax_multiplier",
  "finite": true
}
```

or:

```json
{
  "op": "and",
  "args": [
    {"op": "gte", "path": "amount", "value": 20},
    {"op": "lte", "path": "amount", "value": 30}
  ]
}
```

**Files that would change:** new predicate DSL/types, MCP incident input, analyzer transfer cache, deterministic event evaluator, and multi-occurrence refinement.

---

## 8. Deterministic priors

### 8a. Dominator tree of the dependence graph

**Verdict: REJECT AS STATED**

Dominance over a dependence graph is not equivalent to an execution checkpoint.

With fan-in:

```text
A ─┐
   ├→ failure
B ─┘
```

neither contributor lies on every explanation path, yet both may be required.

MAY edges and cycles further destroy the claimed interpretation.

Use:

- CFG dominators to find code guaranteed to execute before the manifestation within one function/execution;
- dependency-cone partitions or graph separators to choose value probes;
- witnessed trace edges for dynamic ordering.

The current analyzer contains CFG edges, but excludes them from the incident dependency result. No dominator implementation exists.

### 8b. Boundaries as preferred cuts

**Verdict: ACCEPT WITH MODIFICATION**

This is cheap and partially implemented already:

- `ProjectGraph._compose_http_boundaries`
- `ProjectGraph._compose_durable_boundaries`
- boundary quota in `AnalysisEngine._frontier`

Boundaries are valuable because they divide ownership and often provide schema-friendly values.

The current weakness is that `_frontier` reserves only roughly one boundary candidate per five probes and may choose either side of the boundary. Prefer the consumer’s immediate after-read location first, because it answers:

> Did this service receive a bad value?

A boundary is not automatically oracle-friendly when its schema is absent or semantically weak.

### 8c. Change recency

**Verdict: ACCEPT ONLY AS A PRIOR**

There is no Astrea v3.7 implementation or Filter B machinery in either checked-out repository. Nothing exists to reuse directly.

Git blame can be added and cached, but change age must never delete old hypotheses. Old defects activated by new data, flags, load, or schedules remain common.

Use separate priors:

```text
defect recency
activation recency
onset alignment
```

The current model and analyzer have no incident-onset or activation records, so this is not “already computable.”

**Files that would change:** cached blame metadata, `AnalysisCriterion`, candidate/hypothesis metadata, and the selection utility.

---

## 9. “Hammocks are the wrong context for value verdicts”

**Verdict: ACCEPT WITH MODIFICATION**

The conceptual separation is correct:

```text
Value correctness:
    value + predicate + relevant uses + comparator/history

Mechanism judgment:
    producer/transformation hammock + diffs + guards
```

The current graph already has `outgoing` edges, so direct downstream use sites are cheap while `ProjectGraph` is loaded. A bounded forward traversal can collect them.

However:

- the persisted plan contains only the selected backward relationships;
- current edges are statement/path approximations;
- aliases and large objects can make a forward result broad;
- framework consumers may be unresolved.

A value dossier should therefore contain:

```text
typed captured value
predicate and provenance
definition site
3–5 predicate-relevant use sites
passing counterpart, when matched
schema/boundary contract
capture truncation/redaction status
```

If use-site resolution explodes, return a coverage warning. Do not silently fall back to a whole producer hammock and call it equivalent.

One factual correction: the current live E2E does not use hammock context for per-value model judgments. Hammock source was used in the experimental static frontier-ranking prompt. This proposal prevents a future conflation rather than fixing an existing live LLM verdict path.

**Files that would change:** forward-use extraction in `AnalysisEngine`, new dossier schema, MCP refinement output, and future model-prompt construction.

---

## 10. Explicit rejections

### BFS to 20 nodes, then let the LLM prune

**Verdict: THE REJECTION IS CORRECT**

Do not let static LLM judgment irreversibly remove hypotheses.

A model may still:

- reorder candidates;
- flag missing framework semantics;
- suggest an additional boundary;
- choose among otherwise equivalent probes.

But static rejection must remain reversible.

The earlier experiment supports the cost concern but is weak evidence about general reasoning quality:

- only four small fixtures;
- frontier sizes of four or five;
- incident descriptions often disclosed the actual mechanism;
- expected-origin recall was already guaranteed by construction;
- no runtime evidence was presented.

So “the model added nothing in these four cases” is true. “The model can never help static ranking” is not established.

### Hammock deduplication and prompt caching are only micro-fixes

**Verdict: MOSTLY CORRECT**

They do not repair the search architecture.

But predicate synthesis and rare transfer-summary calls remain in the accepted design. For those calls, eliminating repeated 12,000-token Codex startup context and duplicate source is still materially worthwhile.

A persistent stateful session should not be the default because it weakens isolation and reproducibility. Provider-level prompt caching or compact stateless requests are safer.

---

# What the proposal got wrong or overstated

1. **Probe count is not free.** Dynamic hit count, pause time, serialization and bytes are the scarce in-round resources.

2. **RideRush did not finish in one round.** It required two.

3. **The wide-round E2E used non-production limits.** It raised both hit and callback budgets to 1,000.

4. **Temporal hit order is not causal order.** It is process-local and does not cover durable/background producers.

5. **The bitset graph is cyclic.** Topological propagation needs SCC condensation or a fixpoint.

6. **The cone rules are not sound over MAY edges.** They require property-preserving witnessed flow.

7. **Python captures mutable references, not immutable hit-time snapshots.**

8. **`occurrence_id` is currently ignored by refinement.**

9. **Hypotheses are not necessarily mutually exclusive.** Multi-input and multi-fault incidents break singleton termination.

10. **`H` does not remain around ten.** This small repository already produces approximately 82 hypotheses for one current criterion.

11. **15–25 rules cover syntax, not production semantics.**

12. **Class 4 and 5 being “the hard majority” is unproven.** The repository contains no production-incident corpus establishing that distribution.

13. **Propagation stalls are predicate-dependent, not solely code-dependent.**

14. **Differential divergence is not automatically wrongness.** Matching and normalization are required.

15. **Pure recomputation cannot exonerate buggy code.**

16. **`|H| = 0` is not a sufficient wrong-predicate detector.**

17. **Dependence-graph dominators are not execution checkpoints.**

---

# Minimal implementation experiment

Do not build the whole redesign yet. The smallest useful experiment is Python-only, controlled replay, scalar values, no LLM.

## 1. Add a deliberately tiny predicate domain

Support only:

```text
is_number
is_not_none
is_finite
comparison to constant
field projection
boolean conjunction
```

Support backward transfers only through:

```text
direct assignment
literal attribute/subscript projection
literal dict/dataclass field construction
known JSON field type
simple primitive arithmetic
```

Everything else returns `UNKNOWN`.

This is enough to test class 1 and selected class 2 without pretending to solve class 4.

## 2. Add a minimal ledger

For acyclic per-request dataflow only:

```text
Hypotheses:
    definition/transformation nodes
    inbound boundary handbacks
    UNKNOWN_MODEL

Observation:
    occurrence ID
    candidate ID
    per-probe hit index
    immutable typed value
    predicate result
    predicate provenance
```

Use compatibility sets rather than unconditional GOOD/BAD cone deletion.

## 3. Add an experimental wide-round planner

Generate all probeable property-relevant after-definition sites, but let the Python runtime preflight the predicted round cost.

Do not change production defaults for the experiment.

Test chain sizes:

```text
4, 8, 12, 20 cold one-hit sites
```

and:

```text
1 site inside loops of 10, 1,000 and 100,000 hits
```

This establishes that static site count and dynamic capture cost are different quantities.

## 4. Freeze only requested scalar values at callback time

Do not deep-copy arbitrary object graphs yet.

Capture requested primitive watch values synchronously so hit-index evidence is stable. Return `UNKNOWN` for unsupported mutable values.

## 5. Compare two policies

```text
A. Current iterative frontier
B. Wide property-aware frontier
```

Measure:

- correlated executions required;
- origin recall;
- intended sites hit;
- dropped/rate-limited hits;
- safety-red transitions;
- callback time;
- request p50/p95/p99;
- serialized bytes;
- mechanical verdict coverage;
- UNKNOWN rate.

### Falsification conditions

The “rounds, not probes” premise fails under current defaults if a wide set of 8–12 cold scalar sites:

- loses intended captures;
- enters safety red;
- materially damages replay latency;
- or does not reduce the two-round RideRush investigation.

The property claim fails if class-1/2 propagation frequently becomes `UNKNOWN` before reaching the known origin even on direct scalar code.

That experiment is small enough to be honest and large enough to kill the redesign before major investment.

---

# Failure-class test matrix

| Class | Scenario | Success criterion |
|---|---|---|
| 1. Type/shape | Existing RideRush `tax_multiplier = "US-CA:1.0825"` causes multiplication `TypeError` | No LLM; numeric predicate propagated to the durable response; earliest observed malformed boundary localized with stable snapshots |
| 2. Domain/range | Pricing/ETA divides by a boundary-provided `driver_speed = 0` | Extract `speed != 0`; mechanically classify probes; localize the first zero source without value judgment |
| 3. Contract | Payment insert violates a named DB `CHECK amount >= 0` constraint | Parse the structured constraint/error into an inspectable predicate; localize negative amount origin; unsupported opaque errors become `INSUFFICIENT` |
| 4. Semantic value | `$23.10` becomes `$2310` through cents/dollars conversion | Match failing and passing executions by normalized inputs; find first relevant divergence; avoid flagging legitimate IDs/timestamps; require final semantic confirmation |
| 5. Absence | Webhook receives `customer.subscription.updated`, code checks `customer.subscription.update`, expected branch never runs | Entry and condition probes hit; intended branch counter does not; alternative/exit counter does; report a control-path localization rather than fabricating a bad value |

### What RideRush currently exercises

The live RideRush E2E exercises only class 1.

The static tracks include:

- a semantically wrong HTTP quote;
- a control-dependent surge value;
- module memory;
- durable malformed data.

But those tracks do not execute a general oracle or prove class-4 localization. Their incident descriptions also reveal substantial information about the expected origin.

Current harness coverage:

```text
Class 1: yes, live
Class 2: no
Class 3: no
Class 4: static candidate recall only
Class 5: no
```

---

# Important missing concerns

- **No-hit semantics:** absence is meaningful only if the probe was armed, the request reached a bracketing checkpoint, sampling did not drop it, and the code revision matched.
- **Security/privacy:** all three snapshot runtimes currently capture broad local state. “Probe everything” expands PII and secret exposure substantially.
- **Replay safety:** production replay may repeat writes, charges, emails or queue acknowledgements. Idempotency is part of the round model.
- **Heisenbugs:** Node/JVM pauses can change races and timeout behavior.
- **Mixed revisions:** a trace can traverse multiple deployments; one repository SHA is insufficient.
- **Distributed causal order:** trace identity alone does not order concurrent spans, queues or durable history.
- **Redaction/truncation:** a predicate evaluated on truncated or redacted data must be `UNKNOWN`.
- **Multiple origins:** the ledger currently assumes one earliest origin.
- **Unknown graph edges:** dynamic dispatch and framework behavior need an explicit `UNKNOWN_MODEL` hypothesis.
- **Predicate governance:** predicates need versioning, provenance, validation, auditability and a restricted DSL.
- **Outcome labeling:** differential capture needs a reliable definition of passing versus failing.
- **Activation versus defect:** the earliest bad value, defect site and incident activation are three different objects and should not be collapsed into one “origin.”
