# Native eBPF readiness smoke test

This standalone test validates the Linux x86-64 kernel/toolchain path before
any LiveProbe native architecture is implemented. It builds a DWARF-enabled,
GNU-build-ID target with a visible `noinline` function, loads a small libbpf
object, and attaches an uprobe only to the waiting target PID.

The BPF program reads the function's integer argument, increments an array-map
counter, and sends PID, TID, monotonic timestamp, and value through a BPF ring
buffer. The userspace loader requires exactly one record containing `4242` and
a final counter value of one. It explicitly destroys the link, ring-buffer
manager, and BPF object; nothing is pinned.

Run from the repository root inside `lightprobe-ebpf-x86`:

```sh
make native-smoke
```

Compilation is unprivileged. Because this VM restricts the BPF syscall to
privileged users, `run.sh` uses passwordless `sudo` only for the loader and for
name-scoped cleanup checks. On loader failure, libbpf/verifier diagnostics are
captured in `tools/ebpf-smoke/.build/smoke.log`.

Run the object-level read-only audit separately with:

```sh
make -C tools/ebpf-smoke readonly-check
```

The audit rejects either a symbolic reference to `bpf_probe_write_user` or its
raw BPF helper call ID 36; events are transported only through the ring buffer.

Build artifacts are local and removable with:

```sh
make -C tools/ebpf-smoke clean
```
