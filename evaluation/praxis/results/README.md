# PRAXIS × LiveProbe evaluation results

Two campaigns, `gpt-5.4`, effort `low`, 9 integrity-verified incidents.

| | r11 | r12 |
| --- | --- | --- |
| Arms | 4 | 3 (PRAXIS dropped) |
| Seeds | 10 | 10, 20 |
| Cap | 50,000 | 250,000 |
| Runs | 36 | 54 |
| LiveProbe actually used | **no** | yes |

**Read r12 for LiveProbe's value. Read r11 only for the metric repair.**

## Headline: LiveProbe costs more time and more tokens

r12, medians per run:

| Arm | Combined@1 | Localized | Tokens | Tool calls | Wall |
| --- | ---: | ---: | ---: | ---: | ---: |
| Normal coding SRE | 10/18 | 14/18 | **26,358** | 21 | **63.9 s** |
| Graph + LiveProbe | 10/18 | 14/18 | 41,698 | 21 | 78.4 s |
| Raw LiveProbe | **12/18** | **16/18** | 35,714 | **19** | 72.7 s |

Earlier drafts reported a "turns" column. That was misleading:
`model_samples` is computed as `tool_calls + 1`, verified across 27 of 27 r11
runs and 51 of 54 r12 runs, so it is not an independent measurement.
`turn.completed` fires once per `codex exec`. The column is tool-call count.

There is **no time multiplier and no token multiplier**. LiveProbe is 14–23%
slower and 35–58% more expensive. Any target of 2× or 5× on either axis is not
supported by this data and is not close.

## Where LiveProbe does pay: boundary faults

| Stratum | Arm | Combined@1 | Localized | Tokens | Wall |
| --- | --- | ---: | ---: | ---: | ---: |
| `direct_code` (10) | normal | **10/10** | 10/10 | **22,636** | **50.7 s** |
| | graph | 8/10 | 9/10 | 36,003 | 78.4 s |
| | raw | 9/10 | 9/10 | 25,512 | 62.2 s |
| `boundary_configuration` (8) | normal | **0/8** | 4/8 | 36,998 | 82.4 s |
| | graph | 2/8 | 5/8 | 50,049 | 94.2 s |
| | raw | **3/8** | **7/8** | 42,495 | 106.9 s |

- **Direct code faults: LiveProbe is a net loss.** The baseline gets 10/10
  while being fastest and cheapest. Reading source is simply sufficient here.
- **Boundary/config faults: LiveProbe is the only thing that works at all.**
  The baseline scores 0/8. Raw LiveProbe gets 3/8 and localizes 7/8 against the
  baseline's 4/8. It buys that with ~30% more wall time and ~15% more tokens.

So the honest positioning is **capability on external-dependency faults, not
efficiency**.

## Why the baseline scores 0/8 on boundary faults

Not a metric artifact. In r11, RCI passed 11/12 on this stratum while RCR
failed 11/12: arms correctly name `recommendation` (an accepted root) but never
produce the `neo4j-productdb → recommendation` edge. They locate where the
failure *surfaces* and never establish the external database as its cause.
That is exactly the gap probing a service boundary is for, and it is why raw
LiveProbe is the only arm to score here.

## r11: the metric repair

r10 scored **0/4 on every arm**. Three defects caused it, all fixed in
`4c3e853` with `scoreDiagnosis` **never modified** — see `../PRE_REGISTRATION.md`.

1. `kind` was scored against an unpublished vocabulary. Published as a schema
   enum that deliberately **excludes** `"code"`, the value three r10 arms emitted.
2. `rcl` was a no-op: the official oracle emits no `locations`, so
   `locationMatches` always returned true. Localization is now measured
   separately, never folded into `combined_pass_at_1`.
3. Propagation identity granularity was unstated, so operation-level and prose
   endpoints could never canonicalize.

r11 result: 4/9, 4/9, 5/9 versus 0/4. PRAXIS exceeded budget on all 9 and is
excluded per owner decision — `fair_praxis_adapter.py:477` splits one 50,000
budget across ~5 sequential calls while each coding arm gets 50,000 for one.

**r11's efficiency numbers are withdrawn.** Its LiveProbe arms deployed
essentially no probes (raw: 0 across 9 incidents), so it compared three
observability-driven agents. Causes and fixes are F0 in `../R11_FINDINGS.md`.
Note the direction reversed once LiveProbe was actually used: r11 appeared to
show LiveProbe ~1.5× *faster*; r12 shows it slower.

## Defects fixed

| | Defect | Effect |
| --- | --- | --- |
| F4/F0b | Broker client had no retry, then too short a window | `broker_unreachable` failures 5 → **0** |
| F0a | Guidance regression displaced investigative instructions | raw probes deployed 0/9 → 6/16 runs; graph 1 → 7/13 |
| — | Readiness gated before an arm, not during it | consecutive-observation gate |
| F1 | 3 deprecated tools exposed, 16% of tool surface | removed by default |
| F2 | `get_probe_data` advertised 30 s long-poll, defaulted to 0 | short default |
| F5 | PRAXIS backend failures reported no cause | stdout now surfaced |

Open: `graph_liveprobe` still fails `start_probe_investigation` 3 of 13 times
and `get_probe_data` twice; it reaches probe deployment in only 7 of 13 runs.
That is the top remaining LiveProbe defect.

## Where the graph arm's tokens go

Measured from the r12 ledgers. Two graph-only tools are 86% of that arm's
LiveProbe payload:

| Tool | Calls | Mean bytes | Total |
| --- | ---: | ---: | ---: |
| `start_probe_investigation` | 13 | **30,989** | 402,860 |
| `collect_investigation_evidence` | 3 | **43,917** | 131,753 |
| `deploy_investigation_probes` | 4 | 1,549 | 6,197 |
| `set_snapshot_probe` | 7 | 1,049 | 7,343 |

`start_probe_investigation` alone is 16.4% of all tool response bytes in the
campaign. Worst case: incident 411, graph, seed 20 — a single response of
**145,524 bytes**, 74.5% of that run's entire tool byte budget. Tool responses
are never cacheable, so this lands wholly in the non-cached input the budget
counts.

Caveat on attribution: the operation ledger records MCP calls only. Each arm
also makes roughly 90–110 shell and file reads, which is how the baseline reads
source, and those bytes are invisible here. Token totals are provider-reported
and unaffected, but byte-share comparisons understate the baseline.

## Scope

9 of 16 four-arm incidents. 402, 405, 406, 413–416 excluded because the
released artifact and the published images have drifted — every tag was hashed
against every locked source, evidence in `../PRE_REGISTRATION.md`. Nothing
excluded on performance grounds. Two seeds; per-stratum cells are n=8 and n=10.
Wall time carries provider-latency noise; `model_samples` is a lower bound.
