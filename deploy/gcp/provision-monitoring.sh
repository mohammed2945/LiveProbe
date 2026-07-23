#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

require_command curl
require_command node
load_gcp_config
load_persisted_https_domain

alert_email_value="${ALERT_EMAILS:-${ALERT_EMAIL:-}}"
[[ -n "$alert_email_value" ]] ||
  die "set ALERT_EMAILS to comma-separated monitoring recipients"
IFS=',' read -r -a unvalidated_alert_emails <<<"$alert_email_value"
alert_emails=()
alert_email_count=0
for email in "${unvalidated_alert_emails[@]}"; do
  email="${email#"${email%%[![:space:]]*}"}"
  email="${email%"${email##*[![:space:]]}"}"
  validate_alert_email "$email"
  if ((alert_email_count > 0)); then
    for existing_email in "${alert_emails[@]}"; do
      [[ "$existing_email" != "$email" ]] ||
        die "ALERT_EMAILS contains a duplicate address: ${email}"
    done
  fi
  alert_emails+=("$email")
  alert_email_count=$((alert_email_count + 1))
done
((alert_email_count >= 1 && alert_email_count <= 5)) ||
  die "ALERT_EMAILS must contain between one and five addresses"
[[ -n "$HTTPS_DOMAIN" ]] || die "monitoring requires the deployed HTTPS domain"
[[ "$DATABASE_BACKEND" == "cloud-sql" ]] ||
  die "production monitoring requires DATABASE_BACKEND=cloud-sql"

UPTIME_DISPLAY_NAME="${UPTIME_DISPLAY_NAME:-LiveProbe broker readiness}"
CHANNEL_DISPLAY_NAME="${CHANNEL_DISPLAY_NAME:-LiveProbe operations email}"
LB_ERROR_METRIC="${LB_ERROR_METRIC:-liveprobe_lb_5xx}"
runtime_service_account="${RUNTIME_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud_cmd services enable \
  logging.googleapis.com \
  monitoring.googleapis.com \
  --project="$PROJECT_ID" \
  --quiet

for role in roles/logging.logWriter roles/monitoring.metricWriter; do
  gcloud_cmd projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${runtime_service_account}" \
    --role="$role" \
    --condition=None \
    --quiet >/dev/null
done

# Use Google's signed package repository installer, then require the service to
# be active before creating policies that depend on guest metrics.
# shellcheck disable=SC2016
ops_agent_command='set -Eeuo pipefail; if ! dpkg-query -W google-cloud-ops-agent >/dev/null 2>&1; then installer="$(mktemp)"; trap '\''rm -f -- "$installer"'\'' EXIT; curl -fsSL https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh -o "$installer"; sudo bash "$installer" --also-install; fi; sudo systemctl enable --now google-cloud-ops-agent; sudo systemctl is-active --quiet google-cloud-ops-agent'
gcloud_cmd compute ssh "$VM_NAME" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" \
  --command="$ops_agent_command" \
  --quiet

access_token="$(gcloud_cmd auth print-access-token)"
channels_url="https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/notificationChannels"
channels_json="$(
  curl --fail --silent --show-error \
    -H "Authorization: Bearer ${access_token}" \
    "${channels_url}?pageSize=100"
)"
channel_names=()
for email in "${alert_emails[@]}"; do
  channel_name="$(
    printf '%s' "$channels_json" | node -e '
      const fs = require("node:fs");
      const email = process.argv[1];
      const channels = JSON.parse(fs.readFileSync(0, "utf8")).notificationChannels ?? [];
      const matches = channels.filter((channel) =>
        channel.type === "email" && channel.labels?.email_address === email,
      );
      if (matches.length > 1) process.exit(2);
      if (matches[0]?.name) process.stdout.write(matches[0].name);
    ' "$email"
  )"
  if [[ -z "$channel_name" ]]; then
    channel_payload="$(
      # The JavaScript template literal is evaluated by Node, not the shell.
      # shellcheck disable=SC2016
      node -e '
        process.stdout.write(JSON.stringify({
          type: "email",
          displayName: `${process.argv[1]} - ${process.argv[2]}`,
          labels: { email_address: process.argv[2] },
          enabled: true,
          userLabels: { managed_by: "liveprobe" },
        }));
      ' "$CHANNEL_DISPLAY_NAME" "$email"
    )"
    channel_response="$(
      curl --fail --silent --show-error \
        -X POST \
        -H "Authorization: Bearer ${access_token}" \
        -H 'Content-Type: application/json' \
        --data "$channel_payload" \
        "$channels_url"
    )"
    channel_name="$(
      printf '%s' "$channel_response" | node -e '
        const fs = require("node:fs");
        const value = JSON.parse(fs.readFileSync(0, "utf8"));
        if (typeof value.name !== "string") process.exit(1);
        process.stdout.write(value.name);
      '
    )"
  fi
  channel_names+=("$channel_name")
done
channel_names_csv="$(IFS=','; printf '%s' "${channel_names[*]}")"
unset access_token channels_json channel_payload channel_response

uptime_name="$(
  gcloud_cmd monitoring uptime list-configs \
    --project="$PROJECT_ID" \
    --filter="displayName='${UPTIME_DISPLAY_NAME}'" \
    --format='value(name)'
)"
[[ "$(wc -l <<<"$uptime_name" | tr -d ' ')" == 1 ]] ||
  die "multiple uptime checks use display name: ${UPTIME_DISPLAY_NAME}"
if [[ -z "$uptime_name" ]]; then
  uptime_name="$(
    gcloud_cmd monitoring uptime create "$UPTIME_DISPLAY_NAME" \
      --project="$PROJECT_ID" \
      --resource-type=uptime-url \
      --resource-labels="host=${HTTPS_DOMAIN},project_id=${PROJECT_ID}" \
      --protocol=https \
      --port=443 \
      --path=/readyz \
      --request-method=get \
      --validate-ssl=true \
      --status-classes=2xx \
      --matcher-type=contains-string \
      --matcher-content='"ok":true' \
      --period=1 \
      --timeout=10 \
      --regions=usa-oregon,europe,asia-pacific \
      --user-labels=managed_by=liveprobe \
      --format='value(name)'
  )"
else
  gcloud_cmd monitoring uptime update "$uptime_name" \
    --project="$PROJECT_ID" \
    --display-name="$UPTIME_DISPLAY_NAME" \
    --port=443 \
    --path=/readyz \
    --request-method=get \
    --validate-ssl=true \
    --set-status-classes=2xx \
    --matcher-type=contains-string \
    --matcher-content='"ok":true' \
    --period=1 \
    --timeout=10 \
    --set-regions=usa-oregon,europe,asia-pacific \
    --update-user-labels=managed_by=liveprobe \
    --quiet >/dev/null
fi
[[ -n "$uptime_name" ]] || die "uptime check creation returned no resource name"
uptime_id="${uptime_name##*/}"

lb_error_filter="resource.type=\"http_load_balancer\" AND resource.labels.backend_service_name=\"${HTTPS_BACKEND_SERVICE}\" AND httpRequest.status>=500"
if gcloud_cmd logging metrics describe "$LB_ERROR_METRIC" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud_cmd logging metrics update "$LB_ERROR_METRIC" \
    --project="$PROJECT_ID" \
    --description="LiveProbe HTTPS load balancer 5xx responses" \
    --log-filter="$lb_error_filter" \
    --quiet >/dev/null
else
  gcloud_cmd logging metrics create "$LB_ERROR_METRIC" \
    --project="$PROJECT_ID" \
    --description="LiveProbe HTTPS load balancer 5xx responses" \
    --log-filter="$lb_error_filter" \
    --quiet >/dev/null
fi

instance_id="$(
  gcloud_cmd compute instances describe "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --format='value(id)'
)"
[[ "$instance_id" =~ ^[0-9]+$ ]] || die "could not resolve the broker VM ID"

# Read only the non-secret server limit so the connection alert follows the
# actual PostgreSQL configuration instead of assuming a machine-tier default.
# shellcheck disable=SC2016
max_connections_command='sudo docker exec liveprobe-demo-broker-1 node -e '\''const {Client}=require("pg");(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const result=await c.query("show max_connections");console.log(result.rows[0].max_connections);await c.end()})().catch(()=>process.exit(1))'\'''
max_connections="$(
  gcloud_cmd compute ssh "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --command="$max_connections_command" \
    --quiet
)"
[[ "$max_connections" =~ ^[1-9][0-9]*$ ]] ||
  die "could not read PostgreSQL max_connections"
connection_threshold=$((max_connections * 80 / 100))
((connection_threshold > 0)) || die "invalid PostgreSQL connection threshold"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/liveprobe-monitoring.XXXXXX")"
trap 'rm -rf -- "$tmp_dir"' EXIT

write_policy() {
  local file="$1"
  local display_name="$2"
  local condition_name="$3"
  local filter="$4"
  local comparison="$5"
  local threshold="$6"
  local duration="$7"
  local aligner="$8"
  local trigger_count="$9"
  local documentation="${10}"
  local enabled="${11:-true}"

  # The JavaScript template literal is evaluated by Node, not the shell.
  # shellcheck disable=SC2016
  node -e '
    const fs = require("node:fs");
    const [file, displayName, conditionName, filter, comparison, threshold,
      duration, aligner, triggerCount, documentation, enabled, channelsCsv] =
      process.argv.slice(1);
    const policy = {
      displayName,
      combiner: "OR",
      enabled: enabled === "true",
      notificationChannels: channelsCsv.split(","),
      documentation: { content: documentation, mimeType: "text/markdown" },
      userLabels: { managed_by: "liveprobe" },
      alertStrategy: {
        autoClose: "604800s",
        notificationPrompts: ["OPENED", "CLOSED"],
      },
      conditions: [{
        displayName: conditionName,
        conditionThreshold: {
          filter,
          comparison,
          thresholdValue: Number(threshold),
          duration,
          aggregations: [{ alignmentPeriod: "60s", perSeriesAligner: aligner }],
          trigger: { count: Number(triggerCount) },
        },
      }],
    };
    fs.writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  ' "$file" "$display_name" "$condition_name" "$filter" "$comparison" \
    "$threshold" "$duration" "$aligner" "$trigger_count" \
    "$documentation" "$enabled" "$channel_names_csv"
}

apply_policy() {
  local display_name="$1"
  local file="$2"
  local existing

  existing="$(
    gcloud_cmd monitoring policies list \
      --project="$PROJECT_ID" \
      --filter="displayName='${display_name}'" \
      --format='value(name)'
  )"
  [[ "$(wc -l <<<"$existing" | tr -d ' ')" == 1 ]] ||
    die "multiple alert policies use display name: ${display_name}"
  if [[ -z "$existing" ]]; then
    gcloud_cmd monitoring policies create \
      --project="$PROJECT_ID" \
      --policy-from-file="$file" \
      --quiet >/dev/null
  else
    gcloud_cmd monitoring policies update "$existing" \
      --project="$PROJECT_ID" \
      --policy-from-file="$file" \
      --quiet >/dev/null
  fi
}

uptime_policy="${tmp_dir}/uptime.json"
write_policy \
  "$uptime_policy" \
  "LiveProbe readiness unavailable" \
  "At least two readiness checkers are failing" \
  "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.labels.check_id = \"${uptime_id}\"" \
  COMPARISON_LT 0.99 120s ALIGN_FRACTION_TRUE 2 \
  "The public HTTPS /readyz endpoint is failing from at least two checker regions. Check the load balancer, broker container, and Cloud SQL proxy."

vm_cpu_policy="${tmp_dir}/vm-cpu.json"
write_policy \
  "$vm_cpu_policy" \
  "LiveProbe VM CPU high" \
  "Broker VM CPU is above 85%" \
  "resource.type = \"gce_instance\" AND metric.type = \"compute.googleapis.com/instance/cpu/utilization\" AND resource.labels.instance_id = \"${instance_id}\"" \
  COMPARISON_GT 0.85 600s ALIGN_MEAN 1 \
  "The broker VM has sustained CPU above 85% for ten minutes. Inspect container CPU and probe volume before resizing."

vm_disk_policy="${tmp_dir}/vm-disk.json"
write_policy \
  "$vm_disk_policy" \
  "LiveProbe VM disk high" \
  "Broker VM filesystem is above 85%" \
  "resource.type = \"gce_instance\" AND metric.type = \"agent.googleapis.com/disk/percent_used\" AND resource.labels.instance_id = \"${instance_id}\" AND metric.labels.state = \"used\"" \
  COMPARISON_GT 85 600s ALIGN_MEAN 1 \
  "A broker VM filesystem has sustained usage above 85%. Inspect Docker images, logs, and release directories."

sql_disk_policy="${tmp_dir}/sql-disk.json"
write_policy \
  "$sql_disk_policy" \
  "LiveProbe Cloud SQL storage high" \
  "Cloud SQL storage utilization is above 80%" \
  "resource.type = \"cloudsql_database\" AND metric.type = \"cloudsql.googleapis.com/database/disk/utilization\" AND resource.labels.database_id = \"${PROJECT_ID}:${CLOUD_SQL_INSTANCE}\"" \
  COMPARISON_GT 0.8 600s ALIGN_MEAN 1 \
  "Cloud SQL storage has remained above 80%. Review retained probe/audit data and storage growth before capacity is exhausted."

sql_connections_policy="${tmp_dir}/sql-connections.json"
write_policy \
  "$sql_connections_policy" \
  "LiveProbe Cloud SQL connections high" \
  "PostgreSQL backends exceed 80% of max_connections" \
  "resource.type = \"cloudsql_database\" AND metric.type = \"cloudsql.googleapis.com/database/postgresql/num_backends\" AND resource.labels.database_id = \"${PROJECT_ID}:${CLOUD_SQL_INSTANCE}\"" \
  COMPARISON_GT "$connection_threshold" 300s ALIGN_MAX 1 \
  "Cloud SQL PostgreSQL backends exceed 80% of max_connections (${max_connections}). Check broker pool sizing and leaked or unexpected clients."

lb_errors_policy="${tmp_dir}/lb-errors.json"
write_policy \
  "$lb_errors_policy" \
  "LiveProbe HTTPS 5xx responses" \
  "The load balancer observed a broker 5xx response" \
  "resource.type = \"l7_lb_rule\" AND metric.type = \"logging.googleapis.com/user/${LB_ERROR_METRIC}\"" \
  COMPARISON_GT 0 0s ALIGN_SUM 1 \
  "The public load balancer observed one or more broker 5xx responses. Inspect request logs, broker health, and Cloud SQL availability." \
  false

apply_policy "LiveProbe readiness unavailable" "$uptime_policy"
apply_policy "LiveProbe VM CPU high" "$vm_cpu_policy"
apply_policy "LiveProbe VM disk high" "$vm_disk_policy"
apply_policy "LiveProbe Cloud SQL storage high" "$sql_disk_policy"
apply_policy "LiveProbe Cloud SQL connections high" "$sql_connections_policy"
apply_policy "LiveProbe HTTPS 5xx responses" "$lb_errors_policy"

printf 'Ops Agent: active on %s\n' "$VM_NAME"
printf 'Uptime check: https://%s/readyz\n' "$HTTPS_DOMAIN"
printf 'Notification emails: %s\n' "$(IFS=', '; printf '%s' "${alert_emails[*]}")"
printf 'Alert policies: readiness, VM CPU/disk, Cloud SQL storage/connections (HTTPS 5xx disabled)\n'
