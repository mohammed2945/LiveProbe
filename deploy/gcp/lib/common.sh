#!/usr/bin/env bash

set -Eeuo pipefail

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

gcloud_cmd() {
  "${GCLOUD_BIN}" "$@"
}

validate_project_id() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] ||
    die "invalid GCP project ID: $1"
}

validate_region() {
  [[ "$1" =~ ^[a-z][a-z0-9-]*[a-z0-9]$ ]] ||
    die "invalid GCP region: $1"
}

validate_zone() {
  local region="$1"
  local zone="$2"
  [[ "$zone" =~ ^${region}-[a-z]$ ]] ||
    die "zone must belong to region ${region}: ${zone}"
}

validate_resource_name() {
  local label="$1"
  local value="$2"
  [[ ${#value} -le 63 && "$value" =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ ]] ||
    die "invalid ${label}: ${value}"
}

validate_managed_firewall_name() {
  local label="$1"
  local value="$2"

  validate_resource_name "$label" "$value"
  case "$value" in
    default-allow-*|default-deny-*)
      die "${label} must not name an unrelated GCP default rule: ${value}"
      ;;
  esac
}

validate_port() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] ||
    die "broker port must be an integer: ${value}"
  ((10#${value} >= 1 && 10#${value} <= 65535)) ||
    die "broker port must be between 1 and 65535: ${value}"
}

validate_commit() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] ||
    die "DEPLOY_COMMIT must be a full lowercase Git SHA: $1"
}

validate_ipv4() {
  local ip="$1"
  local octet
  local -a octets

  IFS='.' read -r -a octets <<<"${ip}"
  [[ ${#octets[@]} -eq 4 ]] || die "invalid IPv4 address: ${ip}"
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] || die "invalid IPv4 address: ${ip}"
    ((10#${octet} <= 255)) || die "invalid IPv4 address: ${ip}"
  done
  [[ "$ip" != "0.0.0.0" ]] || die "0.0.0.0 is not a valid client address"
}

print_cursor_mcp_json() {
  local ip="$1"
  local port="$2"

  validate_ipv4 "$ip"
  validate_port "$port"
  cat <<EOF
{
  "mcpServers": {
    "liveprobe": {
      "command": "npx",
      "args": [
        "-y",
        "@doomslayer2945/liveprobe-mcp@0.1.0",
        "--broker-url",
        "http://${ip}:${port}"
      ]
    }
  }
}
EOF
}

resolve_project_id() {
  local project="${PROJECT_ID:-}"

  if [[ -z "$project" ]]; then
    project="$(gcloud_cmd config get-value project 2>/dev/null || true)"
  fi
  [[ -n "$project" && "$project" != "(unset)" ]] ||
    die "set PROJECT_ID or configure a gcloud project"
  validate_project_id "$project"
  printf '%s\n' "$project"
}

resolve_client_ip() {
  local ip="${CLIENT_IP:-}"
  local candidate
  local endpoint

  if [[ -z "$ip" ]]; then
    require_command curl
    for endpoint in \
      "https://api.ipify.org" \
      "https://checkip.amazonaws.com"; do
      candidate="$(
        curl -4 --fail --silent --max-time 10 "$endpoint" 2>/dev/null || true
      )"
      candidate="${candidate//$'\r'/}"
      candidate="${candidate//$'\n'/}"
      if [[ -n "$candidate" ]] &&
        (validate_ipv4 "$candidate") 2>/dev/null; then
        ip="$candidate"
        break
      fi
    done
    [[ -n "$ip" ]] ||
      die "could not detect public IPv4; set CLIENT_IP explicitly"
  fi
  ip="${ip//$'\r'/}"
  ip="${ip//$'\n'/}"
  validate_ipv4 "$ip"
  printf '%s\n' "$ip"
}

load_gcp_config() {
  GCLOUD_BIN="${GCLOUD_BIN:-gcloud}"
  require_command "$GCLOUD_BIN"

  PROJECT_ID="$(resolve_project_id)"
  REGION="${REGION:-us-central1}"
  ZONE="${ZONE:-us-central1-a}"
  VM_NAME="${VM_NAME:-liveprobe-demo}"
  MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-4}"
  DISK_SIZE="${DISK_SIZE:-40GB}"
  STATIC_IP_NAME="${STATIC_IP_NAME:-${VM_NAME}-ip}"
  FIREWALL_RULE="${FIREWALL_RULE:-${VM_NAME}-broker}"
  FIREWALL_SSH_RULE="${FIREWALL_SSH_RULE:-${VM_NAME}-ssh}"
  NETWORK="${NETWORK:-default}"
  NETWORK_TAG="${NETWORK_TAG:-liveprobe-demo}"
  BROKER_PORT="${BROKER_PORT:-7070}"

  validate_region "$REGION"
  validate_zone "$REGION" "$ZONE"
  validate_resource_name "VM name" "$VM_NAME"
  validate_resource_name "static IP name" "$STATIC_IP_NAME"
  validate_managed_firewall_name "firewall rule name" "$FIREWALL_RULE"
  validate_managed_firewall_name "SSH firewall rule name" "$FIREWALL_SSH_RULE"
  [[ "$FIREWALL_RULE" != "$FIREWALL_SSH_RULE" ]] ||
    die "broker and SSH firewall rules must have different names"
  validate_resource_name "network name" "$NETWORK"
  validate_resource_name "network tag" "$NETWORK_TAG"
  [[ "$MACHINE_TYPE" =~ ^[a-z0-9][-a-z0-9]*$ ]] ||
    die "invalid machine type: ${MACHINE_TYPE}"
  [[ "$DISK_SIZE" =~ ^[1-9][0-9]*GB$ ]] ||
    die "invalid boot disk size: ${DISK_SIZE}"
  validate_port "$BROKER_PORT"
}
