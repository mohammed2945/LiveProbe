# LiveProbe on Kubernetes — dogfood findings

Running log from setting LiveProbe up the way a new user would: docs only, no
repo knowledge. Target: a real DeathStarBench application on GKE under live
synthetic load, with working probes on every supported language.

Status legend: **BLOCKER** stops the documented path outright, **GAP** means the
docs do not cover a case the user will hit, **FRICTION** means it works but
costs the user time or confidence.

---

## Verified working

| Leg | Result |
| --- | --- |
| Hosted broker | `/healthz` and `/readyz` return `{"ok":true}` |
| MCP over stdio | `npx @doomslayer2945/liveprobe-mcp@0.4.0` — 23 tools listed, `ping_broker` OK |
| Node snapshot probe | End-to-end. `src/payments.ts:61` source-mapped to `dist/src/payments.js:36`, real locals captured, armed→hit in 94 ms, `hit-limit-reached` latched, `remove_probe` clean |
| Python snapshot probe | End-to-end. `app.py:118`, captured `user.address.postal_code = "10115"`, `subtotal_cents = 2125`, four-frame stack through `renew_subscription` into the anyio worker |
| JVM snapshot probe | End-to-end. `InventoryService.java:336`, captured `sku`, `requested`, `waveId`, `requestRole`, `threadName = "JettyServerThreadPool-19"`, and a typed `RaceWave` object; stack resolved through `reserve` |
| Live services on hosted broker | `payment-service` (node), `billing-worker` (python), `inventory-service` (jvm) |

| C++ snapshot probe | End-to-end on Kubernetes via eBPF uprobes. `ComposePostHandler.h:135` in DeathStarBench `ComposePostService`, under live wrk2 load. See below. |

| Rust snapshot probe | End-to-end via eBPF uprobes on the cluster. `rust_orders_service.rs:11`, values verified against the service's own output. See finding 9 for an important caveat. |

All five supported languages are proven to *return evidence*, not merely to
register an agent: Node, Python and the JVM through the in-process agents, C++
and Rust through the native eBPF backend. Probes were removed after each run.

`NativeLanguage` turns out to be inert past discovery — nothing in the agent
branches on Rust versus C++ outside test fixtures — so the two share one code
path and the Rust run mainly confirms a different DWARF producer resolves.

### The C++ leg, end to end

Target: stock `deathstarbench/social-network-microservices`, unmodified, running
as an ordinary pod. Observer: the privileged DaemonSet on the same node. Load:
wrk2 mixed workload, ~40 req/s sustained.

```
probe:  dsb-compose-post-service ComposePostHandler.h:135
status: hit-limit-reached

SNAPSHOT 2026-07-29T08:27:25.472Z  req_id=946353034568225500  user_id=544
SNAPSHOT 2026-07-29T08:27:25.539Z  req_id=919347594365647200  user_id=778
SNAPSHOT 2026-07-29T08:27:25.605Z  req_id=506580054448130400  user_id=431
```

Three hits about 66 ms apart, each a different user from the generator, then the
hit limit latched and the probe detached. The instance identifier
`dsb-compose-post-service-7871-11521` carries the host PID and process start
time, and the build ID `82eb2f1f21d278d846fb9962c356b7453705a5dd` is the one in
the published image — the same value read from the artefact before any of this
was deployed.

Nothing about the target changed to make this work: no rebuild, no LiveProbe
library, no restart, no `-g` flag added. The service was already running under
load when the probe was placed from an MCP client.

Rust and C++ have **never** registered against the hosted broker. Native is the
unproven leg, and finding 2 below explains why it cannot be proven on Kubernetes
as the code currently stands.

### DeathStarBench binaries are probe-ready as shipped

Checked before building anything, because a stripped target would have made the
C++ leg unprovable regardless of finding 2. The stock published image needs no
rebuild:

```
$ file ComposePostService
ELF 64-bit LSB executable, x86-64, ..., BuildID[sha1]=82eb2f1f21d278d846fb9962c356b7453705a5dd,
with debug_info, not stripped
```

`.debug_info`, `.debug_line`, `.debug_str`, `.debug_loc` and `.debug_ranges` are
all present in `deathstarbench/social-network-microservices:latest`, along with
eleven probeable C++ services (`ComposePostService`, `UserTimelineService`,
`SocialGraphService`, …). Both requirements from the client-setup debug-info
table are satisfied by the published artefact, so the C++ leg needs only the
container-awareness fix, not a custom image build.

---

## 1. GAP — the documentation has no Kubernetes path at all

`docs/client-setup.md` and `deploy/gcp/README.md` describe exactly two
topologies: a developer laptop, and one GCE VM running docker-compose. There is
no manifest, no Helm chart, no sidecar pattern, no DaemonSet, and no guidance on
where `LIVEPROBE_API_KEY` should come from in a cluster (Secret? Workload
Identity? CSI driver?).

Every realistic user deploying "a real product" lands on Kubernetes first. The
setup guide currently stops one layer short of where they live.

## 2. BLOCKER — the native agent cannot attach to a containerized process

This is the finding that decides whether Rust and C++ can be demonstrated on
Kubernetes at all. It is a code-level constraint, not a configuration mistake.

`native/agent/src/discovery.rs:78` reads the target's executable via
`fs::read_link("/proc/<pid>/exe")`. That returns a path string valid **in the
target's mount namespace** — for a pod, something like
`/usr/local/bin/socialNetworkMicroservices`. The agent then uses that same
string to read file *content* in **its own** mount namespace:

- `fs::metadata(&exe)` — discovery.rs:172
- `symbols::build_id(&exe)` — discovery.rs:196
- `symbols::architecture(&exe)` — discovery.rs:241

From a DaemonSet pod, or from the node itself, that path does not exist. Every
container target fails discovery before it is ever reported to the broker.

The loader rejects it a second time. `native/loader/src/policy.rs:60-71`:

```rust
let target = fs::canonicalize(&request.target.executable_path)?;   // ENOENT for a pod path
...
let proc_exe = fs::canonicalize(format!("/proc/{}/exe", request.target.pid))?;
```

`canonicalize` on a containerized process's `/proc/<pid>/exe` resolves to the
in-container path, which does not exist in the loader's root. It errors before
the allowlist comparison runs.

Two details show container support was *intended* but never finished:

- `ServiceConfig.cgroup_prefix` (`native/agent/src/config.rs:29`) exists and
  `matches_selector` implements cgroup-v2 matching (discovery.rs:376-384). A
  cgroup prefix selector is only useful for containers.
- `discover_with_known` already takes `proc_root` as a parameter — but
  `main.rs:195` hardcodes `Path::new("/proc")`, so it can never be pointed at a
  bind-mounted host `/proc`.

**The fix is well-scoped.** Open the target through the kernel's magic symlink
instead of re-resolving the string:

1. Thread a configurable `procRoot` through from `AgentConfig` (default
   `/proc`), so a DaemonSet can mount the host's at `/host/proc`.
2. Add a resolved read path, `<procRoot>/<pid>/exe`, used for all *content*
   reads (metadata, build ID, architecture, DWARF, debuglink). Keep the
   readlink string as the reported `executablePath` and for selector matching,
   so the broker still shows a meaningful path.
3. Resolve sibling debug artefacts and `symbolDirectories` under
   `<procRoot>/<pid>/root/…`.
4. In the loader, compare the allowlist against the in-namespace path string,
   and open the file through `/proc/<pid>/exe`. The security binding is
   unchanged: build ID, inode, and process start time are still verified, and
   those are the checks that actually prevent target substitution.

Opening `/proc/<pid>/exe` is also *safer* than the current string round-trip —
it is race-free against a binary replaced on disk between discovery and attach,
which the present code detects only after the fact via the inode check.

Uprobe attachment itself is unaffected: uprobes register against an inode, and
the kernel resolves `/proc/<pid>/exe` to the correct inode across namespaces.

### Fixed and verified

Implemented across `native/agent/src/{discovery,runtime,main}.rs` and
`native/loader/src/{policy,bpf}.rs`. `DiscoveredInstance` now carries a
`resolved_path` (`/proc/<pid>/exe`, `#[serde(skip)]` so the broker payload is
unchanged) alongside the reported `executable_path`. Content reads, DWARF
resolution, debug-artefact search, loader validation and uprobe attachment all
go through the resolved path; the reported path remains what the broker
displays and what the loader allowlist matches.

The loader change also *tightens* security. It previously trusted the
executable path supplied by the agent; it now reads `/proc/<pid>/exe` itself
and compares the agent's claim against the kernel's answer. Build ID, inode and
process-start-time checks are unchanged.

Verified against a real containerised target — a C++ service built with `-g
-Wl,--build-id=sha1`, running in its own container, observed from a second
container sharing only the PID namespace:

```
$ ls /opt/app/bin/target-service           # from the observing container
ls: cannot access '/opt/app/bin/target-service': No such file or directory

$ discover '{"serviceId":"orders","language":"cpp",
             "executablePath":"/opt/app/bin/target-service"}' target.cpp 12
found service=orders pid=1 arch=aarch64 build-id=127a58ae58c73a15cbd53c659b4fedf38be1ec37
  reported path (target's view): /opt/app/bin/target-service
  opened path   (agent's view):  /proc/1/exe
  debug search root:             /proc/1/root/opt/app/bin
  embedded DWARF:                true
  target namespace:              separate (No such file or directory (os error 2))
  resolved target.cpp:12 -> address=0x400ad0 offset=0xad0
  ... 11 candidate sites
```

The executable the agent must read does not exist at its reported path, which is
exactly what defeated the previous code. Build ID, DWARF and eleven concrete
uprobe offsets are all recovered. `native/agent/examples/discover.rs` is the
tool used, kept in the tree as the first-line answer to "can the agent see my
service?".

The same test against a Rust service built with `debug = 2, strip = false`
resolves identically — different DWARF producer, same result:

```
found service=rust-orders pid=1 arch=aarch64 build-id=3fb1d6f2cb5c67eb10bf66eb59857a88b96468a8
  reported path (target's view): /srv/app/rust-service
  opened path   (agent's view):  /proc/1/exe
  embedded DWARF:                true
  target namespace:              separate (No such file or directory (os error 2))
  resolved src/main.rs:6 -> address=0x8458 offset=0x8458
```

A second, quieter bug surfaced while fixing this. `find_debug_artifact` located
GNU debuglink files via `executable.parent()`, which once the agent opens
`/proc/<pid>/exe` becomes `/proc/<pid>` — not where sibling debug files live. It
now takes the executable's directory as an explicit argument, rebased under the
target's root. Configured `symbolDirectories` are rebased the same way; for a
host process `/proc/<pid>/root` is `/`, so those paths are unchanged, while a
container now finds the debug files shipped in its own image instead of
same-named paths on the node.

Note that the agent needs `CAP_SYS_PTRACE` to read `/proc/<pid>/exe` and
`/proc/<pid>/root` for processes it does not own — true before this change for
`exe`, and unchanged in kind. The Kubernetes DaemonSet must request it.

Full native workspace — agent, loader and protocol — builds and tests green on
x86-64 Linux after the change.

**Not yet verified:** end-to-end uprobe *attachment* to a containerised target,
which needs a real x86-64 kernel with BPF privileges. Apple Silicon cannot
stand in for this: Docker runs amd64 images under Rosetta, and
`/proc/<pid>/exe` then resolves to `/run/rosetta/rosetta` rather than the
service binary, so the discovery result is meaningless there. Use an arm64
container locally, or an x86-64 node, and never a translated amd64 container.

## 3. GAP — no published native package, so the setup guide asks users to compile

`docs/client-setup.md:300` — "No published package yet, so build both binaries
from the repository on a machine matching the target host. Needs Rust 1.88+."

The documented Rust/C++ install is: install a dozen apt packages including
`clang`, `llvm`, `bpftool`, `libbpf-dev` and `dwarves`, then `make
native-release`. Compare with Node (`npm install <one package>`) and Python
(`pip install liveprobe`). This is the single largest asymmetry in the setup
experience and it lands on the two languages that are already hardest to set up.

On GKE this gets worse: the default node image is Container-Optimized OS, which
has a read-only `/usr` and no package manager, so `sudo make native-install` to
`/usr/local/bin` is impossible. The install has to become a container image
shipped as a DaemonSet, which is *also* the answer to finding 1.

## 4. FRICTION — uninitialized bindings are reported as `"[getter]"`

The snapshot on `src/payments.ts:61` captured correct values for everything in
scope, but reported three variables like this:

```json
"availableBalanceCents": { "t": "str", "v": "[getter]" },
"debited":               { "t": "str", "v": "[getter]" },
"paymentId":             { "t": "str", "v": "[getter]" }
```

Those are block-scoped bindings declared later in the function and still in the
temporal dead zone when line 61 executes. The truthful report is "not yet
initialized at this point"; `"[getter]"` instead suggests an accessor property
the agent declined to invoke. A user debugging a real incident would read this
as "the probe could not see the value" and go looking for a permissions or
redaction problem that does not exist.

Worth distinguishing `[uninitialized]` from `[getter]` in the Node serializer.

## 5. FRICTION — the documented MCP auth path cannot be exercised headlessly

`docs/client-setup.md:404-420` presents hosted OAuth (Clerk browser sign-in) as
the primary MCP path, with the local stdio key as "fallback". The hosted flow
requires an interactive browser and an MCP-client restart. Any automated
verification, CI smoke test, or scripted onboarding check has to use the
"fallback" path — which is the one that actually works unattended.

---

## 6. BLOCKER — the snapshot BPF program fails verification on Linux 6.17

Found by deploying to a real node. `liveprobe_count` loads; `liveprobe_snapshot`
does not, so the whole BPF object fails and the loader exits. **Native snapshot
probes do not work at all on a current kernel**, independently of Kubernetes.

```
1567: (85) call bpf_probe_read_user#112
invalid access to memory, mem_size=552 off=488 size=255
R1 max value is outside of the allowed memory range
libbpf: prog 'liveprobe_snapshot': failed to load: -EACCES
```

`bpf_probe_read_user(event->values[destination], op->width, ...)` took its size
straight from a map value. The guard was a chain of inequalities:

```c
if (op->width != 1 && op->width != 2 && op->width != 4 && op->width != 8
    && op->width != LIVEPROBE_SLOT_BYTES) { event->flags |= 2; continue; }
```

That rejects every unapproved width at run time but tells the verifier nothing:
it tracks value *ranges*, not sets, and cannot represent "not 1 and not 2". The
size register stays `umax=255` while the destination slot has only 64 bytes left
at `off=488` of a 552-byte record, so the read is rejected.

Two fixes failed before one worked, and the reason is worth recording:

1. Copying the width to a local and adding an explicit `width > 64` bound —
   clang sank the reload of `op->width` past the check, so the call still saw an
   unconstrained register.
2. A `switch` calling `bpf_probe_read_user` with a constant size per arm — clang
   tail-merged the 1/2/4/8 arms back into a single variable-size call, because
   they differed only in one constant.

The fix that holds reads into a differently typed local per width, which is
structurally distinct enough that the arms cannot be merged, then copies into the
slot with a constant size.

**Verify the object, not the source.** Whether the fix survives optimisation is
visible in the disassembly in about twenty seconds, and is the difference between
knowing and guessing:

```sh
clang -O2 -g -target bpf -D__TARGET_ARCH_x86 -Iinclude \
  -I/usr/include/x86_64-linux-gnu -c src/liveprobe.bpf.c -o /tmp/lp.o
llvm-objdump -d /tmp/lp.o | grep -B2 'call.*112' | grep 'r2 = '
```

Every size register must be a constant. A `r2 = r<N>` means a variable size
reached the helper and the kernel will reject the program. All 35 call sites are
constant after the fix. This check now runs in `native/bpf/Makefile`'s `audit`
target next to the existing `bpf_probe_write_user` scan, so the failure is caught
at build time rather than on a node.

### 6b. A second, independent rejection was hiding behind the first

Fixing the width did not make the program load. The verifier had simply been
stopping at the first error it reached:

```
2863: (79) r1 = *(u64 *)(r1 +0)
dereference of modified ctx ptr R1 off=96 disallowed
```

`register_value` selects a `pt_regs` field by a runtime register number. Clang
compiled the sixteen-case switch into a single load through a computed pointer —
`ctx + offset[reg]`, where offset 96 is `rdx`. The verifier permits
`*(u64 *)(ctx + CONST)` but refuses to dereference a ctx pointer that carries a
computed offset, because that would let a program read outside the context.

The fix fences each loaded value so the reads cannot be folded into one
pointer-select, and each case emits its own load with the offset in the
instruction. The capture loop also lost its `#pragma unroll`: replicating the
switch eight times was creating the register pressure that pushed clang toward
the pointer-select and toward spilling ctx. The bound is a compile-time constant,
so a bounded loop verifies fine on any kernel from 5.3 onward, and the program
shrank from 2861 to 577 instructions.

Both bugs mean the same thing: **the native eBPF backend had never been loaded by
a real kernel.** Neither is subtle once the program reaches a verifier, and no
amount of source review substitutes for loading it. That is what
`bpftool prog loadall` gives you in about thirty seconds:

```sh
clang -O2 -g -target bpf -D__TARGET_ARCH_x86 -Iinclude \
  -I/usr/include/x86_64-linux-gnu -c src/liveprobe.bpf.c -o /tmp/lp.o
sudo bpftool prog loadall /tmp/lp.o /sys/fs/bpf/lptest && sudo rm -rf /sys/fs/bpf/lptest
```

Result on Linux 6.17 after both fixes:

```
>>> VERIFIER ACCEPTED <<<
756: kprobe  name liveprobe_snapshot  tag 2a4499a89a4959fd  gpl
```

This loop should be part of native CI. Rebuilding a container image to discover a
verifier verdict costs about five minutes per attempt; loading the object costs
seconds, and it is the only check that actually answers the question.

## 7. GAP — a non-root pod cannot get CAP_SYS_PTRACE from `capabilities.add`

The agent needs `CAP_SYS_PTRACE` to read `/proc/<pid>/exe` and
`/proc/<pid>/root` for processes it does not own, which on a node is all of
them. The obvious manifest is wrong:

```yaml
runAsUser: 10001
allowPrivilegeEscalation: false
capabilities: { add: ["SYS_PTRACE"], drop: ["ALL"] }
```

It fails silently. The agent starts, sees every process on the node, reads none
of them, registers no services, and logs nothing — the discovery loop treats the
permission errors as ordinary churn for processes it has no prior knowledge of.

```
$ grep -E '^Cap(Prm|Eff|Bnd)' /proc/self/status
CapPrm: 0000000000000000     <- empty
CapEff: 0000000000000000     <- empty
CapBnd: 0000000000080000     <- SYS_PTRACE, bounding set only
```

Kubernetes has no ambient-capability support, so for a **non-root** user
`capabilities.add` populates only the bounding set. The permitted and effective
sets stay empty and the capability is never actually held.

The fix keeps the unprivileged account. Set a file capability on the binary in
the image and allow the transition:

```dockerfile
RUN setcap cap_sys_ptrace=ep /usr/local/bin/liveprobe-native-agent
```

```yaml
allowPrivilegeEscalation: true   # else NO_NEW_PRIVS blocks the file capability
capabilities: { add: ["SYS_PTRACE"], drop: ["ALL"] }
```

`allowPrivilegeEscalation: true` reads alarmingly but does not make the agent
root: the bounding set is still only `SYS_PTRACE`, so that is the single
capability it can ever hold, and it remains unable to load BPF. Running the
container as root instead would be the easy fix and the wrong one — it would
also require passing uid 0 as the loader's worker uid, dissolving the peer check
that keeps the two halves distinct.

This belongs in the Kubernetes guide as a worked example. The failure gives no
error message, so anyone who hits it will assume the agent or the broker is
broken.

## 8. FRICTION — `source-file-not-found` is reported when the file was found

The first C++ probe was placed on `ComposePostHandler.h:134`, the line the call
visibly starts on. It failed with:

```
status: error   reasonCode: source-file-not-found
```

The file was found. Line 134 simply has no row in the line table — the call
spans 134-135 and the compiler attributed it to 135. Moving the probe to 135
worked immediately.

`resolve_line` in `native/agent/src/dwarf/mod.rs` only sets `saw_file` inside a
loop already filtered to `row.line() == requested_line`, so a perfectly good
source path with a non-executable line reports the path as missing. The error
that fits is `no-executable-address`, which the same function already defines
and returns elsewhere.

This matters more for C++ than for the interpreted runtimes: with `-O2`, the
line a human would point at is frequently not the line the line table records,
so users will hit this constantly and will go looking for a path or debuginfo
problem that does not exist. Worth reporting the nearest lines that do have code,
which the agent already knows.

## 9. BLOCKER-CLASS — an optimized build can yield a confidently wrong value

The most serious finding, and the only one that produces bad data rather than no
data.

Probing `rust_orders_service.rs:11` in a Rust service built with the documented
release settings (`debug = 2, strip = false`, so `opt-level = 3`):

| Watch | Reported | Actual |
| --- | --- | --- |
| `fee_cents` | 53 | 53 ✓ |
| `net_cents` | `variable-not-found` | assigned on this line, not yet live ✓ |
| `order_id` | `variable-not-found` | a field of `order`, not a bare local ✓ |
| `tier_code` | **140735268890816** | **3 or 7** ✗ |

The service prints `tier=3` and `tier=7` alternately. The probe returned the same
value every hit — just under 2^47, an x86-64 stack address.

Rebuilding the identical source with `opt-level = 0` and changing nothing else
returns `tier_code` = 7, 3, 7, matching the service's own output exactly. So the
capture machinery is correct; the input was not.

Both variables use a plain `DW_OP_fbreg` home slot — `fee_cents` at +8,
`tier_code` at +16 — and the frame base resolves correctly, which is why
`fee_cents` is right. At `-O2`, `tier_code` lives in a register at that PC and its
home slot is simply stale. LLVM emitted a single `DW_OP_fbreg` rather than a
location list, so nothing in the DWARF says the slot is invalid there.

A conventional debugger would misreport this too, so it is not a defect unique to
LiveProbe. What *is* specific is the presentation: the stale slot is returned as a
confident number, indistinguishable from the correct `fee_cents` beside it. The
agent already has a vocabulary for uncertainty — it correctly returned
`variable-not-found` twice in the same snapshot — and did not use it here.

The contrast with C++ identifies the root cause precisely. GCC emits a **location
list** with PC ranges for the equivalent variable, and the agent's
`attribute_expression_at_pc` selects the entry valid at the probe address — which
is why every C++ capture was correct at `-O3`. LLVM emitted a bare `DW_OP_fbreg`
with no range, so there is nothing to select against. Full measurements for both
languages, including an `opt-level` matrix, are in
`docs/native-language-evaluation.md`.

This matters more than for a human debugger. A person seeing a tier code of
140735268890816 discounts it instantly. An AI client reasoning over the snapshot
has no such reflex, and this is an AI-native debugger.

Worth considering:

- Prefer a location list when one exists and honour its PC ranges.
- When a variable's only location is a bare `DW_OP_fbreg` and `DW_AT_producer`
  shows an optimizing build, mark the value low-confidence rather than plain.
- A cheap sanity filter: a captured scalar that falls in the stack address range
  is almost never a legitimate business value.
- At minimum, say in the setup guide that `debug = 2` on a release profile gives
  reliable *lines* but not reliable *locals*, and that values should be
  corroborated before being trusted.

## 10. BLOCKER — one stale event permanently kills all probing for an agent

The most severe defect found, and it silently disables the product.

`packages/broker/src/index.ts:1926-1933` validates a native ingest batch in a
loop and **throws on the first bad event**, rejecting the entire batch:

```ts
for (const event of input.events) {
  const stored = this.probes.get(event.probeId);
  if (stored === undefined || ...) {
    throw new BrokerHttpError(400, "invalid_request", "native event does not match its logical probe");
  }
```

`remove_probe` deletes the logical probe immediately, but the uprobe detaches
only on the agent's next poll. Events captured in that window reference a probe
the broker no longer has, so `stored === undefined` and the batch is refused. The
agent logs and discards it:

```
dropping broker-rejected ingest batch: native event ingestion failed with HTTP 400:
{"error":{"code":"invalid_request","message":"native event does not match its logical probe"}}
```

Because a single stale event invalidates the whole batch, **every valid event for
every current probe is dropped with it**. The condition persists, and the agent
never recovers on its own. From the user's side, probes report `armed` and simply
never produce data — no error surfaces through MCP, and the broker's own logs
look healthy.

Confirmed by restart: after `kubectl rollout restart` of the DaemonSet, a probe
on the same line of the same unchanged binary returned evidence within seconds.
Before the restart, the identical probe returned nothing across repeated
attempts.

This cost real time and produced a wrong conclusion: several Rust builds were
recorded as "arms but never fires", and the cause was assumed to be optimization
level. It was this. See `docs/native-language-evaluation.md`.

### Fixed

Batch atomicity turned out to be deliberate, not an oversight: an existing test
asserts that an unrecognised probe id rejects the whole batch *and* that the
valid event beside it is not stored. That is a defensible integrity stance, so
the fix keeps it and narrows the exception to the case that actually races.

`removeProbe` now records the id in `recentlyRemovedProbes`. During ingest, an
event whose probe is absent is skipped only if it carries a tombstone within
`REMOVED_PROBE_GRACE_MS` (10 minutes, comfortably beyond a poll cycle plus
backoff); an id that was never seen is still a hard `400`. Tombstones are pruned
on each ingest so they cannot accumulate. `ingestNative` returns the count
actually retained rather than the count submitted, so the `{ accepted }` in the
`202` response stops silently overstating what was stored.

The version-mismatch `409` is deliberately left alone. The probe still exists in
that case, so the broker can name the disagreement precisely and the agent
re-reads its assignment — and unlike the removed-probe path it was never
observed recurring, so it does not justify relaxing batch integrity.

Two regression tests in `packages/broker/test/native-integration.test.ts` cover
it: one puts a removed probe's late event *first* in a batch (the ordering the
old code failed on) and asserts the live probe's evidence still lands with
`accepted: 1`; the other asserts a probe belonging to a different service is
still rejected, so the exception cannot become a blanket amnesty. Full broker
suite: 70 passed, 0 failed.

### The silent failure is now surfaced

Fixing the race is not enough on its own: the reason this cost hours is that
losing evidence looked exactly like a probe on a line that had not executed.

The broker issues the rejections, so it can count them without any protocol or
agent change. `ingestNative` wraps its checked body and records every
`BrokerHttpError` against the service, alongside the benign count of stale
events skipped. `safetyOverview` reports both as an `evidence` block and, when
any batch has been rejected, pushes a caveat saying so in plain words:

```
Evidence is being discarded: 3 ingest batch(es) rejected (last: invalid_request).
Probes may report armed while returning no data.
```

`evidence` is omitted entirely when nothing has been lost, so a healthy service
is unchanged.

**Deployment ordering matters here.** `safetyResponseSchema` in the MCP server
is `.strict()`, so an unrecognised field is a parse error rather than an ignored
key. The MCP package must therefore be published *before* a broker carrying
this field is deployed, or `get_safety_overview` breaks for existing clients —
and it would break precisely when a service starts losing evidence, which is the
worst possible moment. The schema is updated in this change; the ordering is the
operational constraint.

Covered by a regression test asserting a clean service reports no `evidence`,
and that after a rejection it reports `rejectedBatches: 1`,
`lastRejectionCode: "invalid_request"`, and the caveat. Broker suite: 71 passed.
MCP suite: 18 passed.

## Deployment plan for the cluster leg

Settled from what the upstream project actually ships, so it is not guesswork
once credentials are available.

DeathStarBench provides a Helm chart at
`socialNetwork/helm-chart/socialnetwork` with roughly thirty subcharts —
eleven C++ Thrift services plus their per-service MongoDB, Redis, memcached and
a Jaeger instance. Defaults request `100m` CPU and `128Mi` per service, so the
whole application asks for approximately 3 vCPU and 4 GiB. Do not hand-write
manifests for it; use the chart.

| Decision | Choice | Why |
| --- | --- | --- |
| Node image | `UBUNTU_CONTAINERD` | Container-Optimized OS has a read-only `/usr` and no package manager, so the documented `make native-install` cannot run there |
| Architecture | x86-64 node pool | DSB publishes amd64 images, and the native backend is x86-64 only |
| Native agent | Privileged DaemonSet, `hostPID: true` | `hostPID` puts host PIDs in the pod's `/proc`; procfs is per-PID-namespace, so no separate proc-root mount is needed |
| Agent capability | `CAP_SYS_PTRACE` | Required to read `/proc/<pid>/exe` and `/proc/<pid>/root` for processes the agent does not own |
| Loader/agent split | Two containers, root loader and unprivileged agent | Preserves the security boundary the client-setup guide describes |
| JVM bridge | Sidecar in the target pod | JDWP stays on `127.0.0.1:5005` inside the shared network namespace and is never exposed — the pattern finding 1 says is missing |
| Language coverage | DSB for C++ and real load; `demo/` services ported for Node, Python, JVM, Rust | No DSB application covers all five (see Open items) |

The native agent config for a pod target selects on the **in-container**
executable path, for example `/usr/local/bin/UserService`, not a node path.
Same for the loader's allowlist. This is a user-visible consequence of the fix
above and has to be stated prominently in the Kubernetes guide, because anyone
following the current documentation will reach for a host path.

Write the `gcloud container clusters delete` line into the guide next to the
create line so the demo is reversible.

## Open items

- gcloud credentials on this machine are expired; GKE work is blocked on
  `gcloud auth login` and confirmation of a billing-enabled project.
- No single DeathStarBench application covers all five supported languages.
  socialNetwork is C++ plus OpenResty Lua plus one-shot Python init scripts;
  hotelReservation is Go, which LiveProbe does not support at all. Full
  language coverage requires DSB for the real-load C++ leg alongside the
  existing `demo/` services ported to the same cluster.
