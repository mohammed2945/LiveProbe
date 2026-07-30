# Resume checkpoint — campaigns r11 and r12

**Both campaigns are COMPLETE and written up. The VM is stopped, not deleted.**
Results are in `results/README.md`; defects in `R11_FINDINGS.md`; the
anti-gaming contract that governs every change is `PRE_REGISTRATION.md`.

Bottom line: **LiveProbe shows no time or token gain — it is 14–23% slower and
35–58% more expensive.** Its value is capability on boundary/configuration
faults, where the baseline scores 0/8 and raw LiveProbe scores 3/8 with 7/8
localization. On direct code faults the baseline wins on all three axes.

To pick this work back up, start the VM, re-run `/home/veer/forwards.sh` to
rebuild the port-forwards, and see "Known open items" below.

## Final state (2026-07-30)

| Thing | Value |
| --- | --- |
| Local and remote | `praxis-eval`, in sync |
| VM `HEAD` | `f851705`, worktree clean, MCP server rebuilt |
| VM | `liveprobe-praxis-eval`, `us-east1-b`, `liveprobeeval`, **TERMINATED (stopped, not deleted)** |
| Campaign r11 | COMPLETE, 36/36 scored |
| Campaign r12 | COMPLETE, 54/54 scored |
| Cluster at shutdown | clean image, 1/1 ready, 0 probes, 0 firing alerts, replay HTTP 200 |

Artifacts for both campaigns are under `results/artifacts/` and are
**gitignored** by the repo's existing convention (`results/*`), so they live
only on this machine and on the VM disk. Regenerate the scorer-only
`oracle/fault-locations.json` with `python/build_fault_locations.py`; never
commit it.

r11 validated the metric repair. Its efficiency comparison was **withdrawn**:
its LiveProbe arms barely invoked LiveProbe (F0). r12 fixed that and is the run
that actually tests LiveProbe — and it **reversed** r11's apparent signal.

tmux sessions on the VM: `r11` (the campaign), plus `broker-forward` (7070),
`ingress-forward` (8080), `frontend-forward` (8081). The three forwards are
self-restarting loops; `kubectl port-forward` binds one pod and dies when a
broker rollout replaces it.

## Exact resume procedure

1. `gcloud compute instances describe liveprobe-praxis-eval --zone us-east1-b
   --project liveprobeeval --format='value(status)'`. If `TERMINATED`, start it,
   then re-run `/home/veer/forwards.sh` to rebuild the port-forwards, and treat
   r11 as interrupted (see step 3).
2. Push the unpushed local commit: `git push origin praxis-eval`.
3. Check r11: `tmux ls` and `python3 /home/veer/r11-status.py` on the VM.
   - Still `RUNNING` → let it finish. Watch with
     `until ... grep -q 'CAMPAIGN DONE' /home/veer/r11.log; do sleep 120; done`.
   - `campaign=COMPLETE` → go to step 4.
   - Session gone without `CAMPAIGN DONE` → r11 was interrupted. The campaign
     writes resume state into `campaign.json`; re-running `/home/veer/run-r11.sh`
     will refuse because the results directory exists. Decide explicitly whether
     to resume or to start a fresh directory, and record the choice.
4. Collect and analyse (all local, zero tokens):
   ```
   gcloud compute ssh liveprobe-praxis-eval --zone us-east1-b \
     --project liveprobeeval --command \
     "cd /home/veer/praxis-campaign-r11 && tar czf /tmp/r11.tgz ."
   gcloud compute scp liveprobe-praxis-eval:/tmp/r11.tgz . \
     --zone us-east1-b --project liveprobeeval
   python3 evaluation/praxis/python/build_fault_locations.py \
     --artifact-root .eval-cache/praxis/438709b4b4b43467ec384de8ee398b2cc75f2e495a57514fd57784021af7814f \
     --output evaluation/praxis/oracle/fault-locations.json
   python3 evaluation/praxis/python/analyze_campaign.py \
     --campaign <r11>/campaign.json \
     --fault-locations evaluation/praxis/oracle/fault-locations.json
   ```
   `fault-locations.json` is gitignored and scorer-only; regenerate it, never
   commit it.
5. Run wave r12 — already staged on the VM as `/home/veer/deploy-r12.sh` and
   `/home/veer/run-r12.sh`, both guarded to refuse while `r11` is alive.
   `deploy-r12.sh` pulls to local HEAD and rebuilds the MCP server, which is
   what applies F1 and F2. `run-r12.sh` is 9 incidents × 3 arms × seeds 10,20 =
   54 runs at `--tier=pilot` (250,000 tokens, 30-minute wall).
6. Write results, run tests, commit, push, clean the cluster, and **stop but do
   not delete** the VM.

## Standing constraints (unchanged, still binding)

- Do **not** delete the VM or the GCP project.
- Do **not** raise the 50,000 cap for r11. The owner approved a higher budget
  **only** for `normal_coding_sre`, `raw_liveprobe` and `graph_liveprobe` in the
  separate r12 wave. PRAXIS stays at 50,000.
- Preserve the six unrelated worktree changes: `demo/ride-analysis/README.md`
  modified, and untracked `.cursor/`, `.vscode/`, `demo/investor/`,
  `demo/ride-analysis/CURRENT_UNKNOWN_FIRST_ARCHITECTURE_TRACE.md`,
  `demo/ride-analysis/GRAPH_LIVEPROBE_INEFFICIENCIES_FIXED.md`.
- Never `git reset --hard`, `git checkout --` broadly, or run bulk cleanup.
- Oracle stays scorer-only: never mounted into an agent working directory,
  prompt, or MCP response.
- Owner wants the **final report extremely brief** — only the relevant numbers.

## Owner decisions on record

- PRAXIS is a sanity check, not the comparison of interest. If it exceeds
  budget, mark it and move on; do not re-run it.
- The comparison that matters is `normal_coding_sre` vs `raw_liveprobe` vs
  `graph_liveprobe`, on **time and tokens**. Accuracy is a gate, not the
  headline.
- Raising the budget substantially for those three arms is acceptable.

## What r11 already establishes

The contract repair works. r10 scored **0/4 on every incident**; r11's three
coding arms now satisfy RCI, RCR, terminal and evidence-backed, with `kind`
`Service`, bare-identifier entities, and service-level propagation edges.
`scoreDiagnosis` was never modified.

Emerging efficiency result over 24 scored-eligible runs — **a wall-time gain
only, no token gain**:

| | normal | graph | raw |
| --- | ---: | ---: | ---: |
| `direct_code` median wall | 78.2 s | 51.6 s | 42.8 s |
| `boundary_configuration` median wall | 65.1 s | 81.9 s | 89.2 s |
| median weighted tokens | 27,308 | 38,270 | 35,808 |

LiveProbe is ~1.5–1.8× faster on direct code faults, **slower** on
boundary/config faults, and costs 30–40% more tokens everywhere. Localization:
graph 5/5, normal 5/6, raw 5/6, PRAXIS 0/5.

Do not present a token multiplier. 86% of input is cached, so the tool-surface
reductions (F1/F3) save only ~1,497 weighted tokens once per run. The real
token lever is **tool response payload size** (F7 in `R11_FINDINGS.md`), which
is untested.

## Unattended driver (r13 / r14) — running since 2026-07-30

`/home/veer/driver.sh` runs in tmux session `driver` on the VM and survives the
laptop closing. It runs two waves back to back:

- **r13** — the measurement wave. 9 incidents × 3 arms × seeds 10,20, 250k cap,
  with every fix from `d4d1141`, `69cfd2b` and `4bf253c` applied.
- **r14** — pure replication, seeds 30,40. Statistics only, no judgment.

r14 starts only if r13 finished mechanically clean (exit 0 and 54/54 results).
Anything needing a human writes `/home/veer/NEEDS_ATTENTION` and stops rather
than guessing.

Check progress from any machine:

```
evaluation/praxis/scripts/check-eval-progress.sh
```

It prints `DRIVER_STATUS`, any `NEEDS_ATTENTION`, whether the driver is alive,
and per-wave run counts. The driver appends a per-arm and per-stratum summary
to `DRIVER_STATUS` as each wave completes, so the headline numbers are readable
without re-running the analyser.

On resume: run the check script, then collect artifacts and analyse exactly as
in the procedure above, substituting `r13`/`r14` for `r11`.

**What to compare.** r12 is the baseline for this change:
`normal 26,358 tok / 63.9 s`, `graph 41,698 / 78.4 s`, `raw 35,714 / 72.7 s`,
with graph reaching probe deployment in only 7 of 13 runs and
`start_probe_investigation` at 30,989 bytes per call. The prediction on record
is that graph lands near the baseline's token count, **not** 2× below it. Two
things to watch: whether graph's accuracy falls along with its tokens, which
would mean the compact view removed reasoning value and not just bytes; and
whether the probe-deployment rate rises now that the continuation tool is named
in the description.

## Highest-value next steps

1. **`graph_liveprobe` reaches probe deployment in only 7 of 13 runs.**
   `start_probe_investigation` failed 3 times and `get_probe_data` twice. The
   analyzer itself works (`prepare_repository_analysis` never failed), so the
   fault is in the investigation path. Fixing this is worth more than any
   further tuning — the graph arm currently pays a ~9,300-token tool surface
   and often never gets to use it.
2. **F7: shrink probe response payloads.** 83–87% of input is cached, so tool
   *descriptions* barely matter; non-cached input is dominated by tool
   *responses*. This is the only remaining credible token lever.
3. **Boundary faults are the product story.** The baseline scores 0/8 there.
   Make the boundary handoff produce the upstream propagation edge and this
   becomes a clean capability claim.
4. Do **not** pursue a time or token multiplier for LiveProbe on direct code
   faults. r12 shows the baseline winning on all three axes; reading source is
   sufficient for that class.

## Known open items

1. **PRAXIS fails on every incident** with codex `shared rollout token budget
   exhausted`, because `fair_praxis_adapter.py:477` splits one 50,000 budget
   across ~5 sequential calls while each coding arm gets 50,000 for a single
   call. Owner decision: mark it, do not fix, do not re-run.
2. **Seven incidents excluded** — 402, 405, 406, 413, 414, 415, 416. The
   released artifact and the published images have drifted; no image tag
   matches those locked sources. Evidence table is in `PRE_REGISTRATION.md`.
3. **F1, F2 not yet measured.** Implemented and committed, held back from r11,
   deployed by `deploy-r12.sh`.
4. **F3 and F7 not implemented.** F3 factors the duplicated
   `MANUAL_PROBE_SCOPE` preamble out of four tool descriptions; F7 trims probe
   response payloads.
5. **r12 confounds two changes** (budget and F1/F2). No r11 arm was truncated
   (maxima 66.0%, 77.8%, 95.3% of cap), which bounds how much the budget change
   alone can explain.

## Reproducing the VM-side scripts

Already present on the VM: `run-r11.sh`, `deploy-r12.sh`, `run-r12.sh`,
`forwards.sh`, `r11-status.py`, `build-images2.sh`, `hashmap.sh`. If the VM is
rebuilt, the campaign invocation is recorded verbatim in
`results/artifacts/praxis-campaign-smoke-gpt54-r10/campaign.log` and in
`run-r11.sh`; r12 differs only by `--tier=pilot`,
`--arms=normal_coding_sre,graph_liveprobe,raw_liveprobe`, `--seeds=10,20` and
`--results-root=/home/veer/praxis-campaign-r12`.

`evaluation/praxis/scripts/measure-tool-surface.mjs` measures the per-profile
MCP tool surface in bytes and tokens without a live broker; it produced the F1
numbers.
