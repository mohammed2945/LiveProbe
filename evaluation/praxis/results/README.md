# PRAXIS × LiveProbe evaluation results

**Current result: campaign r15.** `gpt-5.4`, effort `low`, 9 incidents × 2
seeds × 3 arms, 250,000-token cap, 48 valid runs of 54. First campaign with
clean evidence windows and the propagation contract published, and therefore
the first trustworthy one. Earlier campaigns are superseded; see
`../HANDOFF.md` for the full history and the corrections made along the way.

## Headline

| Arm | Accuracy (ran) | Accuracy (all runs) | Median tokens | Median wall |
| --- | --- | --- | ---: | ---: |
| Normal coding SRE | 10/18 (56%) | **10/18 (56%)** | **26,738** | **33.6 s** |
| Graph + LiveProbe | 8/14 (57%) | 8/18 (44%) | 40,038 (1.50×) | 47.3 s (1.41×) |
| Raw LiveProbe | 10/16 (62%) | 10/18 (56%) | 34,842 (1.30×) | 43.9 s (1.31×) |

**The graph has no accuracy advantage over the bare agent and costs 1.5× the
tokens and 1.4× the wall time.** The r13 result that showed graph ahead
13/18 to 8/18 was an artifact of cross-incident evidence leakage plus an
unpublished propagation contract. With both fixed, the gap disappears.

## By stratum

| Stratum | normal | graph | raw |
| --- | --- | --- | --- |
| `direct_code` (5 incidents) | **10/10** | 8/8 | 9/9 |
| `boundary_configuration` (4 incidents) | 0/8 | 0/6 | **1/7** |

`direct_code` is saturated: every arm is perfect and the baseline is also
cheapest and fastest. `boundary_configuration` is near-dead at 1 of 21. The one
success is `raw_liveprobe` on 409 seed 10, which produced the required chain
`neo4j-productdb → recommendation → frontend → frontend-proxy` rooted at
`neo4j-productdb`. So the stratum is solvable and LiveProbe is the only arm that
has solved it — while 20 of 21 runs stop at `recommendation` with `neo4j`
present in the logs.

## Availability is part of the result

All 6 invalid runs share one cause, the LiveProbe service failing to stay
registered, and all 6 are LiveProbe arms on incidents 407 and 412 — the
bootstrap-crash and logic-slow variants. **A probe cannot attach to a service
that will not stay up**, and the bare agent is unaffected because it needs
nothing from the target. Counting those as failures, which is what a user
experiences, puts graph at 44%, below the baseline.

## The measurement ceiling

The answer key has fields for `entity`, `kind` and `propagation`. **No file, no
line, no expression: 0 of 9 incidents carry a location, and every root kind it
can express is `Service`.** This is structural across the RCA benchmark family —
ITBench scores `kind`+`name`, AIOpsLab submits service names.

LiveProbe's differentiator is line-level precision, and these benchmarks score
at service granularity, so that precision cannot be rewarded. No amount of loop
optimisation changes this. See `../LANDSCAPE.md` and `../HANDOFF.md` §3.

## Scope

9 of 16 four-arm incidents. 402, 405, 406 and 413–416 are excluded because the
released artifact and the published images have drifted: every image tag was
pulled and hashed against every locked source, and no tag matches those six.
Nothing is excluded on performance grounds.

Two seeds. Per-stratum cells are n=6 to n=10. Wall time carries provider
latency noise. `model_samples` is `tool_calls + 1`, not a provider turn count,
and is reported as tool calls.
