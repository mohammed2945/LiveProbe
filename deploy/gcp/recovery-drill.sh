#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

require_command node
load_gcp_config

[[ "$DATABASE_BACKEND" == "cloud-sql" ]] ||
  die "recovery-drill.sh requires DATABASE_BACKEND=cloud-sql"

RECOVERY_POINT_AGE_SECONDS="${RECOVERY_POINT_AGE_SECONDS:-300}"
validate_positive_integer \
  "RECOVERY_POINT_AGE_SECONDS" \
  "$RECOVERY_POINT_AGE_SECONDS"
((RECOVERY_POINT_AGE_SECONDS >= 300 &&
  RECOVERY_POINT_AGE_SECONDS <= 86400)) ||
  die "RECOVERY_POINT_AGE_SECONDS must be between 300 and 86400"

timestamp="$(date -u +%Y%m%d%H%M%S)"
recovery_suffix="-recovery-${timestamp}"
source_prefix_length=$((63 - ${#recovery_suffix}))
source_prefix="${CLOUD_SQL_INSTANCE:0:source_prefix_length}"
source_prefix="${source_prefix%-}"
default_recovery_instance="${source_prefix}${recovery_suffix}"
recovery_instance="${RECOVERY_INSTANCE:-$default_recovery_instance}"
validate_resource_name "recovery instance name" "$recovery_instance"
[[ "$recovery_instance" == "${CLOUD_SQL_INSTANCE}-recovery-"* ||
  "$recovery_instance" == "${source_prefix}-recovery-"* ]] ||
  die "RECOVERY_INSTANCE must use the source instance recovery namespace"
[[ "$recovery_instance" != "$CLOUD_SQL_INSTANCE" ]] ||
  die "recovery instance must differ from the source instance"

source_state="$(
  gcloud_cmd sql instances describe "$CLOUD_SQL_INSTANCE" \
    --project="$PROJECT_ID" \
    --format='value(state)'
)"
[[ "$source_state" == "RUNNABLE" ]] ||
  die "source Cloud SQL instance is not runnable: ${source_state:-unknown}"

if gcloud_cmd sql instances describe "$recovery_instance" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  die "recovery instance already exists: ${recovery_instance}"
fi

latest_backup="$(
  gcloud_cmd sql backups list \
    --instance="$CLOUD_SQL_INSTANCE" \
    --project="$PROJECT_ID" \
    --filter='status=SUCCESSFUL' \
    --limit=1 \
    --format='csv[no-heading](id,status,type,endTime)'
)"
IFS=',' read -r backup_id backup_status backup_type backup_end_time \
  <<<"$latest_backup"
[[ "$backup_id" =~ ^[0-9]+$ && "$backup_status" == "SUCCESSFUL" &&
  -n "$backup_type" && -n "$backup_end_time" ]] ||
  die "no successful managed backup was found"

read -r -d '' validation_js <<'NODE' || true
  const { Client } = require("pg");
  const requiredTables = [
    "audit_events", "environments", "liveprobe_schema_migrations",
    "probe_events", "probe_statuses", "probes", "projects",
    "service_credentials", "service_versions", "services",
    "source_map_sets", "source_maps", "tenants",
  ];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function connect() {
    const connection = new URL(process.env.DATABASE_URL);
    if (process.env.RECOVERY_HOST) {
      connection.hostname = process.env.RECOVERY_HOST;
      connection.port = "5432";
    }
    let lastError;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const client = new Client({ connectionString: connection.toString() });
      try {
        await client.connect();
        return client;
      } catch (error) {
        lastError = error;
        await client.end().catch(() => undefined);
        await sleep(2000);
      }
    }
    throw lastError;
  }
  (async () => {
    const client = await connect();
    try {
      const tablesResult = await client.query(
        `select table_name from information_schema.tables
         where table_schema = $1`,
        ["public"],
      );
      const tables = new Set(tablesResult.rows.map(({ table_name }) => table_name));
      const missingTables = requiredTables.filter((table) => !tables.has(table));
      if (missingTables.length > 0) {
        throw new Error(`missing tables: ${missingTables.join(",")}`);
      }
      const result = await client.query(`
        select
          (select max(version)::int from liveprobe_schema_migrations)
            as "schemaVersion",
          (select count(*)::int from tenants) as "tenantCount",
          (select count(*)::int from projects) as "projectCount",
          (select count(*)::int from environments) as "environmentCount",
          (select count(*)::int from services) as "serviceCount",
          (select count(*)::int from audit_events) as "auditEventCount",
          (select count(*)::int from pg_trigger
            where tgname = 'audit_events_immutable'
              and tgrelid = 'audit_events'::regclass)
            as "immutableTriggerCount",
          exists(
            select 1 from tenants where tenant_id = 'internal'
          ) as "hasDefaultTenant",
          exists(
            select 1 from projects
            where tenant_id = 'internal' and project_id = 'default'
          ) as "hasDefaultProject",
          exists(
            select 1 from environments
            where tenant_id = 'internal'
              and project_id = 'default'
              and environment_id = 'default'
          ) as "hasDefaultEnvironment"
      `);
      process.stdout.write(`${JSON.stringify(result.rows[0])}\n`);
    } finally {
      await client.end();
    }
  })().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
NODE

# Resolve the deployed schema version through the broker container without
# reading or printing DATABASE_URL.
# shellcheck disable=SC2016
printf -v source_validation_command \
  'set -Eeuo pipefail; compose=(sudo docker compose --env-file /etc/liveprobe/deployment.env -f /opt/liveprobe/current/demo/docker-compose.yml -f /opt/liveprobe/current/deploy/gcp/docker-compose.gcp.yml -f /opt/liveprobe/current/deploy/gcp/docker-compose.cloud-sql.yml); broker_id="$("${compose[@]}" ps -q broker)"; test -n "$broker_id"; sudo docker exec "$broker_id" node -e %q' \
  "$validation_js"
source_snapshot="$(
  gcloud_cmd compute ssh "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --command="$source_validation_command" \
    --quiet
)"

point_in_time="$(
  node -e '
    const ageSeconds = Number(process.argv[1]);
    process.stdout.write(new Date(Date.now() - ageSeconds * 1000).toISOString());
  ' "$RECOVERY_POINT_AGE_SECONDS"
)"

cleanup_allowed=false
cleanup_recovery_instance() {
  [[ "$cleanup_allowed" == true ]] || return 0
  if ! gcloud_cmd sql instances describe "$recovery_instance" \
    --project="$PROJECT_ID" >/dev/null 2>&1; then
    cleanup_allowed=false
    return 0
  fi
  gcloud_cmd sql instances patch "$recovery_instance" \
    --project="$PROJECT_ID" \
    --no-deletion-protection \
    --quiet >/dev/null 2>&1 || true
  gcloud_cmd sql instances delete "$recovery_instance" \
    --project="$PROJECT_ID" \
    --quiet >/dev/null
  cleanup_allowed=false
}
trap cleanup_recovery_instance EXIT INT TERM

cleanup_allowed=true
gcloud_cmd sql instances clone \
  "$CLOUD_SQL_INSTANCE" \
  "$recovery_instance" \
  --project="$PROJECT_ID" \
  --point-in-time="$point_in_time" \
  --quiet >/dev/null

recovery_connection_name="$(
  gcloud_cmd sql instances describe "$recovery_instance" \
    --project="$PROJECT_ID" \
    --format='value(connectionName)'
)"
[[ "$recovery_connection_name" == "${PROJECT_ID}:${REGION}:${recovery_instance}" ]] ||
  die "unexpected recovery connection name: ${recovery_connection_name:-<empty>}"

proxy_name="${recovery_instance}-proxy"
proxy_image="gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.23.0"
# The Docker inspect template and container variables are evaluated remotely.
# shellcheck disable=SC2016
printf -v recovery_validation_command \
  'set -Eeuo pipefail; compose=(sudo docker compose --env-file /etc/liveprobe/deployment.env -f /opt/liveprobe/current/demo/docker-compose.yml -f /opt/liveprobe/current/deploy/gcp/docker-compose.gcp.yml -f /opt/liveprobe/current/deploy/gcp/docker-compose.cloud-sql.yml); broker_id="$("${compose[@]}" ps -q broker)"; test -n "$broker_id"; network="$(sudo docker inspect --format='\''{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'\'' "$broker_id" | awk '\''/_app$/ { print; exit }'\'')"; test -n "$network"; ! sudo docker container inspect %q >/dev/null 2>&1; cleanup_proxy() { sudo docker rm -f %q >/dev/null 2>&1 || true; }; trap cleanup_proxy EXIT; sudo docker run --detach --rm --name %q --network "$network" %q --address=0.0.0.0 --port=5432 %q >/dev/null; sudo docker exec -e RECOVERY_HOST=%q "$broker_id" node -e %q' \
  "$proxy_name" \
  "$proxy_name" \
  "$proxy_name" \
  "$proxy_image" \
  "$recovery_connection_name" \
  "$proxy_name" \
  "$validation_js"
recovery_snapshot="$(
  gcloud_cmd compute ssh "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --command="$recovery_validation_command" \
    --quiet
)"

validation_summary="$(
  # JavaScript template literals are intentionally protected from the shell.
  # shellcheck disable=SC2016
  node -e '
    const source = JSON.parse(process.argv[1]);
    const recovered = JSON.parse(process.argv[2]);
    for (const field of [
      "schemaVersion", "tenantCount", "projectCount", "environmentCount",
      "serviceCount", "auditEventCount",
    ]) {
      if (!Number.isInteger(recovered[field]) || recovered[field] < 1) {
        throw new Error(`recovered ${field} is invalid`);
      }
    }
    if (recovered.schemaVersion !== source.schemaVersion) {
      throw new Error(
        `schema version mismatch: source=${source.schemaVersion}, ` +
        `recovered=${recovered.schemaVersion}`,
      );
    }
    if (recovered.immutableTriggerCount !== 1) {
      throw new Error("recovered immutable audit trigger is missing");
    }
    for (const field of [
      "hasDefaultTenant", "hasDefaultProject", "hasDefaultEnvironment",
    ]) {
      if (recovered[field] !== true) {
        throw new Error(`recovered ${field} is false`);
      }
    }
    process.stdout.write(JSON.stringify({
      schemaVersion: recovered.schemaVersion,
      tenantCount: recovered.tenantCount,
      serviceCount: recovered.serviceCount,
      auditEventCount: recovered.auditEventCount,
      immutableAudit: true,
    }));
  ' "$source_snapshot" "$recovery_snapshot"
)"

cleanup_recovery_instance
trap - EXIT INT TERM

printf 'Recovery drill passed\n'
printf 'Source instance: %s\n' "$CLOUD_SQL_INSTANCE"
printf 'Managed backup: %s (%s, completed %s)\n' \
  "$backup_id" "$backup_type" "$backup_end_time"
printf 'Point in time: %s\n' "$point_in_time"
printf 'Validation: %s\n' "$validation_summary"
printf 'Temporary instance deleted: %s\n' "$recovery_instance"
