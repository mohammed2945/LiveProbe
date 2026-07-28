Absolutely. The easiest way to understand the current system is to stop thinking about compiler terminology and instead think of it as an automated investigation map.

## Big picture, in plain English

A request fails in the payments service while calculating `amount`.

LiveProbe does four broad things:

1. It asks: “What values were used to produce `amount`?”
2. It repeatedly asks the same question about those inputs:
   - Where did `subtotal` come from?
   - Where did `per_mile_rate` come from?
   - Where did `tax_multiplier` come from?
   - Did any of them come from another function, service, database, or configuration store?
3. It chooses a small number of useful locations where observing the real runtime values would divide the remaining possibilities.
4. It runs the application again, collects those values from the same request, and uses the results to decide which direction to continue.

So the static portion does not claim to know where the bug is. It constructs a map of plausible origins.

The probes then reveal which route through that map the failing request actually followed and what values moved along it.

Finally, Codex receives a compact investigation report such as:

> The pricing value was normal. The adjustment value was already malformed immediately after reading external runtime configuration. Payments used that malformed value correctly according to its current code. Investigate the configuration producer or stored value.

The analyzer performs the mechanical tracing. The probes collect facts. Codex interprets those facts and decides what the finding means operationally.

---

# The concrete RideRush example

Here is the simplified payments code involved in the real test:

```python
pricing_response = await pricing_client.get(...)
adjustment_response = await config_client.get(...)

pricing = pricing_response.json()
adjustments = adjustment_response.json()

fare_inputs = FareInputs(
    base_fare=pricing["base_fare"],
    per_mile_rate=pricing["per_mile_rate"],
    tax_multiplier=adjustments["tax_multiplier"],
    partner_discount=adjustments["partner_discount"],
)

subtotal = (
    fare_inputs.base_fare
    + fare_inputs.per_mile_rate * request.distance * request.surge
)

amount = (
    subtotal
    * fare_inputs.tax_multiplier
    - fare_inputs.partner_discount
)
```

The failure occurs while calculating `amount`.

For the failing request, the important runtime values are:

```text
request.distance                 = 8
request.surge                    = 1.0

pricing.base_fare                = 3.5
pricing.per_mile_rate            = 2.45

adjustments.tax_multiplier       = "US-CA:1.0825"
adjustments.partner_discount     = 0
```

The problem is that `tax_multiplier` is a string containing both a region and a number. The calculation expected something numeric such as:

```text
1.0825
```

That causes:

```python
23.1 * "US-CA:1.0825"
```

to fail.

Now let’s walk through every step that leads LiveProbe to that conclusion.

---

# Phase 1: Codex identifies the starting question

## Step 1: The incident supplies a manifestation location

The incident identifies:

```text
Service: payments
File: services/payments/app.py
Line: 65
Observed failure: TypeError
Relevant expression: amount calculation
Value to investigate: amount
```

The important starting pair is:

```text
program location = payments/app.py:65
tracked value    = amount
```

This is called the analysis criterion internally, but it simply means:

> Begin at this line, and explain where the value named `amount` came from.

Currently, LiveProbe does not autonomously infer `amount` from an arbitrary incident report in every case. Codex or another incident-processing layer supplies the starting file, line, and value.

That is a reasonable division:

- Codex interprets stack traces, exceptions, symptoms, and user intent.
- The analyzer performs exact mechanical dependency tracing once given a starting point.

For example, Codex might convert this:

```text
TypeError at payments/app.py:65:
can't multiply sequence by non-int of type 'float'
```

into:

```json
{
  "service": "payments",
  "file": "services/payments/app.py",
  "line": 65,
  "value": "amount"
}
```

---

# Phase 2: The repository is prepared

## Step 2: LiveProbe pins the exact code version

The request includes a Git commit:

```text
c67ee35026aa12fe8a0335761c606355a695554c
```

The analyzer uses that exact commit rather than whatever files happen to be currently checked out.

This matters because the running payments service may be executing yesterday’s deployment while a developer’s working tree already contains newer code.

The preparation layer:

1. Checks that the commit exists.
2. Reads Python files from that commit.
3. Hashes their contents.
4. Reuses previously analyzed files whose contents have not changed.
5. Parses only new or changed files.

The cache is based primarily on file contents, not merely the commit ID. If the same Python file exists unchanged across ten commits, its local analysis can be reused.

This is where most of the reusable work happens. It is not placing probes or investigating a particular failure yet.

---

# Phase 3: Each relevant Python function is mechanically understood

## Step 3: The analyzer reads the function containing line 65

It parses the Python syntax tree and identifies the containing function.

Conceptually, it turns:

```python
subtotal = ...
amount = subtotal * fare_inputs.tax_multiplier
return {"amount": amount}
```

into statement records similar to:

```json
[
  {
    "id": "payments.calculate_fare:subtotal_assignment",
    "line": 60,
    "defines": ["subtotal"],
    "uses": [
      "fare_inputs.base_fare",
      "fare_inputs.per_mile_rate",
      "request.distance",
      "request.surge"
    ]
  },
  {
    "id": "payments.calculate_fare:amount_assignment",
    "line": 65,
    "defines": ["amount"],
    "uses": [
      "subtotal",
      "fare_inputs.tax_multiplier",
      "fare_inputs.partner_discount"
    ]
  },
  {
    "id": "payments.calculate_fare:return",
    "line": 70,
    "defines": [],
    "uses": ["amount"]
  }
]
```

These records answer two basic questions for every statement:

- What values does this statement create or modify?
- What existing values does it read?

This is deterministic Python analysis. No LLM is involved.

---

## Step 4: It records execution order and branching

The analyzer also builds a control-flow map.

For straightforward code:

```text
read pricing
    ↓
read adjustments
    ↓
parse responses
    ↓
construct fare_inputs
    ↓
calculate subtotal
    ↓
calculate amount
```

For a branch:

```python
if request.region == "US":
    tax = us_tax
else:
    tax = international_tax

amount = subtotal * tax
```

the map looks like:

```text
                    ┌─ true  → tax = us_tax ───────────┐
region comparison ──┤                                  ├─→ amount
                    └─ false → tax = international_tax ┘
```

This tells the analyzer which assignments could reach a later use.

It also allows it to include relevant conditions. If `tax` is wrong, the selected branch may be just as important as the assignment that created `tax`.

Again, this is mechanical and does not involve Codex.

---

## Step 5: It connects uses to possible definitions

Consider:

```python
tax = default_tax

if request.region == "US":
    tax = us_tax

amount = subtotal * tax
```

At the `amount` calculation, `tax` may have come from either assignment:

```text
default_tax assignment ── MAY ──→ use of tax
us_tax assignment      ── MAY ──→ use of tax
```

Neither possibility can be discarded without knowing whether the condition was true for this execution.

In simple straight-line code:

```python
subtotal = calculate_subtotal(...)
amount = subtotal * tax
```

the relationship is stronger:

```text
subtotal assignment ── MUST ──→ use of subtotal
```

Here “MUST” does not mean the value is definitely buggy. It means this definition is the unambiguous local producer of the value used at that point.

“MAY” means multiple producers or memory objects could conservatively be responsible.

The probes later reveal which MAY relationship was actually exercised.

---

## Step 6: It records function calls and returns

Suppose the code were:

```python
subtotal = calculate_subtotal(fare_inputs, request)
amount = calculate_amount(subtotal, fare_inputs.tax_multiplier)
```

The analyzer records:

```text
caller argument fare_inputs
        ↓
callee parameter fare_inputs
        ↓
callee statements
        ↓
callee return value
        ↓
caller variable subtotal
```

This is what allows investigation to leave the current function.

It does not first expand every function in the repository into one enormous detailed graph. Instead:

1. The current function is already summarized.
2. The analyzer sees that a tracked value came from a call.
3. It resolves possible call targets.
4. It loads the cached summary for those target functions.
5. It expands only the relevant parameter-to-return relationships.
6. Unrelated parts of the target function are excluded from the incident result.

For example:

```python
def calculate_subtotal(fare_inputs, request):
    audit_request(request.user_id)
    emit_metric("fare_calculation")
    return (
        fare_inputs.base_fare
        + fare_inputs.per_mile_rate * request.distance
    )
```

If the tracked result is the return value, the analyzer follows:

```text
fare_inputs.base_fare
fare_inputs.per_mile_rate
request.distance
```

It does not need to continue through `audit_request()` merely because that call appears in the same function. That call did not contribute to the returned subtotal.

---

# Phase 4: The analyzer walks backward from `amount`

## Step 7: It starts at the `amount` definition

The target statement is conceptually:

```python
amount = subtotal * fare_inputs.tax_multiplier \
         - fare_inputs.partner_discount
```

The analyzer records:

```text
amount depends on:
    subtotal
    fare_inputs.tax_multiplier
    fare_inputs.partner_discount
```

It places those three values onto a work queue.

Conceptually:

```text
Work queue:
1. Where did subtotal come from?
2. Where did fare_inputs.tax_multiplier come from?
3. Where did fare_inputs.partner_discount come from?
```

This is the core backward traversal algorithm.

In simplified pseudocode:

```python
queue = [amount_at_line_65]
visited = set()

while queue is not empty:
    current_value = queue.pop()

    if current_value was already examined:
        continue

    find statements that could produce current_value

    for each producing statement:
        add dependency relationship
        add values read by that statement to queue
```

There is no LLM choosing the next statement. The graph relationships determine it.

---

## Step 8: It follows `subtotal`

The analyzer finds:

```python
subtotal = (
    fare_inputs.base_fare
    + fare_inputs.per_mile_rate * request.distance * request.surge
)
```

It records:

```text
subtotal depends on:
    fare_inputs.base_fare
    fare_inputs.per_mile_rate
    request.distance
    request.surge
```

These inputs are added to the work queue.

The current dependency map now resembles:

```text
amount
├── subtotal
│   ├── fare_inputs.base_fare
│   ├── fare_inputs.per_mile_rate
│   ├── request.distance
│   └── request.surge
├── fare_inputs.tax_multiplier
└── fare_inputs.partner_discount
```

---

## Step 9: It follows the fields of `fare_inputs`

The analyzer finds where `fare_inputs` was constructed:

```python
fare_inputs = FareInputs(
    base_fare=pricing["base_fare"],
    per_mile_rate=pricing["per_mile_rate"],
    tax_multiplier=adjustments["tax_multiplier"],
    partner_discount=adjustments["partner_discount"],
)
```

Now it can connect individual fields:

```text
fare_inputs.base_fare
    ← pricing["base_fare"]

fare_inputs.per_mile_rate
    ← pricing["per_mile_rate"]

fare_inputs.tax_multiplier
    ← adjustments["tax_multiplier"]

fare_inputs.partner_discount
    ← adjustments["partner_discount"]
```

This is important. It is not merely tracking the variable `fare_inputs` as one opaque object. It preserves useful field paths where the syntax allows it.

The map becomes:

```text
amount
├── subtotal
│   ├── fare_inputs.base_fare
│   │   └── pricing["base_fare"]
│   ├── fare_inputs.per_mile_rate
│   │   └── pricing["per_mile_rate"]
│   ├── request.distance
│   └── request.surge
├── fare_inputs.tax_multiplier
│   └── adjustments["tax_multiplier"]
└── fare_inputs.partner_discount
    └── adjustments["partner_discount"]
```

---

## Step 10: It follows `pricing` and `adjustments`

It finds:

```python
pricing = pricing_response.json()
adjustments = adjustment_response.json()
```

Therefore:

```text
pricing fields
    ← pricing
    ← pricing_response
    ← result of pricing HTTP request

adjustment fields
    ← adjustments
    ← adjustment_response
    ← result of runtime-config HTTP request
```

The map now reaches the boundaries of the payments service:

```text
pricing service response
    ↓
pricing_response
    ↓
pricing
    ↓
fare_inputs.base_fare / per_mile_rate
    ↓
subtotal
    ↓
amount

runtime-config response
    ↓
adjustment_response
    ↓
adjustments
    ↓
fare_inputs.tax_multiplier / partner_discount
    ↓
amount
```

This already tells LiveProbe that two external inputs could be relevant:

- Pricing configuration.
- Runtime adjustment configuration.

But static code alone cannot tell which response was malformed during the failing request.

That is precisely why probes are needed.

---

# Phase 5: Crossing boundaries

## Step 11: It recognizes known communication operations

The analyzer recognizes patterns such as:

```python
await http_client.get("http://pricing/...")
await http_client.get("http://config/...")
database.execute(...)
redis.get(...)
queue.publish(...)
```

For each recognized operation, it creates a boundary record:

```json
{
  "kind": "http_read",
  "source_service": "payments",
  "target_service": "pricing",
  "result": "pricing_response"
}
```

or:

```json
{
  "kind": "durable_read",
  "service": "payments",
  "resource": "fare_runtime_config",
  "result": "adjustment_response"
}
```

When another function is known to write the same logical resource, the analyzer can conservatively connect them:

```text
pricing._refresh_rate
    writes pricing_config.per_mile_rate

payments.calculate_fare
    reads pricing_config.per_mile_rate
```

Therefore:

```text
pricing._refresh_rate ── MAY ──→ payments pricing read
```

This is a possible producer relationship, not proof that:

- this writer created the currently observed value;
- it ran for this request;
- it ran recently;
- no other writer exists.

That is why it is labelled MAY and generally ranked behind a direct observation of the payments-side response.

---

## Step 12: It does not blindly traverse an entire second service

When a boundary is encountered, LiveProbe has choices:

1. Observe the receiving value first.
2. Continue into a known local call immediately.
3. Expand a remote producer if the receiving value proves malformed.
4. Return an exoneration/value contract to the AI SRE if ownership belongs elsewhere.

For this incident, observing this is highly informative:

```python
adjustment_response = await config_client.get(...)
```

If the value is already malformed immediately after this operation, there is little reason to inspect all the payments transformations first. Payments received bad data.

The next investigation can begin in the producer with a precise contract:

```text
Resource: fare_runtime_config
Field: tax_multiplier
Observed value: "US-CA:1.0825"
Expected property: numeric
Consumer: payments
Trace/replay: ride-e2e-1
```

This is much better than asking Codex to “inspect the config service for anything suspicious.”

---

# Phase 6: Grouping statements into readable regions

## Step 13: The statements are grouped into hammock blocks

Now we can introduce the compiler term.

A hammock is a bounded region of code with a clear entry and exit. The current implementation uses conservative AST-based regions, approximately function/body-level regions. It is not yet a mathematically complete SESE decomposition of every control-flow structure.

For this example, the regions resemble:

```text
Hammock A: acquire external inputs
    pricing_response = ...
    adjustment_response = ...

Hammock B: normalize/build fare inputs
    pricing = ...
    adjustments = ...
    fare_inputs = ...

Hammock C: calculate fare
    subtotal = ...
    amount = ...
```

Why do this?

Because neither Codex nor a human wants eleven disconnected statement IDs. A candidate should arrive with enough neighboring code to understand what that location does.

A candidate might therefore mean:

```text
Investigate Hammock A at the adjustment-response boundary.
Watch adjustment_response and its decoded body.
```

rather than merely:

```text
Probe line 49.
```

The region is a presentation and reasoning unit. The actual probe is still attached to a concrete executable line.

---

# Phase 7: Selecting the first probes

## Step 14: The analyzer scores candidate locations

The original map contained:

```text
7 functions
11 relevant statement nodes
28 dependency relationships
3 hammock regions
6 initial candidates
```

A candidate contains data similar to:

```json
{
  "id": "candidate-payments-adjustments",
  "file": "services/payments/app.py",
  "line": 54,
  "function": "calculate_fare",
  "hammock": "input-normalization-block",
  "watch": [
    "adjustments",
    "adjustments.tax_multiplier",
    "adjustments.partner_discount"
  ],
  "distance_from_failure": 3,
  "certainty": "MUST",
  "reason": "Direct producer of fields consumed by amount",
  "upstream_weight": 6.8
}
```

The fields mean:

- `file` and `line`: where to install the probe.
- `function`: which function owns the location.
- `hammock`: the surrounding readable code region.
- `watch`: values to capture.
- `distance_from_failure`: how many dependency steps separate it from the manifestation.
- `certainty`: whether it is an unambiguous local dependency or only a conservative possibility.
- `reason`: why observing it would help.
- `upstream_weight`: an estimate of how much unexplored territory this observation can eliminate.

The initial real frontier was approximately:

```text
1. pricing.py:97
   Watch the possible per-mile-rate writer.
   Relationship: MAY

2. payments.py:65
   Watch subtotal before the final calculation.
   Relationship: MUST

3. payments.py:63
   Watch fare_inputs.
   Relationship: MUST

4. payments.py:53
   Watch pricing.
   Relationship: MUST

5. payments.py:54
   Watch adjustments.
   Relationship: MUST

6. payments.py:41
   Watch pricing_response.
   Relationship: MAY/boundary
```

This frontier covers multiple useful levels:

```text
remote writer
external responses
decoded structures
combined input object
last valid intermediate value
failure
```

It is not simply “probe every line.”

---

## Step 15: Why the probe line can appear after the assignment

Python’s runtime monitoring event occurs before the selected line executes.

Suppose we want to observe `fare_inputs` created here:

```python
54: fare_inputs = FareInputs(...)
55:
56: subtotal = ...
```

A probe placed at line 54 may execute before `fare_inputs` has been assigned.

Therefore the analyzer finds a safe successor line:

```text
Definition location: line 54
Probe location:      line 56
```

At line 56, the new `fare_inputs` value exists.

This distinction is stored so the report can still say:

> This candidate represents the definition at line 54, observed immediately afterward at line 56.

---

# Phase 8: Deploying probes

## Step 16: The MCP server translates candidates into runtime probes

Codex calls the LiveProbe MCP tool with the selected candidate IDs.

The MCP server creates probes containing metadata such as:

```json
{
  "investigationId": "ride-e2e-1",
  "candidateId": "candidate-payments-adjustments",
  "round": 1,
  "service": "payments",
  "file": "services/payments/app.py",
  "line": 54,
  "expressions": [
    "adjustments",
    "adjustments.get('tax_multiplier')",
    "adjustments.get('partner_discount')"
  ]
}
```

The responsibilities are separated:

- Analyzer: recommends meaningful observation points.
- MCP server: converts recommendations into concrete probe operations.
- Broker: distributes probes and receives events.
- Python SDK/runtime: evaluates expressions when execution reaches the location.

No LLM is required to construct these runtime probe objects.

---

# Phase 9: Running and correlating the failing request

## Step 17: A controlled replay is sent

The test sends:

```json
{
  "ride_id": "ride-e2e-1",
  "distance": 8,
  "surge": 1.0
}
```

It also supplies correlation context.

Conceptually:

```text
trace_id:              ride-e2e-1
correlation source:    controlled_replay
correlation quality:   exact_execution
service instance:      payments-instance-1
local hit sequence:    1, 2, 3, ...
```

The Python SDK propagates this context across supported HTTP calls.

Consequently, values captured in pricing and payments can be grouped as evidence from the same logical request, rather than merely values observed around the same time.

That distinction is essential.

Without correlation:

```text
pricing probe saw 2.45 at 10:00:01
payments probe saw a bad value at 10:00:01
```

Those might belong to different users.

With correlation:

```text
pricing probe saw 2.45 for trace ride-e2e-1
payments received it for trace ride-e2e-1
```

Now the evidence can support a causal investigation.

---

# Phase 10: What each probe captures

## Step 18: The runtime serializes typed values

A probe does not merely convert everything to display strings.

It records typed structures similar to:

```json
{
  "t": "object",
  "v": {
    "base_fare": {
      "t": "num",
      "v": 3.5
    },
    "per_mile_rate": {
      "t": "num",
      "v": 2.45
    }
  }
}
```

The adjustment capture looks conceptually like:

```json
{
  "t": "object",
  "v": {
    "tax_multiplier": {
      "t": "str",
      "v": "US-CA:1.0825"
    },
    "partner_discount": {
      "t": "num",
      "v": 0
    }
  }
}
```

Preserving the type lets the investigator distinguish:

```text
1.0825                  number
"1.0825"                numeric-looking string
"US-CA:1.0825"          malformed compound string
null                    null
missing                 field absent
serialization failure   probe could not inspect value
```

These are operationally very different findings.

---

## Step 19: The actual values appear along the path

For the replay, the evidence is approximately:

```text
Pricing response:
{
  base_fare: 3.5,
  per_mile_rate: 2.45
}

Adjustment response:
{
  tax_multiplier: "US-CA:1.0825",
  partner_discount: 0
}

FareInputs:
{
  base_fare: 3.5,
  per_mile_rate: 2.45,
  tax_multiplier: "US-CA:1.0825",
  partner_discount: 0
}

Subtotal:
23.1

Amount:
not successfully produced
```

The subtotal calculation is valid:

```text
3.5 + 2.45 × 8 × 1.0
= 3.5 + 19.6
= 23.1
```

The final calculation attempts:

```text
23.1 × "US-CA:1.0825" - 0
```

and raises a `TypeError`.

---

# Phase 11: Interpreting “good,” “bad,” and “unknown”

## Step 20: Evidence is assessed against a property

“Good” does not mean:

> This entire statement or service is correct.

It means:

> The captured value does not exhibit the offending property currently being investigated.

For this incident, the relevant property is approximately:

```text
tax_multiplier must be numeric before the amount calculation
```

The assessments become:

```text
pricing.per_mile_rate = 2.45
Assessment: GOOD
Reason: numeric and valid for the relevant contract

subtotal = 23.1
Assessment: GOOD
Reason: successfully calculated numeric intermediate

adjustments.tax_multiplier = "US-CA:1.0825"
Assessment: BAD
Reason: string where numeric multiplier is required

fare_inputs.tax_multiplier = "US-CA:1.0825"
Assessment: BAD
Reason: malformed value has propagated into fare construction

pricing._refresh_rate writer
Assessment: UNKNOWN
Reason: candidate existed statically but did not execute in this replay
```

The current implementation does not possess a universal oracle that understands every possible application invariant.

For this E2E test, the numeric contract is explicit. In broader production use, a property can come from:

- the exception itself;
- a schema;
- a type contract;
- an assertion or invariant;
- a passing-versus-failing comparison;
- an API contract;
- user-supplied expectations;
- finally, Codex interpreting a bounded context.

This is one of the remaining product challenges. Runtime capture tells us what happened; determining whether every arbitrary intermediate value is semantically correct is not always automatic.

---

# Phase 12: Refining the investigation

## Step 21: Evidence is returned to the analyzer

The MCP server groups events by exact correlation identity and sends assessments similar to:

```json
[
  {
    "candidateId": "payments-pricing",
    "status": "good",
    "observed": {
      "base_fare": 3.5,
      "per_mile_rate": 2.45
    }
  },
  {
    "candidateId": "payments-adjustments",
    "status": "bad",
    "observed": {
      "tax_multiplier": "US-CA:1.0825",
      "partner_discount": 0
    }
  },
  {
    "candidateId": "payments-subtotal",
    "status": "good",
    "observed": 23.1
  },
  {
    "candidateId": "pricing-writer",
    "status": "unknown",
    "reason": "not observed during correlated execution"
  }
]
```

The analyzer then prunes the investigation map.

If pricing is good, branches that only explain a malformed pricing value receive lower priority.

If adjustment data is bad, all paths upstream of that value remain relevant.

If subtotal is good, its pricing inputs are less likely to explain this particular type failure.

Conceptually:

```text
Before evidence:

pricing writer ───────────────┐
pricing response ─────────────┤
                              ├─→ amount failure
runtime config response ──────┤
request inputs ───────────────┘


After evidence:

pricing writer ───────── good / deprioritized
pricing response ─────── good / deprioritized
request inputs ───────── good / deprioritized

runtime config response ─ bad / continue upstream
```

---

## Step 22: A second-round probe is selected

The important remaining question becomes:

> Did payments corrupt the adjustment value after receiving it, or was it already malformed at the boundary?

The next candidate is immediately after:

```python
adjustment_response = await config_client.get(...)
```

This captures the response before the later `FareInputs` construction.

The result is already:

```json
{
  "tax_multiplier": "US-CA:1.0825",
  "partner_discount": 0
}
```

Therefore:

```text
external read
    produced malformed value
        ↓
payments decoded it
        ↓
payments copied it into FareInputs
        ↓
amount calculation failed
```

The earliest observed bad point inside payments is its external input boundary.

---

# Phase 13: What is presented to Codex

## Step 23: Codex receives a bounded investigation artifact

Codex does not need to read the complete repository or every raw runtime event.

It receives something closer to:

```json
{
  "incident": {
    "service": "payments",
    "manifestation": "services/payments/app.py:65",
    "trackedValue": "amount",
    "error": "TypeError during multiplication"
  },
  "correlation": {
    "traceId": "ride-e2e-1",
    "quality": "exact_execution"
  },
  "observedPath": [
    {
      "location": "pricing response",
      "value": {
        "base_fare": 3.5,
        "per_mile_rate": 2.45
      },
      "assessment": "good"
    },
    {
      "location": "runtime-config response",
      "value": {
        "tax_multiplier": "US-CA:1.0825",
        "partner_discount": 0
      },
      "assessment": "bad"
    },
    {
      "location": "FareInputs construction",
      "value": {
        "tax_multiplier": "US-CA:1.0825"
      },
      "assessment": "bad"
    },
    {
      "location": "subtotal calculation",
      "value": 23.1,
      "assessment": "good"
    }
  ],
  "remainingExplanation": {
    "boundary": "fare_runtime_config read",
    "contract": "tax_multiplier must be numeric",
    "observed": "US-CA:1.0825"
  },
  "suggestedVerdict": "EXONERATED"
}
```

The accompanying hammock context might show only:

```python
adjustment_response = await config_client.get(...)
adjustments = adjustment_response.json()

fare_inputs = FareInputs(
    ...
    tax_multiplier=adjustments["tax_multiplier"],
)
```

Codex now performs the semantic judgment:

- Did payments create the malformed value?
- Did it merely receive and propagate it?
- Is the responsible object code, configuration, data, or another service?
- What should be inspected next?
- What is the safest verification plan?

For this case, the result is:

```text
EXONERATED: Payments is the manifestation service and victim.

Mechanism:
Payments received a string-valued tax multiplier from fare_runtime_config
and used it in a numeric calculation.

Handback contract:
Investigate the producer or stored state for fare_runtime_config.tax_multiplier.
Expected numeric; observed "US-CA:1.0825" for replay ride-e2e-1.

Verification:
Correct the stored value or producer serialization, replay the same request,
and verify that amount is calculated successfully.
```

“Exonerated” does not mean payments could never be hardened. It could validate the input and return a better error. It means the value corruption did not originate in the payments code examined during this investigation.

---

# Exactly where deterministic code and the LLM participate

| Operation | Owner | Why |
|---|---|---|
| Interpret incident and select initial value/location | Codex/incident layer | Requires understanding symptom meaning |
| Pin commit and read repository | Deterministic analyzer | Exact mechanical operation |
| Parse Python | Deterministic analyzer | Compiler operation |
| Find definitions and uses | Deterministic analyzer | Compiler operation |
| Build control-flow relationships | Deterministic analyzer | Compiler operation |
| Resolve local calls and returns | Deterministic analyzer | Mechanical when resolvable |
| Recognize HTTP/durable access patterns | Deterministic analyzer | Pattern and framework adapters |
| Walk dependencies backward | Deterministic analyzer | Graph traversal |
| Group code into hammocks | Deterministic analyzer | Structural code operation |
| Score initial candidates | Deterministic analyzer | Fixed heuristic |
| Optionally rerank a large frontier | One bounded LLM call | Only when it can materially reduce probes |
| Install probes | MCP server/broker | Runtime operation |
| Capture values | Language SDK | Runtime operation |
| Correlate observations | SDK/broker | Trace/replay identifiers |
| Apply explicit type/schema invariant | Deterministic | Contract is known |
| Judge ambiguous semantic correctness | Codex | No general mechanical oracle |
| Prune graph from good/bad evidence | Deterministic analyzer | Evidence-guided graph operation |
| Explain mechanism and ownership | Codex | Semantic and operational judgment |
| Select verification/mitigation | Codex/AI SRE | Requires incident reasoning |

The intended rule is:

> Deterministic code handles everything that follows from program structure or exact runtime identity. Codex handles ambiguity, semantic intent, ownership, and operational decisions.

---

# When the optional LLM frontier-ranking call happens

It should not happen during every graph step or at every MAY relationship.

That would be slow, expensive, and inconsistent.

The sensible policy is:

```text
If deterministic frontier fits within safe probe budget:
    deploy it directly

Else if one ranking call is likely to remove enough probes:
    send the complete bounded frontier to Codex once
    ask it to select the most discriminating candidates

Else:
    use deterministic ranking and investigate in rounds
```

For example:

```text
6 candidates, budget 8
→ no LLM ranking needed

40 candidates, budget 8
→ one ranking call may be worthwhile

12 candidates, budget 8, top 8 dominate structurally
→ deterministic ranking is probably enough
```

The LLM sees candidate summaries and hammock contexts together. It does not get called separately while traversing every node.

That preserves the useful division:

```text
Analyzer creates a complete conservative map.
Deterministic ranking produces a strong default frontier.
One optional LLM call can improve a genuinely ambiguous large frontier.
Runtime evidence decides what actually happened.
Codex interprets the final bounded evidence.
```

---

# What “backward slice” means after seeing the example

Now the compiler term should be less mysterious.

For this incident, the backward slice is simply the selected portion of the program dependency graph that can affect `amount` at line 65.

It consists of:

### Statement nodes

Examples:

```text
amount assignment
subtotal assignment
FareInputs construction
pricing decoding
adjustment decoding
pricing HTTP read
runtime-config HTTP read
possible pricing writer
```

### Value-dependency edges

Examples:

```text
subtotal → amount
fare_inputs.tax_multiplier → amount
adjustments.tax_multiplier → fare_inputs.tax_multiplier
adjustment_response → adjustments
```

### Control-dependency edges

For example, if a region or flag determines which tax value is selected:

```text
request.region == "US"
    ↓ controls
tax_multiplier assignment
```

### Function-boundary edges

Examples:

```text
caller argument → callee parameter
callee return → caller variable
```

### Conservative memory edges

Examples:

```text
possible write to config["per_mile_rate"]
    ── MAY ──→
later read of config["per_mile_rate"]
```

### Service/resource-boundary edges

Examples:

```text
pricing writer
    ── MAY via pricing_config ──→
payments pricing read
```

### Hammock membership

Examples:

```text
response acquisition statements ∈ Hammock A
normalization statements         ∈ Hammock B
fare calculation statements      ∈ Hammock C
```

So the backward slice is not a runtime trace and is not itself a set of probes.

It is the conservative static investigation map from which probe candidates are selected.

---

# The most important current limitations

To keep the picture honest:

1. **Starting-value selection is not universally automatic.**
   Codex currently supplies something like `amount at line 65`.

2. **The Python analysis is useful but not equivalent to CodeQL’s mature whole-program analysis.**
   Dynamic dispatch, reflection, generated code, monkey-patching, and unusual framework behavior can produce unresolved edges.

3. **Memory analysis is conservative and lightweight.**
   It uses shared roots and recognizable field/resource relationships, not a heavyweight whole-program points-to solver.

4. **Cross-service connections require recognizable boundaries.**
   HTTP routes, durable-resource names, trace metadata, or explicit adapters provide these connections. Arbitrary external semantics cannot be inferred perfectly from syntax.

5. **The general good/bad oracle remains an open product layer.**
   Explicit schemas, exceptions, differential runs, and invariants work well. Arbitrary business correctness may require Codex.

6. **Hammocks are currently practical AST regions.**
   True SESE hammock decomposition would make complex branching and loops more precise.

7. **Automatic LLM frontier ranking is experimental.**
   The implemented policy exists, but the ordinary MCP flow does not yet invoke it automatically.

Those limitations do not invalidate the architecture. They establish where the deterministic engine ends and where evidence contracts, framework adapters, and Codex reasoning begin.

The essential flow is:

```text
Failure
  ↓
Choose the bad output or suspicious value
  ↓
Mechanically trace possible origins through code
  ↓
Choose high-information observation points
  ↓
Run one correlated execution
  ↓
Observe real values
  ↓
Discard explanations inconsistent with those values
  ↓
Move observation closer to the earliest known bad boundary
  ↓
Give Codex a compact, evidence-backed mechanism and ownership boundary
```

That is the complete investigation loop the current implementation is beginning to provide.
