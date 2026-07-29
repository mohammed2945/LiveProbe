---
name: liveprobe-raw-investigation
description: Use LiveProbe's manual snapshot, log, counter, and metric probes after observability has narrowed an incident to a deployed service and failing occurrence. Use when a coding or SRE agent must inspect correlated runtime values without LiveProbe's causal analyzer graph, legal-action frontier, or automatic probe-location generation.
---

# Raw LiveProbe Investigation

Protocol compatibility: `liveprobe-raw-investigation/v1.1`.

Use observability to find the failing service, operation, deployed revision, and trace or replay identity before adding probes. Raw LiveProbe supplies runtime values; it does not select a causal path or validate probe locations for you.

## Establish a criterion

Start with:

- an exact runtime `service_id`;
- the deployed Git commit and matching local checkout;
- a failing trace or reproducible occurrence;
- a file, executable line, and value whose origin or mutation matters.

Do not start with a repository-wide symptom. Inspect the deployed source and trace path until you can state a falsifiable hypothesis.

## Choose observations deliberately

Read source before selecting a probe. Prefer the smallest group of executable sites whose values distinguish the current hypotheses:

- a value immediately after creation or mutation;
- both sides of a suspected boundary;
- a branch input and the first branch-specific output;
- a mutable-state or feature-flag read;
- a value before and after an unresolved dynamic call.

It is valid to keep reading and following source through several intermediate functions before deploying anything. Do this when the current values merely repeat known state or a later location will separate the hypotheses more directly.

Use `set_snapshot_probe` for typed values. Use log, counter, or metric probes only when their output answers the hypothesis without losing necessary type or structure. Supply only watch paths visible at that exact executable line.

Raw probe locations are model-selected and therefore unvalidated. Recheck the deployed revision, source path, line, and lexical scope before deployment. Never copy locations from benchmark ground truth, another arm, or a different source revision.

## Run a correlated loop

1. Call `list_services` and preserve its exact `serviceId` and revision metadata.
2. Deploy a small probe batch for the current hypothesis. If the observability replay tool supports preparation, first call `replay_incident` with `prepare_only=true`, then copy its returned `trace_id` into `correlation_trace_id` so unrelated hot-path traffic cannot spend the Python runtime's probe capacity. Never invent this identity; omit the filter if it cannot be known before arming.
3. Wait until every probe is armed; remove and correct probes that report an error.
4. Replay the registered failing occurrence with the prepared identity. In the evaluation harness, call `replay_incident` again with the exact returned `prepared_replay_id`.
5. Call `get_probe_data` and retain only snapshots carrying that identity.
6. Compare the observed values with the hypothesis. Eliminate a path only with correlated evidence.
7. Read more source or add the next discriminating probes. Do not mechanically instrument every line.
8. Repeat with a fresh replay when confirming the final mechanism.
9. Remove all probes when finished.

Keep unobserved values `UNKNOWN`. A missing snapshot is not a false value: check arm state, service and commit mapping, executable coverage, replay propagation, and correlation first.

## Rank evidence

1. A typed probe value from the correlated replay is hard evidence.
2. A log carrying the same trace identity is near-hard; the probe wins on conflict.
3. Uncorrelated logs, metrics, deploy history, and source plausibility are soft priors. They rank the next observation but do not eliminate hypotheses.

Do not substitute an existing log for an affordable probe when mutation timing or revision identity matters.

## Stop honestly

Return:

- `LOCALIZED` after a fresh correlated replay confirms the earliest statement that creates the faulty value;
- `HANDOFF` when the evidence reaches an unsupported service, library, datastore, configuration, or ownership boundary;
- `INSUFFICIENT` when the occurrence cannot be reproduced or correlated, the relevant fact is an absence, or no affordable observation distinguishes the remaining explanations.

Report every probe location as model-selected raw-LiveProbe evidence. Do not describe it as graph-validated.
