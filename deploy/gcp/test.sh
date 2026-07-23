#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

for script in "${SCRIPT_DIR}"/*.sh "${SCRIPT_DIR}"/lib/*.sh; do
  bash -n "$script"
  [[ -x "$script" ]] || fail "script is not executable: $script"
done

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "${SCRIPT_DIR}"/*.sh "${SCRIPT_DIR}"/lib/*.sh
fi

if grep -R --exclude=test.sh -F '0.0.0.0/0' "${SCRIPT_DIR}" >/dev/null ||
  grep -F '0.0.0.0/0' "${REPO_ROOT}/README.md" >/dev/null; then
  fail "deployment files must never allow 0.0.0.0/0"
fi

make_output="$(
  make --directory="$REPO_ROOT" --dry-run \
    DOCKER_COMPOSE='sudo docker compose' \
    gcp-demo-up
)"
grep -F \
  "sudo docker compose -f demo/docker-compose.yml -f deploy/gcp/docker-compose.gcp.yml" \
  <<<"$make_output" >/dev/null ||
  fail "GCP Make targets do not preserve DOCKER_COMPOSE"
grep -F 'pnpm --filter @doomslayer2945/liveprobe-node run build' \
  <<<"$make_output" >/dev/null ||
  fail "GCP prerequisites do not build the Node SDK"

# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
mcp_json="$(print_cursor_mcp_json 203.0.113.11 80 'fixture-key-with-"quote')"
node -e '
  const config = JSON.parse(process.argv[1]);
  const server = config.mcpServers?.liveprobe;
  const expected = [
    "-y",
    "@doomslayer2945/liveprobe-mcp@0.1.1",
    "--broker-url",
    "http://203.0.113.11:80",
  ];
  if (server?.command !== "npx" ||
      JSON.stringify(server.args) !== JSON.stringify(expected) ||
      server.env?.LIVEPROBE_API_KEY !== "fixture-key-with-\"quote") {
    process.exit(1);
  }
' "$mcp_json" || fail "Cursor MCP JSON is invalid"

https_mcp_json="$(
  print_broker_mcp_json \
    'https://probe.example.com' \
    'fixture-key-with-"quote'
)"
node -e '
  const config = JSON.parse(process.argv[1]);
  const server = config.mcpServers?.liveprobe;
  if (server?.args?.at(-1) !== "https://probe.example.com" ||
      server.env?.LIVEPROBE_API_KEY !== "fixture-key-with-\"quote") {
    process.exit(1);
  }
' "$https_mcp_json" || fail "HTTPS MCP JSON is invalid"

live_key_call="print_broker_mcp_json \"\$broker_url\" \"\$LIVEPROBE_API_KEY\""
redacted_key_call="print_broker_mcp_json \"\$broker_url\" '<LIVEPROBE_API_KEY>'"
for deploy_script in deploy.sh activate-https.sh; do
  if grep -F "$live_key_call" \
    "${SCRIPT_DIR}/${deploy_script}" >/dev/null; then
    fail "${deploy_script} prints the live broker API key"
  fi
  grep -F "$redacted_key_call" \
    "${SCRIPT_DIR}/${deploy_script}" >/dev/null ||
    fail "${deploy_script} does not print a redacted MCP template"
done

for invalid_domain in \
  'localhost' \
  '-probe.example.com' \
  'probe..example.com' \
  'probe_example.com' \
  'https://probe.example.com'; do
  if (validate_domain_name "$invalid_domain") >/dev/null 2>&1; then
    fail "invalid HTTPS domain was accepted: ${invalid_domain}"
  fi
done
validate_domain_name 'probe.example.com'

detected_range="$(
  (
    unset CLIENT_IP CLIENT_CIDR
    curl() {
      printf '203.0.113.25\n'
    }
    resolve_client_source_range
  )
)"
[[ "$detected_range" == "203.0.113.25/32" ]] ||
  fail "detected client IPv4 was not converted to /32"

cidr_range="$(
  CLIENT_IP='' \
    CLIENT_CIDR=68.65.169.130/28 \
    resolve_client_source_range
)"
[[ "$cidr_range" == "68.65.169.128/28" ]] ||
  fail "explicit client CIDR was not normalized"

if (
  CLIENT_IP=203.0.113.25 \
    CLIENT_CIDR=68.65.169.128/28 \
    resolve_client_source_range >/dev/null 2>&1
); then
  fail "CLIENT_IP and CLIENT_CIDR were not mutually exclusive"
fi

for invalid_cidr in \
  '0.0.0.0/0' \
  '68.65.169.0/23' \
  '68.65.169.128/33' \
  '68.65.169.128' \
  'stanford.example/28' \
  '68.65.169.128/28,68.65.169.144/28' \
  '999.65.169.128/28'; do
  if (
    CLIENT_IP='' \
      CLIENT_CIDR="$invalid_cidr" \
      resolve_client_source_range >/dev/null 2>&1
  ); then
    fail "invalid client CIDR was accepted: ${invalid_cidr}"
  fi
done

grep -F "\"\${BROKER_PORT:-7070}:7070\"" \
  "${REPO_ROOT}/demo/docker-compose.yml" >/dev/null ||
  fail "local Docker broker default changed from 7070"
grep -F "\"0.0.0.0:\${BROKER_PORT:-80}:7070\"" \
  "${SCRIPT_DIR}/docker-compose.gcp.yml" >/dev/null ||
  fail "GCP broker default is not port 80"
grep -F "client_source_range=\"\$(resolve_client_source_range)\"" \
  "${SCRIPT_DIR}/deploy.sh" >/dev/null ||
  fail "deploy does not resolve the client source once"
grep -F "CLIENT_CIDR=\"\$client_source_range\"" \
  "${SCRIPT_DIR}/deploy.sh" >/dev/null ||
  fail "deploy does not pass the normalized source to firewall refresh"
# These assertions intentionally search for literal shell expressions.
# shellcheck disable=SC2016
grep -F '"${SCRIPT_DIR}/provision-cloud-sql.sh"' \
  "${SCRIPT_DIR}/deploy.sh" >/dev/null ||
  fail "deploy does not invoke the Cloud SQL provisioner"
# shellcheck disable=SC2016
grep -F '"${SCRIPT_DIR}/provision-secrets.sh"' \
  "${SCRIPT_DIR}/deploy.sh" >/dev/null ||
  fail "deploy does not invoke the Secret Manager provisioner"
# shellcheck disable=SC2016
grep -F -- '--service-account="$runtime_service_account"' \
  "${SCRIPT_DIR}/deploy.sh" >/dev/null ||
  fail "deploy does not attach the dedicated runtime service account"
# shellcheck disable=SC2016
grep -F 'GCP_DATABASE_BACKEND="$DATABASE_BACKEND"' \
  "${SCRIPT_DIR}/bootstrap.sh" >/dev/null ||
  fail "bootstrap does not select the deployed database Compose layer"
grep -F 'GCP_ENV_FILE=/etc/liveprobe/deployment.env' \
  "${SCRIPT_DIR}/remote-compose.sh" >/dev/null ||
  fail "remote operations do not load the protected deployment env"
grep -F 'metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
  "${SCRIPT_DIR}/bootstrap.sh" >/dev/null ||
  fail "bootstrap does not use the VM metadata identity for secrets"
grep -F 'remote_api_keys=""' "${SCRIPT_DIR}/deploy.sh" >/dev/null ||
  fail "Secret Manager deploy does not clear API keys from the SSH command"
grep -F 'remote_postgres_password=""' "${SCRIPT_DIR}/deploy.sh" >/dev/null ||
  fail "Secret Manager deploy does not clear the database password from SSH"
grep -F 'remote_clerk_secret_key=""' "${SCRIPT_DIR}/deploy.sh" >/dev/null ||
  fail "Secret Manager deploy does not clear the Clerk secret from SSH"
# shellcheck disable=SC2016
grep -F 'LIVEPROBE_API_KEYS: ${LIVEPROBE_API_KEYS:-}' \
  "${REPO_ROOT}/demo/docker-compose.yml" >/dev/null ||
  fail "broker Compose service does not receive the rotation key ring"
# shellcheck disable=SC2016
grep -F 'CLERK_SECRET_KEY: ${CLERK_SECRET_KEY:-}' \
  "${REPO_ROOT}/demo/docker-compose.yml" >/dev/null ||
  fail "broker Compose service does not receive the Clerk secret"

cloud_sql_password="$(printf 'a%.0s' {1..64})"
cloud_sql_connection_name="lightprobe-test:us-central1:lp-test-postgres"
cloud_services="$(
  POSTGRES_PASSWORD="$cloud_sql_password" \
  CLOUD_SQL_INSTANCE_CONNECTION_NAME="$cloud_sql_connection_name" \
    docker compose \
      -f "${REPO_ROOT}/demo/docker-compose.yml" \
      -f "${SCRIPT_DIR}/docker-compose.gcp.yml" \
      -f "${SCRIPT_DIR}/docker-compose.cloud-sql.yml" \
      config --services
)"
grep -Fx 'cloud-sql-proxy' <<<"$cloud_services" >/dev/null ||
  fail "Cloud SQL Compose does not start the auth proxy"
if grep -Fx 'postgres' <<<"$cloud_services" >/dev/null; then
  fail "Cloud SQL Compose still starts VM-local Postgres"
fi
cloud_make_output="$(
  make --directory="$REPO_ROOT" --dry-run \
    DOCKER_COMPOSE='sudo docker compose' \
    GCP_DATABASE_BACKEND=cloud-sql \
    GCP_ENV_FILE=/etc/liveprobe/deployment.env \
    gcp-demo-up
)"
grep -F -- '--env-file /etc/liveprobe/deployment.env' \
  <<<"$cloud_make_output" >/dev/null ||
  fail "Cloud SQL Make target does not load the protected deployment env"
grep -F -- '-f deploy/gcp/docker-compose.cloud-sql.yml' \
  <<<"$cloud_make_output" >/dev/null ||
  fail "Cloud SQL Make target does not include its Compose layer"

if (validate_database_backend unsupported) >/dev/null 2>&1; then
  fail "unsupported database backend was accepted"
fi
if (validate_positive_integer LIVEPROBE_DB_POOL_SIZE 0) >/dev/null 2>&1; then
  fail "invalid database pool size was accepted"
fi
fixture_api_key="$(printf 'a%.0s' {1..64})"
previous_api_key="$(printf 'b%.0s' {1..64})"
validate_api_key_ring "$fixture_api_key"
validate_api_key_ring "${fixture_api_key},${previous_api_key}"
[[ "$(primary_api_key "${fixture_api_key},${previous_api_key}")" == \
  "$fixture_api_key" ]] || fail "primary API key was not selected"
if (validate_api_key_ring 'short') >/dev/null 2>&1; then
  fail "short API key was accepted"
fi
if (validate_api_key_ring "${fixture_api_key},${fixture_api_key}") \
  >/dev/null 2>&1; then
  fail "duplicate API key ring was accepted"
fi
if (validate_api_key_ring \
  "${fixture_api_key},${previous_api_key},$(printf 'c%.0s' {1..64})") \
  >/dev/null 2>&1; then
  fail "API key ring with more than two keys was accepted"
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/liveprobe-gcp-test.XXXXXX")"
trap 'rm -rf -- "$tmp_dir"' EXIT
mock_gcloud="${tmp_dir}/gcloud"
mock_log="${tmp_dir}/gcloud.log"
mock_curl_log="${tmp_dir}/curl.log"
mock_secret_data_log="${tmp_dir}/secret-data.log"

cat >"$mock_gcloud" <<'MOCK'
#!/usr/bin/env bash
set -u
{
  printf 'CALL'
  for argument in "$@"; do
    printf ' <%s>' "$argument"
  done
  printf '\n'
} >>"${MOCK_GCLOUD_LOG:?}"

if [[ "${1:-} ${2:-} ${3:-}" == \
  "compute firewall-rules describe" ]]; then
  [[ "${MOCK_FIREWALL_EXISTS:-false}" == true ]] && exit 0
  exit 1
fi

if [[ "${1:-} ${2:-} ${3:-}" == "compute ssh lp-test" &&
  -n "${MOCK_DATABASE_CONFIG:-}" ]]; then
  printf '%s\n' "$MOCK_DATABASE_CONFIG"
  exit 0
fi

if [[ "${1:-} ${2:-} ${3:-}" == "compute instances describe" &&
  -n "${MOCK_PERSISTED_HTTPS_DOMAIN:-}" ]]; then
  for argument in "$@"; do
    if [[ "$argument" == "--format=json(metadata.items)" ]]; then
      printf '{"metadata":{"items":[{"key":"unrelated","value":"ignored"},'
      printf '{"key":"liveprobe-https-domain","value":"%s"}]}}\n' \
        "$MOCK_PERSISTED_HTTPS_DOMAIN"
      exit 0
    fi
  done
fi

if [[ "${MOCK_RECOVERY_DRILL:-false}" == true ]]; then
  case "${1:-} ${2:-} ${3:-}" in
    "sql instances describe")
      if [[ "${4:-}" == "lp-test-postgres" ]]; then
        for argument in "$@"; do
          if [[ "$argument" == "--format=value(state)" ]]; then
            printf 'RUNNABLE\n'
            exit 0
          fi
        done
        exit 0
      fi
      if [[ "${4:-}" == "lp-test-postgres-recovery-test" ]] &&
        grep -F '<sql> <instances> <clone>' "${MOCK_GCLOUD_LOG:?}" >/dev/null; then
        for argument in "$@"; do
          if [[ "$argument" == "--format=value(connectionName)" ]]; then
            printf 'lightprobe-test:us-central1:lp-test-postgres-recovery-test\n'
          fi
        done
        exit 0
      fi
      exit 1
      ;;
    "sql backups list")
      printf '1784689200000,SUCCESSFUL,AUTOMATED,2026-07-22T04:27:46.719Z\n'
      exit 0
      ;;
    "sql instances clone"|"sql instances patch"|"sql instances delete")
      exit 0
      ;;
    "compute ssh lp-test")
      printf '%s\n' \
        '{"schemaVersion":6,"tenantCount":1,"projectCount":1,"environmentCount":1,"serviceCount":19,"auditEventCount":42,"immutableTriggerCount":1,"hasDefaultTenant":true,"hasDefaultProject":true,"hasDefaultEnvironment":true}'
      exit 0
      ;;
  esac
fi

if [[ "${MOCK_PROVISION_MONITORING:-false}" == true ]]; then
  case "${1:-} ${2:-} ${3:-}" in
    "auth print-access-token")
      printf 'fixture-monitoring-access-token\n'
      exit 0
      ;;
    "compute instances describe")
      for argument in "$@"; do
        if [[ "$argument" == "--format=value(id)" ]]; then
          printf '1234567890123456789\n'
          exit 0
        fi
      done
      ;;
    "compute ssh lp-test")
      for argument in "$@"; do
        if [[ "$argument" == *"show max_connections"* ]]; then
          printf '400\n'
          exit 0
        fi
      done
      exit 0
      ;;
    "monitoring uptime list-configs")
      if [[ "${MOCK_MONITORING_EXISTS:-false}" == true ]]; then
        printf 'projects/lightprobe-test/uptimeCheckConfigs/liveprobe-ready\n'
      fi
      exit 0
      ;;
    "monitoring uptime create")
      printf 'projects/lightprobe-test/uptimeCheckConfigs/liveprobe-ready\n'
      exit 0
      ;;
    "monitoring policies list")
      if [[ "${MOCK_MONITORING_EXISTS:-false}" == true ]]; then
        printf 'projects/lightprobe-test/alertPolicies/liveprobe-policy\n'
      fi
      exit 0
      ;;
    "logging metrics describe")
      [[ "${MOCK_MONITORING_EXISTS:-false}" == true ]] && exit 0
      exit 1
      ;;
  esac
fi

if [[ "${MOCK_PROVISION_HTTPS:-false}" == true ||
  "${MOCK_ACTIVATE_HTTPS:-false}" == true ]]; then
  case "${1:-} ${2:-} ${3:-}" in
    "compute instances describe") exit 0 ;;
    "compute addresses describe")
      for argument in "$@"; do
        if [[ "$argument" == "--format=value(address)" ]]; then
          printf '198.51.100.40\n'
          exit 0
        fi
      done
      [[ "${MOCK_ACTIVATE_HTTPS:-false}" == true ]] && exit 0
      exit 1
      ;;
    "compute instance-groups unmanaged")
      [[ "${4:-}" == "list-instances" ]] && exit 0
      [[ "${4:-}" == "describe" ]] && exit 1
      ;;
    "compute health-checks describe"|"compute url-maps describe"|\
    "compute ssl-policies describe"|"compute target-https-proxies describe"|\
    "compute target-http-proxies describe")
      exit 1
      ;;
    "compute backend-services describe")
      for argument in "$@"; do
        [[ "$argument" == "--format=value(backends.group)" ]] && exit 0
      done
      exit 1
      ;;
    "compute ssl-certificates describe")
      for argument in "$@"; do
        if [[ "$argument" == "--format=value(managed.status)" ]]; then
          printf '%s\n' "${MOCK_CERTIFICATE_STATUS:-PROVISIONING}"
          exit 0
        fi
      done
      [[ "${MOCK_ACTIVATE_HTTPS:-false}" == true ]] && exit 0
      exit 1
      ;;
    "compute forwarding-rules describe")
      [[ "${MOCK_ACTIVATE_HTTPS:-false}" == true ]] && exit 0
      exit 1
      ;;
  esac
fi

if [[ "${MOCK_PROVISION_SECRETS:-false}" == true ||
  "${MOCK_ROTATE_SECRET:-false}" == true ]]; then
  case "${1:-} ${2:-} ${3:-}" in
    "iam service-accounts describe")
      [[ "${MOCK_SECRETS_EXIST:-false}" == true ]] && exit 0
      exit 1
      ;;
    "secrets describe liveprobe-test-broker-api-keys"|\
    "secrets describe liveprobe-test-postgres-password"|\
    "secrets describe liveprobe-test-clerk-secret-key")
      [[ "${MOCK_SECRETS_EXIST:-false}" == true ]] && exit 0
      exit 1
      ;;
    "secrets versions list")
      if [[ "${MOCK_SECRETS_EXIST:-false}" == true ]]; then
        printf '1\n'
      fi
      exit 0
      ;;
    "secrets versions access")
      printf '%s\n' "${MOCK_SECRET_RING:?}"
      exit 0
      ;;
    "secrets versions add")
      payload="$(cat)"
      printf '%s <%s>\n' "${4:-}" "$payload" \
        >>"${MOCK_SECRET_DATA_LOG:?}"
      exit 0
      ;;
  esac
fi

if [[ "${MOCK_PROVISION_CLOUD_SQL:-false}" == true ]]; then
  case "${1:-} ${2:-} ${3:-}" in
    "iam service-accounts describe") exit 1 ;;
    "sql databases describe") exit 1 ;;
    "sql users list")
      if [[ "${MOCK_SQL_INSTANCE_EXISTS:-false}" == true ]]; then
        printf 'liveprobe\n'
      fi
      exit 0
      ;;
    "sql instances describe")
      for argument in "$@"; do
        case "$argument" in
          --format=value\(connectionName\))
            printf '%s\n' "${MOCK_CONNECTION_NAME:?}"
            exit 0
            ;;
          --format=value\(databaseVersion\))
            printf 'POSTGRES_16\n'
            exit 0
            ;;
          --format=value\(region\))
            printf 'us-central1\n'
            exit 0
            ;;
        esac
      done
      [[ "${MOCK_SQL_INSTANCE_EXISTS:-false}" == true ]] && exit 0
      exit 1
      ;;
  esac
fi
MOCK
chmod +x "$mock_gcloud"

cat >"${tmp_dir}/dig" <<'MOCK'
#!/usr/bin/env bash
set -u
printf '%s\n' "${MOCK_DNS_IP:?}"
MOCK
cat >"${tmp_dir}/curl" <<'MOCK'
#!/usr/bin/env bash
set -u
printf 'CALL' >>"${MOCK_CURL_LOG:?}"
for argument in "$@"; do
  printf ' <%s>' "$argument" >>"${MOCK_CURL_LOG:?}"
done
printf '\n' >>"${MOCK_CURL_LOG:?}"
if [[ "${MOCK_PROVISION_MONITORING:-false}" == true ]]; then
  for argument in "$@"; do
    if [[ "$argument" == *'/notificationChannels'* ]]; then
      if [[ " $* " == *' -X POST '* ]]; then
        if [[ " $* " == *'secondary@example.com'* ]]; then
          printf '{"name":"projects/lightprobe-test/notificationChannels/liveprobe-email-secondary"}\n'
        else
          printf '{"name":"projects/lightprobe-test/notificationChannels/liveprobe-email-ops"}\n'
        fi
      elif [[ "${MOCK_MONITORING_EXISTS:-false}" == true ]]; then
        printf '{"notificationChannels":['
        printf '{"name":"projects/lightprobe-test/notificationChannels/liveprobe-email-ops","type":"email","labels":{"email_address":"ops@example.com"}},'
        printf '{"name":"projects/lightprobe-test/notificationChannels/liveprobe-email-secondary","type":"email","labels":{"email_address":"secondary@example.com"}}]}\n'
      else
        printf '{"notificationChannels":[]}\n'
      fi
      exit 0
    fi
  done
fi
printf '{"ok":true}\n'
MOCK
chmod +x "${tmp_dir}/dig" "${tmp_dir}/curl"

: >"$mock_log"
: >"$mock_secret_data_log"
PROJECT_ID=lightprobe-test \
REGION=us-central1 \
ZONE=us-central1-a \
VM_NAME=liveprobe-test \
SECRETS_BACKEND=secret-manager \
LIVEPROBE_API_KEY="$fixture_api_key" \
POSTGRES_PASSWORD="$cloud_sql_password" \
CLERK_SECRET_KEY=sk_test_fixture_1234567890 \
CLERK_AUTHORIZED_PARTIES=https://app.example.com \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
MOCK_SECRET_DATA_LOG="$mock_secret_data_log" \
MOCK_PROVISION_SECRETS=true \
  "${SCRIPT_DIR}/provision-secrets.sh" >/dev/null
for expected_call in \
  '<services> <enable> <iam.googleapis.com> <secretmanager.googleapis.com>' \
  '<iam> <service-accounts> <create> <liveprobe-runtime>' \
  '<secrets> <create> <liveprobe-test-broker-api-keys>' \
  '<secrets> <create> <liveprobe-test-postgres-password>' \
  '<secrets> <create> <liveprobe-test-clerk-secret-key>' \
  '<secrets> <add-iam-policy-binding> <liveprobe-test-broker-api-keys>' \
  '<secrets> <add-iam-policy-binding> <liveprobe-test-postgres-password>' \
  '<secrets> <add-iam-policy-binding> <liveprobe-test-clerk-secret-key>' \
  '<--role=roles/secretmanager.secretAccessor>'; do
  grep -F "$expected_call" "$mock_log" >/dev/null ||
    fail "Secret Manager provisioner omitted command: ${expected_call}"
done
grep -F "liveprobe-test-broker-api-keys <${fixture_api_key}>" \
  "$mock_secret_data_log" >/dev/null ||
  fail "broker API key secret was not initialized through stdin"
grep -F "liveprobe-test-postgres-password <${cloud_sql_password}>" \
  "$mock_secret_data_log" >/dev/null ||
  fail "Postgres password secret was not initialized through stdin"
grep -F 'liveprobe-test-clerk-secret-key <sk_test_fixture_1234567890>' \
  "$mock_secret_data_log" >/dev/null ||
  fail "Clerk secret key was not initialized through stdin"
if grep -F "$fixture_api_key" "$mock_log" >/dev/null ||
  grep -F "$cloud_sql_password" "$mock_log" >/dev/null ||
  grep -F 'sk_test_fixture_1234567890' "$mock_log" >/dev/null; then
  fail "secret payload leaked into gcloud arguments"
fi

: >"$mock_log"
: >"$mock_secret_data_log"
PROJECT_ID=lightprobe-test \
VM_NAME=liveprobe-test \
SECRETS_BACKEND=secret-manager \
CLERK_AUTHORIZED_PARTIES=https://app.example.com \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
MOCK_SECRET_DATA_LOG="$mock_secret_data_log" \
MOCK_PROVISION_SECRETS=true \
MOCK_SECRETS_EXIST=true \
  "${SCRIPT_DIR}/provision-secrets.sh" >/dev/null
if grep -F '<secrets> <create>' "$mock_log" >/dev/null ||
  grep -F '<secrets> <versions> <add>' "$mock_log" >/dev/null; then
  fail "existing secrets were recreated or overwritten"
fi

: >"$mock_log"
: >"$mock_secret_data_log"
new_api_key="$(printf 'c%.0s' {1..64})"
rotation_output="$(
  PROJECT_ID=lightprobe-test \
  VM_NAME=liveprobe-test \
  SECRETS_BACKEND=secret-manager \
  LIVEPROBE_NEW_API_KEY="$new_api_key" \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  MOCK_SECRET_DATA_LOG="$mock_secret_data_log" \
  MOCK_ROTATE_SECRET=true \
  MOCK_SECRET_RING="$fixture_api_key" \
    "${SCRIPT_DIR}/rotate-api-key.sh" begin
)"
grep -F "New API key: ${new_api_key}" <<<"$rotation_output" >/dev/null ||
  fail "API key rotation did not return its new primary key"
grep -F "liveprobe-test-broker-api-keys <${new_api_key},${fixture_api_key}>" \
  "$mock_secret_data_log" >/dev/null ||
  fail "API key rotation did not create an overlap version"

: >"$mock_secret_data_log"
PROJECT_ID=lightprobe-test \
VM_NAME=liveprobe-test \
SECRETS_BACKEND=secret-manager \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
MOCK_SECRET_DATA_LOG="$mock_secret_data_log" \
MOCK_ROTATE_SECRET=true \
MOCK_SECRET_RING="${new_api_key},${fixture_api_key}" \
  "${SCRIPT_DIR}/rotate-api-key.sh" finish >/dev/null
grep -F "liveprobe-test-broker-api-keys <${new_api_key}>" \
  "$mock_secret_data_log" >/dev/null ||
  fail "API key rotation did not retire the previous key"

: >"$mock_log"
provisioned_connection_name="$(
  PROJECT_ID=lightprobe-test \
  REGION=us-central1 \
  ZONE=us-central1-a \
  VM_NAME=lp-test \
  DATABASE_BACKEND=cloud-sql \
  CLOUD_SQL_INSTANCE=lp-test-postgres \
  POSTGRES_PASSWORD="$cloud_sql_password" \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  MOCK_PROVISION_CLOUD_SQL=true \
  MOCK_CONNECTION_NAME="$cloud_sql_connection_name" \
    "${SCRIPT_DIR}/provision-cloud-sql.sh"
)"
[[ "$provisioned_connection_name" == "$cloud_sql_connection_name" ]] ||
  fail "Cloud SQL provisioner did not return the connection name"
for expected_call in \
  '<services> <enable> <iam.googleapis.com> <sqladmin.googleapis.com>' \
  '<iam> <service-accounts> <create> <liveprobe-runtime>' \
  '<projects> <add-iam-policy-binding> <lightprobe-test>' \
  '<--role=roles/cloudsql.client>' \
  '<sql> <instances> <create> <lp-test-postgres>' \
  '<--database-version=POSTGRES_16>' \
  '<--availability-type=regional>' \
  '<--connector-enforcement=REQUIRED>' \
  '<--enable-point-in-time-recovery>' \
  '<--deletion-protection>' \
  '<sql> <databases> <create> <liveprobe>' \
  '<sql> <users> <create> <liveprobe>'; do
  grep -F "$expected_call" "$mock_log" >/dev/null ||
    fail "Cloud SQL provisioner omitted command: ${expected_call}"
done

: >"$mock_log"
existing_connection_name="$(
  PROJECT_ID=lightprobe-test \
  REGION=us-central1 \
  ZONE=us-central1-a \
  VM_NAME=lp-test \
  DATABASE_BACKEND=cloud-sql \
  CLOUD_SQL_INSTANCE=lp-test-postgres \
  POSTGRES_PASSWORD="$cloud_sql_password" \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  MOCK_PROVISION_CLOUD_SQL=true \
  MOCK_SQL_INSTANCE_EXISTS=true \
  MOCK_CONNECTION_NAME="$cloud_sql_connection_name" \
    "${SCRIPT_DIR}/provision-cloud-sql.sh" 2>/dev/null
)"
[[ "$existing_connection_name" == "$cloud_sql_connection_name" ]] ||
  fail "existing Cloud SQL provisioner did not return the connection name"
grep -F '<sql> <instances> <patch> <lp-test-postgres>' \
  "$mock_log" >/dev/null ||
  fail "existing Cloud SQL instance security settings were not converged"
grep -F '<sql> <users> <set-password> <liveprobe>' \
  "$mock_log" >/dev/null ||
  fail "existing Cloud SQL user password was not updated"
if grep -F '<sql> <instances> <create> <lp-test-postgres>' \
  "$mock_log" >/dev/null; then
  fail "existing Cloud SQL instance was recreated"
fi

: >"$mock_log"
: >"$mock_curl_log"
monitoring_output="$(
  PATH="${tmp_dir}:$PATH" \
  PROJECT_ID=lightprobe-test \
  REGION=us-central1 \
  ZONE=us-central1-a \
  VM_NAME=lp-test \
  DATABASE_BACKEND=cloud-sql \
  CLOUD_SQL_INSTANCE=lp-test-postgres \
  HTTPS_DOMAIN=probe.example.com \
  ALERT_EMAILS='ops@example.com, secondary@example.com' \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  MOCK_CURL_LOG="$mock_curl_log" \
  MOCK_PROVISION_MONITORING=true \
    "${SCRIPT_DIR}/provision-monitoring.sh"
)"
grep -F 'Ops Agent: active on lp-test' <<<"$monitoring_output" >/dev/null ||
  fail "monitoring provisioner did not verify the Ops Agent"
grep -F 'Uptime check: https://probe.example.com/readyz' \
  <<<"$monitoring_output" >/dev/null ||
  fail "monitoring provisioner did not report the readiness check"
for expected_call in \
  '<services> <enable> <logging.googleapis.com> <monitoring.googleapis.com>' \
  '<--role=roles/logging.logWriter>' \
  '<--role=roles/monitoring.metricWriter>' \
  '<monitoring> <uptime> <create> <LiveProbe broker readiness>' \
  '<--path=/readyz>' \
  '<--period=1>' \
  '<--regions=usa-oregon,europe,asia-pacific>' \
  '<--validate-ssl=true>' \
  '<logging> <metrics> <create> <liveprobe_lb_5xx>' \
  '<monitoring> <policies> <create>'; do
  grep -F "$expected_call" "$mock_log" >/dev/null ||
    fail "monitoring provisioner omitted command: ${expected_call}"
done
[[ "$(grep -F -c '<monitoring> <policies> <create>' "$mock_log")" -eq 6 ]] ||
  fail "monitoring provisioner did not create all six alert policies"
# The metric variable is intentionally matched as source text.
# shellcheck disable=SC2016
grep -F 'resource.type = \"l7_lb_rule\" AND metric.type = \"logging.googleapis.com/user/${LB_ERROR_METRIC}\"' \
  "${SCRIPT_DIR}/provision-monitoring.sh" >/dev/null ||
  fail "HTTPS 5xx policy does not use the logs-based metric resource type"
grep -F 'notificationChannels' "$mock_curl_log" >/dev/null ||
  fail "monitoring provisioner did not create an email notification channel"
[[ "$(grep -F -c '<-X> <POST>' "$mock_curl_log")" -eq 2 ]] ||
  fail "monitoring provisioner did not create both email notification channels"

: >"$mock_log"
: >"$mock_curl_log"
PATH="${tmp_dir}:$PATH" \
PROJECT_ID=lightprobe-test \
REGION=us-central1 \
ZONE=us-central1-a \
VM_NAME=lp-test \
DATABASE_BACKEND=cloud-sql \
CLOUD_SQL_INSTANCE=lp-test-postgres \
HTTPS_DOMAIN=probe.example.com \
ALERT_EMAILS='ops@example.com, secondary@example.com' \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
MOCK_CURL_LOG="$mock_curl_log" \
MOCK_PROVISION_MONITORING=true \
MOCK_MONITORING_EXISTS=true \
  "${SCRIPT_DIR}/provision-monitoring.sh" >/dev/null
grep -F '<monitoring> <uptime> <update>' "$mock_log" >/dev/null ||
  fail "monitoring rerun did not update the existing uptime check"
[[ "$(grep -F -c '<monitoring> <policies> <update>' "$mock_log")" -eq 6 ]] ||
  fail "monitoring rerun did not update all existing alert policies"
grep -F '<logging> <metrics> <update> <liveprobe_lb_5xx>' \
  "$mock_log" >/dev/null ||
  fail "monitoring rerun did not update the existing log metric"
if grep -F '<monitoring> <uptime> <create>' "$mock_log" >/dev/null ||
  grep -F '<monitoring> <policies> <create>' "$mock_log" >/dev/null ||
  grep -F '<-X> <POST>' "$mock_curl_log" >/dev/null; then
  fail "monitoring rerun duplicated an existing managed resource"
fi

: >"$mock_log"
if PATH="${tmp_dir}:$PATH" \
  PROJECT_ID=lightprobe-test \
  DATABASE_BACKEND=cloud-sql \
  HTTPS_DOMAIN=probe.example.com \
  ALERT_EMAIL=not-an-email \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  MOCK_PROVISION_MONITORING=true \
  "${SCRIPT_DIR}/provision-monitoring.sh" >/dev/null 2>&1; then
  fail "monitoring provisioner accepted an invalid alert email"
fi
if grep -F '<services> <enable>' "$mock_log" >/dev/null; then
  fail "invalid monitoring configuration mutated GCP resources"
fi

: >"$mock_log"
if PATH="${tmp_dir}:$PATH" \
  PROJECT_ID=lightprobe-test \
  DATABASE_BACKEND=cloud-sql \
  HTTPS_DOMAIN=probe.example.com \
  ALERT_EMAILS='ops@example.com,ops@example.com' \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  MOCK_PROVISION_MONITORING=true \
  "${SCRIPT_DIR}/provision-monitoring.sh" >/dev/null 2>&1; then
  fail "monitoring provisioner accepted duplicate alert emails"
fi
if grep -F '<services> <enable>' "$mock_log" >/dev/null; then
  fail "duplicate monitoring recipients mutated GCP resources"
fi

: >"$mock_log"
https_output="$(
  PROJECT_ID=lightprobe-test \
  REGION=us-central1 \
  ZONE=us-central1-a \
  VM_NAME=lp-test \
  HTTPS_DOMAIN=probe.example.com \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  MOCK_PROVISION_HTTPS=true \
    "${SCRIPT_DIR}/provision-https.sh"
)"
grep -F 'HTTPS load balancer IP: 198.51.100.40' <<<"$https_output" >/dev/null ||
  fail "HTTPS provisioner did not print the reserved address"
grep -F 'Required DNS record: probe.example.com A 198.51.100.40' \
  <<<"$https_output" >/dev/null ||
  fail "HTTPS provisioner did not print the required DNS record"
for expected_call in \
  '<compute> <addresses> <create> <lp-test-https-ip>' \
  '<compute> <instance-groups> <unmanaged> <create> <lp-test-https-backend>' \
  '<--named-ports=http:80>' \
  '<compute> <health-checks> <create> <http> <lp-test-https-health>' \
  '<--request-path=/healthz>' \
  '<compute> <backend-services> <create> <lp-test-https-service>' \
  '<--load-balancing-scheme=EXTERNAL_MANAGED>' \
  '<compute> <backend-services> <add-backend> <lp-test-https-service>' \
  '<--source-ranges=35.191.0.0/16,130.211.0.0/22>' \
  '<compute> <ssl-certificates> <create> <lp-test-certificate>' \
  '<--domains=probe.example.com>' \
  '<--profile=MODERN>' \
  '<--min-tls-version=1.2>' \
  '<compute> <target-https-proxies> <create> <lp-test-https-proxy>' \
  '<compute> <forwarding-rules> <create> <lp-test-https-forwarding>' \
  '<--ports=443>' \
  '<compute> <url-maps> <import> <lp-test-http-redirect-map>' \
  '<compute> <forwarding-rules> <create> <lp-test-http-redirect-forwarding>' \
  '<--ports=80>'; do
  grep -F "$expected_call" "$mock_log" >/dev/null ||
    fail "HTTPS provisioner omitted command: ${expected_call}"
done

: >"$mock_log"
: >"$mock_curl_log"
activation_output="$(
  PATH="${tmp_dir}:$PATH" \
  PROJECT_ID=lightprobe-test \
  REGION=us-central1 \
  ZONE=us-central1-a \
  VM_NAME=lp-test \
  FIREWALL_RULE=lp-test-broker \
  FIREWALL_SSH_RULE=lp-test-ssh \
  HTTPS_FIREWALL_RULE=lp-test-lb-backend \
  HTTPS_DOMAIN=probe.example.com \
  LIVEPROBE_API_KEY=fixture-api-key \
  CLIENT_IP=203.0.113.9 \
  CLIENT_CIDR='' \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  MOCK_CURL_LOG="$mock_curl_log" \
  MOCK_DNS_IP=198.51.100.40 \
  MOCK_ACTIVATE_HTTPS=true \
  MOCK_CERTIFICATE_STATUS=ACTIVE \
  MOCK_FIREWALL_EXISTS=true \
    "${SCRIPT_DIR}/activate-https.sh"
)"
grep -F 'HTTPS is active: https://probe.example.com' \
  <<<"$activation_output" >/dev/null ||
  fail "HTTPS activation did not report the public broker URL"
[[ "$(grep -F -c '<https://probe.example.com/readyz>' "$mock_curl_log")" -eq 2 ]] ||
  fail "HTTPS activation did not verify readiness before and after firewall cutover"
[[ "$(grep -F -c '<https://probe.example.com/v1/ping>' "$mock_curl_log")" -eq 2 ]] ||
  fail "HTTPS activation did not verify authenticated access around cutover"
grep -F '<compute> <firewall-rules> <delete> <lp-test-broker>' \
  "$mock_log" >/dev/null ||
  fail "HTTPS activation did not close direct broker ingress"
grep -F '<compute> <instances> <add-metadata> <lp-test>' \
  "$mock_log" >/dev/null ||
  fail "HTTPS activation did not persist its hostname on the VM"

: >"$mock_log"
if PATH="${tmp_dir}:$PATH" \
  PROJECT_ID=lightprobe-test \
  VM_NAME=lp-test \
  HTTPS_DOMAIN=probe.example.com \
  LIVEPROBE_API_KEY=fixture-api-key \
  CLIENT_IP=203.0.113.9 \
  CLIENT_CIDR='' \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  MOCK_CURL_LOG="$mock_curl_log" \
  MOCK_DNS_IP=198.51.100.41 \
  MOCK_ACTIVATE_HTTPS=true \
  MOCK_CERTIFICATE_STATUS=ACTIVE \
    "${SCRIPT_DIR}/activate-https.sh" >/dev/null 2>&1; then
  fail "HTTPS activation accepted DNS pointing away from the load balancer"
fi
if grep -F '<compute> <firewall-rules>' "$mock_log" >/dev/null; then
  fail "failed HTTPS activation changed firewall rules"
fi

: >"$mock_log"
PROJECT_ID=lightprobe-test \
REGION=us-central1 \
ZONE=us-central1-a \
VM_NAME=lp-test \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
MOCK_DATABASE_CONFIG=$'DATABASE_BACKEND=cloud-sql\nCLOUD_SQL_INSTANCE_CONNECTION_NAME=lightprobe-test:us-central1:lp-test-postgres' \
  "${SCRIPT_DIR}/backup.sh" >/dev/null
grep -F '<sql> <backups> <create> <--instance=lp-test-postgres>' \
  "$mock_log" >/dev/null ||
  fail "Cloud SQL backup did not create a managed on-demand backup"

: >"$mock_log"
recovery_output="$(
  PROJECT_ID=lightprobe-test \
  REGION=us-central1 \
  ZONE=us-central1-a \
  VM_NAME=lp-test \
  DATABASE_BACKEND=cloud-sql \
  CLOUD_SQL_INSTANCE=lp-test-postgres \
  RECOVERY_INSTANCE=lp-test-postgres-recovery-test \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  MOCK_RECOVERY_DRILL=true \
    "${SCRIPT_DIR}/recovery-drill.sh"
)"
grep -F 'Recovery drill passed' <<<"$recovery_output" >/dev/null ||
  fail "recovery drill did not report success"
grep -F 'Temporary instance deleted: lp-test-postgres-recovery-test' \
  <<<"$recovery_output" >/dev/null ||
  fail "recovery drill did not report temporary instance cleanup"
for expected_call in \
  '<sql> <backups> <list> <--instance=lp-test-postgres>' \
  '<sql> <instances> <clone> <lp-test-postgres> <lp-test-postgres-recovery-test>' \
  '<--point-in-time=' \
  'docker compose --env-file /etc/liveprobe/deployment.env' \
  '<sql> <instances> <patch> <lp-test-postgres-recovery-test>' \
  '<--no-deletion-protection>' \
  '<sql> <instances> <delete> <lp-test-postgres-recovery-test>'; do
  grep -F "$expected_call" "$mock_log" >/dev/null ||
    fail "recovery drill omitted command: ${expected_call}"
done
if grep -F '<sql> <instances> <delete> <lp-test-postgres>' \
  "$mock_log" >/dev/null; then
  fail "recovery drill attempted to delete the production instance"
fi

: >"$mock_log"
if PROJECT_ID=lightprobe-test \
  REGION=us-central1 \
  ZONE=us-central1-a \
  VM_NAME=lp-test \
  DATABASE_BACKEND=cloud-sql \
  CLOUD_SQL_INSTANCE=lp-test-postgres \
  RECOVERY_INSTANCE=lp-test-postgres \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  MOCK_RECOVERY_DRILL=true \
    "${SCRIPT_DIR}/recovery-drill.sh" >/dev/null 2>&1; then
  fail "recovery drill accepted the production instance as its target"
fi
[[ ! -s "$mock_log" ]] ||
  fail "unsafe recovery target mutated GCP resources"

PROJECT_ID=lightprobe-test \
REGION=us-central1 \
ZONE=us-central1-a \
VM_NAME=lp-test \
STATIC_IP_NAME=lp-test-ip \
FIREWALL_RULE=lp-test-broker \
FIREWALL_SSH_RULE=lp-test-ssh \
NETWORK=default \
NETWORK_TAG=liveprobe-demo \
BROKER_PORT='' \
CLIENT_IP=203.0.113.9 \
CLIENT_CIDR='' \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
  "${SCRIPT_DIR}/refresh-firewall.sh" >/dev/null

grep -F '<compute> <firewall-rules> <create> <lp-test-broker>' \
  "$mock_log" >/dev/null ||
  fail "firewall create command was not constructed"
grep -F '<--source-ranges=203.0.113.9/32>' "$mock_log" >/dev/null ||
  fail "firewall source is not the current client /32"
[[ "$(grep -F -c '<--source-ranges=203.0.113.9/32>' "$mock_log")" -eq 2 ]] ||
  fail "broker and SSH firewall rules do not share the client /32"
grep -F '<--rules=tcp:80>' "$mock_log" >/dev/null ||
  fail "firewall does not use the default GCP broker port 80"
grep -F '<--target-tags=liveprobe-demo>' "$mock_log" >/dev/null ||
  fail "firewall does not target the demo VM tag"
grep -F '<compute> <firewall-rules> <create> <lp-test-ssh>' \
  "$mock_log" >/dev/null ||
  fail "SSH firewall create command was not constructed"
grep -F '<--rules=tcp:22>' "$mock_log" >/dev/null ||
  fail "SSH firewall does not restrict access to tcp:22"

: >"$mock_log"
PROJECT_ID=lightprobe-test \
REGION=us-central1 \
ZONE=us-central1-a \
VM_NAME=lp-test \
STATIC_IP_NAME=lp-test-ip \
FIREWALL_RULE=lp-test-broker \
FIREWALL_SSH_RULE=lp-test-ssh \
NETWORK=default \
NETWORK_TAG=liveprobe-demo \
BROKER_PORT='' \
CLIENT_IP='' \
CLIENT_CIDR=68.65.169.130/28 \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
  "${SCRIPT_DIR}/refresh-firewall.sh" >/dev/null

[[ "$(grep -F -c '<--source-ranges=68.65.169.128/28>' "$mock_log")" -eq 2 ]] ||
  fail "explicit /28 was not normalized for both firewall rules"

: >"$mock_log"
PROJECT_ID=lightprobe-test \
REGION=us-central1 \
ZONE=us-central1-a \
VM_NAME=lp-test \
FIREWALL_RULE=lp-test-broker \
FIREWALL_SSH_RULE=lp-test-ssh \
HTTPS_FIREWALL_RULE=lp-test-lb-backend \
HTTPS_DOMAIN=probe.example.com \
NETWORK=default \
NETWORK_TAG=liveprobe-demo \
BROKER_PORT='' \
CLIENT_IP=203.0.113.9 \
CLIENT_CIDR='' \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
MOCK_FIREWALL_EXISTS=true \
  "${SCRIPT_DIR}/refresh-firewall.sh" >/dev/null

grep -F '<compute> <firewall-rules> <update> <lp-test-lb-backend>' \
  "$mock_log" >/dev/null ||
  fail "HTTPS firewall was not updated"
grep -F '<--source-ranges=35.191.0.0/16,130.211.0.0/22>' \
  "$mock_log" >/dev/null ||
  fail "HTTPS firewall does not restrict origin ingress to Google proxies"
grep -F '<compute> <firewall-rules> <delete> <lp-test-broker>' \
  "$mock_log" >/dev/null ||
  fail "HTTPS activation did not remove direct broker ingress"
grep -F '<--source-ranges=203.0.113.9/32>' "$mock_log" >/dev/null ||
  fail "HTTPS firewall refresh did not preserve restricted SSH access"

: >"$mock_log"
PROJECT_ID=lightprobe-test \
REGION=us-central1 \
ZONE=us-central1-a \
VM_NAME=lp-test \
FIREWALL_RULE=lp-test-broker \
FIREWALL_SSH_RULE=lp-test-ssh \
HTTPS_FIREWALL_RULE=lp-test-lb-backend \
HTTPS_DOMAIN='' \
NETWORK=default \
NETWORK_TAG=liveprobe-demo \
BROKER_PORT='' \
CLIENT_IP=203.0.113.9 \
CLIENT_CIDR='' \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
MOCK_FIREWALL_EXISTS=true \
MOCK_PERSISTED_HTTPS_DOMAIN=probe.example.com \
  "${SCRIPT_DIR}/refresh-firewall.sh" >/dev/null

grep -F '<compute> <firewall-rules> <update> <lp-test-lb-backend>' \
  "$mock_log" >/dev/null ||
  fail "firewall refresh did not recover the activated HTTPS configuration"

: >"$mock_log"
PROJECT_ID=lightprobe-test \
REGION=us-central1 \
ZONE=us-central1-a \
VM_NAME=lp-test \
STATIC_IP_NAME=lp-test-ip \
FIREWALL_RULE=lp-test-broker \
FIREWALL_SSH_RULE=lp-test-ssh \
NETWORK=default \
NETWORK_TAG=liveprobe-demo \
BROKER_PORT='' \
CLIENT_IP=203.0.113.10 \
CLIENT_CIDR='' \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
MOCK_FIREWALL_EXISTS=true \
  "${SCRIPT_DIR}/refresh-firewall.sh" >/dev/null

grep -F '<compute> <firewall-rules> <update> <lp-test-broker>' \
  "$mock_log" >/dev/null ||
  fail "existing firewall rule was not updated"
grep -F '<--source-ranges=203.0.113.10/32>' "$mock_log" >/dev/null ||
  fail "firewall update did not replace the client /32"
[[ "$(grep -F -c '<--source-ranges=203.0.113.10/32>' "$mock_log")" -eq 2 ]] ||
  fail "firewall updates do not share the refreshed client /32"
grep -F '<--allow=tcp:80>' "$mock_log" >/dev/null ||
  fail "firewall update did not preserve the port-80 broker rule"
grep -F '<compute> <firewall-rules> <update> <lp-test-ssh>' \
  "$mock_log" >/dev/null ||
  fail "existing SSH firewall rule was not updated"
grep -F '<--allow=tcp:22>' "$mock_log" >/dev/null ||
  fail "SSH firewall update did not preserve tcp:22 only"

: >"$mock_log"
PROJECT_ID=lightprobe-test \
REGION=us-central1 \
ZONE=us-central1-a \
VM_NAME=lp-test \
STATIC_IP_NAME=lp-test-ip \
FIREWALL_RULE=lp-test-broker \
FIREWALL_SSH_RULE=lp-test-ssh \
NETWORK=default \
NETWORK_TAG=liveprobe-demo \
BROKER_PORT='' \
GCLOUD_BIN="$mock_gcloud" \
MOCK_GCLOUD_LOG="$mock_log" \
MOCK_FIREWALL_EXISTS=true \
  "${SCRIPT_DIR}/destroy.sh" >/dev/null

grep -F '<compute> <firewall-rules> <delete> <lp-test-broker>' \
  "$mock_log" >/dev/null ||
  fail "destroy did not delete the managed broker firewall"
grep -F '<compute> <firewall-rules> <delete> <lp-test-ssh>' \
  "$mock_log" >/dev/null ||
  fail "destroy did not delete the managed SSH firewall"
grep -F '<compute> <target-https-proxies> <delete> <lp-test-https-proxy>' \
  "$mock_log" >/dev/null ||
  fail "destroy did not delete the managed HTTPS proxy"
grep -F '<compute> <addresses> <delete> <lp-test-https-ip>' \
  "$mock_log" >/dev/null ||
  fail "destroy did not delete the managed HTTPS address"
if grep -F 'default-allow-ssh' "$mock_log" >/dev/null; then
  fail "destroy attempted to modify an unrelated default firewall"
fi

: >"$mock_log"
if PROJECT_ID=lightprobe-test \
  FIREWALL_RULE=lp-test-broker \
  FIREWALL_SSH_RULE=default-allow-ssh \
  CLIENT_IP=203.0.113.9 \
CLIENT_CIDR='' \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  "${SCRIPT_DIR}/refresh-firewall.sh" >/dev/null 2>&1; then
  fail "firewall refresh accepted an unrelated default rule name"
fi
[[ ! -s "$mock_log" ]] ||
  fail "firewall refresh touched gcloud after rejecting a default rule"

if PROJECT_ID=lightprobe-test \
  CLIENT_IP=0.0.0.0 \
  CLIENT_CIDR='' \
  GCLOUD_BIN="$mock_gcloud" \
  MOCK_GCLOUD_LOG="$mock_log" \
  "${SCRIPT_DIR}/refresh-firewall.sh" >/dev/null 2>&1; then
  fail "firewall refresh accepted 0.0.0.0 as a client address"
fi

printf 'GCP deployment tests passed\n'
