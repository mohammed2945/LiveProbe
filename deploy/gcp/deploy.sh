#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

require_command git
require_command node
[[ "$(git -C "$REPO_ROOT" rev-parse --show-toplevel)" == "$REPO_ROOT" ]] ||
  die "deploy.sh must be located inside the repository root"
[[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)" ]] ||
  die "deployment requires a clean Git working tree"

DEPLOY_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
validate_commit "$DEPLOY_COMMIT"

load_gcp_config
load_persisted_https_domain
if [[ "$SECRETS_BACKEND" == "secret-manager" ]]; then
  PROJECT_ID="$PROJECT_ID" \
  REGION="$REGION" \
  ZONE="$ZONE" \
  VM_NAME="$VM_NAME" \
  SECRETS_BACKEND="$SECRETS_BACKEND" \
  LIVEPROBE_API_KEYS_SECRET="$LIVEPROBE_API_KEYS_SECRET" \
  POSTGRES_PASSWORD_SECRET="$POSTGRES_PASSWORD_SECRET" \
  CLERK_SECRET_KEY_SECRET="$CLERK_SECRET_KEY_SECRET" \
  CLERK_SECRET_KEY="${CLERK_SECRET_KEY:-}" \
  CLERK_AUTHORIZED_PARTIES="$CLERK_AUTHORIZED_PARTIES" \
  CLERK_AUDIENCE="$CLERK_AUDIENCE" \
  RUNTIME_SERVICE_ACCOUNT="$RUNTIME_SERVICE_ACCOUNT" \
  LIVEPROBE_API_KEY="${LIVEPROBE_API_KEY:-}" \
  LIVEPROBE_API_KEYS="${LIVEPROBE_API_KEYS:-}" \
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}" \
  GCLOUD_BIN="$GCLOUD_BIN" \
    "${SCRIPT_DIR}/provision-secrets.sh"
  LIVEPROBE_API_KEYS="$(read_secret_version "$LIVEPROBE_API_KEYS_SECRET")"
  POSTGRES_PASSWORD="$(read_secret_version "$POSTGRES_PASSWORD_SECRET")"
  if [[ -n "$CLERK_AUTHORIZED_PARTIES" ]]; then
    CLERK_SECRET_KEY="$(read_secret_version "$CLERK_SECRET_KEY_SECRET")"
  fi
else
  LIVEPROBE_API_KEYS="${LIVEPROBE_API_KEYS:-${LIVEPROBE_API_KEY:-}}"
fi
validate_api_key_ring "$LIVEPROBE_API_KEYS"
LIVEPROBE_API_KEY="$(primary_api_key "$LIVEPROBE_API_KEYS")"
[[ "$POSTGRES_PASSWORD" =~ ^[0-9a-f]{64}$ ]] ||
  die "POSTGRES_PASSWORD must be a 64-character lowercase hex value"
if ! client_source_range="$(resolve_client_source_range)"; then
  exit 1
fi
if [[ -n "$HTTPS_DOMAIN" ]]; then
  certificate_status="$(
    gcloud_cmd compute ssl-certificates describe "$HTTPS_CERTIFICATE" \
      --project="$PROJECT_ID" \
      --global \
      --format='value(managed.status)' 2>/dev/null || true
  )"
  [[ "$certificate_status" == "ACTIVE" ]] ||
    die "HTTPS_DOMAIN requires an ACTIVE managed certificate; run provision-https.sh first"
  gcloud_cmd compute forwarding-rules describe "$HTTPS_FORWARDING_RULE" \
    --project="$PROJECT_ID" \
    --global >/dev/null 2>&1 ||
    die "HTTPS forwarding rule is missing; run provision-https.sh first"
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/liveprobe-deploy.XXXXXX")"
archive="${tmp_dir}/liveprobe-${DEPLOY_COMMIT}.tar.gz"
bootstrap_copy="${tmp_dir}/liveprobe-bootstrap-${DEPLOY_COMMIT}.sh"
trap 'rm -rf -- "$tmp_dir"' EXIT

git -C "$REPO_ROOT" archive \
  --format=tar.gz \
  --output="$archive" \
  "$DEPLOY_COMMIT"
cp -- "${SCRIPT_DIR}/bootstrap.sh" "$bootstrap_copy"

gcloud_cmd services enable compute.googleapis.com \
  --project="$PROJECT_ID" \
  --quiet

cloud_sql_connection_name=""
runtime_service_account="${RUNTIME_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
needs_runtime_identity=false
if [[ "$DATABASE_BACKEND" == "cloud-sql" ||
  "$SECRETS_BACKEND" == "secret-manager" ]]; then
  needs_runtime_identity=true
fi
if [[ "$DATABASE_BACKEND" == "cloud-sql" ]]; then
  cloud_sql_connection_name="$(
    PROJECT_ID="$PROJECT_ID" \
    REGION="$REGION" \
    ZONE="$ZONE" \
    VM_NAME="$VM_NAME" \
    DATABASE_BACKEND="$DATABASE_BACKEND" \
    CLOUD_SQL_INSTANCE="$CLOUD_SQL_INSTANCE" \
    CLOUD_SQL_DATABASE="$CLOUD_SQL_DATABASE" \
    CLOUD_SQL_USER="$CLOUD_SQL_USER" \
    CLOUD_SQL_AVAILABILITY_TYPE="$CLOUD_SQL_AVAILABILITY_TYPE" \
    RUNTIME_SERVICE_ACCOUNT="$RUNTIME_SERVICE_ACCOUNT" \
    LIVEPROBE_DB_POOL_SIZE="$LIVEPROBE_DB_POOL_SIZE" \
    POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    GCLOUD_BIN="$GCLOUD_BIN" \
      "${SCRIPT_DIR}/provision-cloud-sql.sh"
  )"
fi

if ! gcloud_cmd compute addresses describe "$STATIC_IP_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" >/dev/null 2>&1; then
  gcloud_cmd compute addresses create "$STATIC_IP_NAME" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --network-tier=PREMIUM \
    --quiet
fi

public_ip="$(
  gcloud_cmd compute addresses describe "$STATIC_IP_NAME" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --format='value(address)'
)"
validate_ipv4 "$public_ip"

PROJECT_ID="$PROJECT_ID" \
REGION="$REGION" \
ZONE="$ZONE" \
VM_NAME="$VM_NAME" \
MACHINE_TYPE="$MACHINE_TYPE" \
DISK_SIZE="$DISK_SIZE" \
STATIC_IP_NAME="$STATIC_IP_NAME" \
FIREWALL_RULE="$FIREWALL_RULE" \
FIREWALL_SSH_RULE="$FIREWALL_SSH_RULE" \
HTTPS_FIREWALL_RULE="$HTTPS_FIREWALL_RULE" \
HTTPS_DOMAIN="$HTTPS_DOMAIN" \
NETWORK="$NETWORK" \
NETWORK_TAG="$NETWORK_TAG" \
BROKER_PORT="$BROKER_PORT" \
CLIENT_IP="" \
CLIENT_CIDR="$client_source_range" \
GCLOUD_BIN="$GCLOUD_BIN" \
  "${SCRIPT_DIR}/refresh-firewall.sh"

if gcloud_cmd compute instances describe "$VM_NAME" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" >/dev/null 2>&1; then
  gcloud_cmd compute instances add-tags "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --tags="$NETWORK_TAG" \
    --quiet

  instance_ip="$(
    gcloud_cmd compute instances describe "$VM_NAME" \
      --project="$PROJECT_ID" \
      --zone="$ZONE" \
      --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
  )"
  [[ "$instance_ip" == "$public_ip" ]] ||
    die "existing VM external IP ${instance_ip:-<none>} does not match reserved IP ${public_ip}"

  instance_status="$(
    gcloud_cmd compute instances describe "$VM_NAME" \
      --project="$PROJECT_ID" \
      --zone="$ZONE" \
      --format='value(status)'
  )"
  if [[ "$needs_runtime_identity" == true ]]; then
    current_service_account="$(
      gcloud_cmd compute instances describe "$VM_NAME" \
        --project="$PROJECT_ID" \
        --zone="$ZONE" \
        --format='value(serviceAccounts[0].email)'
    )"
    current_scopes="$(
      gcloud_cmd compute instances describe "$VM_NAME" \
        --project="$PROJECT_ID" \
        --zone="$ZONE" \
        --format='value(serviceAccounts[0].scopes)'
    )"
    if [[ "$current_service_account" != "$runtime_service_account" ||
      "$current_scopes" != *"https://www.googleapis.com/auth/cloud-platform"* ]]; then
      if [[ "$instance_status" != "TERMINATED" ]]; then
        gcloud_cmd compute instances stop "$VM_NAME" \
          --project="$PROJECT_ID" \
          --zone="$ZONE" \
          --quiet
      fi
      gcloud_cmd compute instances set-service-account "$VM_NAME" \
        --project="$PROJECT_ID" \
        --zone="$ZONE" \
        --service-account="$runtime_service_account" \
        --scopes=cloud-platform \
        --quiet
      instance_status="TERMINATED"
    fi
  fi
  if [[ "$instance_status" != "RUNNING" ]]; then
    gcloud_cmd compute instances start "$VM_NAME" \
      --project="$PROJECT_ID" \
      --zone="$ZONE" \
      --quiet
  fi
else
  vm_identity_args=()
  if [[ "$needs_runtime_identity" == true ]]; then
    vm_identity_args=(
      "--service-account=${runtime_service_account}"
      "--scopes=cloud-platform"
    )
  fi
  gcloud_cmd compute instances create "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family=ubuntu-2404-lts-amd64 \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size="$DISK_SIZE" \
    --boot-disk-type=pd-balanced \
    --network="$NETWORK" \
    --address="$public_ip" \
    --network-tier=PREMIUM \
    --tags="$NETWORK_TAG" \
    --maintenance-policy=MIGRATE \
    --provisioning-model=STANDARD \
    "${vm_identity_args[@]}" \
    --quiet
fi

ssh_ready=false
for _attempt in {1..18}; do
  if gcloud_cmd compute ssh "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --command=true \
    --quiet >/dev/null 2>&1; then
    ssh_ready=true
    break
  fi
  sleep 10
done
[[ "$ssh_ready" == true ]] || die "VM did not become reachable over SSH"

remote_archive="/tmp/$(basename -- "$archive")"
remote_bootstrap="/tmp/$(basename -- "$bootstrap_copy")"
gcloud_cmd compute scp "$archive" "$bootstrap_copy" \
  "${VM_NAME}:/tmp/" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" \
  --quiet

remote_api_key="$LIVEPROBE_API_KEY"
remote_api_keys="$LIVEPROBE_API_KEYS"
remote_postgres_password="$POSTGRES_PASSWORD"
remote_clerk_secret_key="$CLERK_SECRET_KEY"
if [[ "$SECRETS_BACKEND" == "secret-manager" ]]; then
  remote_api_key=""
  remote_api_keys=""
  remote_postgres_password=""
  remote_clerk_secret_key=""
fi

# The remote shell, not this local shell, must expand status.
# shellcheck disable=SC2016
printf -v remote_command \
  'sudo env DEPLOY_COMMIT=%q RELEASE_ARCHIVE=%q BROKER_PORT=%q PUBLIC_IP=%q PROJECT_ID=%q SECRETS_BACKEND=%q LIVEPROBE_API_KEYS_SECRET=%q POSTGRES_PASSWORD_SECRET=%q CLERK_SECRET_KEY_SECRET=%q LIVEPROBE_API_KEY=%q LIVEPROBE_API_KEYS=%q POSTGRES_PASSWORD=%q CLERK_SECRET_KEY=%q CLERK_AUTHORIZED_PARTIES=%q CLERK_AUDIENCE=%q DATABASE_BACKEND=%q CLOUD_SQL_INSTANCE_CONNECTION_NAME=%q CLOUD_SQL_DATABASE=%q CLOUD_SQL_USER=%q LIVEPROBE_DB_POOL_SIZE=%q bash %q; status=$?; sudo rm -f -- %q; exit $status' \
  "$DEPLOY_COMMIT" \
  "$remote_archive" \
  "$BROKER_PORT" \
  "$public_ip" \
  "$PROJECT_ID" \
  "$SECRETS_BACKEND" \
  "$LIVEPROBE_API_KEYS_SECRET" \
  "$POSTGRES_PASSWORD_SECRET" \
  "$CLERK_SECRET_KEY_SECRET" \
  "$remote_api_key" \
  "$remote_api_keys" \
  "$remote_postgres_password" \
  "$remote_clerk_secret_key" \
  "$CLERK_AUTHORIZED_PARTIES" \
  "$CLERK_AUDIENCE" \
  "$DATABASE_BACKEND" \
  "$cloud_sql_connection_name" \
  "$CLOUD_SQL_DATABASE" \
  "$CLOUD_SQL_USER" \
  "$LIVEPROBE_DB_POOL_SIZE" \
  "$remote_bootstrap" \
  "$remote_bootstrap"
gcloud_cmd compute ssh "$VM_NAME" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" \
  --command="$remote_command" \
  --quiet

if [[ -n "$HTTPS_DOMAIN" ]]; then
  broker_url="https://${HTTPS_DOMAIN}"
else
  broker_url="http://${public_ip}:${BROKER_PORT}"
fi
printf 'Broker URL: %s\n' "$broker_url"
printf 'Deployed SHA to paste when asked: %s\n' "$DEPLOY_COMMIT"
printf '\nExact Cursor MCP JSON:\n'
print_broker_mcp_json "$broker_url" "$LIVEPROBE_API_KEY"
