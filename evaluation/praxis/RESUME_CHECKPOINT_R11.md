# Resume checkpoint — campaign r11 / r12

Paused at the owner's request on 2026-07-29, ~00:05 UTC (VM clock), with r11
still executing. **Nothing needs to be restarted to keep r11 alive** — it runs
in a detached tmux session on the VM and continues without this session.

Read this file plus `PRE_REGISTRATION.md` and `R11_FINDINGS.md` before acting.
`PRE_REGISTRATION.md` is the anti-gaming contract and governs every change.

## State (updated 2026-07-30, r12 in flight)

| Thing | Value |
| --- | --- |
| Local and remote | `praxis-eval` @ `78b05dc`, in sync |
| VM `HEAD` | `f851705`, worktree clean, MCP server rebuilt |
| VM | `liveprobe-praxis-eval`, `us-east1-b`, `liveprobeeval`, **RUNNING** |
| Campaign r11 | **COMPLETE**, 36/36 scored, artifacts under `results/artifacts/praxis-campaign-r11/` (gitignored) |
| Campaign r12 | **RUNNING** in tmux `r12`, 9 incidents × 3 arms × seeds 10,20 = 54 runs at `--tier=pilot` (250k) |

r11's results are written up in `results/README.md`. Its efficiency comparison
was **withdrawn** — the LiveProbe arms barely invoked LiveProbe (F0 in
`R11_FINDINGS.md`). r12 is the run that actually tests LiveProbe, with the
guidance regression and the retry window both fixed in `f851705`.

r12's first incident confirms the fix took: `raw_liveprobe` deployed a probe
and read data (`set_snapshot_probe`, `get_probe_data` ×2), where in r11 it
deployed none across nine incidents. `graph_liveprobe` still stalls before
probe deployment — it reaches `start_probe_investigation` and errors there
(460-byte failure, distinct from r11's 423-byte `broker_unreachable`). Quantify
that across all nine incidents when r12 lands.

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
