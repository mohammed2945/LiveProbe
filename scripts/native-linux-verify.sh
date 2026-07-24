#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "error: verification must run inside Linux" >&2
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
case "${ID:-}:${ID_LIKE:-}" in
  ubuntu:*|debian:*|*:ubuntu*|*:debian*) ;;
  *) echo "error: only Ubuntu/Debian guests are supported" >&2; exit 1 ;;
esac

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "error: expected x86_64, found $(uname -m)" >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
elif command -v sudo >/dev/null 2>&1 && sudo -n true; then
  SUDO=(sudo -n)
else
  echo "error: passwordless sudo is required for kernel capability checks" >&2
  exit 1
fi

echo "== Guest =="
uname -a
cat /etc/os-release
nproc
free -h
df -h /

echo "== Toolchains =="
git --version
node --version
npm --version
corepack --version
test "$(pnpm --version)" = "11.9.0"
pnpm --version
python3 --version
java -version
mvn --version | sed -n '1,2p'
rustc --version
cargo --version
if command -v rustup >/dev/null 2>&1; then rustup show; else echo "rustup: not installed (distro Rust)"; fi
clang --version | sed -n '1,2p'
bpftool version
pahole --version
docker --version
docker compose version

echo "== Libraries and kernel =="
uname -r
test -r /sys/kernel/btf/vmlinux
ls -lh /sys/kernel/btf/vmlinux
pkg-config --modversion libbpf
pkg-config --modversion libelf
pkg-config --modversion zlib

if ! mountpoint -q /sys/kernel/tracing; then
  "${SUDO[@]}" mkdir -p /sys/kernel/tracing
  "${SUDO[@]}" mount -t tracefs tracefs /sys/kernel/tracing
fi
mountpoint /sys/kernel/tracing
"${SUDO[@]}" test -e /sys/kernel/tracing/uprobe_events
"${SUDO[@]}" test -e /sys/kernel/tracing/dynamic_events

feature_report="$(mktemp)"
trap 'rm -f "$feature_report"' EXIT
"${SUDO[@]}" bpftool feature probe kernel >"$feature_report"
grep -Fq 'bpf() syscall is available' "$feature_report"
grep -Fq 'eBPF program_type kprobe is available' "$feature_report"
grep -Fq 'eBPF program_type tracepoint is available' "$feature_report"
grep -Fq 'eBPF map_type ringbuf is available' "$feature_report"
grep -Fq 'CONFIG_DEBUG_INFO_BTF is set to y' "$feature_report"
grep -Fq -- '- bpf_ringbuf_output' "$feature_report"
echo "BPF syscall: available"
echo "BTF: available"
echo "Kprobe/uprobe-capable program type: available"
echo "Ring buffer map and helper: available"

printf '%s\n' 'int x(void *ctx) { return 0; }' | \
  clang -target bpf -O2 -g -x c -c -o /tmp/lightprobe-bpf-smoke.o -
printf '%s\n' '#include <bpf/libbpf.h>' 'int main(void) { return libbpf_num_possible_cpus() < 1; }' | \
  cc -x c -o /tmp/lightprobe-libbpf-smoke - $(pkg-config --cflags --libs libbpf)
/tmp/lightprobe-libbpf-smoke
rm -f /tmp/lightprobe-bpf-smoke.o /tmp/lightprobe-libbpf-smoke

run_bpftrace_smoke() {
  local program="$1" trigger="$2" marker="$3" output pid
  output="$(mktemp)"
  "${SUDO[@]}" timeout 45 bpftrace -e "$program" >"$output" 2>&1 &
  pid=$!
  sleep 5
  bash -lc "$trigger"
  if ! wait "$pid"; then
    cat "$output" >&2
    rm -f "$output"
    return 1
  fi
  grep -Fq "$marker" "$output"
  rm -f "$output"
}

run_bpftrace_smoke \
  'tracepoint:syscalls:sys_enter_execve { printf("TRACEPOINT_SMOKE_OK\\n"); exit(); }' \
  '/usr/bin/true' 'TRACEPOINT_SMOKE_OK'
run_bpftrace_smoke \
  'uprobe:/usr/lib/x86_64-linux-gnu/libc.so.6:malloc { printf("UPROBE_SMOKE_OK\\n"); exit(); }' \
  '/bin/ls / >/dev/null' 'UPROBE_SMOKE_OK'

echo "Tracefs: mounted with uprobe interfaces"
echo "Tracepoint smoke: passed"
echo "Uprobe smoke: passed"
echo "NATIVE_LINUX_VERIFY_OK"
