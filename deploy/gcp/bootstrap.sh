#!/usr/bin/env bash

set -Eeuo pipefail

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

validate_ipv4() {
  local ip="$1"
  local octet
  local -a octets

  IFS='.' read -r -a octets <<<"${ip}"
  [[ ${#octets[@]} -eq 4 ]] || die "invalid PUBLIC_IP: ${ip}"
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] || die "invalid PUBLIC_IP: ${ip}"
    ((10#${octet} <= 255)) || die "invalid PUBLIC_IP: ${ip}"
  done
}

compose_is_healthy() {
  local release_dir="$1"
  local services
  local service
  local container_id
  local state
  local health
  local service_count=0
  local -a compose=(
    docker compose
    -f "${release_dir}/demo/docker-compose.yml"
    -f "${release_dir}/deploy/gcp/docker-compose.gcp.yml"
  )

  services="$("${compose[@]}" config --services)" || return 1
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    ((service_count += 1))
    container_id="$("${compose[@]}" ps --quiet "$service")" || return 1
    [[ -n "$container_id" && "$container_id" != *$'\n'* ]] || return 1
    state="$(docker inspect --format '{{.State.Status}}' "$container_id")" ||
      return 1
    health="$(
      docker inspect \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "$container_id"
    )" || return 1
    [[ "$state" == "running" && "$health" == "healthy" ]] || return 1
  done <<<"$services"

  ((service_count > 0))
}

print_failure_guidance() {
  printf 'Inspect status with: deploy/gcp/status.sh\n' >&2
  printf 'Inspect logs with: deploy/gcp/logs.sh\n' >&2
}

[[ ${EUID} -eq 0 ]] || die "bootstrap must run as root"

DEPLOY_COMMIT="${DEPLOY_COMMIT:-}"
RELEASE_ARCHIVE="${RELEASE_ARCHIVE:-}"
BROKER_PORT="${BROKER_PORT:-80}"
PUBLIC_IP="${PUBLIC_IP:-}"
LIVEPROBE_API_KEY="${LIVEPROBE_API_KEY:-}"

[[ "$DEPLOY_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
  die "DEPLOY_COMMIT must be a full lowercase Git SHA"
[[ -f "$RELEASE_ARCHIVE" ]] ||
  die "release archive not found: ${RELEASE_ARCHIVE:-<unset>}"
[[ "$BROKER_PORT" =~ ^[0-9]+$ ]] ||
  die "BROKER_PORT must be an integer"
((10#${BROKER_PORT} >= 1 && 10#${BROKER_PORT} <= 65535)) ||
  die "BROKER_PORT must be between 1 and 65535"
validate_ipv4 "$PUBLIC_IP"
[[ -n "$LIVEPROBE_API_KEY" ]] || die "LIVEPROBE_API_KEY must not be empty"

trap 'rm -f -- "$RELEASE_ARCHIVE"' EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes ca-certificates curl git gnupg make

install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --location \
  https://download.docker.com/linux/ubuntu/gpg \
  --output /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] ||
  die "bootstrap requires Ubuntu 24.04"
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

node_key="$(mktemp)"
curl --fail --silent --show-error --location \
  https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  --output "$node_key"
gpg --batch --yes --dearmor \
  --output /etc/apt/keyrings/nodesource.gpg "$node_key"
rm -f -- "$node_key"
cat >/etc/apt/sources.list.d/nodesource.list <<'EOF'
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main
EOF

apt-get update
apt-get install --yes \
  containerd.io \
  docker-buildx-plugin \
  docker-ce \
  docker-ce-cli \
  docker-compose-plugin \
  nodejs
systemctl enable --now docker

[[ "$(node --version)" == v24.* ]] ||
  die "Node.js 24 was not installed"
docker compose version >/dev/null

release_root="/opt/liveprobe/releases"
release_dir="${release_root}/${DEPLOY_COMMIT}"
install -d -m 0755 "$release_root"

if [[ -d "$release_dir" ]]; then
  [[ -f "${release_dir}/.deploy-commit" ]] ||
    die "existing release is missing its commit marker: ${release_dir}"
  [[ "$(<"${release_dir}/.deploy-commit")" == "$DEPLOY_COMMIT" ]] ||
    die "existing release commit marker does not match"
else
  staging_dir="${release_root}/.${DEPLOY_COMMIT}.$$"
  rm -rf -- "$staging_dir"
  install -d -m 0755 "$staging_dir"
  tar --extract --gzip --file "$RELEASE_ARCHIVE" \
    --directory "$staging_dir" --no-same-owner
  [[ -f "${staging_dir}/package.json" ]] ||
    die "release archive does not contain package.json"
  printf '%s\n' "$DEPLOY_COMMIT" >"${staging_dir}/.deploy-commit"
  mv -- "$staging_dir" "$release_dir"
fi

package_manager="$(
  node -p "require(process.argv[1]).packageManager || ''" \
    "${release_dir}/package.json"
)"
[[ "$package_manager" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] ||
  die "packageManager must pin an exact pnpm version"
pnpm_version="${package_manager#pnpm@}"

npm install --global corepack@latest
corepack enable
corepack install --global "$package_manager"
[[ "$(pnpm --version)" == "$pnpm_version" ]] ||
  die "installed pnpm version does not match packageManager"

pnpm --dir "$release_dir" install --frozen-lockfile
ln --symbolic --force --no-dereference --no-target-directory \
  "$release_dir" /opt/liveprobe/current

if ! BROKER_PORT="$BROKER_PORT" \
  GIT_COMMIT="${DEPLOY_COMMIT:-abcdef1234567890}" \
  LIVEPROBE_API_KEY="$LIVEPROBE_API_KEY" \
  make --directory=/opt/liveprobe/current \
    DOCKER_COMPOSE="docker compose" \
    gcp-demo-up; then
  printf 'error: Compose failed to start the GCE demo\n' >&2
  print_failure_guidance
  exit 1
fi

post_start_ok=false
for attempt in {1..12}; do
  if compose_is_healthy "$release_dir" &&
    curl --fail --silent --show-error --max-time 5 \
      "http://127.0.0.1:${BROKER_PORT}/healthz" >/dev/null; then
    post_start_ok=true
    break
  fi
  if ((attempt < 12)); then
    sleep 5
  fi
done

if [[ "$post_start_ok" != true ]]; then
  docker compose \
    -f "${release_dir}/demo/docker-compose.yml" \
    -f "${release_dir}/deploy/gcp/docker-compose.gcp.yml" \
    ps >&2 || true
  printf 'error: remote post-start checks did not become healthy\n' >&2
  print_failure_guidance
  exit 1
fi

printf 'Broker URL: http://%s:%s\n' "$PUBLIC_IP" "$BROKER_PORT"
printf 'Deployed SHA: %s\n' "$DEPLOY_COMMIT"
