# Native Linux eBPF development

LightProbe's initial native eBPF test target is **Linux x86-64**. On an Apple
Silicon Mac, Lima must use QEMU full-system x86-64 emulation. Booting, package
installation, and compilation are therefore substantially slower than native
ARM64 Linux.

The isolated VM is named `lightprobe-ebpf-x86`. Build and test in
`~/src/LightProbe` on the VM's native filesystem. Do not compile final eBPF
artifacts from a macOS-shared directory, and do not edit the macOS and Linux
working copies simultaneously.

## Create the VM

The configuration is in `dev/lima/lightprobe-ebpf-x86.yaml`. The installed Lima
2.2 syntax used to create the current VM was:

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

For a fresh VM created directly from the checked-in configuration, use:

```sh
limactl start --name=lightprobe-ebpf-x86 --tty=false \
  dev/lima/lightprobe-ebpf-x86.yaml
```

Always confirm that `uname -m` reports `x86_64`. ARM64 is not a substitute for
the initial test target.

## Daily workflow

Start the VM:

```sh
limactl start lightprobe-ebpf-x86
```

Enter the VM-native checkout:

```sh
./scripts/native-linux-shell.sh
```

Bootstrap or safely rerun package setup from inside the VM:

```sh
cd "$HOME/src/LightProbe"
./scripts/native-linux-bootstrap.sh
```

Run kernel, toolchain, tracefs, BTF, ring-buffer, and uprobe checks:

```sh
cd "$HOME/src/LightProbe"
./scripts/native-linux-verify.sh
```

Run the standalone real uprobe/ring-buffer readiness smoke test:

```sh
cd "$HOME/src/LightProbe"
make native-smoke
```

This target builds in the VM-native checkout, attaches only to its waiting test
process, transports events through a BPF ring buffer, and verifies cleanup. It
does not implement or exercise the LiveProbe product architecture.

Stop the VM without deleting its disk:

```sh
limactl stop lightprobe-ebpf-x86
```

## Repository synchronization

Keep the authoritative development checkout inside the VM while implementing
and testing Linux-native code. For this integration, use
`native-main-integration`; `adding-unmanaged-languages` remains an unchanged
source/reference branch. If private-repository credentials are unavailable in
the guest, copy a clean checkout into `~/src/LightProbe` with `limactl copy`.
Pushing is not required for local validation.

## Cleanup (destructive; do not run casually)

Deletion is not part of normal setup. It permanently removes the VM-native
checkout and all guest state. First stop the VM, inspect `limactl list`, and ask
for explicit confirmation that `lightprobe-ebpf-x86` is the intended target.
Only after that confirmation would the cleanup command be:

```sh
limactl delete lightprobe-ebpf-x86
```

Never apply that command to the existing Kali, Windows, VirtualBox, VMware, or
Docker Desktop environments.
