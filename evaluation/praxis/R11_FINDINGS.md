# r11 audit findings

## F0 — r11's LiveProbe arms barely used LiveProbe (the headline caveat)

Counted from the r11 operation ledgers across all 9 incidents:

| Arm | Observability calls | LiveProbe calls | Probes deployed | Failed |
| --- | ---: | ---: | ---: | ---: |
| normal | 104 | 0 | 0 | 0 |
| graph | 112 | 13 | 1 | 3 |
| raw | 109 | 7 | **0** | 2 |

`raw_liveprobe` deployed no probes on any incident. Its seven calls were all
`list_services`. So r11 compared three observability-driven agents, and no
efficiency difference between them is attributable to LiveProbe. The r11
efficiency claim was withdrawn in `7689901`.

Two causes:

**F0a — a guidance regression, self-inflicted.** The naming contract added for
r11 ran to ~200 words and sat last in `guidance/observability-sre.md`. On
incident 401, r10's raw arm ran the full
`set_snapshot_probe → list_probes → get_probe_data → remove_probe` workflow;
r11's called `list_services` and stopped, same incident and model. Compressed to
one paragraph and moved ahead of the terminal-state instruction in `f851705`.
No probe encouragement beyond r10's was added — this only undoes the
regression.

**F0b — the retry window was mis-scaled (F4's fix was too small).** 5 of 16
LiveProbe calls failed with `broker_unreachable`. Identified by matching the
ledger's recorded 423-byte failure against reproduced error shapes: a socket
reset serialises to exactly 423 bytes as a full JSON-RPC message, while 503,
502 and 401 give 252, 252 and 392. Retry covered that failure class but totalled
under half a second against pod rollouts that take seconds. Widened to 5
attempts at 300ms exponential backoff, ~4.5 s, in `f851705`. An arm that loses
its first call abandons LiveProbe for the rest of the incident, so this failure
is far more costly than its rate suggests.

---

# Earlier findings (recorded before r11 results landed)

Efficiency defects found by zero-token inspection, before r11 results land.
None applied during r11 — changing the tool surface mid-campaign would
invalidate the run. Each is a candidate for a second wave with a measurable
delta.

## F1 — Deprecated tools are still exposed alongside their replacements

`analyze_probe_candidates`, `deploy_probe_frontier` and
`refine_probe_candidates` describe themselves as "Legacy stateless workflow …
use X for new agent-driven work", yet all three are in the graph profile's
`tools/list`.

Measured, graph profile: 21 tools, 37,137 B (~9,284 tokens) of tool surface.
The three legacy tools are 5,987 B (~1,497 tokens) = **16.1%**.

The tool surface is part of every turn's prompt. At r10's 19 model samples for
the graph arm that is ~28,400 tokens spent describing tools the agent is told
not to use — more than the whole baseline arm's 25,614 weighted-token run.

Beyond cost, exposing a deprecated path next to its replacement invites the
agent to take it, spending turns on the wrong protocol.

Fix: drop them from the exposed surface (or gate them behind an explicit
legacy profile). Generalizes to every LiveProbe user; changes no answer.

## F2 — `wait_seconds` defaults to 0, forcing a poll loop

`get_probe_data`, `refine_probe_candidates` and
`collect_investigation_evidence` all declare `wait_seconds` with `.default(0)`.
The `get_probe_data` description advertises long-polling "up to 30 seconds",
but the default does not use it.

An agent that arms a probe and immediately collects gets empty events, then has
to call again — one wasted round trip per collection, and r10 shows round trips
are what drive token cost (per-sample context was 15.3k–17.5k across all arms
while sample counts ranged 10–19).

Fix: default to a small non-zero wait. Zero remains available for callers that
genuinely want a non-blocking peek.

## F3 — The probe surface is schema-heavy

Of the graph profile's 37,137 B, input schemas are 26,956 B (73%); descriptions
are only 6,479 B. The four `set_*_probe` tools cost ~2,700–2,950 B each and
repeat the same 253-character `MANUAL_PROBE_SCOPE` preamble.

Fix: factor the shared preamble into the server instructions, which are sent
once, rather than into four descriptions sent on every turn.

## F4 — Broker client had no transient-fault tolerance (FIXED, in r11)

Fixed in `4c3e853`. A single blip surfaced as a hard tool error; in r10 it cost
the graph arm its only LiveProbe call. Retry now covers idempotent methods
only, so probe creation can never double-fire. Tests in
`packages/mcp-server/test/integration.test.ts`.

## F5 — PRAXIS backend failures report no cause (FIXED locally, not deployed)

r11 incident 401 lost the PRAXIS arm to `Codex backend failed (1): ` with an
empty message. `codex exec --json` writes its event stream, including error
events, to stdout and can exit non-zero with an empty stderr, but
`fair_praxis_adapter.py` reported `result.stderr` only and discarded stdout.
`praxis-runner.mjs` already falls back to stdout.

Not budget or timeout: the run used 22,947 of 50,000 weighted tokens (46%) over
3 of 5 planned calls, and 56 s of a 180 s limit. Cause still unknown; a
provider-side transient is the leading hypothesis.

Fixed in `13fe2de`, diagnostics only. Deliberately **not** deployed mid-r11,
because pulling would also apply the `get_probe_data` wait default and change
LiveProbe arm behaviour partway through the campaign. If PRAXIS keeps failing,
that arm gets re-run separately after r11 with the fix in place.

## Contract repair validated on incident 401

r11 vs r10, same incident, same model:

| | r10 | r11 |
| --- | --- | --- |
| `kind` | `"code"` (unscoreable) | `"Service"` |
| `entity` | `"recommendation get_product_list field access"` | `"recommendation"` |
| propagation | operation-level prose | `recommendation → frontend` |
| evidence IDs | present | 4–7 per arm |
| `combined_pass_at_1` | 0/4 | 3/4 expected |

The three coding arms now satisfy RCI, RCR, terminal and evidence-backed. The
fourth is the crashed PRAXIS arm, which fails correctly rather than spuriously.

Efficiency on 401, the log-rich control where LiveProbe cannot add anything:

| Arm | Turns | Weighted | Wall |
| --- | ---: | ---: | ---: |
| Normal coding SRE | 15 | 24,403 | 38.4 s |
| Graph + LiveProbe | **12** | 38,885 | 39.1 s |
| Raw LiveProbe | 13 | 36,839 | 42.1 s |

Turn order is graph < raw < baseline; token order is the reverse. The composite
workflow does buy turns, but the graph arm's ~9,284-token tool surface plus
probe payloads more than cancel it in weighted tokens. On this incident that is
expected — the traceback is already in the logs. The log-silent incidents
(407–412) are the real test.

## F6 — PRAXIS fails systematically, not transiently (2/2 so far)

Incidents 401 and 403 both lost the PRAXIS arm the same way: the third
`inference()` call dies. The ledger shows the failing call recorded
`new_input_tokens=0, output_tokens=0, model_ms=32561` — codex ran for 32 s and
never completed a turn, so no usage was reported. The two preceding calls were
small and clean (10,950 and 11,273 new input). Not budget (22,947 and 17,473 of
50,000) and not timeout (56 s and 62 s of 180 s).

Two failures with identical shape rules out a one-off provider blip. The
diagnostics fix was applied to the VM as a single-file patch so the next
failure reports its cause. Deliberately **not** a full pull: that would have
also applied the `get_probe_data` wait default and the legacy-tool removal,
changing LiveProbe arm behaviour partway through r11.

Incidental finding from the same logs: PRAXIS selects `product-catalog` as its
first entity and logs "Could not locate codebase for entity: product-catalog …
Skipping code graph traversal", then falls back to a code-free prompt. That
explains r10's wrong answer — it named the callee it had no source for.

## Log-richness is real and it discriminates (measured, not selected)

| Incident | Logs name file | Logs name a target line | `log_names_fault` |
| --- | --- | --- | --- |
| 401 | yes | yes (96) | **true** |
| 403 | yes | no | false |
| 404 | yes | no | false |

The `errcode` variant (403) aborts the RPC without emitting a traceback, so the
faulty line never reaches the logs. All three coding arms still located it, via
source reading rather than log reading.

First efficiency signal, and it points the way the mechanism predicts:

| Arm | 401 (log-rich) wall | 403 (log-silent) wall |
| --- | ---: | ---: |
| Normal coding SRE | 38.4 s | 78.2 s |
| Graph + LiveProbe | 39.1 s | **51.6 s** |
| Raw LiveProbe | 42.1 s | **42.8 s** |

On the log-rich incident all three are within 4 s of each other. On the
log-silent incident the baseline nearly doubles while both LiveProbe arms stay
close to flat — 1.52× and 1.83× faster than baseline respectively. Turn counts
move the same way (18 baseline vs 14 graph vs 15 raw).

Weighted tokens still favour the baseline everywhere. So the current picture is
a **wall-time** gain, not a token gain. Single incident per cell; needs the
remaining six.

## Correction to F1's cost, and F7

**F1's saving was overstated.** Measured on r11 (24 runs), 83–87% of every arm's
input is cached:

| Arm | total input | cached | new input | cached share |
| --- | ---: | ---: | ---: | ---: |
| graph | 1,280,045 | 1,105,408 | 174,637 | 86.4% |
| normal | 1,231,304 | 1,074,176 | 157,128 | 87.2% |
| raw | 1,202,498 | 999,424 | 203,074 | 83.1% |

The tool surface is byte-identical on every turn, so it is cached after the
first. F1 therefore saves roughly 1,497 **weighted** tokens once per run — about
4% of graph's 38,270 — not the ~28,000 implied by multiplying 1,497 by the turn
count. That earlier figure was total input tokens, most of which are cached and
do not consume the enforced rollout cap.

F1 keeps real but smaller value: cached tokens are still billed, and a
deprecated path beside its replacement still invites wrong turns. It is not a
route to a token multiplier.

## F7 — The token lever is tool response size, not tool schema size

New input per turn: graph 1,963, raw 1,766, normal 1,403. Non-cached input is
dominated by tool *responses*, which change every call and can never be cached.
Raw has the highest total new input (203,074) and in r10 a single
`get_probe_data` returned 25,955 bytes.

So the way to reduce LiveProbe's token cost is to shrink what probes return —
paginate captures, cap frame and watch-path payloads, summarise repeated
occurrences — not to shrink tool descriptions. Untested; stated as the next
lever rather than a result.

## Context for interpreting F1–F3

The graph arm carries ~9,284 tokens of tool surface against raw's ~4,031. That
is the price of the composite workflow. It only pays for itself if
`deploy_investigation_probes` + `collect_investigation_evidence` genuinely
replace more turns than the surface costs. r10 never tested this: the graph
arm's single LiveProbe call failed and it answered from observability alone.
That is the central open question r11 should answer.
