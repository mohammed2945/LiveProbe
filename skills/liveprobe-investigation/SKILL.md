---
name: liveprobe-investigation
description: Use LiveProbe's persistent runtime-guided investigation tools to trace an observability-derived service, file, line, value, and occurrence criterion to a runtime-confirmed code cause or an honest boundary or insufficient result. Use when a coding or SRE agent already has metrics, logs, traces, and deploy context and needs correlated runtime values and causal provenance rather than more log speculation.
---

# LiveProbe Investigation

Protocol compatibility: `liveprobe-investigation/v1.2`.
Expected decision packet protocol: `liveprobe-adaptive-v2`.

Use LiveProbe after observability has answered where to begin. Treat it as the runtime-value and causal-provenance layer of an incident investigation, not as a replacement for metrics, logs, or traces.

## Establish the starting criterion

Use traces, logs, metrics, and deploy history first to identify:

- the failing service and endpoint;
- one failing occurrence or trace identity that can be replayed or correlated;
- the exact deployed commit;
- a repository-relative file and executable line;
- the value or expression whose runtime provenance matters.

Do not start LiveProbe cold with a broad repository or symptom. Do not remain in a log-guessing loop after a concrete criterion exists.

Prepare the exact deployed checkout with `prepare_repository_analysis`, then call `start_probe_investigation`. Use `list_services` when service IDs or runtime source roots need discovery. Preserve the returned `investigation_id` and `revision`.

## Rank evidence correctly

Apply this evidence order:

1. Probe evidence from the correlated occurrence is hard evidence. It may eliminate a hypothesis.
2. A log carrying the same trace identity is near-hard evidence. Prefer the probe if the two conflict.
3. Uncorrelated logs or metrics, metric anomalies, and recent deploys are soft priors. Use them only to rank choices; never use them to eliminate a hypothesis.

Observability may re-enter after investigation start as:

- a filter: trace spans may show that a static branch did not execute;
- a soft prior: metrics or deploy history may rank a frontier that exceeds the probe budget or remains ambiguous.

Do not submit log IDs or metric IDs as LiveProbe `evidence_refs`.

## Run the investigation loop

1. Read the current view from `start_probe_investigation`, `get_investigation_context`, or the preceding mutation.
2. Auto-traverse a unique causal chain by choosing its returned `FOLLOW_PATH` action.
3. At each frontier, choose between structural expansion and runtime observation. Treat graph expansion as cheap navigation and probes as costed interventions.
4. Expand without probing when an exact legal `FOLLOW_PATH` action continues a unique, trace-confirmed, or already evidence-supported direction and a later frontier is likely to be more discriminating. This is especially useful when the current sites are intermediate, repeat an established value, or sit before the branch, boundary, or mutation that matters.
5. After expanding, refresh the investigation and use its new actions and `probe_bundle`; never deploy the stale bundle from the prior revision. Repeating legal expansion for several steps before probing is valid.
6. Observe now when runtime values are needed to choose between plausible paths, when the frontier reaches branches, service or library boundaries, feature flags, mutable-state reads, unresolved dynamic calls, or when further expansion would merely encode a guess.
7. When observing, deploy the whole current bundle with `deploy_investigation_probes` if it fits the budget. If the observability replay tool supports preparation, call `replay_incident` with `prepare_only=true`, then copy its returned `trace_id` into `correlation_trace_id`; this keeps unrelated hot-path traffic from spending the Python runtime's probe capacity. Never invent that identity. If no replay identity can be known before arming, omit the filter and correlate retained evidence after replay. Seek the smallest returned observation set that can change the next decision. Do not replace a probe needed to distinguish current hypotheses with a logged value: the log may precede mutation or come from another revision.
8. Execute the failing request with the same propagated correlation identity. For a prepared evaluation replay, call `replay_incident` again with the exact returned `prepared_replay_id`. Collect only the matching occurrence with `collect_investigation_evidence`.
9. Let the correlated evidence choose among the current legal actions. Use soft priors only when the frontier is too wide or the evidence is ambiguous.
10. Call `apply_investigation_decision` with the exact current `revision` as `based_on_revision` and exact `action_id` values from the current `actions` menu.
11. Repeat until the result is `LOCALIZED`, `HANDOFF`, or `INSUFFICIENT`.

Do not probe mechanically at every frontier. A good AI SRE spends probes where the answer can alter the causal path, and uses legal graph traversal to move past low-information intermediates. Conversely, do not keep expanding merely because probing costs a replay: if the selected direction depends on an unobserved runtime fact, observe it or keep the alternatives `UNKNOWN`.

Use `get_investigation_result` for the terminal report. Remove deployed probes when the investigation is complete.

## Use only legal actions

The action vocabulary for protocol `liveprobe-investigation/v1.2` is:

- `FOLLOW_PATH`: traverse a returned causal path.
- `PROBE_REGION`: observe returned region ports or frontier outputs.
- `INSPECT_MECHANISM`: move from localized value flow to the supplied mechanism anchors.
- `CONFIRM_CANDIDATE`: test a supplied candidate using pre-registered predictions and a fresh replay.
- `COMPLETE_LOCALIZATION`: finish using returned evidence observation IDs.
- `HANDOFF_BOUNDARY`: stop at an ownership or system boundary with evidence.

Treat `actions` as a menu, not a template. Never construct an action ID, probe file, line, expression, watch path, traversal ID, candidate anchor, or mechanism prediction from source reading. Probe locations must come from the current canonical `probe_bundle`, whose sites are built from graph nodes and region ports.

If a server returns a different protocol or action vocabulary, follow the current tool output and its documentation instead of translating or inventing actions. Update this skill before using the new vocabulary in evaluation.

## Keep unknowns unknown

`UNKNOWN` means no mechanical check has fired and no pre-registered hypothesis has been tested for the correlated occurrence. It is not an invitation to infer a value from code, naming, model prior, or an unrelated log.

Resolve an `UNKNOWN` by:

- proposing a falsifiable hypothesis using the supplied legal mechanism choices or predicates;
- deploying the resulting legal probe bundle and replaying the occurrence; or
- asking the human for an unavailable oracle or semantic fact.

Never turn `UNKNOWN` into a verdict by assertion.

## Confirm and stop honestly

At mechanism inspection, choose only supplied candidates and predicates. Confirm a candidate with a fresh failing replay; do not reuse the discovery occurrence as confirmation. Complete localization only with observation IDs supplied by evidence-recorded decision events.

Stop with:

- `LOCALIZED` when correlated evidence confirms a code cause and finer detail would not distinguish the remaining explanations;
- `HANDOFF` when the causal path reaches an external, unsupported, or differently owned boundary;
- `INSUFFICIENT` when the required signal is an absence, a semantic value has no mechanical oracle, the occurrence cannot be correlated, or finer probing cannot distinguish the remaining explanations.

## Recover from rejected calls

- Stale revision: call `get_investigation_context`, use its latest `revision`, and select again from its current `actions`.
- Illegal or unavailable action: refresh context and choose an exact current action ID; do not repair the ID.
- Budget exceeded: choose a smaller returned cut, reduce supplied confirmation predictions, or rank the legal frontier with soft priors.
- Missing capture: verify the deployed commit and service mapping, arm state, replay propagation, and correlation identity; do not reinterpret absence as a value.
- Unsupported correlation filter runtime: exact pre-capture filtering currently requires a service reporting `sdk=python`; omit the filter or hand off instead of assuming another runtime honored it.
