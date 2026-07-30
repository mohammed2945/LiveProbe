# Pre-registration: campaign r11

Written **before** any r11 run. Every change below is justified by a mechanism
that holds independently of which incidents are in the set. Nothing here was
chosen after seeing an r11 result.

Baseline of record: campaign r10, `results/README.md`, all four arms
`combined_pass_at_1 = 0`.

## Primary question

r10 measured accuracy and found the metric broken. The question for r11 is
**efficiency**: does LiveProbe reach a correct diagnosis in materially fewer
tokens and less wall time than an arm without it, and does the graph compound
that? Accuracy must be repaired well enough that "cheaper" cannot mean
"cheaper and wrong", but accuracy is not the headline.

Headline metrics, reported per arm **and per stratum**:

- `weighted_tokens_per_correct` — rollout-weighted tokens / correct answers
- `wall_ms_per_correct`
- `model_samples` (turn count) — r10 showed token cost tracks turns, not
  context size (per-sample context was 15.3k–17.5k across all arms, while
  samples ranged 10–19)
- `mcp_round_trips_to_first_runtime_value` — LiveProbe-specific

Accuracy is reported as a gate, not a headline.

## Rules

A change is **legitimate** if it fixes a defect that would still be a defect
with a different incident set, and it is applied identically to all four arms.

A change is **gaming** and is forbidden:

1. Naming, branching on, or special-casing any incident ID or source variant.
2. Putting fault-specific content in guidance, skill files, tool descriptions
   or prompts — no `products_list`, no "check for return-type mismatches", no
   "look at timeouts". Guidance may describe *method*, never *findings*.
3. Loosening a scorer check so that outputs already observed in r10 start
   passing. Where r10 outputs failed a check, the fix is to **state the
   contract the check enforces**, not to relax the check.
4. Dropping incidents LiveProbe loses on. 401–404 stay in the set.
5. Giving a LiveProbe arm evidence another arm cannot obtain, other than the
   LiveProbe capability itself.
6. Editing the environment to hide evidence other arms legitimately use — the
   401 stack trace stays in the logs.
7. Tuning any threshold, budget or contract after seeing r11 results.

If a change cannot be defended without referring to a specific incident, it
does not ship.

## Defects found (evidence, not inference)

**D1 — `kind` is scored against an unpublished vocabulary.**
`core.mjs:775` requires `root_cause.kind` to match the oracle's kind.
`build-official-oracle.mjs:118` takes that kind verbatim from the released
ITBench ground truth. Across all 16 four-arm incidents the released ground
truth uses exactly two kinds, `Service` and `Pod`, and **every root cause is
`Service`**. The agent is never told this vocabulary exists:
`schemas/diagnosis.schema.json:36` declares `kind` as a free-form string and
`guidance/observability-sre.md:15` steers toward code granularity. All four
r10 arms answered `"code"` or `"Service"` and RCI failed for three of them on
kind alone. Scoring against a hidden contract measures nothing.

**D2 — RCL is a no-op.** `locationMatches` (`core.mjs:711`) returns `true`
when the oracle carries no `locations`, and `build-official-oracle.mjs`
never emits `locations`. So `rcl === rci` for every official run. The
benchmark does not measure localization at all — which is precisely the axis
LiveProbe exists to improve. `oracle/fixtures.json` has locations, but it is a
unit-test fixture covering 3 incidents and is not what campaigns score against.

**D3 — propagation identities are scored at a granularity nobody specified.**
Oracle edges are service-level (`recommendation > frontend`).
`canonicalIdentity` normalizes case, underscores and whitespace only. Three of
four r10 arms emitted operation-level or prose endpoints
(`recommendation:/oteldemo.RecommendationService/ListRecommendations`,
`frontend gRPC handler fails`), which can never canonicalize to a service name,
so RCR failed. The schema constrains `from`/`to` to `{"type": "string"}` with
no statement of what a valid identity is.

**D4 — broker readiness is gated before an arm, not during it.**
`waitForLiveProbeService` (`campaign.mjs:293`) polls through the port-forward
and returns on the first match. Each arm is bracketed by a
`kubectl rollout restart` of the broker. In r10 `graph_liveprobe`'s only
LiveProbe call failed ~16 s into the arm; the gate had already passed. That arm
deployed zero probes and is contaminated.

## Changes pre-registered

**C1 (fixes D1) — publish the vocabulary.** Add an `enum` to
`schemas/diagnosis.schema.json` for `root_cause.kind`, taken from the ITBench
ground-truth taxonomy, and state it in guidance. **The scorer is not changed.**
Because every four-arm root is `Service`, `kind` carries no discriminative
information in this slice; RCI therefore reduces to an entity match and will be
reported as such. This removes a hidden trap; it does not make the hard part
easier.

**C2 (fixes D3) — specify the identity namespace.** State in schema and
guidance that `root_cause.entity` and propagation `from`/`to` must be bare
entity identifiers from the deployed topology (service or resource names), not
operations, endpoints, file positions or prose. Code-level detail belongs in
the `file` / `line` / `function` fields, which already exist and are already
required. **`canonicalIdentity` and the RCR all-edges requirement are not
touched.** Arms that emit prose will still fail, correctly. Note PRAXIS already
emitted clean service names in r10 and still failed RCR on a substantive
topology disagreement — C2 does not rescue it, which is the intended behaviour.

**C3 (measures around D2) — report localization as a separate metric.**
Ground truth for fault locations is authored in `oracle/fault-locations.json`
from the diff between each fault variant and the artifact's own `faultfree`
variant. This is independent of LiveProbe: it comes from the fault injection,
not from any analyzer output. Deriving locations from
`liveprobe-compatibility.json`'s `criterion` field would be circular and is
forbidden.

*Revised before any r11 run, in the conservative direction.* The first draft of
C3 wired these locations into the official oracle so that `rcl` — and therefore
`combined_pass_at_1` — became strict. Rejected for three reasons: it would
require restructuring `locationMatches` to be per-accepted-root (the boundary
incidents have two accepted roots, one of which is an external resource with no
code location), it changes the headline metric in the same run that changes the
incident set, and a metric that moved after the author saw r10 invites exactly
the suspicion this document exists to prevent.

Instead: **`scoreDiagnosis` is not modified at all.** `rcl` stays vacuous under
the official oracle and is reported as vacuous. Localization is computed
post-hoc as a standalone `localization_correct` metric and reported beside
`combined_pass_at_1`, never folded into it. `combined_pass_at_1` therefore
remains exactly comparable to r10.

Locations are authored **before** r11 runs and are never revised afterwards.

**C4 (fixes D4) — hold readiness for the arm's duration**, not just before it.

**C5 — reduce MCP round trips per runtime observation.** r10's raw arm needed
6 calls (`replay prepare → set_snapshot_probe → list_probes → replay execute →
get_probe_data → remove_probe`) to obtain one value. This is a product cost
that every LiveProbe user pays on every investigation, independent of the
benchmark. Reducing it is the main efficiency lever and is justified without
reference to any incident.

## Incident set

All 16 four-arm incidents, 401–416. Both strata (`direct_code` → `LOCALIZED`,
`boundary_configuration` → `HANDOFF`). 401–404 are retained even though their
logs contain the full traceback and LiveProbe cannot beat a log read on them;
they are the control showing where LiveProbe adds nothing.

**Seven incidents are excluded because the released artifact and the published
images have drifted apart.** The build's source integrity gate refuses to run
an arm whose deployed source differs from the locked source the agent is
shown, which is correct.

This was checked exhaustively rather than assumed. Every one of the 16 mapped
image tags was pulled, its `/usr/src/app/recommendation_server.py` hashed, and
compared against all 16 locked sources:

| Incident | Locked source | Mapped tag | Result |
| --- | --- | --- | --- |
| 401 | `01d80fed` | `dev` | match |
| 403 | `6c35fb3a` | `alpha` | match |
| 404 | `000b442f` | `monzo` | match |
| 407 | `d171eb22` | `neo4jto-bootstrap` | match |
| 408 | `11a0d2a8` | `neo4jto-serving` | match |
| 409 | `7f27648d` | `neo4jto-live-bootstrap` | match |
| 410 | `68e58a03` | `neo4jto-live-serving` | match |
| 411 | `85365438` | `logicc` | match |
| 412 | `fe32e9e9` | `logics` | match |
| 402 | `640128e4` | `nightly` (`c5a0cdc0`) | **no tag matches** |
| 405 | `759c5c66` | `neo4j-serving` (`8c0570a0`) | **no tag matches** |
| 406 | `12da597a` | `neo4j-bootstrap` (`29cf7225`) | **no tag matches** |
| 413 | `cad629e3` | `neo4j-label-serving` (`fec65377`) | **no tag matches** |
| 414 | `a89a8c9f` | `neo4j-label-bootstrap` (`2b0ce2c9`) | **no tag matches** |
| 415 | `510da82e` | `config` (`5f5925d4`) | **no tag matches** |
| 416 | `c9cf01d8` | `configdb` (`57e0984c`) | **no tag matches** |

No locked source matches *any* other tag, so `image-map.json` is not
mismapped and there is no correct tag to substitute. For 402 the divergence
was inspected directly: both files are 182 lines and differ on line 47 alone,
where the image logs `"Exception in get_product_list, products_list cannot be
fetched due to Attribute Error."` and the locked source logs `"Error fetching
product catalog: {e}"` — the deployed image names the fault more explicitly
than the source the agent is shown.

These exclusions are mechanical and do not weaken rule 4. Nothing is dropped
on performance grounds. 401, 403 and 404 cover the same fault class as 402, so
the log-rich control stratum is fully preserved.

**Resulting set: 9 incidents, both strata represented.**

- `direct_code` (expects `LOCALIZED`): 401, 403, 404, 411, 412
- `boundary_configuration` (expects `HANDOFF`): 407, 408, 409, 410

A **log-richness** covariate is computed per incident before running — whether
the snapshot logs already name the faulty file and line — and results are
broken out by it. This is measured, not selected on.

## Budget decisions, taken mid-r11 and recorded here

PRAXIS failed on every incident with codex's `shared rollout token budget
exhausted`. Cause: `fair_praxis_adapter.py:477` hands each of PRAXIS's ~5
sequential calls the *remainder* of one 50,000 budget, while every coding arm
is a single `codex exec` that gets the whole 50,000. Measured across 401, 403
and 404, calls 1–2 complete on 17–23k and call 3 then exhausts the 27–33k
remainder. In r10 PRAXIS finished five calls in 40,034 total; in r11 it reaches
real code context and costs more.

Decision (owner): **leave the cap at 50,000 for PRAXIS, mark it
budget-exceeded, do not re-run it.** PRAXIS is a sanity check, not the
comparison of interest. Its runs are excluded from leaderboard accuracy and
reported as overhead, per the existing rule for invalid setup attempts.

The comparison of interest is `normal_coding_sre` vs `raw_liveprobe` vs
`graph_liveprobe`. The owner has approved raising the budget for **those three
arms only** in a follow-up wave. Motivation is on record before that wave runs:
no r11 arm was truncated (maxima 66.0%, 77.8% and 95.3% of cap), but
`raw_liveprobe` at 95.3% was receiving codex budget-pressure reminders at 1/3,
1/6 and 1/15 remaining, which can make an agent stop early. Raising the cap
removes that pressure; it does not by itself create a gain.

r11 itself remains a uniform 50,000 study for all arms. Any higher-budget wave
is reported separately and never merged into r11's tables.

## Post-r12 changes, and the honesty risk in one of them

r12 showed LiveProbe losing to the baseline on `direct_code` (baseline 10/10,
cheapest and fastest) and winning on `boundary_configuration` (baseline 0/8,
raw LiveProbe 3/8 with 7/8 localization). Four changes follow from it.

**P1 — shrink `start_probe_investigation` and `collect_investigation_evidence`
responses.** Measured at 30,989 and 43,917 bytes per call, together 86% of the
graph arm's LiveProbe payload. Tool responses are never cacheable, so this is
pure non-cached input. Justified without reference to any incident: every
LiveProbe user pays ~7,750 tokens per investigation start.

**P2 — per-turn token tracing.** Persist the codex event stream and attribute
tokens to turns and to the tool responses preceding them. Measurement only,
cannot affect a score. Deliberately local rather than an external tracing
service, since the eval handles incident data.

**P3 — fix the graph investigation path.** `start_probe_investigation` failed 3
of 13 times and the arm reached probe deployment in only 7 of 13 runs, while
`prepare_repository_analysis` never failed. A capability the arm pays for and
cannot reach is a defect regardless of benchmark.

**P4 — an entry gate on whether to probe at all**, added to both LiveProbe
skill files. **This is the change that carries an honesty risk and it is
recorded here in full.**

The risk: it was authored *after* seeing that LiveProbe loses where a traceback
already names the fault and wins where the cause sits across an external
boundary. Guidance written with that knowledge can encode the answer key rather
than a method.

Why it is defensible anyway: the gate is stated purely as evidence economics —
do not spend an expensive observation to restate a fact you already hold;
spend it when only an observed runtime value separates the remaining
hypotheses, or when the cause sits behind something your source cannot derive.
That is ordinary debugging practice and would be the same advice for any
production system, written by someone who had never seen this benchmark. It
names no incident, file, value, fault class, or stratum, and it does not tell
the agent which answer to give.

Why it is still not proof: it was authored with knowledge of the direction of
the result, and there is no held-out incident set left — all 9 usable incidents
have been observed. The correct reading is that P4 is **plausible but
unvalidated**, and any improvement it produces must be reported with that
caveat attached rather than as a clean win.

P1–P3 carry no such risk: none of them can change which answer an arm gives.

## What r11 cannot support

n is still small. Single-seed results are anecdotes; any claim of a multiplier
requires the seed count to be stated next to it. Per-stratum cells with fewer
than 3 incidents will be reported as raw numbers, not rates.
