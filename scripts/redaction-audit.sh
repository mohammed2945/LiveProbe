#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required for the TypeScript redaction fixtures" >&2
  exit 127
fi

echo "==> TypeScript serializer fixtures"
pnpm --filter @doomslayer2945/liveprobe-node exec vitest run test/serializer.test.ts

echo "==> Python serializer fixtures"
if ! sh scripts/python312.sh -c 'import pytest' >/dev/null 2>&1; then
  echo "pytest is required for the Python redaction fixtures" >&2
  exit 1
fi
(cd python/sdk && sh ../../scripts/python312.sh -m pytest tests/test_serializer.py)

if ! sh scripts/java17.sh true >/dev/null 2>&1; then
  echo "SKIP Java redaction fixtures (JDK 17+ is unavailable)"
  exit 0
fi

echo "==> Java serializer fixtures"
sh scripts/java17.sh make -C java/bridge test
