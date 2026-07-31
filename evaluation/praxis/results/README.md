# PRAXIS × LiveProbe evaluation results

Current result: **r13 + r13b**, `gpt-5.4`, effort `low`, 9 incidents × 2 seeds ×
3 arms, 250,000-token cap, **53 valid runs**. All fixes through `b8f71fc`
applied. Earlier campaigns are superseded and kept in git history.

## Headline

| Stratum | Arm | Pass | Tokens | Wall |
| --- | --- | ---: | ---: | ---: |
| All | Normal coding SRE | 8/18 | **26,752** | **48.2 s** |
| | **Graph + LiveProbe** | **13/18** | 38,229 | 64.0 s |
| | Raw LiveProbe | 9/17 | 30,829 | 53.4 s |
| `direct_code` | normal | 8/10 | **26,720** | **46.6 s** |
| | **graph** | **10/10** | 38,326 | 70.9 s |
| | raw | 9/10 | 28,656 | 51.3 s |
| `boundary_configuration` | normal | **0/8** | 26,752 | 49.5 s |
| | **graph** | **3/8** | 37,472 | **51.1 s** |
| | raw | **0/7** | 31,087 | 55.5 s |

**Graph is the most accurate arm, and the only arm that scores at all on
boundary faults.** It buys that with 43% more tokens than the baseline. There is
no time or token multiplier: the honest claim is capability, not efficiency.

This reverses r12, where raw beat graph. The difference is the fixes: the
compact investigation view, accurate error reporting, the long-poll deadline,
and naming the continuation tool in `start_probe_investigation`.

## Probing is still miscalibrated, and the wins are not obviously from probes

| Stratum | Probed | n | Pass | Median tokens |
| --- | --- | ---: | ---: | ---: |
| `direct_code` | yes | 10 | 10/10 | 41,400 |
| `direct_code` | no | 20 | 17/20 | 27,559 |
| `boundary_configuration` | yes | 7 | **1/7** | 45,858 |
| `boundary_configuration` | no | 16 | **2/16** | 28,982 |

Graph probes **8/10** on `direct_code`, where reading source already answers,
and only **3/8** on `boundary_configuration`, where observation is the whole
point. Of its three boundary wins, **two came from runs that never deployed a
probe** (18,685 and 21,476 tokens); the single probing win cost 79,236.

So graph's advantage does not currently look like it comes from runtime
observation. It looks like the analyzer's *static* structure. That is the
opposite of the premise that virtual breakpoints alone drive the gain, and it
is the main open question.

**This is correlational.** Runs that probe may be the runs that were already
stuck, so probing may track difficulty rather than cause failure. Separating
those requires manipulating probing rather than observing it — see
`../PRE_REGISTRATION.md`.

## Method notes

- Traces come from persisted `codex exec` event streams; `evaluation/praxis/python/trace_turns.py` attributes cost per step.
- `model_samples` is `tool_calls + 1`, not a provider turn count, so it is reported as tool calls.
- The operation ledger sees MCP calls only, not the 90–110 shell reads per arm, so byte-share attribution understates the baseline's source reading.
- r13 covers 401,403,404,407,408; r13b covers 409,410,411,412 after the Codex plan quota was exhausted mid-wave and the run resumed on API-key billing. Same code and settings; billing route differs.
- Excluded: 402, 405, 406, 413–416, because the released artifact and the published images have drifted. Evidence in `../PRE_REGISTRATION.md`. Nothing excluded on performance grounds.
