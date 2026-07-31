# LiveProbe evaluation — state of play

Single entry point. Read this first; it supersedes `RESUME_HANDOFF.md` and
`RESUME_CHECKPOINT_R11.md`, which describe earlier campaigns.

**Bottom line: the benchmark cannot measure the thing LiveProbe does, and the
current numbers say the graph does not earn its cost. Both claims are verified,
not inferred. The recommendation is to stop optimising against ITBench.**

---

## 1. What this evaluates

Four arms diagnose injected incidents in an OpenTelemetry astronomy-shop
deployment on a kind cluster, via `codex exec` with `gpt-5.4`:

| Arm | Capability |
| --- | --- |
| `normal_coding_sre` | observability MCP + shell/source access. The baseline. |
| `raw_liveprobe` | + manual probe tools (virtual breakpoints) |
| `graph_liveprobe` | + analyzer investigation tools (causal/value-flow graph) |
| `praxis` | the PRAXIS fair adapter. Sanity check only, not the comparison. |

Two experiment arms exist and are opt-in, outside `ARM_NAMES`:
`graph_probe_off` (probe tools removed at the MCP layer) and `graph_probe_on`
(probing instructed). They were built for a forced-probe experiment that has
**not yet produced data** — see §6.

---

## 2. Current result — campaign r15, the first trustworthy one

9 incidents × 2 seeds × 3 arms, clean snapshots, edge contract published.
48 valid runs of 54.

| Arm | Accuracy (ran) | Accuracy (all) | Median tokens | Median wall |
| --- | --- | --- | ---: | ---: |
| normal | 10/18 (56%) | **10/18 (56%)** | **26,738** | **33.6 s** |
| graph | 8/14 (57%) | 8/18 (44%) | 40,038 (1.50×) | 47.3 s (1.41×) |
| raw | 10/16 (62%) | 10/18 (56%) | 34,842 (1.30×) | 43.9 s (1.31×) |

By stratum:

| Stratum | normal | graph | raw |
| --- | --- | --- | --- |
| `direct_code` (5 incidents) | **10/10** | 8/8 | 9/9 |
| `boundary_configuration` (4) | 0/8 | 0/6 | **1/7** |

- **`direct_code` is saturated.** Every arm is perfect. The baseline is also
  cheapest and fastest. Nothing left to measure here.
- **`boundary` is near-dead.** 1 of 21. The one success is `raw_liveprobe` on
  409 seed 10, which produced the exact required chain
  `neo4j-productdb → recommendation → frontend → frontend-proxy` rooted at
  `neo4j-productdb` with status `HANDOFF`. So the stratum **is** solvable and
  LiveProbe is the only arm that has solved it. 20 of 21 runs stop at
  `recommendation` while `neo4j` sits in the logs.
- **Graph has no accuracy advantage over the bare agent and costs 1.5×.**

All 6 invalid runs share one cause — the LiveProbe service not staying
registered — and hit **only LiveProbe arms**, only on 407 and 412 (bootstrap
crash and logic-slow). *You cannot attach a probe to a service that will not
stay up.* Under the harsher scoring that counts these as failures, which is
what a user experiences, graph drops to 44%, below the baseline.

---

## 3. The strategic finding

**The answer key has no line-level slot.** Verified directly against the
oracle: fields are `entity`, `kind`, `propagation`, `expected_statuses`;
**0 of 9 incidents carry a `locations` field**, and every root kind it can
express is `Service`.

This is not a defect to fix. It is structural across the RCA benchmark family —
ITBench scores over `kind`+`name`, AIOpsLab's submission is
`submit(faulty_components: list[str])`. **LiveProbe's differentiator is
line-level precision; these benchmarks score at service granularity, so the
precision is invisible by construction.**

It was first recorded as "D2 — RCL is vacuous" in `PRE_REGISTRATION.md` and
treated as a fixable bug. That reading was wrong.

Compounding it: the C1 fix that published the `kind` enum turned arms' `"code"`
answers into `"Service"`. Correct for the contract, and it erased the one place
an arm was expressing sub-service precision.

**Fault-population mismatch,** from ITBench's own classification of its 30
incidents: 47% marked as ones LiveProbe should not start on (9 ConfigMap, plus
NetworkChaos/StressChaos/JVMChaos/Pod/Deployment), 33% expect a boundary
handoff, **20% expect in-process localization**. And ITBench hands the agent
the faulty source, so reading beats observing.

`LANDSCAPE.md` has the full survey. Key external points:
- No published measurement supports large token savings from breakpoint-style
  agent debugging. Microsoft's Debug2Fix measured tokens going **up ~400K**.
- Best with/without-debugger control (debug-gym, SWE-bench Lite) is mixed:
  Claude 3.7 37→52%, but **GPT-4o got worse** (19.1→17.2).
- The one published token win is **SieveFL, −49% input tokens on Defects4J**,
  from using runtime *coverage to prune candidates before the model reads* —
  not from capturing values. That is what our static graph should claim.
- An OpenRCA study concluded *"the bottleneck is not data access but the
  agent's ability to reason over it"* — independently matching our own finding
  that **18 of 21 boundary failures had the needed entity already in the run's
  own tool output**.

---

## 4. Defects found and fixed (all verified, with evidence)

| # | Defect | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | Cross-incident evidence leakage | 8/9 snapshots carried earlier incidents; 407's traces held 401's `AttributeError` and all five 407 runs diagnosed it | window anchored to injection (600 s → 65–190 s) + assertion; `e629128` |
| 2 | K8s events unwindowed | survived fix 1; assertion caught it | events windowed; `f335b68` |
| 3 | Propagation edge set unpublished | 21/23 failures were RCR-only, 20 missing the same edge | contract published; `2691ca8` |
| 4 | `kind` scored against hidden vocabulary | all r10 arms scored 0 | schema enum; `4c3e853` |
| 5 | Broker client had no retry, then too short a window | r13 lost 5/16 LiveProbe calls to `broker_unreachable` | 5 attempts / ~4.5 s; `f851705` |
| 6 | `get_probe_data` self-aborting long poll | **self-inflicted** by the wait default | deadline includes poll window; `69cfd2b` |
| 7 | Investigation view 31 KB/call | 86% of graph's payload | compact default, 70,874 → 5,357 B; `d4d1141` |
| 8 | `start_probe_investigation` named no continuation tool | only 4/13 runs reached probe deployment | description states it; `69cfd2b` |
| 9 | Tool surface bloat | `$schema` ×18, `maximum: 9007199254740991` ×17, a 194-token regex | 7,797 → 6,758 tokens; `1020bc0` |

**Changes tried and reverted:** a probe entry gate telling the agent to skip
probing when evidence sufficed. It suppressed probing everywhere — 0/9 runs
deployed a probe, including on boundary faults where probing is the point.
Reverted in `b8f71fc`. The flaw was structural: it asked the agent to judge its
own evidence sufficiency, and agents are overconfident.

---

## 5. Corrections to earlier reporting

Recorded because several were reported to the owner before being caught:

- **"Graph wins 13/18 vs 8/18" (r13) was an artifact** of contamination plus
  the unpublished edge contract. Clean, the gap disappears.
- **"LiveProbe is ~1.5× faster on direct_code" (r11) was withdrawn** — those
  arms had barely invoked LiveProbe (raw deployed 0 probes across 9 incidents).
- **"8 of 9 snapshots contaminated" conflated** real trace leakage with
  Kubernetes rollout history. Both were real; only the first changed diagnoses.
- **"Replay is broken, all replays returned HTTP 500"** — wrong, from a
  subagent, caught on verification. All 8 executed replays returned valid trace
  IDs; 500 is the *replayed request's* status and is expected.
- **`model_samples` is `tool_calls + 1`,** not a provider turn count. Earlier
  tables showed it as an independent "turns" column; it is not.
- **Tool surface was estimated at ~9,284 tokens via bytes/4.** Real ratio is
  4.46 B/token; actual was 7,797.

---

## 6. Not done

- **Forced-probe experiment.** Arms built and verified (`graph-noprobe` strips
  6 tools, 18 → 13) but never produced data: first attempt hit a transient
  unhealthy pod, second was killed to fix contamination first. **Now likely
  uninformative** — `direct_code` is saturated and `boundary` is at ~0, so both
  strata are degenerate and it would probably measure 0 vs 0.
- **Boundary investigation ("option A").** Read the 21 boundary traces to
  determine whether agents retrieved `neo4j` evidence and discarded it, or never
  looked. Zero-cost. Recommended **against** doing on its own merits — it
  improves a benchmark we should stop optimising against — but it is cheap and
  its answer transfers to any new benchmark.
- **7 of 16 incidents permanently excluded**: 402, 405, 406, 413–416. The
  released artifact and published images have drifted; every tag was hashed
  against every locked source and no tag matches. Not a performance exclusion.
- `apply_investigation_decision` was **never called once** in 33 graph runs
  despite being the documented way to advance an investigation. Deliberately not
  removed — it looks like a workflow defect, not dead weight.
- 6 of 18 graph tools uncalled, 2,802 tokens (41% of surface). Capability
  question, not a size one.

---

## 7. Recommendation

1. **Stop optimising against ITBench.** It cannot reward line-level precision.
2. **Reposition from capture to pruning.** "Cut the candidate set before the
   model reads" is measurable, has a published number to beat (SieveFL −49%),
   and matches where our graph already helps — graph's boundary wins came from
   *non-probing* runs, i.e. from structure, not observation.
3. **Move to a line-granularity benchmark**: Defects4J / GitBug-Java, where
   SieveFL, LLM4FL and Debug2Fix have published controls we can be compared
   against fairly rather than a test we authored.
4. Honest caveats: code bugs are 21–27% of cloud incidents, and 77% of
   production failures reproduce in a unit test where a free local debugger
   beats a probe fabric. The defensible wedge is narrower and specific —
   Microsoft Teams found **70% of incidents with no monitor were code bugs**.
   Not "debugging", but "debugging where telemetry is absent".

---

## 8. Infrastructure

- VM `liveprobe-praxis-eval`, zone `us-east1-b`, project `liveprobeeval`.
  **Stop it when idle; never delete it.**
- Codex auth is API-key mode (`~/.codex/auth.json`, `auth_mode: apikey`). The
  ChatGPT plan quota was exhausted and resets **Aug 5**. **The API key was
  pasted into a session transcript — rotate it.**
- `evaluation/praxis/scripts/check-eval-progress.sh` reports status from any
  machine.
- Port-forwards: `bash /home/veer/forwards.sh` (broker 7070, ingress 8080,
  frontend 8081). Prometheus path is `/prometheus/api/v1/...`.
- **Killing a campaign mid-incident leaves the cluster dirty.** Recovery:
  `cd <artifact>/itbench-lite-ae/sre && env PATH=/home/veer/LightProbe/.venv/bin:$PATH INCIDENT_NUMBER=<n> make remove_incident_fault`,
  then wait for alerts to drain. `ansible-playbook` is only in the venv.
- Campaigns require incident 401 in the set as the runtime tripwire.
- Artifacts under `results/artifacts/` are gitignored and live on this machine
  and the VM only. `oracle/fault-locations.json` is scorer-only; regenerate with
  `python/build_fault_locations.py`, never commit.
- Gates: `node --test evaluation/praxis/test/contracts.test.mjs` (40 pass,
  1 skip) and `npx vitest run` in `packages/mcp-server` (47 pass).

## 9. Method rules that still bind

`PRE_REGISTRATION.md` is the anti-gaming contract. The rule that has mattered
most: **where an answer fails a check, state the contract the check enforces —
do not relax the check.** `scoreDiagnosis` has never been modified. Guidance
changes have twice produced large unintended behavioural swings, so they are
the highest-risk category, not the cheapest.
