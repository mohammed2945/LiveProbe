#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

load_gcp_config
if ! source_range="$(resolve_client_source_range)"; then
  exit 1
fi

upsert_firewall_rule() {
  local rule_name="$1"
  local port="$2"

  if gcloud_cmd compute firewall-rules describe "$rule_name" \
    --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud_cmd compute firewall-rules update "$rule_name" \
      --project="$PROJECT_ID" \
      --allow="tcp:${port}" \
      --source-ranges="$source_range" \
      --target-tags="$NETWORK_TAG" \
      --quiet
  else
    gcloud_cmd compute firewall-rules create "$rule_name" \
      --project="$PROJECT_ID" \
      --network="$NETWORK" \
      --direction=INGRESS \
      --priority=1000 \
      --action=ALLOW \
      --rules="tcp:${port}" \
      --source-ranges="$source_range" \
      --target-tags="$NETWORK_TAG" \
      --quiet
  fi
}

upsert_firewall_rule "$FIREWALL_RULE" "$BROKER_PORT"
upsert_firewall_rule "$FIREWALL_SSH_RULE" 22

printf 'Broker firewall source: %s\n' "$source_range"
printf 'SSH firewall source: %s\n' "$source_range"
