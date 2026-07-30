# PRAXIS × LiveProbe evaluation results

Current campaign: **r11**. Model `gpt-5.4`, effort `low`, 9 incidents, seed 10,
uniform 50,000 rollout-weighted-token cap per arm. 36 runs, all scored.

The r10 report is superseded and kept in git history. r10 scored **0/4 on every
arm** because of three metric defects, not arm failures; those are fixed in
`4c3e853` and documented in `../PRE_REGISTRATION.md`. `scoreDiagnosis` was never
modified.

## Headline

| Arm | Combined@1 | Localized | Median tokens | Median turns | Median wall |
| --- | ---: | ---: | ---: | ---: | ---: |
| Normal coding SRE | 4/9 | 7/9 | 25,671 | 19 | 67.9 s |
| Graph + LiveProbe | 4/9 | **8/9** | 38,270 | 18 | 61.7 s |
| Raw LiveProbe | **5/9** | 6/9 | 34,757 | 16 | 66.1 s |
| PRAXIS | 0/9 | 0/9 | — | 3 | 62.1 s |

**PRAXIS exceeded its budget on all 9 incidents and produced no diagnosis.**
`fair_praxis_adapter.py:477` splits one 50,000 budget across ~5 sequential
calls while each coding arm gets 50,000 for a single call. Owner decision: mark
it, do not re-run. Its runs are excluded from accuracy and reported as
overhead.

## The result that matters

Everything separates by stratum, and it separates cleanly.

| Stratum | Arm | Combined@1 | Median tokens | Median wall |
| --- | --- | ---: | ---: | ---: |
| `direct_code` (5) | normal | 4/5 | 28,946 | 78.2 s |
| | graph | 4/5 | 38,885 | **51.6 s** |
| | raw | 4/5 | 31,325 | **53.9 s** |
| `boundary_configuration` (4) | normal | 0/4 | 25,252 | **66.5 s** |
| | graph | 0/4 | 38,050 | 81.9 s |
| | raw | 1/4 | 34,766 | 82.9 s |

- **Direct code faults: LiveProbe is ~1.5× faster in wall time** (1.52× graph,
  1.45× raw) at equal accuracy.
- **Boundary/config faults: LiveProbe is ~1.25× slower** and nearly everyone
  fails.
- **LiveProbe costs 30–50% more tokens everywhere.** There is no token gain.

## Why the boundary stratum fails, for every arm

Not a metric artifact. The sub-metrics isolate it:

| Stratum | Arm | RCI | RCR | Combined |
| --- | --- | ---: | ---: | ---: |
| boundary | normal | 3/4 | **0/4** | 0 |
| boundary | graph | 4/4 | **0/4** | 0 |
| boundary | raw | 4/4 | **1/4** | 1 |
| direct_code | all three | 4–5/5 | 5/5 | 4 |

RCI passes 11/12 — the arms correctly name `recommendation`, an accepted root.
RCR fails 11/12 because they never produce the `neo4j-productdb →
recommendation` edge. They identified where the failure *surfaces* and never
established the external database as its cause. `raw_liveprobe` on incident 409
produced the full chain, so it is achievable, not an impossible requirement.

This is the clearest headroom in the product: probing across a service boundary
to prove the external dependency is at fault.

## Scope and exclusions

- **9 of 16 four-arm incidents.** 402, 405, 406, 413–416 are excluded because
  the released artifact and the published images have drifted; no image tag
  matches those locked sources. Every tag was pulled and hashed against every
  locked source — evidence table in `../PRE_REGISTRATION.md`. Nothing was
  excluded on performance grounds.
- **Seed 10 only.** One run per incident per arm. Per-stratum cells are n=4 and
  n=5. Treat the wall-time ratios as directional.
- **Log-richness is measured, not selected on.** Only incident 401's logs name
  the faulty line; the other 8 are log-silent. All arms sit within 4 s of each
  other on 401 and diverge on the rest — the gain appears where logs do not
  give the answer away.
- Wall time carries provider-latency noise. `model_samples` is an event-derived
  lower bound for coding arms. Turn count is the steadier of the two.

## Defects found and fixed

`../R11_FINDINGS.md` has the full list. In r11:

- **Broker client had no retry.** A transient blip surfaced as a hard tool
  error and cost r10's graph arm its only LiveProbe call. Fixed; idempotent
  methods only, so probe creation can never double-fire.
- **Readiness gated before an arm, not during it.** Now requires consecutive
  clean observations.

Held back from r11 to keep the tool surface and probe timing constant, measured
in r12: deprecated tool removal (F1) and the `get_probe_data` long-poll default
(F2).

## What this does not support

A token multiplier. 86% of input is cached, so tool-surface reductions save
~1,497 weighted tokens once per run, ~4%. The remaining token lever is probe
**response payload** size (F7), which is untested.
