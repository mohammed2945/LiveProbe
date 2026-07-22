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

validate_api_key_ring() {
  local value="$1"
  local key
  local -a keys

  IFS=',' read -r -a keys <<<"$value"
  [[ ${#keys[@]} -ge 1 && ${#keys[@]} -le 2 ]] ||
    die "broker API key ring must contain one or two keys"
  for key in "${keys[@]}"; do
    [[ ${#key} -ge 32 && ${#key} -le 256 &&
      "$key" =~ ^[A-Za-z0-9._~-]+$ ]] ||
      die "broker API keys must be 32-256 URL-safe characters"
  done
  if [[ ${#keys[@]} -eq 2 && "${keys[0]}" == "${keys[1]}" ]]; then
    die "broker API key ring contains a duplicate key"
  fi
}

fetch_secret() {
  local project_id="$1"
  local secret_name="$2"

  node --input-type=module - "$project_id" "$secret_name" <<'NODE'
const [projectId, secretName] = process.argv.slice(2);
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
async function fetchWithRetry(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      lastError = new Error(`request failed: ${response.status}`);
      if (![403, 429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 8) await sleep(2_000);
  }
  throw lastError;
}
const metadataResponse = await fetchWithRetry(
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
  { headers: { "Metadata-Flavor": "Google" } },
);
const { access_token: accessToken } = await metadataResponse.json();
if (typeof accessToken !== "string" || accessToken.length === 0) {
  throw new Error("metadata token response did not include an access token");
}
const secretResponse = await fetchWithRetry(
  `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secretName}/versions/latest:access`,
  { headers: { Authorization: `Bearer ${accessToken}` } },
);
const body = await secretResponse.json();
if (typeof body?.payload?.data !== "string") {
  throw new Error("Secret Manager response did not include payload data");
}
process.stdout.write(Buffer.from(body.payload.data, "base64").toString("utf8"));
NODE
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
    --env-file /etc/liveprobe/deployment.env
    -f "${release_dir}/demo/docker-compose.yml"
    -f "${release_dir}/deploy/gcp/docker-compose.gcp.yml"
  )
  if [[ "$DATABASE_BACKEND" == "cloud-sql" ]]; then
    compose+=(
      -f "${release_dir}/deploy/gcp/docker-compose.cloud-sql.yml"
    )
  fi

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
    [[ "$state" == "running" ]] || return 1
    if [[ "$service" == "cloud-sql-proxy" ]]; then
      [[ "$health" == "none" || "$health" == "healthy" ]] || return 1
    else
      [[ "$health" == "healthy" ]] || return 1
    fi
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
LIVEPROBE_API_KEYS="${LIVEPROBE_API_KEYS:-}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
PROJECT_ID="${PROJECT_ID:-}"
SECRETS_BACKEND="${SECRETS_BACKEND:-environment}"
LIVEPROBE_API_KEYS_SECRET="${LIVEPROBE_API_KEYS_SECRET:-}"
POSTGRES_PASSWORD_SECRET="${POSTGRES_PASSWORD_SECRET:-}"
CLERK_SECRET_KEY_SECRET="${CLERK_SECRET_KEY_SECRET:-}"
CLERK_SECRET_KEY="${CLERK_SECRET_KEY:-}"
CLERK_AUTHORIZED_PARTIES="${CLERK_AUTHORIZED_PARTIES:-}"
CLERK_AUDIENCE="${CLERK_AUDIENCE:-}"
DATABASE_BACKEND="${DATABASE_BACKEND:-local}"
CLOUD_SQL_INSTANCE_CONNECTION_NAME="${CLOUD_SQL_INSTANCE_CONNECTION_NAME:-}"
CLOUD_SQL_DATABASE="${CLOUD_SQL_DATABASE:-liveprobe}"
CLOUD_SQL_USER="${CLOUD_SQL_USER:-liveprobe}"
LIVEPROBE_DB_POOL_SIZE="${LIVEPROBE_DB_POOL_SIZE:-10}"

[[ "$DEPLOY_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
  die "DEPLOY_COMMIT must be a full lowercase Git SHA"
[[ -f "$RELEASE_ARCHIVE" ]] ||
  die "release archive not found: ${RELEASE_ARCHIVE:-<unset>}"
[[ "$BROKER_PORT" =~ ^[0-9]+$ ]] ||
  die "BROKER_PORT must be an integer"
((10#${BROKER_PORT} >= 1 && 10#${BROKER_PORT} <= 65535)) ||
  die "BROKER_PORT must be between 1 and 65535"
validate_ipv4 "$PUBLIC_IP"
case "$SECRETS_BACKEND" in
  environment) ;;
  secret-manager)
    [[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] ||
      die "invalid PROJECT_ID"
    secret_names=(
      "$LIVEPROBE_API_KEYS_SECRET"
      "$POSTGRES_PASSWORD_SECRET"
    )
    if [[ -n "$CLERK_AUTHORIZED_PARTIES" ]]; then
      secret_names+=("$CLERK_SECRET_KEY_SECRET")
    fi
    for secret_name in "${secret_names[@]}"; do
      [[ ${#secret_name} -le 63 &&
        "$secret_name" =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ ]] ||
        die "invalid Secret Manager secret name: ${secret_name:-<empty>}"
    done
    ;;
  *) die "SECRETS_BACKEND must be environment or secret-manager" ;;
esac
case "$DATABASE_BACKEND" in
  local) ;;
  cloud-sql)
    [[ "$CLOUD_SQL_INSTANCE_CONNECTION_NAME" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z][a-z0-9-]*[a-z0-9]:[a-z]([-a-z0-9]*[a-z0-9])?$ ]] ||
      die "invalid CLOUD_SQL_INSTANCE_CONNECTION_NAME"
    ;;
  *) die "DATABASE_BACKEND must be local or cloud-sql" ;;
esac
[[ "$CLOUD_SQL_DATABASE" =~ ^[a-z][a-z0-9_]{0,62}$ ]] ||
  die "invalid CLOUD_SQL_DATABASE"
[[ "$CLOUD_SQL_USER" =~ ^[a-z][a-z0-9_]{0,62}$ ]] ||
  die "invalid CLOUD_SQL_USER"
[[ "$LIVEPROBE_DB_POOL_SIZE" =~ ^[1-9][0-9]*$ ]] ||
  die "LIVEPROBE_DB_POOL_SIZE must be a positive integer"

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

if [[ "$SECRETS_BACKEND" == "secret-manager" ]]; then
  LIVEPROBE_API_KEYS="$(fetch_secret "$PROJECT_ID" "$LIVEPROBE_API_KEYS_SECRET")"
  POSTGRES_PASSWORD="$(fetch_secret "$PROJECT_ID" "$POSTGRES_PASSWORD_SECRET")"
  if [[ -n "$CLERK_AUTHORIZED_PARTIES" ]]; then
    CLERK_SECRET_KEY="$(fetch_secret "$PROJECT_ID" "$CLERK_SECRET_KEY_SECRET")"
  fi
elif [[ -z "$LIVEPROBE_API_KEYS" ]]; then
  LIVEPROBE_API_KEYS="$LIVEPROBE_API_KEY"
fi
validate_api_key_ring "$LIVEPROBE_API_KEYS"
LIVEPROBE_API_KEY="${LIVEPROBE_API_KEYS%%,*}"
[[ "$POSTGRES_PASSWORD" =~ ^[0-9a-f]{64}$ ]] ||
  die "POSTGRES_PASSWORD must be a 64-character lowercase hex value"
if [[ -n "$CLERK_AUTHORIZED_PARTIES" ]]; then
  [[ ${#CLERK_SECRET_KEY} -ge 20 && ${#CLERK_SECRET_KEY} -le 512 &&
    "$CLERK_SECRET_KEY" =~ ^[A-Za-z0-9._-]+$ ]] ||
    die "CLERK_SECRET_KEY must be a 20-512 character single-line key"
  IFS=',' read -r -a clerk_authorized_parties <<<"$CLERK_AUTHORIZED_PARTIES"
  for party in "${clerk_authorized_parties[@]}"; do
    [[ "$party" =~ ^https?://[^/,[:space:]]+$ ]] ||
      die "invalid Clerk authorized-party origin: ${party:-<empty>}"
  done
  if [[ -n "$CLERK_AUDIENCE" ]]; then
    [[ "$CLERK_AUDIENCE" =~ ^[A-Za-z0-9._:/-]+(,[A-Za-z0-9._:/-]+)*$ ]] ||
      die "invalid CLERK_AUDIENCE"
  fi
elif [[ -n "$CLERK_SECRET_KEY" || -n "$CLERK_AUDIENCE" ]]; then
  die "CLERK_AUTHORIZED_PARTIES is required when Clerk is configured"
fi

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

install -d -m 0700 /etc/liveprobe
deployment_env_tmp="$(mktemp /etc/liveprobe/deployment.env.XXXXXX)"
chmod 0600 "$deployment_env_tmp"
{
  printf 'DATABASE_BACKEND=%s\n' "$DATABASE_BACKEND"
  printf 'GCP_DATABASE_BACKEND=%s\n' "$DATABASE_BACKEND"
  printf 'CLOUD_SQL_INSTANCE_CONNECTION_NAME=%s\n' \
    "$CLOUD_SQL_INSTANCE_CONNECTION_NAME"
  printf 'CLOUD_SQL_DATABASE=%s\n' "$CLOUD_SQL_DATABASE"
  printf 'CLOUD_SQL_USER=%s\n' "$CLOUD_SQL_USER"
  printf 'LIVEPROBE_DB_POOL_SIZE=%s\n' "$LIVEPROBE_DB_POOL_SIZE"
  printf 'SECRETS_BACKEND=%s\n' "$SECRETS_BACKEND"
  printf 'LIVEPROBE_API_KEYS_SECRET=%s\n' "$LIVEPROBE_API_KEYS_SECRET"
  printf 'POSTGRES_PASSWORD_SECRET=%s\n' "$POSTGRES_PASSWORD_SECRET"
  printf 'CLERK_SECRET_KEY_SECRET=%s\n' "$CLERK_SECRET_KEY_SECRET"
  printf 'CLERK_SECRET_KEY=%s\n' "$CLERK_SECRET_KEY"
  printf 'CLERK_AUTHORIZED_PARTIES=%s\n' "$CLERK_AUTHORIZED_PARTIES"
  printf 'CLERK_AUDIENCE=%s\n' "$CLERK_AUDIENCE"
  printf 'LIVEPROBE_API_KEY=%s\n' "$LIVEPROBE_API_KEY"
  printf 'LIVEPROBE_API_KEYS=%s\n' "$LIVEPROBE_API_KEYS"
  printf 'POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD"
} >"$deployment_env_tmp"
mv -- "$deployment_env_tmp" /etc/liveprobe/deployment.env

# POSTGRES_PASSWORD is only applied by the image when the data directory is
# first initialized. Rotate an existing role before Compose recreates clients.
if [[ "$DATABASE_BACKEND" == "local" ]]; then
  existing_postgres="$({
    docker ps \
      --filter 'label=com.docker.compose.project=liveprobe-demo' \
      --filter 'label=com.docker.compose.service=postgres' \
      --format '{{.ID}}'
  } | head -n 1)"
  if [[ -n "$existing_postgres" ]]; then
    printf "alter role liveprobe with password '%s';\n" "$POSTGRES_PASSWORD" | \
      docker exec --interactive "$existing_postgres" \
        psql --username=liveprobe --dbname=liveprobe --set=ON_ERROR_STOP=1 \
        >/dev/null
  fi
fi

if ! BROKER_PORT="$BROKER_PORT" \
  GIT_COMMIT="${DEPLOY_COMMIT:-abcdef1234567890}" \
  LIVEPROBE_API_KEY="$LIVEPROBE_API_KEY" \
  LIVEPROBE_API_KEYS="$LIVEPROBE_API_KEYS" \
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  GCP_DATABASE_BACKEND="$DATABASE_BACKEND" \
  GCP_ENV_FILE=/etc/liveprobe/deployment.env \
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
      "http://127.0.0.1:${BROKER_PORT}/readyz" >/dev/null; then
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
