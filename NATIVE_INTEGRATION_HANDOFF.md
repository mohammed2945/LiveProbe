# Native Rust/C++ eBPF integration handoff

Integration source checkpoint: 2026-07-23. Main-architecture integration:
2026-07-24.

This document describes the implementation committed with this file. Source
code and executable tests are authoritative if this handoff becomes stale.
Identify the exact checkpoint with:

```sh
git show -s --format='%H %s' HEAD
```

## Decision

**GO for local host-process Rust and C++ integration testing on supported
Linux x86-64. This is not a production-readiness statement.**

This is a backend-readiness decision, not evidence that RideRush itself has
already run under LiveProbe. RideRush was not modified or executed while
preparing this checkpoint.

No production system, credential, database, broker, or MCP endpoint was used
while preparing this integration. Production readiness is deliberately out of
scope.

## Repository and version state

- Branch: `native-main-integration`.
- Base: `origin/main` at `36b722f319c1617aaca89e60a6c90296dc66cf4e`.
- Native source reference: `adding-unmanaged-languages` at
  `17c38f497362533fb929b924633b1608e9041bb5` (left unchanged).
- The implementation and this handoff are committed together as one local
  checkpoint. No package was published and no branch or release was pushed.
- Native-capable source components are unreleased on this branch:
  - `@liveprobe/broker` remains private at `0.0.0`;
  - `@doomslayer2945/liveprobe-mcp` is prepared as `0.3.0`;
  - `@liveprobe/protocol` is `0.2.0`;
  - `liveprobe-native-agent`;
  - `liveprobe-bpf-loader`; and
  - `liveprobe-native-protocol`.
- Already-published MCP, Node, Python, and Java artifacts must not be
  described as containing this native implementation.
- BPF/userspace binary ABI: `2`.
- Loader IPC protocol: `2`.
- Broker routes remain under `/v1`.

## Integration inventory

- Native-only source: `native/`, the Rust/C++ demos, native Linux/Lima
  development tooling, eBPF smoke tests, and native development documents.
- Independently changed on both branches: broker state/routes, authentication,
  protocol schemas, MCP response schemas, package metadata, top-level build
  targets, protocol documentation, and audit scripts.
- Contract conflicts: the native branch used a separate strict contract and
  physical-assignment model; main used richer logical probes and expression
  fields. Canonical TypeScript wire schemas now live in
  `packages/protocol`, while Rust validates the same shared JSON fixture.
- Authentication conflicts: the old native path accepted a shared broker key.
  Normal operation now uses hashed `lp_native_` host-agent credentials bound to
  one scope, one agent, and an explicit service allowlist. The shared key is
  retained only for local development/break-glass use.
- Persistence conflicts: old native desired state was memory/file based while
  main's authoritative store is tenant-scoped PostgreSQL. Schema version 9
  adds scoped agents, instances, statuses, assignment versions, build identity,
  and native credential authorization records.
- MCP conflicts: main publishes twenty-three logical control-plane tools and richer
  managed schemas. No native-only placement tool was added; service and safety
  responses now describe either backend.
- Capability conflicts: managed expression, stack-local, metric-expression,
  interpolation, and log-level features exceed the bounded native capture
  contract. Native placement uses the safe capability intersection across
  active instances and rejects unsupported fields with
  `unsupported_by_backend`.
- Tests ported or rewritten: Rust contract/worker/loader tests, broker native
  auth/reconciliation/ingest tests, PostgreSQL restart/isolation tests, MCP
  native service/probe tests, compiled-object audits, demos, and local
  MCP-to-eBPF acceptance tests.

## Supported environment

The implemented and privileged-tested target is:

- host processes on Linux `x86_64`;
- an ELF executable with a non-empty GNU build ID;
- matching DWARF line and variable metadata;
- BTF, uprobes, BPF ring buffers, tracefs, clang/LLVM, bpftool, libbpf,
  libelf, zlib, Rust 1.88+, Node 20+, and the repository pnpm version;
- a dedicated unprivileged native agent; and
- a root/capability-scoped loader that is the only BPF-privileged process.

The final privileged validation environment was Ubuntu 26.04 LTS,
Linux `7.0.0-28-generic`, `x86_64`, Rust 1.93.1, Clang 21.1.8, bpftool 7.7.0,
and libbpf 1.6.3 in the checked-in Lima/QEMU development VM.

The following remain unsupported:

- Docker or Kubernetes native attachment;
- aarch64/ARM64;
- USDT;
- floating-point capture;
- `DW_OP_piece` register-piece reconstruction;
- STL or Rust-container traversal;
- deep pointer traversal; and
- suspended-future inspection.

Do not convert these boundaries into implied support without implementation and
privileged tests.

## Build, install, and startup

Run native builds and tests on a Linux native filesystem:

```sh
corepack pnpm install --frozen-lockfile
make native-release
make native-demo
make native-loader-relocation-test
```

Install into the default layout:

```sh
sudo make native-install
```

Installed paths:

```text
/usr/local/bin/liveprobe-native-agent
/usr/local/bin/liveprobe-bpf-loader
/etc/liveprobe/
/run/liveprobe/
```

`NATIVE_PREFIX` changes `/usr/local`; `DESTDIR` stages a reproducible package
tree.

The loader embeds the approved compiled `liveprobe.bpf.o`. No external BPF
object is installed or located at runtime. The build:

- compiles the checked-in BPF source into Cargo's build output directory, so a
  clean checkout does not require a generated source-tree object;
- audits its BPF instructions for forbidden helper 36
  (`bpf_probe_write_user`);
- embeds its build-time SHA-256 digest; and
- rejects damaged embedded bytes before loading.

The broker and worker cannot send BPF bytes, an object path, an arbitrary
program name, or a command through loader IPC. IPC request structs deny unknown
fields.

Create the runtime socket directory:

```sh
sudo install -d -o root -g liveprobe -m 0750 /run/liveprobe
```

Start the loader first. Its CLI is positional:

```sh
sudo /usr/local/bin/liveprobe-bpf-loader \
  /run/liveprobe/loader.sock \
  "$(id -u liveprobe)" \
  "$(id -g liveprobe)" \
  /absolute/path/to/allowed-rust-binary \
  /absolute/path/to/allowed-cpp-binary
```

Syntax:

```text
liveprobe-bpf-loader SOCKET WORKER_UID WORKER_GID TARGET...
```

Targets are canonicalized and must match the authenticated process executable,
device/inode identity, and build ID. The socket is root-owned, group-readable
only by the configured worker group, and the loader validates peer UID.

Then start the agent as the unprivileged account:

```sh
sudo -u liveprobe env \
  LIVEPROBE_NATIVE_CREDENTIAL="$(secret-tool lookup service liveprobe-native-agent)" \
  /usr/local/bin/liveprobe-native-agent /etc/liveprobe/native-agent.json
```

Agent syntax:

```text
liveprobe-native-agent CONFIG.json
```

Every service entry requires `serviceId`, `language` (`rust` or `cpp`), and at
least one exact executable-path or cgroup-prefix selector. If both selectors
are supplied, both must match.

## Testing boundary

All integration and acceptance testing is local. Use an isolated local
PostgreSQL database and locally generated credentials. Do not contact a hosted
broker, production Clerk tenant, production MCP endpoint, or production
database.

## Native control plane

Native end-to-end placement uses authenticated broker HTTP:

```text
POST   /v1/probes
GET    /v1/probes/:id/data
DELETE /v1/probes/:id
```

The native agent uses:

```text
POST /v1/native/agents/register
PUT  /v1/native/agents/:agentId/instances
GET  /v1/native/agents/:agentId/assignments?since=VERSION
POST /v1/native/ingest
```

Assignments are complete desired state, not deltas. Reconnection performs
registration, complete instance replacement, assignment polling, and desired
state reconciliation.

MCP `set_*` tools remain backward compatible, but neither mandatory native E2E
test uses MCP to create probes.

### Shared broker/MCP status contract

`@liveprobe/protocol` is the canonical shared wire contract for broker, MCP,
managed-runtime, and native-eBPF traffic. Broker, MCP, TypeScript, and Rust
contract tests fail if their accepted reason codes or fields drift.

The five statuses are:

```text
armed
error
hit-limit-reached
suspended
expired
```

Current native reason codes are:

```text
service-not-found
ambiguous-service-match
target-instance-changed
build-mismatch
no-build-id
no-debug-info
no-line-info
source-file-not-found
source-file-ambiguous
no-executable-address
variable-not-found
variable-optimized-out
unsupported-location-expression
unsupported-register-piece
unsupported-type
floating-point-register-unavailable
attach-permission-denied
uprobe-attach-failed
raw-hit-budget-exceeded
ring-buffer-full
local-policy-denied
process-inspection-permission-denied
capture-event-invalid
process-inspection-failed
process-metadata-invalid
invalid-build-identity
unsupported-architecture
```

`probeVersion` is preserved through broker storage, PostgreSQL restore, MCP
`list_probes`, and MCP `get_probe_data`. Stale status generations cannot
terminate a newer assignment.

The final review found and fixed one P1 ingest-ordering issue: native status
identity and required version fields are now validated for the complete batch
before any event is appended. A rejected request cannot leave evidence in
memory for a later persistence operation.

## Loader and binary ABI

`CapturePlan` ABI v2 is 144 bytes and includes:

- approved program kind;
- target PID/cgroup identity;
- generation;
- hit limit;
- token-bucket refill and burst;
- deterministic `sample_every`; and
- at most eight bounded capture operations.

The raw event ABI remains a fixed 552-byte record with eight 64-byte slots.
Loader `GetInfo` reports IPC and binary ABI versions. The agent fails visibly
with `abi-incompatible` rather than attaching with a mismatched layout.

The approved programs are count-only and scalar-snapshot. Logs and metrics use
the scalar-snapshot program and are rendered locally. The loader keeps links
unpinned, detaches all links when the authenticated worker exits, and loses all
links safely on loader exit. A detected loader restart clears physical state
and triggers safe reattachment from broker desired state.

## Sampling and safety semantics

For snapshot, log, and metric sites, preflight calculates either:

- accept with `sample_every = 1`;
- accept with deterministic `sample_every = N`; or
- reject as too hot.

Kernel order is:

```text
raw hit
  -> exact raw-hit counter increment
  -> every-N deterministic sampling
  -> event token bucket
  -> capture hit limit
  -> ring-buffer emission
```

Therefore:

- raw-hit counters are exact and never event-sampled;
- sampling reduces capture work but does not conceal raw-hit safety load;
- the token bucket is a shared atomic per-probe output ceiling, so its burst is
  exact even when the target thread moves between CPUs;
- hit limits count accepted physical captures/events as appropriate; and
- changing `sample_every` changes the physical generation so stale records are
  rejected.

Counters increment their exact BPF aggregate without event sampling.
Conditional native counters remain rejected because a userspace condition
cannot be applied exactly to a kernel aggregate.

The safety supervisor samples interval deltas, not lifetime averages. A real
hot burst exceeding the configured per-probe raw-hit budget automatically
causes:

1. `raw-hit-budget-exceeded` status ingest;
2. a detach request to the loader;
3. disappearance of the BPF link; and
4. continued operation of unrelated probes.

TTL, hit-limit, event-decode fault, host raw-hit, and per-probe raw-hit terminal
conditions also detach physical sites.

## Failure policy

Transient failures do not terminate the global agent:

- registration retries with bounded jittered backoff;
- procfs discovery retains known instances when inspection temporarily fails;
- instance replacement and assignment polling retain cached desired state;
- symbol and debuginfod failures retain cached plans when retryable;
- loader connection, preflight, attach, detach, event polling, and counter
  reads reconnect or retry without busy loops;
- a broker reconnect performs complete reconciliation; and
- shutdown interrupts backoff promptly.

Broker ingest has a bounded queue of 256 batches and 8 MiB. It drops the oldest
batch when full, retries transport failures, HTTP 408/429, and 5xx, and drops
permanent 4xx rejections so one bad batch cannot poison later evidence.

Permanent configuration, policy, target-identity, and ABI failures remain
visible instead of retrying forever.

## Source, DWARF, and value boundaries

The target must expose a GNU build ID and matching line/type information.
Recommended builds retain full debug metadata, avoid stripping/LTO, and use
frame pointers where practical.

Source matching uses a normalized suffix. The request should use the longest
unique suffix available. If multiple compilation files match and cannot be
shown to be the same normalized file, resolution fails with
`source-file-ambiguous`; it never combines unrelated files.

Supported location/value forms include:

- simple general-purpose register scalars;
- register plus constant offset;
- normalized `DW_OP_fbreg`;
- constant-offset scalar fields;
- `DW_OP_stack_value`;
- signed/unsigned integer and boolean values;
- pointer values; and
- bounded C strings.

Optimized-out or unsupported values become structured unavailable nodes.
Register-piece plans return `unsupported-register-piece` rather than claiming
unproven `DW_OP_piece` semantics.

Condition-only paths are captured for local evaluation but excluded from
outbound variables unless independently requested. Conditions are evaluated
before output. Redaction then applies to snapshots, watches, logs, metrics,
statuses, unavailable details, and error diagnostics.
The broker and worker both reject probes requiring more than eight unique
capture paths, including a distinct condition-only path, so assignments cannot
exceed the fixed native ABI slot count.

## Mandatory tests

Run on supported Linux x86-64:

```sh
TEST_DATABASE_URL="<isolated-test-postgres-url>" make test
cargo test --manifest-path native/Cargo.toml --workspace
make readonly-audit
make -C native/bpf audit
make native-demo
make native-loader-relocation-test
make native-ebpf-test
make native-smoke
make native-e2e-rust
make native-e2e-cpp
make native-hot-burst-test
git diff --check
```

Final checkpoint results:

| Check | Result |
| --- | --- |
| Full TypeScript workspace test | PASS, 180 passed / 9 PostgreSQL skips |
| Broker suite including PostgreSQL restart tests | PASS, 72/72 |
| Shared TypeScript protocol contract | PASS, 29/29 |
| MCP contract/package tests | PASS, 18/18 |
| Python SDK | PASS, 86/86 |
| Java bridge | PASS, 176 assertions |
| Rust workspace | PASS, 56/56 |
| Read-only audit | PASS, 70 runtime source files and 7 guards |
| Compiled BPF helper audit | PASS |
| Release loader relocation and digest | PASS |
| Local Linux x86-64 privileged BPF integration | PASS |
| BPF smoke test | PASS |
| Optimized Rust MCP-to-eBPF E2E | PASS |
| Optimized C++ MCP-to-eBPF E2E | PASS |
| Automatic hot-burst detachment | PASS |
| Repository credential/artifact inspection | PASS |
| LiveProbe BPF cleanup | PASS: 0 links, 0 programs, 0 maps |
| Post-review broker regression suite | PASS, 63/63 with 9 PostgreSQL skips |

Final E2E summaries:

```text
NATIVE_E2E_RUST_OK buildId=2aaa694d45d609f3fbff8dbbc0b6b4608b17a497 source=demo/rust-service/src/main.rs:16 counter=20 hot=raw-hit-budget-exceeded
NATIVE_E2E_CPP_OK buildId=25eb0105f87692d51a6929b8287595001deb9897 source=demo/cpp-service/main.cpp:20 counter=20 hot=raw-hit-budget-exceeded
```

Both E2Es use MCP for native service discovery, supported logical probe
creation, evidence reads, and removal. They cover registration, build identity,
DWARF scalar resolution, privileged IPC, local BPF attachment, real traffic,
ring-buffer decode, conditions, redaction, exact counters, broker restart
persistence, automatic hot-burst detachment, unrelated-probe survival, and BPF
cleanup. Set `LIVEPROBE_NATIVE_EXTENDED_E2E=1` to include the slower extended
condition/log/unavailable/metric matrix.

No mandatory check skipped on the documented supported environment. Two
`gimli::Dwarf::borrow` deprecation warnings remain non-fatal.

## Credential model

The normal native credential is a scoped host-agent principal created through
`POST /v1/native-credentials`. It binds one exact agent ID and an explicit
service allowlist to tenant, project, and environment. Secrets use the
`lp_native_` prefix, are returned once, and are stored only as hashes.
Revocation is immediate. Shared broker keys remain a documented local
development/break-glass path, not the normal host-agent production credential.
