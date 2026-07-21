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
[[ -n "${LIVEPROBE_API_KEY:-}" ]] ||
  die "set LIVEPROBE_API_KEY to the shared broker/MCP/agent bearer key"

DEPLOY_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
validate_commit "$DEPLOY_COMMIT"

load_gcp_config
if ! client_source_range="$(resolve_client_source_range)"; then
  exit 1
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
  if [[ "$instance_status" != "RUNNING" ]]; then
    gcloud_cmd compute instances start "$VM_NAME" \
      --project="$PROJECT_ID" \
      --zone="$ZONE" \
      --quiet
  fi
else
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

# The remote shell, not this local shell, must expand status.
# shellcheck disable=SC2016
printf -v remote_command \
  'sudo env DEPLOY_COMMIT=%q RELEASE_ARCHIVE=%q BROKER_PORT=%q PUBLIC_IP=%q LIVEPROBE_API_KEY=%q bash %q; status=$?; sudo rm -f -- %q; exit $status' \
  "$DEPLOY_COMMIT" \
  "$remote_archive" \
  "$BROKER_PORT" \
  "$public_ip" \
  "$LIVEPROBE_API_KEY" \
  "$remote_bootstrap" \
  "$remote_bootstrap"
gcloud_cmd compute ssh "$VM_NAME" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" \
  --command="$remote_command" \
  --quiet

printf 'Broker URL: http://%s:%s\n' "$public_ip" "$BROKER_PORT"
printf 'Deployed SHA to paste when asked: %s\n' "$DEPLOY_COMMIT"
printf '\nExact Cursor MCP JSON:\n'
print_cursor_mcp_json "$public_ip" "$BROKER_PORT" "$LIVEPROBE_API_KEY"
