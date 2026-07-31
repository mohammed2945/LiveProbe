# LANDSCAPE — is LiveProbe aimed at the right problem?

Survey date: 2026-07-31. All URLs fetched on that date unless noted.
Repository facts (ITBench fault library, AIOpsLab problem registry) were counted
directly from `main` on 2026-07-31, not taken from papers, and the counting
commands are given so they can be re-run.

**Reading rule used throughout.** Every number below is tagged:
`[M]` measured and published with methodology, `[C]` counted by me from a public
repo, `[A]` analyst projection, `[V]` vendor claim with no disclosed method.
Where I could not find evidence I say so instead of estimating.

---

## 0. The short answer

The measured finding that prompted this survey is not an artifact of a bad run.
It is what the benchmark's own construction predicts, and three independent
structural facts explain it:

1. **ITBench's fault library is a Kubernetes-misconfiguration library.** Of the
   30 fault mechanisms shipped in `scenarios/sre/library/indexes/faults/`,
   **29 are control-plane, network, scheduling, service-mesh or resource
   faults**. Exactly one (`18.json`, "OpenTelemetry Demo Feature Flag") reaches
   into application code, and it does so by flipping a key in the `flagd-config`
   ConfigMap. `[C]`
2. **The answer key has no line-level slot.** ITBench scores fault localization
   with NTAM over entities (`kind` + `name`); AIOpsLab's localization action is
   `submit(faulty_components: list[str])` — a list of *service names*. An agent
   that knows the exact faulty line and the exact bad value cannot score above an
   agent that names the right service. The R11 finding that `kind: "code"` was
   *unscoreable* is the benchmark telling you this directly. `[C]`
3. **The one application-level fault family is source-annotated.** The OTel
   astronomy shop's feature-flag faults (`productCatalogFailure`,
   `cartServiceFailure`, `recommendationServiceCacheFailure`, …) are hand-written
   `if (flag) { fail }` branches sitting in the repository. A source-reading
   agent does not need to observe anything; it needs to grep. `[M]`

So the LiveProbe-vs-coding-agent result on 9 incidents is the *expected* result,
not a disappointing one. It is evidence about the benchmark at least as much as
about the tool.

The harder question — *where would runtime value observation be necessary?* —
has a defensible answer, but the honest version is narrower than the pitch:

> Runtime value observation is decisive when **(a) the failure is
> non-deterministic or environment-dependent so the same source produces both
> outcomes, or (b) the value that discriminates the hypotheses is derived at
> runtime and never serialised anywhere, and (c) the ground truth is at
> line/value granularity so knowing more precisely actually scores.**
> Almost no existing benchmark satisfies all three. The ones that come closest
> are flaky-test and concurrency corpora, not SRE incident suites.

---

## (a) Candidate benchmark table

"Runtime state decisive?" is my judgement, with the reason stated. It is not
from the papers.

### Incident-response / cloud RCA

| Benchmark | Size | Fault taxonomy | Source given to agent? | Failure reproducible on demand? | Runtime state plausibly decisive? |
|---|---|---|---|---|---|
| **ITBench SRE** (IBM, [arXiv:2502.05352](https://arxiv.org/abs/2502.05352), 7 Feb 2025; ICML 2025) | 94 scenarios across SRE/CISO/FinOps; SRE fault library = 30 mechanisms `[C]` | 29/30 mechanisms are k8s/infra/mesh/scheduling/resource; 1 is an OTel demo feature flag `[C]`. Leaderboard categories: "Change, Configuration Setting, Resource Saturation, Resource Unavailable, Latency, Other" | **No.** [ITBench-SRE-Agent](https://github.com/IBM/ITBench-SRE-Agent) ships kubectl + Prometheus + Jaeger + ClickHouse. No source tool. | Yes — live cluster, Ansible/AWX fault injection | **No.** Entity-granularity answer key; fault lives in declarative objects |
| **AIOpsLab** (MSR, [arXiv:2501.06706](https://arxiv.org/abs/2501.06706), 12 Jan 2025; MLSys 2025) | Paper v1: 48 problems, 10 fault types. Registry on `main` 2026-07-31: **101 problem instances / 34 unique fault scenarios** `[C]` | 12 of 34 are `astronomy_shop_*` (feature-flag app faults); rest are k8s target-port misconfig, chaos pod/network, MongoDB auth, operator faults, Flower FL, kernel fault `[C]` | **No.** Action API is `get_logs`, `get_metrics`, `get_traces`, `exec_shell` | Yes — live Kind/remote cluster + workload generator + push-button injector | **No.** `submit(faulty_components: list[str])` is service-granular |
| **OpenRCA** (ICLR'25, [microsoft/OpenRCA](https://github.com/microsoft/OpenRCA)) | 335 failures, 3 enterprise systems (Telecom, Bank, Market), 68 GB telemetry | Component + "reason" labels; no config-vs-code split published | **No** | **No** — frozen offline telemetry, nothing to attach to | **No.** Structurally excluded: there is no running process |
| **RCAEval** ([arXiv:2412.17015](https://arxiv.org/abs/2412.17015); ASE'24/WWW'25/FSE'26) | 735 cases; RE1 375, RE2 270, RE3 90 | **11 fault types, and it is the only RCA suite with an explicit code-level family**: 4 resource, 2 network, **5 code-level** (incorrect parameter value, missing parameter, missing function call, incorrect return value, missing exception handler) `[M]` | Not stated in repo docs | **No** as shipped — datasets are downloaded recordings (`download_re3_dataset()`), no live re-injection path documented | **Would be**, if re-injected live. See §(c) A3 |
| **Train Ticket fault replication** ([FudanSELab](https://github.com/FudanSELab/train-ticket-fault-replicate); underlying study Zhou et al., *TSE* 47(2):243–260, 2021) | 22 faults replicated from an industrial survey | Mixed: JVM/Docker memory-limit mismatch, config, code | Yes (OSS system) | Yes — deployable | **Partly.** Small; several faults are config-level |
| **Chaos-Mesh-derived suites** (used inside AIOpsLab, ITBench `21.json`, RCAEval) | n/a | CPU/mem/disk/network/pod-kill by construction | n/a | Yes | **No.** Chaos Mesh cannot express a wrong in-process value |

### Code / debugging benchmarks

| Benchmark | Size | Fault taxonomy | Source given? | Failure reproducible on demand? | Runtime state plausibly decisive? |
|---|---|---|---|---|---|
| **SWE-bench Verified** ([swebench.com/verified](https://www.swebench.com/verified.html)) | 500 human-validated instances, 12 Python repos | Real GitHub issues; no taxonomy | **Yes**, full repo + Docker | Partially — **fail-to-pass tests are withheld**; the agent must write its own reproduction | **Sometimes.** debug-gym shows +11 to +20 pts for strong models (below) |
| **SWE-bench-Live** ([arXiv:2505.23419](https://arxiv.org/abs/2505.23419)) | 1,319 at release → 1,890 tasks / 223 repos; post-2024 issues, +50/month | Real issues | Yes, per-instance Docker | Same as above | Same as above; contamination-resistant, so cleaner |
| **SWE-Gym** ([arXiv:2412.21139](https://arxiv.org/abs/2412.21139)) | 2,438 instances, 11 Python repos | Real issues | Yes, executable env + tests | Yes | Training corpus, not an eval; useful for *training* probe use |
| **Defects4J v2.0** | 835 bugs, 17 Java projects | Real bugs, curated | Yes | **Yes — deterministic failing test ships with each bug** | **Yes.** The standard FL/APR substrate; SieveFL measured a 49% token cut from runtime coverage here |
| **BugsInPy** (ESEC/FSE 2020) | 493 bugs, 17 Python projects | Real bugs | Yes | Yes | Yes, same reasons |
| **GitBug-Java** (MSR 2024, [arXiv:2402.02961](https://arxiv.org/abs/2402.02961)) | 199 bugs, 55 repos, 2023 commits | Real bugs | Yes | **Yes — full Docker state saved from the repo's own GitHub Actions** | **Yes.** Debug2Fix already published a with/without-debugger control here |
| **QuixBugs** (SPLASH 2017) | 40 single-line algorithmic bugs, Python + Java | Off-by-one, wrong comparison, etc. | Yes | Yes | **No.** Single-line, single-file; reading beats probing |
| **RunBugRun** ([arXiv:2304.01102](https://arxiv.org/abs/2304.01102); *EMSE* 2026) | 456,750 executable instances, 8 languages | Fine-grained bug-type labels; 29% single-token fixes | Yes | Yes, fully executable | **No.** Competitive-programming scale; too small to need a debugger |
| **DebugBench** ([arXiv:2401.04621](https://arxiv.org/abs/2401.04621), ACL Findings 2024) | 4,253 instances, C++/Java/Python | 4 major / 18 minor types (Syntax, Reference, Logic, Multiple) | Yes | Yes | **No, and it is contaminated by construction** — bugs were *implanted by GPT-4* into LeetCode solutions |
| **BigCodeBench-R / LiveCodeBench-R** (from InspectCoder) | 607 / 151 buggy LLM-generated solutions | LLM self-generated defects | Yes | Yes | Weakly. Single-file self-repair; strongest published dynamic-analysis gains sit here, which is itself a warning |
| **SEC-bench** (NeurIPS 2025, [arXiv:2506.11791](https://arxiv.org/abs/2506.11791)) | 200 real CVEs, 29 C/C++ projects | Memory-safety (UAF, overflow), high CVSS | Yes, containerised repo + harness | **Yes — PoC reproduces the crash** | **Yes** — but C/C++, which LiveProbe does not support |
| **JaConTeBe** (ASE 2015) | 47 real Java concurrency bugs | Atomicity/order violations, deadlock | Yes | **Almost-deterministically**, via supplied interleaving tests | **Yes.** Source is identical in pass and fail runs |
| **ReproFlake** ([arXiv:2605.21677](https://arxiv.org/abs/2605.21677), 20 May 2026) | 1,115 flaky tests, 4 failure categories, repro scripts + fix scripts + pass/fail logs | Flakiness root-cause categories | Yes | **Yes — that is the entire point of the dataset** | **Yes, strongest case in the whole table.** See §(c) A2 |

**The pattern.** Runtime state is plausibly decisive in exactly the corpora where
the source is *fully available and still insufficient* (flaky, concurrency,
memory-safety) — and is plausibly *irrelevant* in every cloud-RCA suite, because
those suites inject config faults and grade at service granularity.

---

## (b) How common are problems that need runtime observation?

This is the section where I most want to avoid inventing a number. There is
**no published study that measures how often an incident required inspecting an
in-process variable that was absent from logs and traces.** I searched for one
and did not find it. What exists are proxies, and they point in *both*
directions.

### Evidence that argues FOR runtime observation

**1. Code bugs are exactly where telemetry is thinnest.** Ghosh et al.,
*How to Fight Production Incidents? An Empirical Study on a Large-scale Cloud
Service*, SoCC 2022 (Best Paper), 152 severe Microsoft Teams incidents `[M]`:

- ~40% of incidents were bugs (27% code, 13% configuration); ~60% were
  non-code/non-config (infrastructure, deployment, dependencies).
- **70% of incidents where no monitor existed were code bugs.**
- **54% of incidents with poor telemetry coverage were root-caused to code bugs.**
- 29% were reported by external users, 10% by internal users — i.e. ~39% were
  not caught by monitoring at all.

This is the single best datum for the LiveProbe thesis. The class of incident
that observability misses is disproportionately the class LiveProbe targets.
It is still a proxy: "no monitor existed" is not the same as "an in-process
value would have answered it."

**2. Some failures produce wrong values and no error at all.** Meta,
*Silent Data Corruptions at Scale* ([arXiv:2102.11245](https://arxiv.org/abs/2102.11245),
Feb 2021) and Google, *Cores that don't count*, HotOS 2021 `[M]`: individual
CPU cores compute incorrect results silently, at rates "much higher than
software engineers expect," and both papers describe thousands of engineering
hours to localise. There is no log line, no trace span, and no source defect.
Comparing computed values against expectation *is the only detection channel*.
Rare, but it is the clean existence proof that static reading cannot always win.

**3. Concurrency defects are value-visible and source-invisible.** Lu et al.,
ASPLOS 2008 `[M]`: 97% of non-deadlock concurrency bugs are atomicity or order
violations; 66% involve a single variable. The source of a racing program is the
same on the run that works and the run that fails; the *interleaving and the
variable's value* are the discriminator.

### Evidence that argues AGAINST it

**4. Most production failures reproduce offline.** Yuan et al.,
*Simple Testing Can Prevent Most Critical Failures*, OSDI 2014, 198 user-reported
failures across Cassandra/HBase/HDFS/MapReduce/Redis `[M]`:

- **77% are reproducible by a unit test**; 74% are deterministic.
- 98% manifest on ≤3 nodes; 84% on ≤2.
- **84% had all triggering events already logged** (median 824 log messages per
  failure).

If three quarters of failures reproduce in a unit test, then for three quarters
of failures a *local* debugger — free, no broker, no production blast radius —
strictly dominates a distributed probe fabric. This is the most damaging single
statistic for a production-probing product and it should not be buried.

**5. The base rate of code bugs in cloud incidents is ~21–27%, and shrinking as a
share of *fixes*.** Azure OpenAI Service incident study
([arXiv:2504.08865](https://arxiv.org/abs/2504.08865), Jun 2020–Feb 2024) `[M]`:
Infrastructure 27.2%, Configuration 24.5%, **Code Bugs 21.5%**, External Usage
14.1%, Operation Errors 12.7%. Mitigation breakdown: **Code Fix only 7.6%**;
rollback 15.2%, config fix 13.0%, self-recover 19.7%. Teams study agrees: ~40%
of incidents were bugs but only 21% of mitigations were bug fixes, because
"it takes substantial time to go through the process of fixing bugs during
mitigation."

The addressable slice is therefore roughly **one incident in five**, before you
subtract the ones whose in-process value is already in a log or a trace.

**6. On the RCA benchmarks, the bottleneck is measured to be reasoning, not
evidence.** Gopal & Krishnan, *How Far Can Root Cause Analysis Go on Real-World
Telemetry Data?* ([arXiv:2607.13548](https://arxiv.org/abs/2607.13548),
15 Jul 2026) `[M]` built a reverse-reasoning agent that, given the correct
answer, checks whether the pipeline *had* the discriminating signal. Verbatim:

> "This analysis reveals that the required evidence is present in the vast
> majority of failures: the bottleneck is not data access but the agent's
> ability to reason over it correctly. […] Reasoning performance remains
> practically bounded even when evidence extraction is perfect: scaffold
> engineering and better data pipelines alone cannot close this gap."

Independently, Liu et al., *An Empirical Study on Failures in Automated Issue
Solving* ([arXiv:2509.13941](https://arxiv.org/abs/2509.13941), Sep 2025), 150
manually analysed SWE-bench-Verified failures `[M]`: agentic failures are
dominated by "flawed reasoning and cognitive deadlocks"; "Superficial
Information Matching" accounts for ~51% of localization failures.
Reproduction/verification failure (C1) is ~24%.

**Adding a new evidence channel does not repair a reasoning bottleneck.**
If LiveProbe's pitch is "the agent lacked evidence," these two papers are the
counter-hypothesis and they are the ones with measurement behind them.

### Net answer

Best defensible estimate, stated as a range with its derivation rather than a
point:

- **Upper bound ~21–27%** of production cloud incidents are code bugs at all
  (Azure OpenAI 21.5%, Teams 27%).
- Of those, **~77% would reproduce in a unit test** (Yuan OSDI'14), where a
  local debugger is cheaper and safer than a production probe.
- The genuinely production-only residue — non-deterministic, data-shape,
  environment-derived, third-party-behaviour — is therefore **plausibly in the
  low single-digit percent of incidents**, but it is over-represented in the
  incidents that have no monitor (Teams: 70%) and in long-MTTR incidents.

That is a real market. It is not a 20% market, and a claim of 20% is not
supported by anything I found.

---

## (c) Published evidence on debugger / runtime tooling for LLM agents

This is the best-evidenced part of the landscape, and it does not say what the
pitch says.

### The one clean with/without-debugger control: debug-gym

Microsoft Research, [arXiv:2503.21557](https://arxiv.org/abs/2503.21557),
27 Mar 2025; [MSR blog](https://www.microsoft.com/en-us/research/blog/debug-gym-an-environment-for-ai-coding-tools-to-learn-how-to-debug-code-like-programmers/),
10 Apr 2025. Gives an agent `pdb`. Benchmarks: Aider (easy function-level),
Mini-nightmare (hand-crafted), SWE-bench Lite (300 real issues). `[M]`

**SWE-bench Lite, % resolved — `rewrite` (no debugger) → `debug` (pdb) → `debug(5)`:**

| Model | rewrite | debug | debug(5) |
|---|---:|---:|---:|
| Claude 3.7 Sonnet | 37.2 ± 2.1 | **48.4 ± 1.6** | **52.1 ± 1.6** |
| o1-preview | 10.7 ± 0.7 | **30.2 ± 1.0** | 30.8 ± 0.9 |
| o3-mini | 8.5 ± 1.0 | **22.1 ± 0.9** | 19.8 ± 1.1 |
| Llama 3.3-70B | 2.4 ± 0.5 | 4.0 ± 1.0 | 4.8 ± 0.4 |
| GPT-4o | 19.1 ± 2.4 | **17.2 ± 0.8** (worse) | 23.6 ± 1.0 |
| GPT-4o-mini | 4.0 ± 0.7 | **3.5 ± 0.7** (worse) | 6.2 ± 0.1 |

**Aider (easy tasks) — the debugger is neutral-to-harmful:** GPT-4o 76.4 → 69.7;
o1-preview 90.5 → 89.0; o3-mini 95.2 → 95.2; DeepSeek-R1-Qwen-32B 82.7 → 82.0.

Three conclusions, all of them constraints on LiveProbe:

- The debugger only pays on **hard, real-world, repository-scale** tasks. On easy
  tasks it costs more than it returns.
- It only pays for **capable models**. Two of nine models got *worse* with pdb.
- MSR's own explanation for the modest ceiling: "we believe this is due to the
  scarcity of data representing sequential decision-making behavior (e.g.,
  debugging traces) in the current LLM training corpus." That is a *training*
  gap, not a tooling gap — and it means a better probe API does not fix it.

### Other published gains, ordered by how much I trust them

| Work | Date | Benchmark | Gain | Trust |
|---|---|---|---|---|
| **Debug2Fix** (Microsoft, [arXiv:2602.18571](https://arxiv.org/abs/2602.18571)) | Feb 2026 | GitBug-Java (186), SWE-bench-Live (400) | GitBug-Java GPT-4o 60.2→73.1 (+21.8% rel), Haiku 4.5 71.0→82.3, Sonnet 4.5 75.7→85.5. SWE-bench-Live GPT-4o 31.2→36.2, Sonnet 4.5 39.6→40.4 (+2.0% rel) | **High.** Independent group, real bugs, per-model controls |
| **SieveFL** ([arXiv:2605.13491](https://arxiv.org/abs/2605.13491)) | May 2026 | Defects4J v1.2.0 (395 bugs) | Top-1 41.8%, +2.1 pp over AgentFL. **Runtime branch coverage pruning: candidates 398.8→187.2 (−53%), input tokens 190.1K→97.4K (−49%), wall-clock 5.07→4.05 min/bug, no Top-1 loss** | **High** for the efficiency claim |
| **InspectCoder** ([arXiv:2510.18327](https://arxiv.org/abs/2510.18327)) | Oct 2025 | BigCodeBench-R (607), LiveCodeBench-R (151) | 67.87% vs LDB 64.58% (+5.10% rel); 12.58% vs 7.95% (+60.37% rel). 20.07 vs 11.97 fixes/hour; ~2–3¢/repair | **Medium.** Self-repair of LLM-generated single-file code — the easiest possible setting for dynamic analysis |
| **VulDebugger** ([arXiv:2504.07634](https://arxiv.org/abs/2504.07634)) | Apr 2025 | 50 real projects | 60% fix rate, "significantly outperforms SOTA" | Medium; small n |
| **DebugHarness** ([arXiv:2604.03610](https://arxiv.org/abs/2604.03610)) | Apr 2026 | SEC-bench (C/C++ CVEs) | ~90% patched, ">30% over SOTA baselines" | Medium; single-paper claim on a hard benchmark |
| **LLM4FL** | 2024–25 | Defects4J v2.0 (675 faults) | +18.55% Top-1 over AutoFL, +4.82% over SoapFL | Medium |
| **Kodezi Chronos** ([arXiv:2507.12482](https://arxiv.org/abs/2507.12482)) | Jul 2025 | Self-defined 5,000-scenario "MRR"; SWE-bench Lite | Claims **80.33% SWE-bench Lite** and 67.3% vs 14.2% for Claude 4.1 Opus | **Do not cite as evidence.** Vendor paper; model gated behind "Kodezi OS Q1 2026"; 500 of 5,000 benchmark samples released; no independent reproduction found |

### On the specific claim in the brief

> *"virtual-breakpoint style tooling yields large token/time reductions"*

**I could not find a published measurement supporting this.** What I found:

- **The nearest positive result is SieveFL's −49% input tokens** — and it comes
  from using runtime *branch coverage* to prune the candidate set before the LLM
  reads anything. It is not from capturing variable values at a breakpoint. If
  LiveProbe wants to claim a token win, *this* is the mechanism the literature
  supports: use runtime data to shrink what the model reads, not to add to it.
- **The one paper that actually measured tokens for breakpoint-style debugging
  found they went up.** Debug2Fix: for Claude Sonnet on GitBug-Java the main
  agent's tokens decreased but the debug subagent added ~400K tokens on average,
  and the authors state plainly: *"we don't measure the computational cost of
  running the debugger itself."*
- InspectCoder's efficiency claim is **fixes-per-hour** (1.67×–2.24×), i.e.
  wall-clock, not tokens.
- debug-gym publishes no token accounting at all.
- The popular blog framing ("print-debugging burns thousands of tokens") is
  qualitative. The most-cited example
  ([shmulc.substack.com](https://shmulc.substack.com/p/give-your-agent-a-breakpoint))
  contains **zero** quantitative claims and its author explicitly writes
  "I think it's less useful than it sounds" and notes Haiku found his example bug
  *without* a debugger. `[V]`

This aligns exactly with r11's own result: wall-time gains on log-silent
incidents (1.52×, 1.83× vs baseline), weighted tokens favouring the baseline
everywhere. **The literature says the honest claim is time, not tokens** — unless
the mechanism is changed to candidate-set pruning à la SieveFL.

### Record-replay / time-travel

- **Undo** ships an MCP server exposing UDB time-travel debugging to agents
  ("Undo AI", Tech Preview); CTO Mark Williamson's talk *Agentic Debugging with
  Time Travel* is the reference. **No benchmark, no published numbers.** `[V]`
- **rr / Pernosco**: no LLM-agent evaluation found.
- *Get Experience from Practice: LLM Agents with Record & Replay*
  ([arXiv:2505.17716](https://arxiv.org/abs/2505.17716)) is about replaying
  *agent* trajectories, not program state. Different problem.

---

## (d) Commercial landscape — what the market actually buys

| Product | Status | What it is sold for | Evidence quality |
|---|---|---|---|
| **Rookout** | Acquired by Dynatrace 31 Jul 2023 | Cloud-native production debugging | — |
| **Dynatrace Live Debugger** | Introduced Perform Jan 2025; **GA announced 29 May 2025** | "Non-breaking breakpoints" in production; entry point is a **Davis AI problem event** linking straight into the debugger. Framed around MTTR for issues that "stretch debugging cycles for weeks" | `[V]` marketing; no benchmark |
| **Datadog Dynamic Instrumentation** | Mostly GA; "capture method parameters and local variables" **In Preview** | Production troubleshooting when logs/traces are insufficient. Probe types: log, metric, span, span-tag. Java/Python/.NET/Node/Ruby/PHP/Go | `[M]` for its documented **limits**: log probes ≤5000/s per instance; **full capture rate-limited to 1 hit/s**; references followed **3 levels deep**, first **100** collection items, **255** chars per string, **20** object fields. No AI/agent integration documented on that page |
| **Lightrun** | Active; $110M raised (Accel, Insight); AT&T, Citi, Microsoft, Salesforce, SAP named. **25 Feb 2026: "industry's first AI SRE with live dynamic runtime context."** Named in 2026 Gartner Market Guide for AI SRE Tooling | **This is LiveProbe's thesis, shipped.** Explicit pitch: let AI agents "create missing evidence dynamically without redeployments," "prove root causes with live execution data (ground truth)" | `[V]` **Zero quantitative claims** in the launch coverage — no MTTR figure, no benchmark, no methodology. Support is an IDC analyst quote and a customer testimonial |
| **Thundra Sidekick** | **Dead.** GitHub repo header reads "Sidekick is no longer in service" | Was: open-source live application debugger | — |
| **Honeycomb** | Active | **The opposite bet.** Wide structured events instrumented ahead of time — 300–400 dimensions per event for a mature service — so you never need to go back and add a probe. Explicitly: "anything that puts pressure on your developer to collect less detail […] is the devil" | `[V]` philosophy, widely adopted |
| **Gartner** | 2026 Market Guide for AI SRE Tooling | Projects **85% of enterprises using AI SRE tooling by 2029, up from <5% in 2025** | `[A]` **Analyst projection. Not a measurement.** Treat as market narrative |

**What the market tells you.**

1. Every dynamic-instrumentation product without exception sells into
   **production incident response / MTTR for the service owner**. Not dev-time
   debugging (that is what an IDE debugger is for, free), and not agent token
   efficiency (nobody sells that).
2. **Standalone live debuggers do not survive as standalone products.** Rookout
   was absorbed into an APM platform; Sidekick died; Lightrun is a decade-old
   company that just repositioned as "AI SRE" after $110M. The distribution
   channel is the observability platform, and the platform vendors now own the
   feature.
3. **Lightrun's Feb 2026 launch means LiveProbe is not first, and the incumbent
   has $110M and five named F500 logos.** The differentiator cannot be "probes
   for agents." It has to be either the static causal/value-flow graph that
   *proposes where to probe* (which no incumbent ships) or a domain where the
   incumbents do not play.
4. **Nobody has published a number.** Not Dynatrace, not Datadog, not Lightrun,
   not Undo. The entire commercial category runs on assertion. That is an
   opportunity: a rigorous with/without measurement on a public benchmark would
   be the first of its kind in this category.

---

## (e) Where is runtime observation genuinely irreplaceable?

For each: can a competent static-source-reading agent (with logs + traces) get
there?

| Class | Could a source-reading agent get there? | Evidence |
|---|---|---|
| **Heisenbugs / non-determinism** | **No, in principle.** The source is byte-identical on the passing and failing run. The discriminator is the interleaving and the values it produced. | Weissenbacher et al., *A Formalization of Heisenbugs and Their Causes*, SEFM 2023: heisenbugs "stem from interactions with environmental entropy" |
| **Concurrency / data races** | **No.** 97% are atomicity or order violations; 66% involve one variable (Lu et al., ASPLOS'08). Reading the source shows the *possibility*; only observation shows which interleaving occurred | JaConTeBe (47 bugs) exists precisely because reproducing these is "non-trivial" |
| **Values derived from config/env at runtime** | **Usually yes**, and this is the trap. `kubectl get cm -o yaml` and `printenv` are cheaper than a probe. Only when the value is *computed* from several sources (merged defaults, feature flag × tenant × region) does observation add anything | Yin et al., SOSP'11: 27% of customer cases are config; 12.2–29.7% of parameter mistakes are **inconsistencies between parameter values** — that subclass is where derivation matters |
| **Production-only data shapes** | **No.** The shape only exists in production traffic. A schema drift, an unexpected null, a unit mismatch, a tenant whose payload is 100× the median — none is in the source | Breck et al., *Data Validation for Machine Learning*, MLSys 2019 (TFX, petabytes/day at Google) exists because this class is real and undetectable statically; Shankar et al., *"We Have No Idea How Models will Behave in Production until Production"* ([arXiv:2403.16795](https://arxiv.org/abs/2403.16795)) |
| **ML / data-pipeline value corruption** | **No.** Silent NaN, drifted feature distribution, wrong dtype — all execute cleanly and produce wrong answers | Same as above; plus the SDC literature (Meta 2021, Google HotOS'21) as the hardware analogue |
| **Cross-service contract mismatch** | **Often yes** — an OTel span attribute or an error body usually names the mismatch. **No** when the mismatch is a *shape* rather than a *status*: a field silently absent, a string where a mapping was expected, a `None` that flows three hops before erroring. This is precisely the `type_shape` criterion in `liveprobe-compatibility.json` | Weak public evidence; I found no study quantifying this class |
| **Third-party library behaviour** | **Mixed.** Source is usually available (OSS) but the *effective* behaviour depends on version, config, and lazily-initialised state. Reading a vendored dependency is expensive in tokens; probing its return value is cheap | No study found. Stated as a hypothesis |
| **Silent data corruption / mercurial cores** | **No, absolutely not.** No error, no log, no source defect | Meta [arXiv:2102.11245](https://arxiv.org/abs/2102.11245); Google *Cores that don't count*, HotOS'21 |
| **State-dependent bugs (Nth request, cache growth, leak)** | **Partly.** Metrics show the aggregate (RSS climbing); only in-process observation shows *which* structure grew and what is in it. AIOpsLab's `recommendation_service_cache_failure` is literally an exponentially growing cache | Real class; no quantification found |

**Honest summary of §(e):** four classes are genuinely irreplaceable —
non-determinism, concurrency, production-only data shapes, and silent value
corruption. Three are "sometimes" — cross-service shape mismatch, derived
config, third-party behaviour. Two are usually solvable statically —
declarative config and single-file logic bugs.

---

## (f) Three-to-five alternative applications, each with a fair test

Ranked by strength of the fairness argument. "Fair" here means: **both arms get
the same source, the same logs, the same budget; the answer key is external to
both; and the benchmark was not chosen because LiveProbe wins on it.**

### A1 — Flaky / non-deterministic test-failure diagnosis (strongest)

**Benchmark:** ReproFlake, [arXiv:2605.21677](https://arxiv.org/abs/2605.21677)
(20 May 2026) — 1,115 flaky tests across 4 failure categories, shipping a
reproducible compile environment, failure-reproduction scripts, fix scripts, and
**paired passing and failing execution logs**. Fallback/complement: IDoFT
(largest public flaky corpus, continuously updated) and JaConTeBe (47 Java
concurrency bugs with near-deterministic triggers).

**Why it is fair, not rigged.**
- The source is fully available to *both* arms and is **identical on the passing
  and failing run**. This is the only benchmark family where "just read the
  source" is provably insufficient by construction, and the reason is a property
  of the dataset, not a choice of mine.
- The answer key is the developer's real fix and the community-assigned
  root-cause category — external to both arms.
- ReproFlake ships pass/fail logs, so the log-only baseline is *strong*, not
  strawmanned.
- LiveProbe already supports the two dominant flaky-test languages (JVM via JDI,
  Python via `sys.monitoring`).

**The pre-registered risk that keeps it honest:** many flaky causes
(order-dependent, async-wait) are diagnosable from test code alone —
iDFlakies found 50.5% order-dependent. **Results must be broken out by
root-cause category**, and the headline must be the category-weighted average,
not the best category. If LiveProbe only wins on Concurrency/NOD, say so.

### A2 — Runtime-guided fault localization with a token budget (best-controlled)

**Benchmark:** Defects4J v2.0 (835 Java bugs) and/or BugsInPy (493 Python bugs);
GitBug-Java (199) as the contamination-resistant replication.

**Why it is fair.** There are already **three independent published controls** on
this exact substrate — SieveFL (Defects4J v1.2.0, 395 bugs), LLM4FL (Defects4J
v2.0, 675 faults), Debug2Fix (GitBug-Java, 186). LiveProbe does not get to pick
the metric: Top-1/Top-5 accuracy and input-token count are already the
convention, and SieveFL published the exact numbers to beat (Top-1 41.8%,
97.4K input tokens/bug after pruning).

**Why this is the right test of the *graph*, not just the probe.** SieveFL's
measured 49% token cut came from *pruning the candidate set with runtime
coverage before the model reads anything*. LiveProbe's static causal/value-flow
graph plus a probe is the same shape of idea with a stronger signal (values, not
just coverage). This is the one place where the "large token reduction" claim
has a published mechanism, a published baseline, and a published number.

**The trap to avoid:** Defects4J is well-known to be in training corpora and has
documented data-cleanliness problems for fault localization
([arXiv:2310.19139](https://arxiv.org/abs/2310.19139)). **Report GitBug-Java
(2023 commits) and SWE-bench-Live (post-2024 issues) alongside**, or the result
is uninterpretable.

### A3 — Live re-injection of RCAEval's code-level fault family

**Benchmark:** RCAEval RE3 — **90 cases with 5 genuinely code-level fault types**
(incorrect parameter value, missing parameter, missing function call, incorrect
return value, missing exception handler) across Online Boutique, Sock Shop and
Train Ticket. This is the **only** microservice RCA taxonomy I found that
contains value-level faults.

**Why it is fair.** The fault taxonomy was defined by an independent group, for
independent reasons, before LiveProbe existed. "Incorrect return value" and
"missing parameter" are *exactly* the `type_shape` criterion in
`liveprobe-compatibility.json` — but LiveProbe did not choose them.

**The honest caveat, which is significant.** RCAEval as shipped is **offline
recorded telemetry** (`download_re3_dataset()`); there is no documented live
re-injection path. Using it therefore requires **rebuilding the injection harness
against the live systems**, which is exactly the kind of work that invites
rigging. Mitigations that must be pre-registered:
- Re-implement injection from RCAEval's published fault descriptions *only*,
  before running any arm.
- Score against RCAEval's own root-cause-service + root-cause-indicator labels,
  not a new rubric.
- Publish the injection code and report the offline-telemetry baseline numbers
  (CIRCA 0.46, RCD 0.54 Avg@5 on RE2 Train Ticket) so the live results are
  anchored to something external.

### A4 — Production-only data-shape failures (real class, no benchmark exists)

**The class:** a request whose payload shape only occurs in production traffic —
a tenant with an unexpected null, a drifted feature distribution, a serialisation
that returns a list where a mapping was expected. Static reading cannot get
there, because the shape is not in the source.

**Evidence the class is real:** Breck et al., *Data Validation for Machine
Learning*, MLSys 2019 (deployed in TFX, "hundreds of product teams", petabytes
of production data validated per day) — an entire production system exists
because this class is undetectable statically. Shankar et al.,
[arXiv:2403.16795](https://arxiv.org/abs/2403.16795), interview study titled
*"We Have No Idea How Models will Behave in Production until Production."*

**Evidence for the agentic version: none. I found no benchmark.** Saying so is
the point. If this is the direction, the deliverable is *building* the benchmark
— which is a legitimate contribution, since it would be the first — but it must
be pre-registered and the fault taxonomy must be derived from a published
incident study (e.g. the Teams or Azure OpenAI taxonomies) rather than from what
LiveProbe can probe. Otherwise it is rigged by construction and will be read
that way.

### A5 — Memory-safety / vulnerability repair (adjacent; needs a language extension)

**Benchmark:** SEC-bench (NeurIPS 2025) — 200 real CVEs, 29 C/C++ projects,
containerised, **PoC reproduces the crash on demand**. Best published agent
results: 18.0% PoC generation, 34.0% patching — a very low ceiling, so headroom
is real. DebugHarness already published a dynamic-debugging result here
(~90% patched, ">30% over baselines") which gives an external control.

**Why fair:** ground truth is the upstream security patch; the crash is
deterministic; source is available to both arms.

**Why I rank it last:** **LiveProbe supports Node/Python/JVM, not C/C++.**
Pursuing this means a native agent, which is a different product. Listed for
completeness because it is the single best-constructed "runtime state is
decisive" benchmark in existence, not because it is reachable today.

---

## (g) Where the evidence says this is NOT the right tool

Blunt section, as requested.

**1. Kubernetes control-plane RCA. Stop.** 29 of 30 ITBench fault mechanisms and
the large majority of AIOpsLab's 34 scenarios are declarative-object faults. The
correct probe is `kubectl get <obj> -o yaml`. No in-process value can be more
informative than the object that caused the fault. This is not a tuning problem;
it is a category error.

**2. Any benchmark whose answer key is service-granular.** ITBench scores NTAM
over `kind`+`name`; AIOpsLab's localization action is
`submit(faulty_components: list[str])`. **There is no slot in the answer for a
line or a value.** Precision above the answer-key granularity is unrewarded by
construction. R11's `kind: "code"` being unscoreable was the benchmark refusing
the tool's output format, and the fix (emitting `kind: "Service"`) is a fix that
makes LiveProbe's extra precision *invisible*. That should be read as a signal,
not a bug.

**3. Offline telemetry benchmarks.** OpenRCA (335 failures, 68 GB) and RCAEval
as shipped have no running process. LiveProbe cannot compete there at all. Any
comparison on them is a comparison of the surrounding agent, not the tool.

**4. Faults that are annotated in the source.** The OTel astronomy shop's
feature flags are hand-written failure branches guarded by a flag. A grep beats a
probe. This is exactly the measured 9-incident result and it will reproduce on
any astronomy-shop-derived suite, including AIOpsLab's 12 `astronomy_shop_*`
scenarios.

**5. Anywhere the failure reproduces in a unit test.** 77% of production failures
in Yuan et al. OSDI'14 do. For those, a local `pdb`/`jdb` is free, safe, and
has no broker, no sanitisation, no rate limit, and no 423-byte socket-reset
retry path. A distributed probe fabric must justify itself against a *local
debugger*, not against "reading the source."

**6. Easy tasks and weak models.** debug-gym: on Aider the debugger is
neutral-to-negative for 7 of 8 models; on SWE-bench Lite it made GPT-4o
(19.1→17.2) and GPT-4o-mini (4.0→3.5) *worse*. If LiveProbe is deployed behind a
cost-optimised small model, expect harm, not help.

**7. The token-reduction story, as currently framed.** No published measurement
supports it. The one paper that measured tokens for breakpoint-style debugging
(Debug2Fix) found them going *up* by ~400K per run for the subagent. r11's own
data agrees: weighted tokens favoured the baseline in every arm and every
incident. **Claim wall-time, or change the mechanism to SieveFL-style candidate
pruning and claim tokens with a measurement.** Claiming tokens on the current
mechanism is a claim the field will check and disprove.

**8. "The agent lacked evidence" as the framing.** Two independent 2025–26
measurement papers say the bottleneck is reasoning:
[arXiv:2607.13548](https://arxiv.org/abs/2607.13548) (evidence present in the
vast majority of OpenRCA failures) and
[arXiv:2509.13941](https://arxiv.org/abs/2509.13941) (agentic failures dominated
by flawed reasoning and cognitive deadlocks; 51% of localization failures are
"superficial information matching"). A new evidence channel does not fix
reasoning. If LiveProbe's story is evidence scarcity, it needs its own
reverse-reasoning analysis showing the discriminating value was *absent*, not
merely unused — that analysis is cheap and it is the single highest-value
experiment available.

**9. Competing on "probes for agents" alone.** Lightrun shipped that on
25 Feb 2026 with $110M behind it and Gartner recognition. The defensible
difference is the **static causal/value-flow graph that proposes where to
probe** — no incumbent ships probe-site selection — and that is what should be
measured, ideally in the SieveFL framing (does the graph shrink what the model
must read?).

---

## (h) What I could not find — stated so it is not mistaken for absence of interest

- **No study quantifying how often an incident required an in-process value that
  was absent from logs and traces.** The Teams study's "70% of no-monitor
  incidents were code bugs" is the closest proxy and it is a proxy.
- **No published token-cost measurement for breakpoint-style agent tooling that
  shows a reduction.** Only SieveFL (coverage-based pruning, −49%) and Debug2Fix
  (increase).
- **No independent evaluation of any commercial dynamic-instrumentation product.**
  Dynatrace, Datadog, Lightrun and Undo all publish assertions only.
- **No benchmark for agentic diagnosis of production-only data-shape failures.**
- **No benchmark for live, in-process value observation on a running distributed
  service with line-level ground truth.** This is the gap LiveProbe's evaluation
  is implicitly trying to fill, and building it is a legitimate contribution —
  but it cannot be built out of ITBench.
- **Kodezi Chronos's claims are unreproduced.** Model gated, 10% of the benchmark
  released, no third-party replication found. Do not cite it.
- **The ITBench SRE resolution rate is reported inconsistently** across versions:
  the arXiv v1 abstract says 13.8% SRE / 25.2% CISO / 0% FinOps; other summaries
  of the same paper say 11.4% / 25.2% / 25.8%. Cite the version you read.

---

## Sources

Benchmarks and datasets:
- [ITBench: Evaluating AI Agents across Diverse Real-World IT Automation Tasks (arXiv:2502.05352)](https://arxiv.org/abs/2502.05352)
- [itbench-hub/ITBench (fault library, SRE leaderboard)](https://github.com/itbench-hub/ITBench)
- [IBM/ITBench-SRE-Agent](https://github.com/IBM/ITBench-SRE-Agent)
- [AIOpsLab: A Holistic Framework to Evaluate AI Agents for Enabling Autonomous Clouds (arXiv:2501.06706)](https://arxiv.org/abs/2501.06706)
- [microsoft/AIOpsLab](https://github.com/microsoft/AIOpsLab)
- [OpenRCA (ICLR'25)](https://github.com/microsoft/OpenRCA)
- [RCAEval (arXiv:2412.17015)](https://arxiv.org/abs/2412.17015) · [phamquiluan/RCAEval](https://github.com/phamquiluan/RCAEval)
- [FudanSELab/train-ticket-fault-replicate](https://github.com/FudanSELab/train-ticket-fault-replicate)
- [SWE-bench Verified](https://www.swebench.com/verified.html) · [SWE-bench Goes Live! (arXiv:2505.23419)](https://arxiv.org/abs/2505.23419) · [SWE-Gym (arXiv:2412.21139)](https://arxiv.org/abs/2412.21139)
- [GitBug-Java (arXiv:2402.02961)](https://arxiv.org/abs/2402.02961) · [RunBugRun (arXiv:2304.01102)](https://arxiv.org/abs/2304.01102) · [DebugBench (arXiv:2401.04621)](https://arxiv.org/abs/2401.04621)
- [SEC-bench (arXiv:2506.11791)](https://arxiv.org/abs/2506.11791) · [A Dataset of Reproducible Flaky-Test Failures (arXiv:2605.21677)](https://arxiv.org/abs/2605.21677)
- [JaConTeBe (ASE 2015)](https://mir.cs.illinois.edu/marinov/publications/LinETAL15JaConTeBe.pdf)
- [Back to the Future! Data Cleanness in Defects4J (arXiv:2310.19139)](https://arxiv.org/abs/2310.19139)

Debugger / runtime tooling for agents:
- [debug-gym (arXiv:2503.21557)](https://arxiv.org/abs/2503.21557) · [MSR blog, 10 Apr 2025](https://www.microsoft.com/en-us/research/blog/debug-gym-an-environment-for-ai-coding-tools-to-learn-how-to-debug-code-like-programmers/) · [TechCrunch coverage](https://techcrunch.com/2025/04/10/ai-models-still-struggle-to-debug-software-microsoft-study-shows/)
- [Debug2Fix (arXiv:2602.18571)](https://arxiv.org/abs/2602.18571)
- [SieveFL (arXiv:2605.13491)](https://arxiv.org/abs/2605.13491)
- [InspectCoder (arXiv:2510.18327)](https://arxiv.org/abs/2510.18327)
- [VulDebugger / Agent That Debugs (arXiv:2504.07634)](https://arxiv.org/abs/2504.07634)
- [DebugHarness (arXiv:2604.03610)](https://arxiv.org/abs/2604.03610)
- [Kodezi Chronos (arXiv:2507.12482)](https://arxiv.org/abs/2507.12482) — vendor claim, unreproduced
- [Undo: Agentic Debugging with Time Travel](https://undo.io/all-types/videos/agentic-debugging-with-time-travel/)

Measurement of where the bottleneck is:
- [How Far Can Root Cause Analysis Go on Real-World Telemetry Data? (arXiv:2607.13548)](https://arxiv.org/abs/2607.13548)
- [An Empirical Study on Failures in Automated Issue Solving (arXiv:2509.13941)](https://arxiv.org/abs/2509.13941)
- [Understanding Code Agent Behaviour (arXiv:2511.00197)](https://arxiv.org/abs/2511.00197)
- [ORACLE-SWE (arXiv:2604.07789)](https://arxiv.org/abs/2604.07789)

Incident and failure base rates:
- [How to Fight Production Incidents? (SoCC 2022, Microsoft Teams, 152 incidents)](https://www.microsoft.com/en-us/research/publication/how-to-fight-production-incidents-an-empirical-study-on-a-large-scale-cloud-service/)
- [An Empirical Study of Production Incidents in Generative AI Cloud Services (arXiv:2504.08865)](https://arxiv.org/abs/2504.08865)
- [Simple Testing Can Prevent Most Critical Failures (OSDI 2014)](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf)
- [An Empirical Study on Configuration Errors (SOSP 2011)](https://www.sigops.org/s/conferences/sosp/2011/current/2011-Cascais/printable/12-yin.pdf)
- [Learning from Mistakes: concurrency bug characteristics (ASPLOS 2008)](https://www.cs.columbia.edu/~junfeng/09fa-e6998/papers/concurrency-bugs.pdf)
- [Silent Data Corruptions at Scale, Meta (arXiv:2102.11245)](https://arxiv.org/abs/2102.11245) · [Cores that don't count, Google (HotOS 2021)](https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s01-hochschild.pdf)
- [Data Validation for Machine Learning (MLSys 2019)](https://research.google/pubs/data-validation-for-machine-learning/) · [We Have No Idea How Models will Behave in Production until Production (arXiv:2403.16795)](https://arxiv.org/abs/2403.16795)

Commercial:
- [Dynatrace to Acquire Rookout (31 Jul 2023)](https://www.dynatrace.com/news/press-release/dynatrace-to-acquire-rookout/) · [Dynatrace Live Debugger GA (29 May 2025)](https://ir.dynatrace.com/news-events/press-releases/detail/381/dynatrace-unveils-live-debugger-to-transform-cloud--and-ai-native-debugging-process) · [Dare to debug production](https://www.dynatrace.com/news/blog/dare-to-debug-production-with-dynatrace-live-debugger/)
- [Datadog Dynamic Instrumentation docs](https://docs.datadoghq.com/tracing/trace_collection/dynamic_instrumentation/)
- [Lightrun launches AI SRE with live dynamic runtime context (25 Feb 2026)](https://itbrief.news/story/lightrun-unveils-ai-sre-tool-for-live-runtime-debugging)
- [runsidekick/sidekick — "Sidekick is no longer in service"](https://github.com/runsidekick/sidekick)
- [Honeycomb: Structured Events Are the Basis of Observability](https://www.honeycomb.io/blog/structured-events-basis-observability)
- [Gartner Market Guide for AI SRE Tooling, 2026 (vendor summaries)](https://komodor.com/blog/komodor-named-a-representative-vendor-in-the-2026-gartner-market-guide-for-ai-site-reliability-engineering-tooling/)
- [OpenTelemetry Demo feature flags](https://opentelemetry.io/docs/demo/feature-flags/)

### Reproducing the repo counts

```sh
# ITBench: 30 SRE fault mechanisms, with names
for i in $(seq 1 30); do
  curl -sL "https://raw.githubusercontent.com/itbench-hub/ITBench/main/scenarios/sre/library/indexes/faults/$i.json" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('$i', d.get('name'))"
done

# AIOpsLab: 101 problem instances / 34 unique fault scenarios
curl -sL https://raw.githubusercontent.com/microsoft/AIOpsLab/main/aiopslab/orchestrator/problems/registry.py \
| grep -oE '"[a-zA-Z0-9_-]+-(detection|localization|analysis|mitigation)(-[0-9]+)?"' | sort -u | wc -l
```
