#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "error: this bootstrap must run inside Linux" >&2
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  echo "error: /etc/os-release is unavailable" >&2
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
case "${ID:-}:${ID_LIKE:-}" in
  ubuntu:*|debian:*|*:ubuntu*|*:debian*) ;;
  *)
    echo "error: only Ubuntu/Debian guests are supported (found ${ID:-unknown})" >&2
    exit 1
    ;;
esac

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "error: the initial LightProbe test target requires x86_64 Linux" >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
elif command -v sudo >/dev/null 2>&1 && sudo -n true; then
  SUDO=(sudo -n)
else
  echo "error: passwordless sudo is required inside the isolated VM" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
"${SUDO[@]}" apt-get update

packages=(
  git curl ca-certificates build-essential gcc g++ make cmake ninja-build
  pkg-config clang llvm lld bpftool libbpf-dev libelf-dev zlib1g-dev
  linux-tools-common linux-tools-generic linux-headers-generic dwarves pahole
  bpftrace jq unzip file binutils elfutils xz-utils
  openjdk-17-jdk maven postgresql-client rustc cargo
)
"${SUDO[@]}" apt-get install -y --no-install-recommends "${packages[@]}"

if apt-cache show python3.12 python3.12-venv python3.12-dev >/dev/null 2>&1; then
  "${SUDO[@]}" apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3.12-dev
else
  echo "info: exact Python 3.12 packages are unavailable; using supported distro Python (must be 3.12+)"
  "${SUDO[@]}" apt-get install -y --no-install-recommends python3 python3-venv python3-dev
fi

python3 - <<'PY'
import sys
if sys.version_info < (3, 12):
    raise SystemExit(f"error: Python 3.12+ is required, found {sys.version.split()[0]}")
PY

# The VM is isolated, so Ubuntu's packages do not replace any host Docker
# configuration. Install both only when the selected release provides them.
if apt-cache show docker.io docker-compose-v2 >/dev/null 2>&1; then
  "${SUDO[@]}" apt-get install -y --no-install-recommends docker.io docker-compose-v2
else
  echo "warning: Ubuntu Docker/Compose packages are unavailable; skipping them" >&2
fi

version_at_least() {
  local actual="${1#v}" required="$2"
  [[ "$(printf '%s\n%s\n' "$required" "$actual" | sort -V | head -n1)" == "$required" ]]
}

install_official_node() {
  local workdir sums archive version install_dir
  workdir="$(mktemp -d)"
  sums="$workdir/SHASUMS256.txt"
  curl --fail --location --silent --show-error \
    https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$sums"
  archive="$(awk '/node-v[0-9.]+-linux-x64[.]tar[.]xz$/ {print $2; exit}' "$sums")"
  if [[ -z "$archive" ]]; then
    echo "error: official Node checksum list lacks an x86-64 Linux archive" >&2
    rm -rf "$workdir"
    return 1
  fi
  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/latest-v24.x/$archive" -o "$workdir/$archive"
  (cd "$workdir" && grep -E "[[:space:]]${archive}$" SHASUMS256.txt | sha256sum --check -)
  version="${archive#node-}"
  version="${version%-linux-x64.tar.xz}"
  install_dir="/opt/node-$version"
  if [[ ! -x "$install_dir/bin/node" ]]; then
    "${SUDO[@]}" mkdir -p "$install_dir"
    "${SUDO[@]}" tar -xJf "$workdir/$archive" --strip-components=1 -C "$install_dir"
  fi
  for tool in node npm npx; do
    "${SUDO[@]}" ln -sfn "$install_dir/bin/$tool" "/usr/local/bin/$tool"
  done
  rm -rf "$workdir"
}

if ! command -v node >/dev/null 2>&1 || ! version_at_least "$(node --version)" 20.0.0; then
  install_official_node
fi

if ! command -v corepack >/dev/null 2>&1; then
  "${SUDO[@]}" npm install --global corepack@0.35.0
fi
"${SUDO[@]}" corepack enable --install-directory /usr/local/bin
corepack prepare pnpm@11.9.0 --activate
if [[ "$(pnpm --version)" != "11.9.0" ]]; then
  echo "error: pnpm 11.9.0 activation failed" >&2
  exit 1
fi

rust_version="$(rustc --version | awk '{print $2}')"
if ! version_at_least "$rust_version" 1.88.0; then
  rustup_dir="$(mktemp -d)"
  rustup_url="https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init"
  curl --fail --location --silent --show-error "$rustup_url" -o "$rustup_dir/rustup-init"
  curl --fail --location --silent --show-error "$rustup_url.sha256" -o "$rustup_dir/rustup-init.sha256"
  printf '%s  %s\n' "$(tr -d '[:space:]' < "$rustup_dir/rustup-init.sha256")" \
    "$rustup_dir/rustup-init" | sha256sum --check -
  chmod +x "$rustup_dir/rustup-init"
  "$rustup_dir/rustup-init" -y --profile minimal --default-toolchain stable
  rm -rf "$rustup_dir"
  rustup_bin="${CARGO_HOME:-${HOME:?HOME is required for rustup}}/bin"
  export PATH="$rustup_bin:$PATH"
fi
rust_version="$(rustc --version | awk '{print $2}')"
if ! version_at_least "$rust_version" 1.88.0; then
  echo "error: Rust 1.88+ is required, found $rust_version" >&2
  exit 1
fi

echo "Bootstrap complete."
node --version
npm --version
corepack --version
pnpm --version
python3 --version
java -version
mvn --version | sed -n '1,2p'
rustc --version
cargo --version
if command -v rustup >/dev/null 2>&1; then
  rustup show
else
  echo "rustup: not installed (Ubuntu Rust is sufficiently current)"
fi
