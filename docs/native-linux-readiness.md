# Native Linux readiness

Verified on 2026-07-21 for the initial LightProbe Linux x86-64 eBPF target.

## Environment

- Host: Apple M2 Pro (`arm64`) running macOS 26.5.1
- Hypervisor/emulator: Lima 2.2.0 with QEMU 11.0.2 full-system x86-64 emulation
- VM: `lightprobe-ebpf-x86`, QEMU, 4 CPUs, 6 GiB configured RAM, 60 GiB configured disk
- Guest: Ubuntu 26.04 LTS, `x86_64`, kernel `7.0.0-28-generic`
- Guest-visible resources: 4 CPUs, 5.8 GiB RAM, 58 GiB root filesystem (52 GiB free after setup)
- Repository: `/home/krishnasingh.guest/src/LightProbe` on the guest-native ext filesystem
- Historical readiness checkpoint: `adding-unmanaged-languages` at
  `c309756dca67fdfffa8461ef6fa1cb776871ce1e`
- Current integration branch: `native-main-integration`

The VM creation command supported by the installed Lima version was:

```sh
limactl start \
  --name=lightprobe-ebpf-x86 \
  --vm-type=qemu \
  --arch=x86_64 \
  --cpus=4 \
  --memory=6 \
  --disk=60 \
  --plain \
  --tty=false
```

## Installed toolchains

- Git 2.53.0
- Node.js 24.18.0 (official x86-64 archive), npm 11.16.0, Corepack 0.35.0
- pnpm 11.9.0
- Python 3.14.4 (Ubuntu 26.04 does not publish separate Python 3.12 packages; 3.14 satisfies the repository's 3.12+ requirement)
- OpenJDK 17.0.19 and Maven 3.9.12
- Rust and Cargo 1.93.1 from Ubuntu; rustup is unnecessary because the distro toolchain is current
- Clang 21.1.8, bpftool 7.7.0, pahole 1.31
- libbpf 1.6.3, libelf 0.194, zlib 1.3.1 via `pkg-config`
- Docker 29.1.3 and Docker Compose 2.40.3 from Ubuntu packages inside the isolated guest
- PostgreSQL client 18.4

The bootstrap installs the requested build, kernel, BPF, ELF, compression,
Java, Rust, Python, PostgreSQL, and container packages. It also includes Ninja,
elfutils, bpftrace, jq, unzip, file, binutils, and xz support used by setup and
verification.

## Kernel and eBPF results

- `/sys/kernel/btf/vmlinux`: present and readable (6.8 MiB)
- BPF syscall: available to privileged users; the verification workflow uses passwordless `sudo` inside the isolated VM
- Kprobe/tracepoint program support: available
- BPF ring-buffer map and `bpf_ringbuf_output` helper: available
- tracefs: mounted at `/sys/kernel/tracing`
- uprobe interfaces: `uprobe_events` and `dynamic_events` present
- BPF-target Clang compilation: passed
- libbpf compile/link/run smoke: passed
- live tracepoint smoke: passed
- live uprobe smoke against glibc `malloc`: passed; the process exited and left no probe installed
- restart persistence: passed; the ext4 checkout, branch, upstream, commit, packages, and verification files survived a full stop/start cycle

### Boot warning

The first restart attempt hit an early kernel panic in `sched_clock_tick` under
QEMU TCG and never reached SSH. Only the panicked `lightprobe-ebpf-x86` QEMU
process was force-stopped. A subsequent cold boot completed in about 47 seconds,
and the full verification suite passed again. If this panic recurs, stop and
request approval to recreate this VM on Ubuntu 24.04 rather than treating an
intermittently booting guest as reliable.

## Reproduction commands

Bootstrap:

```sh
cd "$HOME/src/LightProbe"
./scripts/native-linux-bootstrap.sh
```

Kernel and live-probe verification:

```sh
cd "$HOME/src/LightProbe"
./scripts/native-linux-verify.sh
```

The verifier runs these capability checks without retaining the full system
dump in Git:

```sh
uname -r
test -r /sys/kernel/btf/vmlinux
pkg-config --modversion libbpf libelf zlib
mountpoint /sys/kernel/tracing
sudo bpftool feature probe kernel
```

## Result

**GO** for real x86-64 Linux uprobe and BPF ring-buffer development and smoke
testing. Expect slow boots and builds because x86-64 is fully emulated on Apple
Silicon. Product implementation and final Linux testing should proceed only in
the VM-native checkout, not concurrently in the macOS checkout.
