# Native Linux x86-64 eBPF backend

The unreleased native backend supports optimized Rust and C++ **host
processes on Linux x86-64**. It does not support aarch64/ARM64 or attachment to
Docker or Kubernetes workloads. Containers may build the demos, but they are
not a supported native attachment topology.

## Trust and privilege boundary

```text
authenticated broker HTTP desired state
                 |
        unprivileged native agent
  /proc discovery, ELF/DWARF, decode,
  conditions, redaction, outbound HTTP
                 |
    root-owned typed Unix socket (0660)
                 |
        privileged BPF loader
  peer UID, target identity, allowlist,
  approved program and bounded-plan policy
                 |
      embedded audited liveprobe.bpf.o
```

The broker and worker cannot supply BPF bytes, a BPF object path, a program
name outside the approved enum, or a command to execute. The loader binary
compiles the checked-in BPF source into Cargo's output directory, embeds that
approved `liveprobe.bpf.o`, verifies its SHA-256 digest before loading it, and
accepts only typed bounded capture plans. This also makes a direct Cargo build
work from a clean checkout without a pre-generated source-tree object. The
build and `make -C native/bpf audit` reject helper 36
(`bpf_probe_write_user`). The loader owns unpinned links and removes them when
it exits or when its authenticated worker process disappears.

Raw target bytes stay on the host. The agent decodes only bounded scalar slots,
evaluates conditions locally, redacts keys and configured exact values, and
sends sanitized JSON to the broker.
Both the broker and agent enforce the fixed eight-slot capture limit across
unique watch, log, metric, and condition paths.

## Supported install layout

`make native-install` installs:

```text
/usr/local/bin/liveprobe-native-agent
/usr/local/bin/liveprobe-bpf-loader
/etc/liveprobe/                    configuration managed by the operator
/run/liveprobe/                    runtime socket directory
```

Override `/usr/local` with `NATIVE_PREFIX`; use `DESTDIR` for reproducible
package staging. No external BPF object is installed because it is embedded in
`liveprobe-bpf-loader`. `make native-loader-relocation-test` copies the release
loader out of the source tree and verifies the embedded object and digest.
The mandatory E2E tests also run a copied loader binary.

The worker account must not have BPF privileges. Run only
`liveprobe-bpf-loader` as root or with the smallest loader-only capability set
the host permits (normally `CAP_BPF`, `CAP_PERFMON`, and sometimes
`CAP_SYS_RESOURCE`; older distributions may require loader-only
`CAP_SYS_ADMIN`). Never grant those capabilities to an application or the
agent.

## Exact build and startup order

Prerequisites are a recent Linux x86-64 kernel with BTF, uprobes, BPF ring
buffers, tracefs, clang/LLVM, bpftool, libbpf, libelf, zlib, a C/C++ toolchain,
Rust 1.88+, Node 20+, and the repository pnpm version.

The `liveprobe` account below is the unprivileged worker the agent runs as, and
it must exist before the loader can be told which UID and GID to hand the
socket to.

```sh
corepack pnpm install --frozen-lockfile
make native-release
make native-demo
sudo useradd --system --no-create-home --shell /usr/sbin/nologin liveprobe
sudo install -d -o root -g liveprobe -m 0750 /run/liveprobe
```

The agent configuration requires a language for every native service. Select
targets by exact executable path. The same paths must be passed to the loader
allowlist.

```json
{
  "agentId": "native-host-1",
  "brokerUrl": "https://broker.example.invalid",
  "loaderSocket": "/run/liveprobe/loader.sock",
  "redactKeys": ["tenantSecret"],
  "redactValues": [],
  "services": [
    {
      "serviceId": "quotes-rust",
      "language": "rust",
      "executablePath": "/opt/quotes/bin/quotes"
    },
    {
      "serviceId": "pricing-cpp",
      "language": "cpp",
      "executablePath": "/opt/pricing/bin/pricing"
    }
  ],
  "symbolDirectories": ["/usr/lib/debug"],
  "debuginfodUrl": null,
  "symbolCacheDirectory": null
}
```

The loader CLI is positional:

```sh
sudo /usr/local/bin/liveprobe-bpf-loader \
  /run/liveprobe/loader.sock \
  "$(id -u liveprobe)" \
  "$(id -g liveprobe)" \
  /opt/quotes/bin/quotes \
  /opt/pricing/bin/pricing
```

Then start the agent as the dedicated unprivileged account:

```sh
sudo -u liveprobe env \
  LIVEPROBE_NATIVE_CREDENTIAL="$(secret-tool lookup service liveprobe-native-agent)" \
  /usr/local/bin/liveprobe-native-agent /etc/liveprobe/native-agent.json
```

The agent retries transient registration, discovery, assignment, ingest,
loader, attach, and symbol failures with bounded jittered backoff. Ingest uses
a 256-batch/8-MiB queue, drops the oldest batch when full, retries transport,
HTTP 408/429, and 5xx failures, and drops permanent 4xx rejections so one bad
batch cannot block later evidence. A broker reconnect performs registration,
complete instance replacement, and complete desired-state reconciliation.

## Broker-direct probe placement

Native placement is authenticated broker HTTP. MCP `set_*` tools remain
compatible for general clients but are not in the native host E2E control path.

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $LIVEPROBE_CONTROL_PLANE_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$BROKER_URL/v1/probes" \
  --data '{
    "serviceId": "quotes-rust",
    "type": "snapshot",
    "sourceCommit": "abcdef1234567890",
    "file": "services/quotes/src/main.rs",
    "line": 87,
    "watchPaths": ["subtotal"],
    "condition": {"path":"subtotal","op":"eq","value":4242},
    "hitLimit": 1,
    "ttlSeconds": 60,
    "createdBy": "operator:native-debug"
  }'
```

Use the longest unique source suffix available. If a suffix matches distinct
compilation files, resolution fails with `source-file-ambiguous`; the agent
never combines those files.

## Debug information and value boundaries

Targets need a GNU build ID, line tables, and matching variable DWARF.
Resolution order is embedded DWARF, validated `.gnu_debuglink`, configured
build-ID directories, then configured HTTP(S) debuginfod with build-ID
validation. Uprobes use ELF file offsets and support PIE executables.

Supported values are integer scalars, booleans, pointers, integer-backed
enums, fixed-offset scalar fields, bounded C strings, and simple register,
register-plus-offset, normalized `fbreg`, dereference, and stack-value
locations. Native snapshots require explicit watch paths. Optimized-out values
are structured unavailable values.

Register-backed `DW_OP_piece` plans are deliberately rejected as
`unsupported-register-piece`; correct piece-source reconstruction is not
claimed. Floating-point registers, arbitrary expressions, STL/container
traversal, deep pointer traversal, suspended Rust futures, USDT, target-memory
writing, and arbitrary BPF are unsupported.

## Sampling and safety semantics

For snapshot, log, and metric event probes, preflight may approve the site,
reject it, or calculate `sample every N`. The physical generation incorporates
the sampling plan, so an update cannot accept stale records.

The kernel performs these operations in order:

1. Increment the exact per-CPU raw-hit counter on every uprobe hit.
2. Accept each deterministic Nth hit (`N=1` accepts every hit).
3. Apply one shared atomic token bucket per probe as an additional output
   ceiling. The configured burst remains exact across CPU migration.
4. Reserve the probe hit limit and emit a ring-buffer record.

Raw-hit counters and counter-probe aggregation are never event-sampled. The
userspace supervisor compares interval deltas against per-probe and host
raw-hit limits and automatically detaches every physical site for a hot logical
probe. TTL and logical hit limits also detach all related physical sites.
Sampling lowers decode/output volume but does not remove uprobe trap cost.

## Build and verification commands

```sh
make readonly-audit
make -C native/bpf audit
cargo test --manifest-path native/Cargo.toml --workspace
make native-demo
make native-ebpf-test
make native-smoke
make native-loader-relocation-test
make native-e2e-rust
make native-e2e-cpp
make native-e2e
make native-hot-burst-test
```

On the documented supported Linux x86-64 host, native E2E and privileged tests
fail rather than skip when their required dependencies are present. After
tests, verify that `bpftool prog show`, `bpftool link show`, and
`bpftool map show` contain no LiveProbe resources.
