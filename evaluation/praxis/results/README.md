# PRAXIS × LiveProbe evaluation results

Campaign `r10`, run 2026-07-29 on the Linux evaluation VM. Report SHA inputs:
`9238be3bc2dbfff3`; generated report sha256
`c2492bb79f7c5ae574b5224d81c34e5753103f84026b02a8b0d0a1445df0fc91`.

Model `gpt-5.4`, reasoning effort `low`, incident `401`, seed `10`, one run per
arm, hard cap 50,000 rollout-weighted tokens per arm, three-minute coding-agent
wall limit.

## Headline

**`n=1`. This is a pipeline and directional result only, not a statistically
meaningful benchmark.**

All four arms scored `Combined@1 = 0.0%`. That number is real and is reported
unchanged — the scorer was **not** modified after seeing results. But taken
alone it is misleading in both directions, so three findings must be read with
it:

1. **Three arms were substantively correct and the scorer could not credit
   them.** A representation mismatch, not a reasoning failure, produced the
   zeros. See [Scorer granularity mismatch](#scorer-granularity-mismatch).
2. **Incident 401 does not discriminate between arms.** Its logs contain the
   complete Python stack trace naming the file, line, function, expression and
   missing attribute. Any arm that reads logs gets the answer. LiveProbe's
   differentiating capability is unnecessary here.
3. **No arm produced a correlated probe occurrence.** `Correlated occurrences`
   is `0` across the board. The central LiveProbe claim — a probe value
   correlated to the replay occurrence — was **not exercised** in this run.

Ground truth, confirmed by reading the injected source
(`.eval-cache/praxis-sources/401/recommendation_server.py:96`):

```python
product_ids = [x.id for x in cat_response.products_list]
```

`ListProductsResponse` has no attribute `products_list`, so the non-cache
branch raises `AttributeError` before recommendations are computed.

## Four-arm leaderboard

| Arm | Runs | RCI@1 | RCL@1 | RCR@1 | Terminal | Evidence-backed | Combined@1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Normal coding SRE | 1 | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% | 0.0% |
| PRAXIS (fair adapter) | 1 | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% | 0.0% |
| Graph + LiveProbe | 1 | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% | 0.0% |
| Raw LiveProbe | 1 | 0.0% | 0.0% | 0.0% | 100.0% | 100.0% | 0.0% |

RCI is root-cause identity, RCL adds location, RCR requires the official
propagation path, and Combined@1 requires all checks. Zero failures, zero
timeouts; every arm returned a well-formed, evidence-backed `LOCALIZED`
diagnosis within budget.

### Per-arm manual inspection

Each answer was read against ground truth by hand. Verdicts are substantive,
independent of the scorer.

| Arm | Answer given | Substantive verdict | Weighted tokens | Wall |
| --- | --- | --- | ---: | ---: |
| Normal coding SRE | `recommendation` / `recommendation_server.py:96` `get_product_list` | **Correct** — exact faulty line | 25,614 | 52.81 s |
| Graph + LiveProbe | `recommendation_server.py:96` `get_product_list` | **Correct**, but arm is **contaminated** (see below) | 31,630 | 64.23 s |
| Raw LiveProbe | `recommendation_server.py:96` `get_product_list` | **Correct** — exact faulty line | 37,656 | 51.94 s |
| PRAXIS (fair adapter) | `product-catalog`, service-level, no file/line | **Wrong** — blamed the callee | 40,034 | 95.31 s |

**Normal coding SRE (no LiveProbe).** Correct, cheapest, and second fastest. It
used six observability calls and no probes. This is the most important negative
result in the run: the arm with the fewest capabilities matched both LiveProbe
arms while spending the least.

**Graph + LiveProbe — contaminated, do not count as a LiveProbe arm.** Its only
LiveProbe call, `list_services`, returned `status: "failed"` in the ledger
(`isError`/JSON-RPC error, not a legal-action rejection — the graph profile
passes tools through unfiltered). It deployed **zero probes** and reached its
answer from observability alone. The pre-arm `waitForLiveProbeService` gate
passed, and the call reproduces successfully against the live broker after the
run, so the failure was **transient** — a residual broker-restart race inside
the arm window that the pre-arm readiness gate does not cover. It spent 23%
more weighted tokens than the baseline for the same answer and delivered no
LiveProbe value.

**Raw LiveProbe.** The only arm that genuinely exercised LiveProbe: full
lifecycle `set_snapshot_probe` → `list_probes` → `get_probe_data`
(25,955 bytes) → `remove_probe`, plus one replay and two watches. But
`Correlated occurrences = 0` and `Evidence collections = 0`, so the probe data
was never correlated to a replay occurrence; its diagnosis still rests on the
stack trace. Most expensive of the three correct arms.

**PRAXIS (fair adapter).** The only substantively wrong answer. It named
`product-catalog` — the *callee*, which returned a valid response — and never
descended to code level, returning no file, line, or function. Slowest
(95.31 s wall) and most weighted tokens (40,034). This is a genuine PRAXIS
miss, independent of the scorer issue, and is the one directional signal in
this run that favors the code-level approach. It remains `n=1`.

### Scorer granularity mismatch

Verified in `evaluation/praxis/src/core.mjs:782-809`, not inferred:

- `rci` requires the `entity` **and** `kind` strings to match the oracle. The
  401 oracle accepts only `entity=recommendation`, `kind=Service`.
- All three coding arms returned `kind: "code"`. The only widenings are
  `serviceboundary`→`service` and `deploymentconfiguration`→`deployment`, so
  `code` can never pass.
- All three set `service: "recommendation"`, which **does** canonicalize to the
  oracle entity — but `rci` never consults `service`.
- `rcl = rci && …`, so it fails automatically. Incident 401 defines no
  `locations`, so location matching itself would have passed.
- `rcr` needs edge `recommendation>frontend`; `normalizeIdentity` only
  lowercases and maps `_`/spaces to `-`, so endpoint-qualified edge names never
  reduce to bare service names. 0/4, PRAXIS included.

The arms were steered into this: `guidance/observability-sre.md:15` instructs
them to *"Return the earliest entity and code/config/resource location"*, and
`schemas/diagnosis.schema.json:36` leaves `kind` as free-form `{"type":
"string"}` with no enum. The scorer expects ITBench service granularity; the
guidance asks for code granularity.

This is a pre-existing contract defect, not a regression from the r10 fix. It
was masked in r7/r8/r9 because no arm ever produced a correct answer to score.
**It is recorded here and deliberately left unfixed** — changing a metric after
seeing which way it moves would invalidate the comparison. Any correction
should be pre-registered and re-run.

### Time and reliability

| Arm | Median wall | Median model | Median non-model/runtime | Failures | Timeouts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Normal coding SRE | 52.81 s | 52.81 s | 0.00 s | 0 | 0 |
| PRAXIS (fair adapter) | 95.31 s | 89.59 s | 5.72 s | 0 | 0 |
| Graph + LiveProbe | 64.23 s | 64.23 s | 0.00 s | 0 | 0 |
| Raw LiveProbe | 51.94 s | 51.94 s | 0.00 s | 0 | 0 |

Wall time is end-to-end arm time. Model time is provider/runner time;
non-model/runtime time includes tool orchestration and replay.

### Provider-reported token accounting

| Arm | Mean input | Mean cached | Mean new input | Mean output | Mean rollout-weighted | Mean reasoning | Agent turns | Model samples |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Normal coding SRE | 171,877 | 147,968 | 23,909 | 1,705 | 25,614 | 537 | 1 | 10 |
| PRAXIS (fair adapter) | 43,018 | 5,632 | 37,386 | 2,648 | 40,034 | 28 | 5 | 5 |
| Graph + LiveProbe | 290,977 | 261,632 | 29,345 | 2,285 | 31,630 | 404 | 1 | 19 |
| Raw LiveProbe | 297,483 | 261,632 | 35,851 | 1,805 | 37,656 | 236 | 1 | 17 |

Input, cached input, output and reasoning tokens are provider-reported
aggregates. "New input" is input minus cached input. "Rollout-weighted" is new
input plus output, matching the enforced Codex rollout budget's default 1.0
prefill and sampling weights. Cached input is reported separately and did not
consume the configured rollout-weighted cap; this does **not** mean cached
tokens were free. A coding-agent `codex exec` is one exact outer turn; its
model-sample count is an event-derived lower bound. Each tool-free PRAXIS
subprocess is one exact model call/sample.

All four arms finished under the 50,000 cap; the closest was PRAXIS at 40,034
(80% of cap). Note the cost ordering is the inverse of capability:
baseline 25,614 < graph 31,630 < raw 37,656 < PRAXIS 40,034, for the same
answer from the first three.

### Tool and runtime operations

| Arm | Tool calls by server | Replays | Probes deployed | Watches | Evidence collections | Correlated occurrences |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Normal coding SRE | observability: 6 | 0 | 0 | 0 | 0 | 0 |
| PRAXIS (fair adapter) | praxis_internal: 15 | 0 | 0 | 0 | 0 | 0 |
| Graph + LiveProbe | liveprobe: 1 (failed)<br>observability: 6 | 0 | 0 | 0 | 0 | 0 |
| Raw LiveProbe | liveprobe: 5<br>observability: 7 | 1 | 1 | 2 | 0 | 0 |

Derived from 48 privacy-preserving ledger records. Captured values and raw
LiveProbe arguments are not stored in the ledger.

## Infrastructure fixes validated by this run

Campaign r9 was invalidated by two defects; commit `9137c31` addressed both.

- **Noninteractive MCP approvals.** In r9 every observability call was
  cancelled before dispatch (`user cancelled MCP tool call`). In r10 there were
  **zero** cancellations and all four arms made real observability calls. A
  dedicated one-call diagnostic confirmed it independently: `get_trace`
  returned `status: completed`, `trace.status = ERROR`, one ledger record, no
  cancellation, at 11,029 weighted tokens against a 15,000 cap.
- **Broker restart readiness race.** `waitForLiveProbeService` now polls
  `/v1/services` for the exact runtime identity
  (`recommendation` @ `fe256c4d88507959b23df2a339469e400456458b`) after every
  pre-arm reset. Raw LiveProbe registered and probed successfully. **The gate
  is not sufficient**: Graph + LiveProbe still lost its single call to a
  transient in-window failure. Readiness is checked before the arm but not
  maintained during it.

## Zero-token validation

Measured in this session, on both the laptop and the VM, at commit `9137c31`:

| Gate | Result | Measured value | Benchmark claim? |
| --- | --- | ---: | --- |
| Evaluation contracts (local) | PASS | 33 passed, 1 skipped | No |
| Evaluation contracts (VM) | PASS | 33 passed, 1 skipped | No |
| Python adapter compilation | PASS | both modules | No |
| Released PRAXIS artifact compatibility | PASS | 16/16 incident graphs; 36/36 checks | No |
| Static LiveProbe compatibility | PASS | 16/16 variants | No |
| Synthetic fixture tripwire | PASS | 12/12; 0 model calls | No |
| Remote host eligibility | PASS | linux, 32 CPUs, 62.4 GiB | No |

The generated report embeds an older `local-validation.json` reporting 23/23
contracts and 41 analyzer tests; those figures predate `9137c31`. The current
contract count is 33 passed / 1 skipped, measured directly above.

## Invalid attempts and setup overhead

Excluded from leaderboard accuracy, reported as overhead. **r7, r8, r9 and all
MCP diagnostics are excluded from leaderboard accuracy.**

| Attempt | Outcome | Input | Cached | New input | Output | Reasoning | Weighted |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Schema preflight | Rejected before model call | 8,173 | — | — | 99 | 10 | — |
| r7 (PRAXIS partial) | Interrupted; 3 arms failed schema validation | 22,405 | 5,632 | 16,773 | 914 | 130 | — |
| r8 (Graph+LiveProbe) | Completed turn, wrongly rejected by old budget check | 394,854 | 338,944 | 55,910 | 3,109 | 1,211 | — |
| 30k capped tripwire | Cap exhausted during probe deployment | — | — | — | — | — | — |
| 50k graph validation | Completed within weighted cap | 377,888 | 340,992 | 36,896 | 3,192 | 1,513 | 40,088 |
| r9 Graph+LiveProbe | INSUFFICIENT — MCP cancelled | 148,603 | 126,464 | 22,139 | 1,182 | 488 | 23,321 |
| r9 Normal coding SRE | HANDOFF from bootstrap/source only | 154,428 | 134,144 | 20,284 | 2,471 | 740 | 22,755 |
| r9 Raw LiveProbe | INSUFFICIENT — MCP cancelled | 195,368 | 176,128 | 19,240 | 1,858 | 358 | 21,098 |
| r9 PRAXIS | Stopped before first model call; empty ledger | — | — | — | — | — | — |
| MCP diagnostic 1 | Discovery prohibited; no call attempted | 8,008 | 0 | 8,008 | 168 | 121 | 8,176 |
| MCP diagnostic 2 | Proved cancel before dispatch | 26,630 | 16,384 | 10,246 | 243 | 101 | 10,489 |
| MCP diagnostic 3 | Global `approval=never` still cancelled | 26,619 | 24,064 | 2,555 | 207 | 83 | 2,762 |
| MCP diagnostic 4 | **PASS** — call completed, ERROR confirmed | 27,729 | 16,896 | 10,833 | 196 | 60 | 11,029 |

The 30k cap was raised once to 50k after it stopped a graph workflow mid probe
deployment. It has not been raised again.

## Interpretation rules

- `n=1`: one incident, one seed, one run per arm. No statistical claim.
- The official oracle is generated after all model attempts and is scorer-only;
  it never appears in a model prompt or MCP result.
- All four arms received the same immutable incident snapshot.
- Synthetic fixtures validate contracts only and never enter leaderboard
  accuracy.
- Probe evidence must be correlated to a replay occurrence; uncorrelated logs
  and metrics rank hypotheses but do not eliminate them. **No arm cleared this
  bar in r10.**
- Failures and timeouts remain visible; invalid setup attempts are excluded
  from accuracy and reported separately above.
- This run used full `gpt-5.4` with low reasoning, not `gpt-5.4-mini`. Public
  claims would additionally require a pinned model snapshot.

## What this run does and does not support

Supported:

- The evaluation pipeline runs end to end and produces scored, budgeted,
  ledgered artifacts for all four arms.
- The r9 MCP-approval defect is fixed and independently verified.
- PRAXIS returned a substantively wrong root cause on this incident where three
  coding arms did not.

Not supported:

- Any claim that LiveProbe improves accuracy. On incident 401 it did not: the
  no-LiveProbe baseline matched both LiveProbe arms at the lowest cost.
- Any claim about correlated probe evidence. Zero correlated occurrences were
  recorded.
- Any leaderboard accuracy ranking, because the scorer cannot express
  code-granularity answers.

Recommended next steps, in order: pin a `kind` vocabulary shared by the schema,
guidance and oracle; extend broker readiness to hold **during** an arm, not
only before it; and select incidents whose logs do **not** contain a stack
trace naming the faulty line, so the arms are actually distinguishable.
