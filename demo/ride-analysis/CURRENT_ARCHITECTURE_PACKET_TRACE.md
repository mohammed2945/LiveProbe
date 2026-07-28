# Current LiveProbe architecture: exact RideRush trace and payload audit

> Historical note (schema 15): this trace describes the retired matched
> differential workflow. The active workflow is failing-only and
> unknown-first. Its serializer keeps the lessons below as regression
> constraints: no raw analyzer-state dump, unsupported builtins, large client
> objects, duplicated judgments, repeated evidence, or function-sized source
> reveal in model decision packets.

This document explains what the current graph+dossier investigation actually
does. It uses the real RideRush `surge_poison` benchmark, the exact packet
serializer used by the external Codex run, and the measured values from that
run.

It deliberately does **not** claim that the current result beats PRAXIS or
LiveProbe V1. The existing experiments did not run those methods on the same
incident under the same controls:

- the controlled PRAXIS-like result covered four source-only cases and seven
  model calls;
- the earlier runtime-guided V1 experiment began inside the pricing service,
  used synthesized value fixtures, and did not perform the gateway-to-pricing
  investigation;
- the current experiment uses real probes, matched live replays, a
  cross-service hop, a verification replay, and persistent model context.

Those numbers cannot support a percentage improvement claim. A fair
comparison must rerun every method on this same runtime test bed. That testing
is intentionally postponed until after this document is reviewed.

## Plain-language overview

The incident is:

> A rider received a quote of `1718.50` when the matching normal request
> received `37.80`.

The manifestation is in the gateway:

```python
return {
    "trip_id": trip["id"],
    "quote": pricing["quote"],
}
```

LiveProbe works backward from `pricing["quote"]`.

The current loop is:

1. Deterministic Python analysis constructs a dependency graph behind the
   manifestation.
2. It converts selected graph nodes into runtime probe sites.
3. The same request is replayed once with the fault inactive and once with the
   fault active.
4. Captured values are paired by probe site.
5. Deterministic code labels equal values `CONSISTENT` and unequal values
   `SUSPICIOUS`.
6. If there is only one legal upstream direction, deterministic code follows
   it without calling the model.
7. Once multiple plausible actions exist, the graph, values, judgments, and
   legal actions are sent to the model.
8. After the model selects a likely origin node, LiveProbe reveals the
   surrounding source hammock and asks for the concrete mechanism.
9. A final correlated replay verifies the selected mechanism.

The compiler graph is therefore doing real work. But the current model packet
is not yet a small distilled explanation. It is mostly a serialized analyzer
state dump.

## Who does what

| Operation | Owner |
| --- | --- |
| Parse Python and index functions | Deterministic analyzer |
| Build def-use, control, call, and boundary relations | Deterministic analyzer |
| Work backward from `pricing.quote` | Deterministic analyzer |
| Resolve the gateway HTTP call to `pricing.quote` | Deterministic analyzer |
| Select probe sites | Deterministic analyzer |
| Correlate passing/failing occurrences | Runtime SDK and broker |
| Pair values at identical sites | Deterministic analyzer |
| Mark equality/difference | Deterministic analyzer |
| Follow a sole legal producer | Deterministic driver |
| Choose among multiple remaining actions | LLM |
| Explain the selected source mechanism | LLM |
| Require another correlated execution | Deterministic investigation state machine |

## Step 0: repository preparation

At this RideRush revision, the analyzer indexes:

```text
files:       39
functions:   248
cache size:  8,359,936 bytes
index time:  about 1.25 seconds on the local machine
```

This index is stored analyzer state. It is not all sent to the model.

The persistent index contains function summaries. Statement-level graph
fragments are loaded only for functions expanded during the investigation.

## Step 1: start at the gateway manifestation

The investigation criterion is structurally equivalent to:

```json
{
  "service": "gateway-e2e",
  "file": "services/gateway/app.py",
  "line": 83,
  "watchPath": "pricing.quote",
  "symptom": "a rider received an implausibly high quote",
  "failureClass": "semantic",
  "probeBudget": 10
}
```

The analyzer loads `gateway.request_ride` and works backward from
`pricing.quote`.

The initial graph has seven nodes:

| File:line | Kind | Defines | Uses |
| --- | --- | --- | --- |
| gateway:81 | response construction | `response.quote`, `response.trip_id` | `pricing.quote`, `trip.id` |
| gateway:53 | assignment | `pricing` | `pricing_response.json` |
| gateway:42 | HTTP assignment | `pricing_response` | request coordinates, headers, HTTP client |
| gateway:40 | assignment | trace header | `trace_id` |
| gateway:39 | assignment | `trace_id` | request correlation state |
| gateway:41 | async context | HTTP client | `httpx.AsyncClient` |
| gateway:32 | function entry | `ride`, `request` | — |

The important dependency spine is:

```text
gateway request inputs
        |
        v
HTTP call -> pricing_response -> pricing_response.json()
                                      |
                                      v
                                 pricing.quote
                                      |
                                      v
                              gateway response quote
```

The analyzer also resolves the HTTP producer:

```text
gateway HTTP response "quote"
        |
        v
services/pricing/app.py :: quote(...)
```

At this point the pricing function is known but not yet expanded.

## Step 2: first probe round

LiveProbe deploys five gateway probe sites. It performs two explicitly paired
executions:

```text
passing execution: surge_poison disabled
failing execution: surge_poison enabled
business request:  otherwise identical
passing quote:      37.80
failing quote:      1718.50
```

The useful observations are:

| Value | Passing | Failing | Deterministic judgment |
| --- | --- | --- | --- |
| business trace identifier | same | same | `CONSISTENT` |
| pricing HTTP response | normal quote body | inflated quote body | `SUSPICIOUS` |

The wrong value already exists in the response received from pricing.

The only legal unresolved producer is `pricing.quote`. The consumer-side HTTP
call is not allowed to become the root while that producer remains
unexplored. Therefore:

```text
decision: FOLLOW_PATH -> pricing.quote
model calls: 0
model packet bytes: 0
```

This is an important actual saving in the current architecture.

## Step 3: expand the pricing producer

The analyzer loads the body of `pricing.quote` and adds eleven pricing nodes.
The combined focused graph now contains 18 nodes and 39 edges.

All 18 nodes sent in the first model packet are:

| File:line | Kind | Defines | Uses |
| --- | --- | --- | --- |
| gateway:81 | `AnnAssign` | response fields | pricing and trip fields |
| gateway:53 | `Assign` | `pricing` | `pricing_response.json` |
| gateway:42 | `Assign` | `pricing_response` | client, headers, ride coordinates |
| gateway:32 | entry | `ride`, `request` | — |
| gateway:40 | `Assign` | headers | `trace_id` |
| gateway:41 | `AsyncWith` | client | `httpx.AsyncClient` |
| gateway:39 | `Assign` | `trace_id` | request state |
| pricing:76 | `Return` | quote response fields | amount, distance, surge |
| pricing:73 | `Assign` | `distance` | coordinates and `abs` |
| pricing:74 | conditional assignment | `surge` | config surge and `is_active` |
| pricing:75 | `Assign` | `amount` | base fare, rate, distance, surge |
| pricing:45 | entry | four coordinates | — |
| pricing:63 | `AnnAssign` | `config` | database response |
| pricing:64 | `Assign` | `rate` | configured per-mile rate |
| pricing:71 | `Assign` | `rate` | `_cached_rate` |
| pricing:52 | `Assign` | database response | client and stack ID |
| pricing:65 | `If` | — | rate type check |
| pricing:51 | `Assign` | `stack_id` | environment |

The useful pricing dependency structure is:

```text
coordinates ---------------------------> distance
                                              |
database response -> config -> base fare -----+
                         |                    |
                         +-> configured rate -+----> amount -> returned quote
                         |         \
                         |          \-> cached-rate MAY alternative
                         |
                         +-> configured surge ----+
                                                   \
feature flag -------------------------------> selected surge
```

The precise edge inventory is:

```text
39 total edges
38 data/control edges marked MUST or MAY

Notable MUST edges:
  pricing_response -> parsed pricing
  config.surge -> selected surge
  selected surge -> amount
  distance -> amount
  amount -> returned quote

Notable MAY edges:
  configured rate -> amount
  cached rate -> amount
  rate type check -> cached-rate assignment
```

The graph also carries two function summaries:

```text
pricing.quote
pricing._refresh_rate
```

`_refresh_rate` remains collapsed. It is exposed as a possible durable writer
of the pricing rate, not expanded into statement nodes.

## Step 4: second probe round

Ten probe sites are deployed across the currently expanded gateway and
pricing graph.

The current packet contains twelve value dossiers:

| Location/value | Passing | Failing | Certainty | Judgment |
| --- | --- | --- | --- | --- |
| pricing:52 `stack_id` | `"e2e"` | `"e2e"` | MUST | consistent |
| pricing:60 database response | rate 2.45, base 3.5, surge 1 | same | MUST | consistent |
| pricing:64 `config` | same object | same object | MUST | consistent |
| pricing:65 builtin `float` | unsupported capture | unsupported capture | MAY | consistent |
| pricing:65 builtin `int` | unsupported capture | unsupported capture | MAY | consistent |
| pricing:65 builtin `isinstance` | unsupported capture | unsupported capture | MAY | consistent |
| pricing:65 `rate` | 2.45 | 2.45 | MAY | consistent |
| pricing:73 `rate` | 2.45 | 2.45 | MAY | consistent |
| gateway:52 HTTP response object | 40-byte body | 43-byte body | MUST | suspicious |
| pricing:74 `distance` | 14 | 14 | MUST | consistent |
| pricing:75 `surge` | 1 | 50 | MUST | suspicious |
| pricing:76 `amount` | 37.8 | 1718.5 | MAY | suspicious |

The source node for the surge assignment is line 74. Its probe fires at the
next safe executable line, so its dossier is displayed at line 75. That is why
the action says “inspect line 74” while the captured `surge` row says line 75.

The evidence path is already visually simple:

```text
database config surge = 1 in both runs        GOOD
rate = 2.45 in both runs                      GOOD
distance = 14 in both runs                    GOOD
selected surge: 1 -> 50                       FIRST USEFUL DIVERGENCE
amount: 37.8 -> 1718.5                        DOWNSTREAM DIVERGENCE
gateway response                              DOWNSTREAM DIVERGENCE
```

The deterministic system does not yet reduce this to the five-line table
above before calling the model. It serializes the complete focused graph and
all twelve dossiers.

## Step 5: first LLM call

### Exact logical payload

The first Codex turn receives:

```json
{
  "protocol": "liveprobe-investigation-delta-v1",
  "incident": {
    "symptom": "a rider received an implausibly high quote",
    "failureClass": "semantic"
  },
  "phase": "TRACING",
  "round": 2,
  "graphDelta": {
    "nodes": "<18 structural nodes>",
    "edges": "<39 variable-level edges>",
    "collapsedFunctions": [
      "pricing.quote",
      "pricing._refresh_rate"
    ]
  },
  "currentRoundValueDossiers": "<12 dossiers>",
  "currentRoundJudgments": "<12 judgments>",
  "actions": "<4 legal actions>"
}
```

Graph nodes omit their `source` field. However, each dossier includes
`downstream_uses`, which contains one to five source lines. The packet is
therefore node-source-free, but not completely source-free.

### Representative graph records

```json
{
  "node_id": "py:services/pricing/app.py:quote:45:n:74:13",
  "kind": "Assign:conditional",
  "file": "services/pricing/app.py",
  "line": 74,
  "defs": ["surge"],
  "uses": ["config", "config.surge", "float", "is_active"]
}
```

```json
{
  "source": "py:services/pricing/app.py:quote:45:n:74:13",
  "target": "py:services/pricing/app.py:quote:45:n:75:14",
  "kind": "DATA",
  "variable": "surge",
  "certainty": "MUST"
}
```

### Representative dossiers

```json
{
  "location": "services/pricing/app.py:75",
  "watch_path": "surge",
  "value": {"t": "num", "v": 50},
  "passing_value": {"t": "num", "v": 1},
  "static_certainty": "MUST",
  "capture_status": "complete",
  "downstream_uses": [
    "amount = float(config[\"base_fare\"]) + float(rate) * distance * surge",
    "return {\"quote\": round(amount, 2), ...}"
  ]
}
```

```json
{
  "location": "services/pricing/app.py:76",
  "watch_path": "amount",
  "value": {"t": "num", "v": 1718.5000000000002},
  "passing_value": {"t": "num", "v": 37.800000000000004},
  "static_certainty": "MAY",
  "capture_status": "complete"
}
```

### Legal actions

The model chooses among:

```text
FOLLOW_PATH
  Follow pricing._refresh_rate
  reason: possible durable writer of per_mile_rate

INSPECT_MECHANISM
  gateway HTTP response assignment

INSPECT_MECHANISM
  pricing surge assignment at line 74

INSPECT_MECHANISM
  pricing amount calculation at line 75
```

### Actual payload size

The exact serialized 32,625-byte packet breaks down as:

| Component | Bytes | Share |
| --- | ---: | ---: |
| 18 graph nodes | 6,577 | 20.2% |
| 39 graph edges | 7,263 | 22.3% |
| collapsed function summaries | 756 | 2.3% |
| 12 value dossiers | 12,811 | 39.3% |
| 12 deterministic judgments | 3,289 | 10.1% |
| 4 legal actions | 1,469 | 4.5% |
| incident/protocol/other | about 460 | 1.4% |

The graph itself is roughly 14.6 KB including function summaries. Runtime
dossiers and their repeated judgments are roughly 16.1 KB.

### Actual model result

The model selects:

```text
Inspect mechanism at services/pricing/app.py:74
```

Its rationale in one representative run was:

> The surge assignment is the earliest confirmed causal divergence: surge is
> 50 in the failing replay versus 1 in the matched passing replay, while
> stack_id, config, rate, and distance remain consistent. The anomalous amount
> and gateway response are downstream consequences.

The selection is correct.

The representative turn reported:

```text
input tokens:      21,106
cached input:       8,960
output tokens:        149
model wall time:      6.8 seconds
```

Caching was inconsistent across repetitions. Other repetitions reported no
cached input for the same logical turn.

## Step 6: final hammock reveal

After line 74 is selected, the analyzer changes from structural localization
to mechanism adjudication.

It sends:

```json
{
  "protocol": "liveprobe-final-mechanism-v1",
  "mechanismContext": {
    "anchorNode": "<line 74 node, now including source>",
    "hammock": "<pricing.quote lines 45-80>",
    "relatedDossiers": "<pricing runtime dossiers>"
  },
  "actions": [
    {
      "kind": "VERIFY_MECHANISM",
      "label": "Verify the proposed mechanism"
    }
  ]
}
```

The revealed hammock is currently the entire 35-line `quote` function:

```python
config = response.data[0]
rate = config["per_mile_rate"]
if isinstance(rate, (int, float)):
    ...
else:
    rate = _cached_rate

distance = abs(dest_x - x) + abs(dest_y - y)
surge = 50.0 if is_active("surge_poison") else float(config["surge"])
amount = float(config["base_fare"]) + float(rate) * distance * surge
return {
    "quote": round(amount, 2),
    "distance": distance,
    "surge": surge,
}
```

The exact 11,626-byte final packet contains:

| Component | Bytes | Share |
| --- | ---: | ---: |
| repeated related dossiers | 8,437 | 72.6% |
| complete function hammock | 2,260 | 19.4% |
| selected anchor node | 456 | 3.9% |
| verification action | 354 | 3.0% |
| protocol/other | about 119 | 1.0% |

The surprising fact is that hammock source is not the dominant part of the
final call. Repeated runtime dossiers are.

Because this is a resumed Codex session, the second turn also reprocesses the
first turn's conversation. In the representative run:

```text
new packet bytes:   11,626
input tokens:       46,176
cached input:        8,960
output tokens:         330
model wall time:       6.0 seconds
```

The model explains:

```text
surge_poison selects 50 instead of configured surge 1
rate and distance remain unchanged
3.5 + 2.45 * 14 * 50 = 1718.5
```

It selects the sole `VERIFY_MECHANISM` action.

## Step 7: verification replay

LiveProbe deploys focused verification probes and performs another failing
execution.

No model call is required for completion. The state machine checks that the
selected source location was observed in a new explicitly correlated
execution and then records:

```text
status: LOCALIZED
source: services/pricing/app.py:74
mechanism: surge_poison overrides configured surge with 50
```

Total runtime work for the adaptive investigation is:

```text
round 1:  5 probes, passing + failing replay
round 2: 10 probes, passing + failing replay
round 3: 10 verification probes, failing replay

total deployed probes: 25
model calls:            2
```

## Complete token ledger

For one representative external run:

| Turn | Product packet | Reported input tokens | Purpose |
| --- | ---: | ---: | --- |
| Sole gateway follow | 0 bytes | 0 | deterministic |
| Graph+dossier ranking | 32,623 bytes | 21,106 | choose origin/frontier action |
| Hammock mechanism | 11,626 bytes | 46,176 | explain and request verification |
| Verification replay | 0 bytes | 0 | deterministic |
| **Total** | **44,249 bytes** | **67,282** | |

Across three runs:

```text
mean raw input tokens:        67,271
mean newly processed tokens:  61,297
mean model time:              14.5 seconds
```

The packet is about 44 KB of JSON, not 67,000 tokens. The difference comes
from:

1. Codex's agent instruction and schema envelope;
2. conversation history being processed again on resume;
3. the first graph packet being present in the second turn's context;
4. inconsistent prompt caching.

## What “bloated” means here

“Bloated” does not mean the graph is useless. It means the serialized model
view contains substantially more bytes than the decision requires.

### 1. Variable-level edges repeat long identifiers

The graph has 18 nodes but 39 edges. A source and target identifier such as:

```text
py:services/pricing/app.py:quote:45:n:74:13
```

is repeated on every edge. Separate edges also repeat the same relationship
for `config`, `config.surge`, and other path variants.

This is appropriate analyzer storage but inefficient LLM serialization.

### 2. The largest dossier is an entire HTTP client object

The `pricing_response` dossier alone is 5,428 bytes—42% of all dossier bytes
and about 17% of the complete first packet.

It contains HTTPX internals such as:

```text
headers._list
transport state
stream state
timeout objects
decoder state
private request fields
circular/truncated markers
```

The useful evidence is only:

```text
status = 200 in both runs
parsed quote differs
body length is 40 versus 43 bytes
```

Capturing or serializing the parsed response fields would be dramatically
smaller and more meaningful.

### 3. Builtins become useless value dossiers

At the rate type-check site, LiveProbe tries to capture:

```text
float
int
isinstance
rate
```

The first three serialize as `unsupported` in both executions. Together with
their judgments, they consume space while adding no diagnostic information.

### 4. Consistent evidence is not summarized

The model receives separate full dossiers for:

```text
database response
config object
rate at multiple sites
distance
stack ID
three unsupported builtins
```

Most merely establish:

```text
all upstream pricing inputs except selected surge agree
```

That statement could be generated deterministically.

### 5. Judgments duplicate dossier information

Each dossier is followed by a judgment carrying:

```text
dossier ID
classification
basis
defeasible flag
evidence references
the same “agrees/differs” rationale
```

This costs 3,289 bytes even though the equality result could be embedded as
one compact field in each value row.

### 6. Use-site source snippets repeat

Dossiers include up to five `downstream_uses` strings. The same assignment can
appear multiple times because several variable-path edges reach it.

Thus the graph nodes omit source, but source fragments still enter through
the dossiers.

### 7. The final call resends nearly all evidence

The final packet is 11.6 KB, of which 8.4 KB is related dossiers already
available in the persistent session. The actual hammock is only 2.3 KB.

The delta protocol therefore stops being a true delta at the mechanism stage.

### 8. The “hammock” is still function-sized

For this example the selected statement needs approximately:

```python
distance = ...
surge = ...
amount = ...
return ...
```

The current mechanism context sends the whole 35-line function, including the
database query and cached-rate branch that runtime evidence already
exonerated.

### 9. The model still performs a mechanical earliest-divergence choice

The graph and differential evidence already establish:

```text
config/rate/distance agree
surge first differs
amount and response differ downstream
```

Yet the deterministic layer does not currently collapse that into a witnessed
explanation spine. It asks the model to choose among line 74, line 75, the
gateway boundary, and `_refresh_rate`.

That is better than asking the model to traverse source, but it is not the
maximum reduction the architecture could provide.

## Why replacing hammock traversal did not automatically create an enormous token reduction

The conceptual graph architecture and the current serialization format are
different things.

The architecture changed:

```text
old idea:
  repeatedly show source regions and ask where to move

current idea:
  deterministically build dependency structure,
  capture runtime values,
  ask only at an evidence-rich frontier
```

But the current implementation still sends:

```text
all 18 focused nodes
all 39 variable-level edges
all 12 dossiers
all 12 repeated judgments
all 4 actions
then an entire function
then 8.4 KB of repeated dossiers
```

So it replaced repeated hammock traversal with a large raw graph-state packet,
not yet with a compact causal explanation.

There are also two measurement effects:

1. A resumed Codex agent bills/reports the accumulated conversation again.
2. The old PRAXIS-like and V1 experiments were not the same workload.

The correct conclusion is not “the graph only saves 17%.” The correct
conclusion is:

> We have not yet performed a valid same-bed comparison, and the current graph
> serializer leaves substantial obvious compression and deterministic
> reasoning work unfinished.

## What the packet should eventually look like

For this incident, deterministic processing could reduce the first model view
to something like:

```json
{
  "symptom": "quote 1718.5; matched passing quote 37.8",
  "witnessPath": [
    {"site": "pricing.config.surge", "passing": 1, "failing": 1, "state": "same"},
    {"site": "pricing.rate", "passing": 2.45, "failing": 2.45, "state": "same"},
    {"site": "pricing.distance", "passing": 14, "failing": 14, "state": "same"},
    {"site": "pricing.surge@74", "passing": 1, "failing": 50, "state": "diff"},
    {"site": "pricing.amount@75", "passing": 37.8, "failing": 1718.5, "state": "diff"}
  ],
  "alternatives": [
    {"path": "_refresh_rate", "evidence": "rate agrees", "status": "deprioritized"}
  ],
  "actions": [
    "inspect pricing.surge@74",
    "inspect pricing.amount@75"
  ]
}
```

The final mechanism call could contain:

```python
distance = abs(dest_x - x) + abs(dest_y - y)
surge = 50.0 if is_active("surge_poison") else float(config["surge"])
amount = float(config["base_fare"]) + float(rate) * distance * surge
```

plus four compact value rows. It would not need the HTTPX object, unsupported
builtins, repeated judgments, complete function, or repeated dossiers.

That is the token-reduction target implied by the architecture. It is not yet
the packet implemented by the benchmark.

## Required controls for the future fair comparison

No comparison is run as part of this document. When approved, every method
must use:

```text
same RideRush commit
same gateway manifestation
same hidden surge_poison origin
same passing and failing requests
same real Python probes
same correlation rules
same per-round probe budget
same requirement to verify on a later execution
same model and model settings
same number/order randomization of repetitions
same success criterion: exact source origin plus supported mechanism
```

The methods must remain genuinely distinct:

1. **Current graph+dossier method**
   - compiler/data-flow graph guides expansion;
   - runtime dossiers guide localization;
   - source appears only for final mechanism adjudication.

2. **Prior naive LiveProbe/V1 method**
   - use the earlier probe-selection and model workflow unchanged;
   - do not quietly give it the new graph or differential explanation spine.

3. **PRAXIS-style method**
   - navigate the code using hammock/block hierarchy and source context;
   - do not provide it the compiler dependency graph;
   - allow it to choose traversal direction in the PRAXIS-like manner;
   - deploy the resulting probes into the same runtime harness;
   - require the same final verification.

Only totals from those same-bed runs should be compared.
