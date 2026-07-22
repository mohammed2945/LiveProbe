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

validate_database_backend() {
  case "$1" in
    local|cloud-sql) ;;
    *) die "DATABASE_BACKEND must be local or cloud-sql: $1" ;;
  esac
}

validate_secrets_backend() {
  case "$1" in
    environment|secret-manager) ;;
    *) die "SECRETS_BACKEND must be environment or secret-manager: $1" ;;
  esac
}

validate_api_key() {
  local value="$1"

  [[ ${#value} -ge 32 && ${#value} -le 256 &&
    "$value" =~ ^[A-Za-z0-9._~-]+$ ]] ||
    die "broker API keys must be 32-256 URL-safe characters"
}

validate_api_key_ring() {
  local value="$1"
  local key
  local -a keys

  IFS=',' read -r -a keys <<<"$value"
  [[ ${#keys[@]} -ge 1 && ${#keys[@]} -le 2 ]] ||
    die "broker API key ring must contain one or two comma-separated keys"
  for key in "${keys[@]}"; do
    validate_api_key "$key"
  done
  if [[ ${#keys[@]} -eq 2 && "${keys[0]}" == "${keys[1]}" ]]; then
    die "broker API key ring contains a duplicate key"
  fi
}

validate_clerk_authorized_parties() {
  local value="$1"
  local party
  local -a parties

  IFS=',' read -r -a parties <<<"$value"
  [[ ${#parties[@]} -ge 1 ]] ||
    die "CLERK_AUTHORIZED_PARTIES must contain at least one origin"
  for party in "${parties[@]}"; do
    [[ "$party" =~ ^https?://[^/,[:space:]]+$ ]] ||
      die "invalid Clerk authorized-party origin: ${party:-<empty>}"
  done
}

validate_clerk_secret_key() {
  local value="$1"

  [[ ${#value} -ge 20 && ${#value} -le 512 &&
    "$value" =~ ^[A-Za-z0-9._-]+$ ]] ||
    die "CLERK_SECRET_KEY must be a 20-512 character single-line key"
}

validate_clerk_audience() {
  local value="$1"
  local audience
  local -a audiences

  [[ -z "$value" ]] && return
  IFS=',' read -r -a audiences <<<"$value"
  for audience in "${audiences[@]}"; do
    [[ "$audience" =~ ^[A-Za-z0-9._:/-]+$ ]] ||
      die "invalid Clerk audience: ${audience:-<empty>}"
  done
}

primary_api_key() {
  local key_ring="$1"

  validate_api_key_ring "$key_ring"
  printf '%s\n' "${key_ring%%,*}"
}

read_secret_version() {
  local secret_name="$1"
  local value

  value="$(
    gcloud_cmd secrets versions access latest \
      --project="$PROJECT_ID" \
      --secret="$secret_name"
  )"
  [[ -n "$value" ]] || die "Secret Manager value is empty: ${secret_name}"
  printf '%s\n' "$value"
}

validate_database_identifier() {
  local label="$1"
  local value="$2"
  [[ ${#value} -le 63 && "$value" =~ ^[a-z][a-z0-9_]*$ ]] ||
    die "invalid ${label}: ${value}"
}

validate_service_account_name() {
  local value="$1"
  [[ ${#value} -ge 6 && ${#value} -le 30 && \
    "$value" =~ ^[a-z]([-a-z0-9]*[a-z0-9])$ ]] ||
    die "invalid runtime service account name: ${value}"
}

validate_domain_name() {
  local domain="$1"
  local label
  local -a labels

  [[ ${#domain} -le 253 && "$domain" == *.* &&
    "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])$ ]] ||
    die "invalid HTTPS domain: ${domain}"
  IFS='.' read -r -a labels <<<"$domain"
  for label in "${labels[@]}"; do
    [[ ${#label} -ge 1 && ${#label} -le 63 &&
      "$label" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
      die "invalid HTTPS domain label: ${label:-<empty>}"
  done
}

validate_positive_integer() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] ||
    die "${label} must be a positive integer: ${value}"
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

normalize_client_cidr() {
  local cidr="$1"
  local ip
  local prefix
  local a
  local b
  local c
  local d
  local address
  local host_bits
  local mask
  local network

  [[ "$cidr" =~ ^([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/(2[4-9]|3[0-2])$ ]] ||
    die "CLIENT_CIDR must be one IPv4 CIDR with prefix 24-32: ${cidr}"
  ip="${BASH_REMATCH[1]}"
  prefix="${BASH_REMATCH[2]}"
  validate_ipv4 "$ip"

  IFS='.' read -r a b c d <<<"$ip"
  address="$((
    (10#${a} << 24) |
      (10#${b} << 16) |
      (10#${c} << 8) |
      10#${d}
  ))"
  host_bits="$((32 - 10#${prefix}))"
  mask="$(((0xFFFFFFFF << host_bits) & 0xFFFFFFFF))"
  network="$((address & mask))"

  printf '%d.%d.%d.%d/%d\n' \
    "$(((network >> 24) & 255))" \
    "$(((network >> 16) & 255))" \
    "$(((network >> 8) & 255))" \
    "$((network & 255))" \
    "$((10#${prefix}))"
}

print_broker_mcp_json() {
  local broker_url="$1"
  local api_key="$2"

  [[ -n "$api_key" ]] || die "LIVEPROBE_API_KEY must not be empty"
  node - "$broker_url" "$api_key" <<'NODE'
const [brokerUrl, apiKey] = process.argv.slice(2);
const parsed = new URL(brokerUrl);
if (!['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    parsed.pathname !== '/') {
  throw new Error('invalid broker URL');
}
const config = {
  mcpServers: {
    liveprobe: {
      command: "npx",
      args: [
        "-y",
        "@doomslayer2945/liveprobe-mcp@0.1.1",
        "--broker-url",
        brokerUrl,
      ],
      env: { LIVEPROBE_API_KEY: apiKey },
    },
  },
};
process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
NODE
}

print_cursor_mcp_json() {
  local ip="$1"
  local port="$2"
  local api_key="$3"

  validate_ipv4 "$ip"
  validate_port "$port"
  print_broker_mcp_json "http://${ip}:${port}" "$api_key"
}

load_persisted_https_domain() {
  local metadata_json
  local persisted_domain

  [[ -z "$HTTPS_DOMAIN" ]] || return 0
  metadata_json="$(
    gcloud_cmd compute instances describe "$VM_NAME" \
      --project="$PROJECT_ID" \
      --zone="$ZONE" \
      --format='json(metadata.items)' 2>/dev/null || true
  )"
  [[ -n "$metadata_json" && "$metadata_json" != "null" ]] || return 0
  require_command node
  persisted_domain="$(
    node -e '
      const instance = JSON.parse(process.argv[1]);
      const item = instance?.metadata?.items?.find(
        ({ key }) => key === process.argv[2],
      );
      if (typeof item?.value === "string") process.stdout.write(item.value);
    ' "$metadata_json" "$HTTPS_DOMAIN_METADATA_KEY"
  )"
  [[ -n "$persisted_domain" ]] || return 0
  validate_domain_name "$persisted_domain"
  HTTPS_DOMAIN="$persisted_domain"
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

resolve_client_source_range() {
  local client_ip="${CLIENT_IP:-}"
  local client_cidr="${CLIENT_CIDR:-}"

  [[ -z "$client_ip" || -z "$client_cidr" ]] ||
    die "CLIENT_IP and CLIENT_CIDR are mutually exclusive"

  if [[ -n "$client_cidr" ]]; then
    normalize_client_cidr "$client_cidr"
  else
    client_ip="$(resolve_client_ip)" || return 1
    printf '%s/32\n' "$client_ip"
  fi
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
  BROKER_PORT="${BROKER_PORT:-80}"
  DATABASE_BACKEND="${DATABASE_BACKEND:-local}"
  CLOUD_SQL_INSTANCE="${CLOUD_SQL_INSTANCE:-${VM_NAME}-postgres}"
  CLOUD_SQL_DATABASE="${CLOUD_SQL_DATABASE:-liveprobe}"
  CLOUD_SQL_USER="${CLOUD_SQL_USER:-liveprobe}"
  CLOUD_SQL_AVAILABILITY_TYPE="${CLOUD_SQL_AVAILABILITY_TYPE:-regional}"
  RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT:-liveprobe-runtime}"
  LIVEPROBE_DB_POOL_SIZE="${LIVEPROBE_DB_POOL_SIZE:-10}"
  SECRETS_BACKEND="${SECRETS_BACKEND:-secret-manager}"
  LIVEPROBE_API_KEYS_SECRET="${LIVEPROBE_API_KEYS_SECRET:-${VM_NAME}-broker-api-keys}"
  POSTGRES_PASSWORD_SECRET="${POSTGRES_PASSWORD_SECRET:-${VM_NAME}-postgres-password}"
  CLERK_SECRET_KEY_SECRET="${CLERK_SECRET_KEY_SECRET:-${VM_NAME}-clerk-secret-key}"
  CLERK_SECRET_KEY="${CLERK_SECRET_KEY:-}"
  CLERK_AUTHORIZED_PARTIES="${CLERK_AUTHORIZED_PARTIES:-}"
  CLERK_AUDIENCE="${CLERK_AUDIENCE:-}"
  HTTPS_DOMAIN="${HTTPS_DOMAIN:-}"
  HTTPS_IP_NAME="${HTTPS_IP_NAME:-${VM_NAME}-https-ip}"
  HTTPS_INSTANCE_GROUP="${HTTPS_INSTANCE_GROUP:-${VM_NAME}-https-backend}"
  HTTPS_HEALTH_CHECK="${HTTPS_HEALTH_CHECK:-${VM_NAME}-https-health}"
  HTTPS_BACKEND_SERVICE="${HTTPS_BACKEND_SERVICE:-${VM_NAME}-https-service}"
  HTTPS_URL_MAP="${HTTPS_URL_MAP:-${VM_NAME}-https-map}"
  HTTPS_CERTIFICATE="${HTTPS_CERTIFICATE:-${VM_NAME}-certificate}"
  HTTPS_SSL_POLICY="${HTTPS_SSL_POLICY:-${VM_NAME}-tls-policy}"
  HTTPS_PROXY="${HTTPS_PROXY:-${VM_NAME}-https-proxy}"
  HTTPS_FORWARDING_RULE="${HTTPS_FORWARDING_RULE:-${VM_NAME}-https-forwarding}"
  HTTP_REDIRECT_URL_MAP="${HTTP_REDIRECT_URL_MAP:-${VM_NAME}-http-redirect-map}"
  HTTP_REDIRECT_PROXY="${HTTP_REDIRECT_PROXY:-${VM_NAME}-http-redirect-proxy}"
  HTTP_REDIRECT_FORWARDING_RULE="${HTTP_REDIRECT_FORWARDING_RULE:-${VM_NAME}-http-redirect-forwarding}"
  HTTPS_FIREWALL_RULE="${HTTPS_FIREWALL_RULE:-${VM_NAME}-lb-backend}"
  # Consumed by scripts that source this library.
  # shellcheck disable=SC2034
  HTTPS_PROXY_SOURCE_RANGES="35.191.0.0/16,130.211.0.0/22"
  HTTPS_DOMAIN_METADATA_KEY="liveprobe-https-domain"

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
  validate_database_backend "$DATABASE_BACKEND"
  validate_secrets_backend "$SECRETS_BACKEND"
  validate_resource_name "broker API keys secret name" "$LIVEPROBE_API_KEYS_SECRET"
  validate_resource_name "Postgres password secret name" "$POSTGRES_PASSWORD_SECRET"
  validate_resource_name "Clerk secret key secret name" "$CLERK_SECRET_KEY_SECRET"
  if [[ -n "$CLERK_SECRET_KEY" || -n "$CLERK_AUTHORIZED_PARTIES" ||
    -n "$CLERK_AUDIENCE" ]]; then
    [[ -n "$CLERK_AUTHORIZED_PARTIES" ]] ||
      die "CLERK_AUTHORIZED_PARTIES is required when Clerk is configured"
    validate_clerk_authorized_parties "$CLERK_AUTHORIZED_PARTIES"
    if [[ -n "$CLERK_SECRET_KEY" ]]; then
      validate_clerk_secret_key "$CLERK_SECRET_KEY"
    fi
    validate_clerk_audience "$CLERK_AUDIENCE"
    if [[ "$SECRETS_BACKEND" == "environment" ]]; then
      [[ -n "$CLERK_SECRET_KEY" ]] ||
        die "CLERK_SECRET_KEY is required for environment-backed Clerk auth"
    fi
  fi
  validate_resource_name "Cloud SQL instance name" "$CLOUD_SQL_INSTANCE"
  validate_database_identifier "Cloud SQL database name" "$CLOUD_SQL_DATABASE"
  validate_database_identifier "Cloud SQL user name" "$CLOUD_SQL_USER"
  case "$CLOUD_SQL_AVAILABILITY_TYPE" in
    regional|zonal) ;;
    *)
      die "CLOUD_SQL_AVAILABILITY_TYPE must be regional or zonal: ${CLOUD_SQL_AVAILABILITY_TYPE}"
      ;;
  esac
  validate_service_account_name "$RUNTIME_SERVICE_ACCOUNT"
  validate_positive_integer "LIVEPROBE_DB_POOL_SIZE" "$LIVEPROBE_DB_POOL_SIZE"
  if [[ -n "$HTTPS_DOMAIN" ]]; then
    validate_domain_name "$HTTPS_DOMAIN"
  fi
  validate_resource_name "HTTPS IP name" "$HTTPS_IP_NAME"
  validate_resource_name "HTTPS instance group name" "$HTTPS_INSTANCE_GROUP"
  validate_resource_name "HTTPS health check name" "$HTTPS_HEALTH_CHECK"
  validate_resource_name "HTTPS backend service name" "$HTTPS_BACKEND_SERVICE"
  validate_resource_name "HTTPS URL map name" "$HTTPS_URL_MAP"
  validate_resource_name "HTTPS certificate name" "$HTTPS_CERTIFICATE"
  validate_resource_name "HTTPS SSL policy name" "$HTTPS_SSL_POLICY"
  validate_resource_name "HTTPS proxy name" "$HTTPS_PROXY"
  validate_resource_name "HTTPS forwarding rule name" "$HTTPS_FORWARDING_RULE"
  validate_resource_name "HTTP redirect URL map name" "$HTTP_REDIRECT_URL_MAP"
  validate_resource_name "HTTP redirect proxy name" "$HTTP_REDIRECT_PROXY"
  validate_resource_name "HTTP redirect forwarding rule name" "$HTTP_REDIRECT_FORWARDING_RULE"
  validate_managed_firewall_name "HTTPS firewall rule name" "$HTTPS_FIREWALL_RULE"
  [[ "$MACHINE_TYPE" =~ ^[a-z0-9][-a-z0-9]*$ ]] ||
    die "invalid machine type: ${MACHINE_TYPE}"
  [[ "$DISK_SIZE" =~ ^[1-9][0-9]*GB$ ]] ||
    die "invalid boot disk size: ${DISK_SIZE}"
  validate_port "$BROKER_PORT"
}
