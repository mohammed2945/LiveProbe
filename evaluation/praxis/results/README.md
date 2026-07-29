# PRAXIS × LiveProbe evaluation results

Generated from checked result artifacts. Report SHA inputs: `777cda42eff79087`.

## Four-arm leaderboard

**Not run.** This machine does not satisfy the released PRAXIS cluster requirements, so no model accuracy, benchmark time, or model-token comparison is reported. The fixture and static checks below are tripwires only.

## Zero-token validation

| Gate | Result | Measured value | Benchmark claim? |
| --- | --- | ---: | --- |
| Required local gates | PASS | 31/31 | No |
| Analyzer tests | PASS | 41 passed in 3.18 s | No |
| MCP server build | PASS | 0.49 s | No |
| MCP server tests | PASS | 22 passed in 4.10 s | No |
| Evaluation contracts | PASS | 20/20 passed in 2.66 s | No |
| Released PRAXIS artifact compatibility | PASS | 16/16 incident graphs; 36/36 checks | No |
| Static LiveProbe compatibility | PASS | 16/16 variants in 2.36 s | No |
| Synthetic fixture tripwire | PASS | 12/12; 0 model calls | No |
| Remote host eligibility | BLOCKED | darwin, 8 CPUs, 16 GiB | No |

The static gate compiled and indexed the exact Git checkout for every incident 401–416, detected required gRPC plus HTTP/socket boundaries, rejected known false HTTP positives, constructed causal graphs, generated canonical legal probes, recorded typed simulated occurrences, and preserved deferred frontiers.

Across the 16 variants it built 19–23 graph nodes per criterion and 30 initial canonical probe sites in 2.36 s. This is static compatibility evidence, not runtime or model benchmark evidence.

## Why the real campaign is pending

- platform must be linux
- at least 16 CPU cores are required
- at least 32 GiB RAM is required
- kind is required
- helm is required
- released PRAXIS Python dependencies are required

The paid campaign intentionally stops before any model call or cluster mutation unless the remote host passes. On a conforming host, incident 401 must also pass two pre-paid runtime contracts: the LiveProbe path (exact source heartbeat, graph, canonical probe deployment, correlated replay, typed values, and preserved alternatives) and a deterministic traversal of the released PRAXIS loop with its incident-specific program graph.

## Interpretation rules

- Synthetic fixtures validate contracts only; they are never merged into leaderboard accuracy.
- The official oracle is generated after all model attempts and is scorer-only.
- All arms receive the same immutable real incident snapshot in the controlled leaderboard.
- Failed setup or arm attempts remain in the selected denominator; failures and timeouts are reported.
- Probe evidence is correlated to a replay occurrence. Uncorrelated logs and metrics rank hypotheses but do not eliminate them.
- Direct-code incidents require `LOCALIZED`; external-boundary incidents accept evidence-backed `HANDOFF` or `LOCALIZED`, with root, location, propagation, and evidence checks unchanged.
- `gpt-5.4-mini` with low reasoning is the cost-controlled default. Public claims additionally require a pinned model snapshot.
