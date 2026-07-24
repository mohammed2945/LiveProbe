#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
build_dir="$script_dir/.build"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
	echo "error: this smoke test requires Linux x86_64" >&2
	exit 1
fi

if [[ ! -r /sys/kernel/btf/vmlinux ]]; then
	echo "error: /sys/kernel/btf/vmlinux is not readable" >&2
	exit 1
fi

make -C "$script_dir" all

if [[ "$(id -u)" -eq 0 ]]; then
	privileged=()
elif command -v sudo >/dev/null 2>&1 && sudo -n true; then
	privileged=(sudo -n)
else
	echo "error: passwordless sudo is required for BPF load/attach" >&2
	exit 1
fi

set +e
"${privileged[@]}" "$build_dir/smoke" \
	"$build_dir/smoke.bpf.o" "$build_dir/target" \
	2>&1 | tee "$build_dir/smoke.log"
smoke_status=${PIPESTATUS[0]}
set -e
if [[ "$smoke_status" -ne 0 ]]; then
	echo "error: smoke test failed; verifier/libbpf log: $build_dir/smoke.log" >&2
	exit "$smoke_status"
fi

assert_resource_absent() {
	local kind="$1"
	local name="$2"
	local output

	output="$(mktemp)"
	if "${privileged[@]}" bpftool "$kind" show name "$name" >"$output" 2>&1; then
		cat "$output" >&2
		rm -f "$output"
		echo "error: smoke-test $kind '$name' remained after teardown" >&2
		return 1
	fi
	if grep -Eq 'Operation not permitted|Permission denied' "$output"; then
		cat "$output" >&2
		rm -f "$output"
		echo "error: unable to verify $kind cleanup" >&2
		return 1
	fi
	rm -f "$output"
}

assert_resource_absent prog smoke_uprobe
assert_resource_absent map smoke_counter
assert_resource_absent map smoke_events
echo "RESOURCE_CLEANUP_OK: no smoke program or maps remain"
