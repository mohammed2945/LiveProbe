#!/usr/bin/env bash
set -euo pipefail

instance="${LIGHTPROBE_LIMA_INSTANCE:-lightprobe-ebpf-x86}"

if ! command -v limactl >/dev/null 2>&1; then
  echo "error: limactl is required on the host" >&2
  exit 1
fi

if ! limactl list --format '{{.Name}}' | grep -Fxq "$instance"; then
  echo "error: Lima instance '$instance' does not exist" >&2
  exit 1
fi

exec limactl shell "$instance" -- bash -lc \
  'cd "$HOME/src/LightProbe" && exec bash -l'
