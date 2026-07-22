#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

load_gcp_config
[[ "$SECRETS_BACKEND" == "secret-manager" ]] ||
  die "provision-secrets.sh requires SECRETS_BACKEND=secret-manager"

initial_api_keys="${LIVEPROBE_API_KEYS:-${LIVEPROBE_API_KEY:-}}"
initial_postgres_password="${POSTGRES_PASSWORD:-}"
initial_clerk_secret_key="${CLERK_SECRET_KEY:-}"
runtime_service_account="${RUNTIME_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud_cmd services enable \
  iam.googleapis.com \
  secretmanager.googleapis.com \
  --project="$PROJECT_ID" \
  --quiet

if ! gcloud_cmd iam service-accounts describe "$runtime_service_account" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud_cmd iam service-accounts create "$RUNTIME_SERVICE_ACCOUNT" \
    --project="$PROJECT_ID" \
    --display-name="LiveProbe runtime" \
    --quiet
fi

ensure_secret() {
  local secret_name="$1"
  local initial_value="$2"
  local value_kind="$3"
  local enabled_version

  if ! gcloud_cmd secrets describe "$secret_name" \
    --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud_cmd secrets create "$secret_name" \
      --project="$PROJECT_ID" \
      --replication-policy=automatic \
      --labels="application=liveprobe" \
      --quiet
  fi

  enabled_version="$(
    gcloud_cmd secrets versions list "$secret_name" \
      --project="$PROJECT_ID" \
      --filter='state=ENABLED' \
      --limit=1 \
      --format='value(name)'
  )"
  if [[ -z "$enabled_version" ]]; then
    [[ -n "$initial_value" ]] ||
      die "${value_kind} is required to initialize secret ${secret_name}"
    printf '%s' "$initial_value" | gcloud_cmd secrets versions add "$secret_name" \
      --project="$PROJECT_ID" \
      --data-file=- \
      --quiet >/dev/null
  fi

  gcloud_cmd secrets add-iam-policy-binding "$secret_name" \
    --project="$PROJECT_ID" \
    --member="serviceAccount:${runtime_service_account}" \
    --role=roles/secretmanager.secretAccessor \
    --quiet >/dev/null
}

if [[ -n "$initial_api_keys" ]]; then
  validate_api_key_ring "$initial_api_keys"
fi
if [[ -n "$initial_postgres_password" ]]; then
  [[ "$initial_postgres_password" =~ ^[0-9a-f]{64}$ ]] ||
    die "POSTGRES_PASSWORD must be a 64-character lowercase hex value"
fi

ensure_secret \
  "$LIVEPROBE_API_KEYS_SECRET" \
  "$initial_api_keys" \
  "LIVEPROBE_API_KEYS or LIVEPROBE_API_KEY"
ensure_secret \
  "$POSTGRES_PASSWORD_SECRET" \
  "$initial_postgres_password" \
  "POSTGRES_PASSWORD"

if [[ -n "$CLERK_AUTHORIZED_PARTIES" ]]; then
  ensure_secret \
    "$CLERK_SECRET_KEY_SECRET" \
    "$initial_clerk_secret_key" \
    "CLERK_SECRET_KEY"
fi

printf 'Secret Manager resources are ready: %s, %s' \
  "$LIVEPROBE_API_KEYS_SECRET" \
  "$POSTGRES_PASSWORD_SECRET"
if [[ -n "$CLERK_AUTHORIZED_PARTIES" ]]; then
  printf ', %s' "$CLERK_SECRET_KEY_SECRET"
fi
printf '\n'
