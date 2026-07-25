import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { NativeIngestEnvelope } from "@liveprobe/protocol";

import type {
  AuditEventRecord,
  AuditListOptions,
  AuditMetadataValue,
  AuditOutcome,
} from "../audit.js";
import type {
  ResourceScope,
  ResourceScopeLabels,
  ServiceCredentialRecord,
  StoredServiceCredential,
  NativeCredentialRecord,
  StoredNativeCredential,
} from "../auth.js";
import type {
  AgentCapability,
  BrokerState,
  IngestInput,
} from "../index.js";
import type {
  EnvironmentRecord,
  ProjectRecord,
  RegisteredServiceRecord,
} from "../resource-catalog.js";
import {
  POSTGRES_MIGRATION_SQL,
  POSTGRES_SCHEMA_VERSION,
} from "./migrations.js";

interface ServiceRow extends QueryResultRow {
  tenant_id: string;
  project_id: string;
  environment_id: string;
  service_id: string;
  last_seen: Date;
  sdk: "node" | "python" | "jvm" | null;
  commit_sha: string | null;
  commit_source: "env" | "config" | null;
  capabilities: AgentCapability[];
  agent_status: unknown | null;
  backend: "managed-runtime" | "native-ebpf" | null;
  language: "node" | "python" | "jvm" | "rust" | "cpp" | null;
  instance_count: number | null;
  build_ids: string[] | null;
  native_limitations: string[] | null;
}

interface ProbeRow extends QueryResultRow {
  tenant_id: string;
  project_id: string;
  environment_id: string;
  definition: unknown;
  expires_at: Date;
  expired: boolean;
}

interface VersionRow extends QueryResultRow {
  tenant_id: string;
  project_id: string;
  environment_id: string;
  service_id: string;
  version: number;
}

interface EventRow extends QueryResultRow {
  tenant_id: string;
  probe_id: string;
  event: unknown;
}

interface StatusRow extends QueryResultRow {
  tenant_id: string;
  probe_id: string;
  status: string;
  updated_at: Date;
  detail: string | null;
}

interface SourceMapSetRow extends QueryResultRow {
  tenant_id: string;
  project_id: string;
  environment_id: string;
  service_id: string;
  commit_sha: string;
  complete: boolean;
  updated_at: Date;
}

interface SourceMapRow extends QueryResultRow {
  tenant_id: string;
  project_id: string;
  environment_id: string;
  service_id: string;
  commit_sha: string;
  map_path: string;
  source_map: Record<string, unknown>;
  uploaded_at: Date;
}

interface ServiceCredentialRow extends QueryResultRow {
  credential_id: string;
  tenant_id: string;
  project_id: string;
  environment_id: string;
  service_id: string;
  label: string;
  key_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}
interface NativeCredentialRow extends QueryResultRow {
  credential_id: string;
  tenant_id: string;
  project_id: string;
  environment_id: string;
  agent_id: string;
  allowed_service_ids: string[];
  label: string;
  key_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

function sameScope(
  candidate: ResourceScope,
  scope: ResourceScope,
): boolean {
  return candidate.tenantId === scope.tenantId &&
    candidate.projectId === scope.projectId &&
    candidate.environmentId === scope.environmentId;
}
interface NativeAgentRow extends QueryResultRow {
  tenant_id: string; project_id: string; environment_id: string;
  agent_id: string; hostname: string; architecture: string;
  capabilities: string[]; agent_version: string; last_seen: Date;
}
interface NativeInstanceRow extends QueryResultRow {
  tenant_id: string; project_id: string; environment_id: string;
  agent_id: string; instance_id: string; service_id: string;
  language: "rust" | "cpp"; pid: string; process_start_time: string;
  executable_path: string; executable_device: string | null;
  executable_inode: string | null; build_id: string; architecture: "x86_64";
  capabilities: string[]; cgroup: string | null; container_id: string | null;
  last_seen: Date;
}
interface NativeStatusRow extends QueryResultRow {
  tenant_id: string; project_id: string; environment_id: string;
  probe_id: string; probe_version: number; agent_id: string;
  instance_id: string; build_id: string; status: unknown;
}
interface NativeVersionRow extends QueryResultRow {
  tenant_id: string; project_id: string; environment_id: string;
  agent_id: string; version: string;
}

interface AuditEventRow extends QueryResultRow {
  audit_id: string;
  tenant_id: string;
  project_id: string;
  environment_id: string;
  occurred_at: Date;
  request_id: string;
  actor_type: AuditEventRecord["actorType"];
  actor_id: string;
  actor_role: AuditEventRecord["actorRole"];
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: AuditOutcome;
  status_code: number | null;
  error_code: string | null;
  metadata: Record<string, AuditMetadataValue>;
}

interface ProjectRow extends QueryResultRow {
  tenant_id: string;
  project_id: string;
  display_name: string;
  created_at: Date;
  archived_at: Date | null;
}

interface EnvironmentRow extends QueryResultRow {
  tenant_id: string;
  project_id: string;
  environment_id: string;
  display_name: string;
  created_at: Date;
  archived_at: Date | null;
}

interface RegisteredServiceRow extends QueryResultRow {
  tenant_id: string;
  project_id: string;
  service_id: string;
  display_name: string;
  created_at: Date;
  archived_at: Date | null;
}

function projectRecord(row: ProjectRow): ProjectRecord {
  return {
    tenantId: row.tenant_id,
    projectId: row.project_id,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
    ...(row.archived_at === null
      ? {}
      : { archivedAt: row.archived_at.toISOString() }),
  };
}

function environmentRecord(row: EnvironmentRow): EnvironmentRecord {
  return {
    tenantId: row.tenant_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
    ...(row.archived_at === null
      ? {}
      : { archivedAt: row.archived_at.toISOString() }),
  };
}

function registeredServiceRecord(
  row: RegisteredServiceRow,
): RegisteredServiceRecord {
  return {
    tenantId: row.tenant_id,
    projectId: row.project_id,
    serviceId: row.service_id,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
    ...(row.archived_at === null
      ? {}
      : { archivedAt: row.archived_at.toISOString() }),
  };
}

function serviceCredentialRecord(
  row: ServiceCredentialRow,
): ServiceCredentialRecord {
  return {
    credentialId: row.credential_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    serviceId: row.service_id,
    label: row.label,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at.toISOString(),
    ...(row.last_used_at === null
      ? {}
      : { lastUsedAt: row.last_used_at.toISOString() }),
    ...(row.revoked_at === null
      ? {}
      : { revokedAt: row.revoked_at.toISOString() }),
  };
}

function nativeCredentialRecord(row: NativeCredentialRow): NativeCredentialRecord {
  return {
    credentialId: row.credential_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    agentId: row.agent_id,
    allowedServiceIds: row.allowed_service_ids,
    label: row.label,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at.toISOString(),
    ...(row.last_used_at === null ? {} : {
      lastUsedAt: row.last_used_at.toISOString(),
    }),
    ...(row.revoked_at === null ? {} : {
      revokedAt: row.revoked_at.toISOString(),
    }),
  };
}

function auditEventRecord(row: AuditEventRow): AuditEventRecord {
  return {
    auditId: row.audit_id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    occurredAt: row.occurred_at.toISOString(),
    requestId: row.request_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    action: row.action,
    resourceType: row.resource_type,
    ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
    outcome: row.outcome,
    ...(row.status_code === null ? {} : { statusCode: row.status_code }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    metadata: row.metadata,
  };
}

export interface PostgresStoreOptions {
  maxConnections?: number;
}

export class PostgresStore {
  public readonly incremental = true;
  private readonly pool: Pool;
  private migrationPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly provisionedScopes = new Map<string, Promise<void>>();

  public constructor(
    databaseUrl: string,
    options: PostgresStoreOptions = {},
  ) {
    if (databaseUrl.trim().length === 0) {
      throw new Error("DATABASE_URL must be non-empty");
    }
    const maxConnections = options.maxConnections ?? 10;
    if (!Number.isSafeInteger(maxConnections) || maxConnections <= 0) {
      throw new RangeError("maxConnections must be a positive safe integer");
    }
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: maxConnections,
    });
    this.pool.on("error", () => {
      process.stderr.write("[liveprobe] unexpected idle PostgreSQL client error\n");
    });
  }

  public async healthCheck(): Promise<void> {
    await this.pool.query("select 1");
  }

  public async ensureResourceScope(
    scope: ResourceScope,
    labels: ResourceScopeLabels = {},
  ): Promise<void> {
    const key = JSON.stringify([
      scope.tenantId,
      scope.projectId,
      scope.environmentId,
    ]);
    const existing = this.provisionedScopes.get(key);
    if (existing !== undefined) {
      await existing;
      return;
    }

    const operation = this.withTransaction(async (client) => {
      await client.query(
        `insert into tenants (tenant_id, display_name)
         values ($1, $2)
         on conflict (tenant_id) do update
           set display_name = excluded.display_name`,
        [scope.tenantId, labels.tenantDisplayName ?? scope.tenantId],
      );
      await client.query(
        `insert into projects (tenant_id, project_id, display_name)
         values ($1, $2, $3)
         on conflict (tenant_id, project_id) do update
           set display_name = excluded.display_name`,
        [
          scope.tenantId,
          scope.projectId,
          labels.projectDisplayName ?? scope.projectId,
        ],
      );
      await client.query(
        `insert into environments (
           tenant_id, project_id, environment_id, display_name
         ) values ($1, $2, $3, $4)
         on conflict (tenant_id, project_id, environment_id) do update
           set display_name = excluded.display_name`,
        [
          scope.tenantId,
          scope.projectId,
          scope.environmentId,
          labels.environmentDisplayName ?? scope.environmentId,
        ],
      );
    }).catch((error: unknown) => {
      this.provisionedScopes.delete(key);
      throw error;
    });
    this.provisionedScopes.set(key, operation);
    await operation;
  }

  public async createProject(
    tenantId: string,
    projectId: string,
    displayName: string,
  ): Promise<ProjectRecord | undefined> {
    await this.ensureMigrated();
    const result = await this.pool.query<ProjectRow>(
      `insert into projects (
         tenant_id, project_id, display_name
       )
       select tenant_id, $2, $3 from tenants where tenant_id = $1
       on conflict (tenant_id, project_id) do update
         set display_name = excluded.display_name, archived_at = null
       returning tenant_id, project_id, display_name, created_at, archived_at`,
      [tenantId, projectId, displayName],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : projectRecord(row);
  }

  public async listProjects(
    tenantId: string,
    includeArchived = false,
  ): Promise<ProjectRecord[]> {
    await this.ensureMigrated();
    const result = await this.pool.query<ProjectRow>(
      `select tenant_id, project_id, display_name, created_at, archived_at
       from projects
       where tenant_id = $1 and ($2::boolean or archived_at is null)
       order by project_id`,
      [tenantId, includeArchived],
    );
    return result.rows.map(projectRecord);
  }

  public async archiveProject(
    tenantId: string,
    projectId: string,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const archived = await client.query(
        `update projects set archived_at = now()
         where tenant_id = $1 and project_id = $2 and archived_at is null
         returning project_id`,
        [tenantId, projectId],
      );
      if (archived.rowCount !== 1) return false;
      await client.query(
        `update environments set archived_at = coalesce(archived_at, now())
         where tenant_id = $1 and project_id = $2`,
        [tenantId, projectId],
      );
      await client.query(
        `update registered_services
         set archived_at = coalesce(archived_at, now())
         where tenant_id = $1 and project_id = $2`,
        [tenantId, projectId],
      );
      await client.query(
        `update service_credentials set revoked_at = now()
         where tenant_id = $1 and project_id = $2 and revoked_at is null`,
        [tenantId, projectId],
      );
      return true;
    });
  }

  public async createEnvironment(
    scope: ResourceScope,
    displayName: string,
  ): Promise<EnvironmentRecord | undefined> {
    await this.ensureMigrated();
    const result = await this.pool.query<EnvironmentRow>(
      `insert into environments (
         tenant_id, project_id, environment_id, display_name
       )
       select tenant_id, project_id, $3, $4
       from projects
       where tenant_id = $1 and project_id = $2 and archived_at is null
       on conflict (tenant_id, project_id, environment_id) do update
         set display_name = excluded.display_name, archived_at = null
       returning tenant_id, project_id, environment_id, display_name,
         created_at, archived_at`,
      [scope.tenantId, scope.projectId, scope.environmentId, displayName],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : environmentRecord(row);
  }

  public async listEnvironments(
    tenantId: string,
    projectId: string,
    includeArchived = false,
  ): Promise<EnvironmentRecord[]> {
    await this.ensureMigrated();
    const result = await this.pool.query<EnvironmentRow>(
      `select tenant_id, project_id, environment_id, display_name,
         created_at, archived_at
       from environments
       where tenant_id = $1 and project_id = $2
         and ($3::boolean or archived_at is null)
       order by environment_id`,
      [tenantId, projectId, includeArchived],
    );
    return result.rows.map(environmentRecord);
  }

  public async archiveEnvironment(scope: ResourceScope): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const archived = await client.query(
        `update environments set archived_at = now()
         where tenant_id = $1 and project_id = $2 and environment_id = $3
           and archived_at is null
         returning environment_id`,
        [scope.tenantId, scope.projectId, scope.environmentId],
      );
      if (archived.rowCount !== 1) return false;
      await client.query(
        `update service_credentials set revoked_at = now()
         where tenant_id = $1 and project_id = $2 and environment_id = $3
           and revoked_at is null`,
        [scope.tenantId, scope.projectId, scope.environmentId],
      );
      return true;
    });
  }

  public async createRegisteredService(
    tenantId: string,
    projectId: string,
    serviceId: string,
    displayName: string,
  ): Promise<RegisteredServiceRecord | undefined> {
    await this.ensureMigrated();
    const result = await this.pool.query<RegisteredServiceRow>(
      `insert into registered_services (
         tenant_id, project_id, service_id, display_name
       )
       select tenant_id, project_id, $3, $4
       from projects
       where tenant_id = $1 and project_id = $2 and archived_at is null
       on conflict (tenant_id, project_id, service_id) do update
         set display_name = excluded.display_name, archived_at = null
       returning tenant_id, project_id, service_id,
         display_name, created_at, archived_at`,
      [tenantId, projectId, serviceId, displayName],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : registeredServiceRecord(row);
  }

  public async getRegisteredService(
    tenantId: string,
    projectId: string,
    serviceId: string,
  ): Promise<RegisteredServiceRecord | undefined> {
    await this.ensureMigrated();
    const result = await this.pool.query<RegisteredServiceRow>(
      `select tenant_id, project_id, service_id,
         display_name, created_at, archived_at
       from registered_services
       where tenant_id = $1 and project_id = $2 and service_id = $3`,
      [tenantId, projectId, serviceId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : registeredServiceRecord(row);
  }

  public async listRegisteredServices(
    tenantId: string,
    projectId: string,
    includeArchived = false,
  ): Promise<RegisteredServiceRecord[]> {
    await this.ensureMigrated();
    const result = await this.pool.query<RegisteredServiceRow>(
      `select tenant_id, project_id, service_id,
         display_name, created_at, archived_at
       from registered_services
       where tenant_id = $1 and project_id = $2
         and ($3::boolean or archived_at is null)
       order by service_id`,
      [tenantId, projectId, includeArchived],
    );
    return result.rows.map(registeredServiceRecord);
  }

  public async archiveRegisteredService(
    tenantId: string,
    projectId: string,
    serviceId: string,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const archived = await client.query(
        `update registered_services set archived_at = now()
         where tenant_id = $1 and project_id = $2 and service_id = $3
           and archived_at is null
         returning service_id`,
        [tenantId, projectId, serviceId],
      );
      if (archived.rowCount !== 1) return false;
      await client.query(
        `update service_credentials set revoked_at = now()
         where tenant_id = $1 and project_id = $2 and service_id = $3
           and revoked_at is null`,
        [tenantId, projectId, serviceId],
      );
      return true;
    });
  }

  public async restore(state: BrokerState): Promise<void> {
    await this.ensureMigrated();
    const client = await this.pool.connect();
    let restoredLegacySnapshot = false;
    try {
      const services = await client.query<ServiceRow>(
        `select tenant_id, project_id, environment_id, service_id, last_seen,
           sdk, commit_sha, commit_source, capabilities, agent_status,
           backend, language, instance_count, build_ids, native_limitations
         from services order by service_id`,
      );
      const probes = await client.query<ProbeRow>(
        `select tenant_id, project_id, environment_id, definition,
           expires_at, expired
         from probes order by probe_id`,
      );
      const versions = await client.query<VersionRow>(
        `select tenant_id, project_id, environment_id, service_id, version
         from service_versions order by service_id`,
      );
      const events = await client.query<EventRow>(
        `select tenant_id, probe_id, event
         from probe_events order by probe_id, sequence`,
      );
      const statuses = await client.query<StatusRow>(
        `select tenant_id, probe_id, status, updated_at, detail
         from probe_statuses order by probe_id`,
      );
      const sourceMapSets = await client.query<SourceMapSetRow>(
        `select tenant_id, project_id, environment_id, service_id,
           commit_sha, complete, updated_at
         from source_map_sets order by service_id, commit_sha`,
      );
      const sourceMaps = await client.query<SourceMapRow>(
        `select tenant_id, project_id, environment_id, service_id, commit_sha,
           map_path, source_map, uploaded_at
         from source_maps order by service_id, commit_sha, map_path`,
      );
      const nativeAgents = await client.query<NativeAgentRow>(
        `select tenant_id, project_id, environment_id, agent_id, hostname,
           architecture, capabilities, agent_version, last_seen
         from native_agents order by tenant_id, project_id, environment_id, agent_id`,
      );
      const nativeInstances = await client.query<NativeInstanceRow>(
        `select tenant_id, project_id, environment_id, agent_id, instance_id,
           service_id, language, pid, process_start_time, executable_path,
           executable_device, executable_inode, build_id, architecture,
           capabilities, cgroup, container_id, last_seen
         from native_instances
         order by tenant_id, project_id, environment_id, agent_id, instance_id`,
      );
      const nativeStatuses = await client.query<NativeStatusRow>(
        `select tenant_id, project_id, environment_id, probe_id, probe_version,
           agent_id, instance_id, build_id, status
         from native_probe_statuses`,
      );
      const nativeVersions = await client.query<NativeVersionRow>(
        `select tenant_id, project_id, environment_id, agent_id, version
         from native_assignment_versions`,
      );

      const hasNormalizedState =
        services.rowCount !== 0 ||
        probes.rowCount !== 0 ||
        versions.rowCount !== 0 ||
        nativeAgents.rowCount !== 0 ||
        nativeInstances.rowCount !== 0 ||
        nativeStatuses.rowCount !== 0 ||
        nativeVersions.rowCount !== 0;
      if (!hasNormalizedState) {
        const legacy = await client
          .query<{ snapshot: unknown }>(
            `select snapshot from broker_snapshots where id = 'liveprobe'`,
          )
          .catch(() => ({ rows: [], rowCount: 0 }));
        const snapshot = legacy.rows[0]?.snapshot;
        if (snapshot !== undefined) {
          state.loadSnapshot(snapshot);
          restoredLegacySnapshot = true;
          return;
        }
      }

      const eventsByProbe = new Map<string, unknown[]>();
      for (const row of events.rows) {
        const values = eventsByProbe.get(row.probe_id) ?? [];
        values.push(row.event);
        eventsByProbe.set(row.probe_id, values);
      }

      const scopeByProbe = new Map(
        probes.rows.map((row) => [
          (row.definition as { id?: unknown }).id,
          {
            tenantId: row.tenant_id,
            projectId: row.project_id,
            environmentId: row.environment_id,
          },
        ]),
      );

      const mapsBySet = new Map<string, SourceMapRow[]>();
      for (const row of sourceMaps.rows) {
        const key = JSON.stringify([
          row.tenant_id,
          row.project_id,
          row.environment_id,
          row.service_id,
          row.commit_sha,
        ]);
        const maps = mapsBySet.get(key) ?? [];
        maps.push(row);
        mapsBySet.set(key, maps);
      }

      state.loadSnapshot({
        formatVersion: 2,
        savedAt: new Date().toISOString(),
        probes: probes.rows.map((row) => ({
          scope: {
            tenantId: row.tenant_id,
            projectId: row.project_id,
            environmentId: row.environment_id,
          },
          probe: row.definition,
          expiresAt: row.expires_at.getTime(),
          expired: row.expired,
        })),
        serviceVersions: versions.rows.map((row) => ({
          tenantId: row.tenant_id,
          projectId: row.project_id,
          environmentId: row.environment_id,
          serviceId: row.service_id,
          version: row.version,
        })),
        events: probes.rows.map((row) => {
          const definition = row.definition as { id?: unknown };
          return {
            scope: {
              tenantId: row.tenant_id,
              projectId: row.project_id,
              environmentId: row.environment_id,
            },
            probeId: definition.id,
            values:
              typeof definition.id === "string"
                ? (eventsByProbe.get(definition.id) ?? [])
                : [],
          };
        }),
        services: services.rows.map((row) => ({
          tenantId: row.tenant_id,
          projectId: row.project_id,
          environmentId: row.environment_id,
          serviceId: row.service_id,
          lastSeen: row.last_seen.toISOString(),
          ...(row.sdk === null ? {} : { sdk: row.sdk }),
          ...(row.commit_sha === null
            ? {}
            : { commitSha: row.commit_sha }),
          ...(row.commit_source === null
            ? {}
            : { commitSource: row.commit_source }),
          capabilities: row.capabilities,
          ...(row.agent_status === null
            ? {}
            : { agentStatus: row.agent_status }),
          ...(row.backend === null ? {} : { backend: row.backend }),
          ...(row.language === null ? {} : { language: row.language }),
          ...(row.instance_count === null ? {} : {
            instanceCount: row.instance_count,
          }),
          ...(row.build_ids === null ? {} : { buildIds: row.build_ids }),
          ...(row.native_limitations === null ? {} : {
            nativeLimitations: row.native_limitations,
          }),
        })),
        statuses: statuses.rows.map((row) => ({
          scope: scopeByProbe.get(row.probe_id),
          probeId: row.probe_id,
          value: {
            status: row.status,
            updatedAt: row.updated_at.toISOString(),
            ...(row.detail === null ? {} : { detail: row.detail }),
          },
        })),
        sourceMapSets: sourceMapSets.rows.map((row) => ({
          tenantId: row.tenant_id,
          projectId: row.project_id,
          environmentId: row.environment_id,
          serviceId: row.service_id,
          commitSha: row.commit_sha,
          complete: row.complete,
          updatedAt: row.updated_at.toISOString(),
          maps: (mapsBySet.get(JSON.stringify([
            row.tenant_id,
            row.project_id,
            row.environment_id,
            row.service_id,
            row.commit_sha,
          ])) ?? [])
            .map((map) => ({
              mapPath: map.map_path,
              map: map.source_map,
              uploadedAt: map.uploaded_at.toISOString(),
            })),
        })),
        nativeAgents: nativeAgents.rows.map((row) => ({
          tenantId: row.tenant_id,
          projectId: row.project_id,
          environmentId: row.environment_id,
          agentId: row.agent_id,
          hostname: row.hostname,
          backend: "native-ebpf",
          architecture: row.architecture,
          capabilities: row.capabilities,
          agentVersion: row.agent_version,
          lastSeen: row.last_seen.toISOString(),
        })),
        nativeInstances: nativeInstances.rows.map((row) => ({
          tenantId: row.tenant_id,
          projectId: row.project_id,
          environmentId: row.environment_id,
          agentId: row.agent_id,
          instanceId: row.instance_id,
          serviceId: row.service_id,
          language: row.language,
          pid: Number(row.pid),
          processStartTime: row.process_start_time,
          executablePath: row.executable_path,
          ...(row.executable_device === null ? {} : {
            executableDevice: row.executable_device,
          }),
          ...(row.executable_inode === null ? {} : {
            executableInode: row.executable_inode,
          }),
          buildId: row.build_id,
          architecture: row.architecture,
          capabilities: row.capabilities,
          ...(row.cgroup === null ? {} : { cgroup: row.cgroup }),
          ...(row.container_id === null ? {} : {
            containerId: row.container_id,
          }),
          lastSeen: row.last_seen.toISOString(),
        })),
        nativeStatuses: nativeStatuses.rows.map((row) => ({
          tenantId: row.tenant_id,
          projectId: row.project_id,
          environmentId: row.environment_id,
          probeId: row.probe_id,
          probeVersion: row.probe_version,
          agentId: row.agent_id,
          instanceId: row.instance_id,
          buildId: row.build_id,
          value: row.status,
        })),
        nativeAssignmentVersions: nativeVersions.rows.map((row) => ({
          tenantId: row.tenant_id,
          projectId: row.project_id,
          environmentId: row.environment_id,
          agentId: row.agent_id,
          version: Number(row.version),
        })),
      });
    } finally {
      client.release();
      if (restoredLegacySnapshot) {
        await this.persist(state);
      }
    }
  }

  public async persist(state: BrokerState): Promise<void> {
    const snapshot = state.snapshot();
    await this.ensureMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [
        1_276_638_214,
      ]);
      await this.insertServices(client, snapshot.services);
      await this.insertProbes(client, snapshot.probes);
      await this.insertEvents(client, snapshot.events);
      await this.insertStatuses(client, snapshot.statuses);
      await this.insertVersions(client, snapshot.serviceVersions);
      await this.insertNativeState(client, snapshot);
      await client.query("commit");
    } catch (error: unknown) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async persistProbe(
    state: BrokerState,
    probeId: string,
    scope: ResourceScope,
  ): Promise<void> {
    const snapshot = state.snapshot();
    const probes = snapshot.probes.filter(
      (stored) =>
        stored.probe.id === probeId &&
        stored.scope.tenantId === scope.tenantId &&
        stored.scope.projectId === scope.projectId &&
        stored.scope.environmentId === scope.environmentId,
    );
    if (probes.length === 0) return;
    const serviceId = probes[0]?.probe.serviceId;
    const versions = snapshot.serviceVersions.filter(
      (candidate) =>
        candidate.serviceId === serviceId &&
        candidate.tenantId === scope.tenantId &&
        candidate.projectId === scope.projectId &&
        candidate.environmentId === scope.environmentId,
    );
    await this.withTransaction(async (client) => {
      await this.insertProbes(client, probes);
      await this.insertVersions(client, versions);
      await this.insertNativeState(client, snapshot);
    });
  }

  public async deleteProbe(
    state: BrokerState,
    probeId: string,
    scope: ResourceScope,
  ): Promise<void> {
    const snapshot = state.snapshot();
    await this.withTransaction(async (client) => {
      await client.query(
        `delete from probes where probe_id = $1 and tenant_id = $2
           and project_id = $3 and environment_id = $4`,
        [probeId, scope.tenantId, scope.projectId, scope.environmentId],
      );
      await this.insertVersions(client, snapshot.serviceVersions);
      await this.insertNativeState(client, snapshot);
    });
  }

  public async persistIngest(
    state: BrokerState,
    input: IngestInput,
    scope: ResourceScope,
  ): Promise<void> {
    const snapshot = state.snapshot();
    const services = snapshot.services.filter(
      (service) =>
        service.serviceId === input.serviceId &&
        service.tenantId === scope.tenantId &&
        service.projectId === scope.projectId &&
        service.environmentId === scope.environmentId,
    );
    const probeIds = [...new Set(input.events.map(({ probeId }) => probeId))];
    const events = snapshot.events.filter(
      (entry) =>
        probeIds.includes(entry.probeId) &&
        entry.scope.tenantId === scope.tenantId &&
        entry.scope.projectId === scope.projectId &&
        entry.scope.environmentId === scope.environmentId,
    );
    const statuses = snapshot.statuses.filter(
      (entry) =>
        probeIds.includes(entry.probeId) &&
        entry.scope.tenantId === scope.tenantId &&
        entry.scope.projectId === scope.projectId &&
        entry.scope.environmentId === scope.environmentId,
    );
    await this.withTransaction(async (client) => {
      await this.insertServices(client, services);
      if (probeIds.length > 0) {
        await client.query(
          `delete from probe_events where probe_id = any($1::text[])
             and tenant_id = $2`,
          [probeIds, scope.tenantId],
        );
      }
      await this.insertEvents(client, events);
      await this.insertStatuses(client, statuses);
    });
  }

  public async persistNativeAgent(
    state: BrokerState,
    agentId: string,
    scope: ResourceScope,
  ): Promise<void> {
    const snapshot = state.snapshot();
    await this.withTransaction(async (client) => {
      await this.insertNativeState(client, {
        ...snapshot,
        nativeAgents: snapshot.nativeAgents.filter(
          (agent) =>
            agent.agentId === agentId &&
            sameScope(agent, scope),
        ),
        nativeInstances: [],
        nativeStatuses: [],
        nativeAssignmentVersions: snapshot.nativeAssignmentVersions.filter(
          (version) =>
            version.agentId === agentId &&
            sameScope(version, scope),
        ),
      });
    });
  }

  public async persistNativeInstances(
    state: BrokerState,
    agentId: string,
    scope: ResourceScope,
  ): Promise<void> {
    const snapshot = state.snapshot();
    const nativeAgents = snapshot.nativeAgents.filter(
      (agent) => agent.agentId === agentId && sameScope(agent, scope),
    );
    const nativeInstances = snapshot.nativeInstances.filter(
      (instance) => instance.agentId === agentId && sameScope(instance, scope),
    );
    const nativeAssignmentVersions = snapshot.nativeAssignmentVersions.filter(
      (version) => version.agentId === agentId && sameScope(version, scope),
    );
    const nativeServices = snapshot.services.filter(
      (service) =>
        service.backend === "native-ebpf" &&
        sameScope(service, scope),
    );
    await this.withTransaction(async (client) => {
      await this.insertNativeState(client, {
        ...snapshot,
        nativeAgents,
        nativeInstances: [],
        nativeStatuses: [],
        nativeAssignmentVersions,
      });
      await client.query(
        `delete from native_instances
         where tenant_id = $1 and project_id = $2 and environment_id = $3
           and agent_id = $4`,
        [scope.tenantId, scope.projectId, scope.environmentId, agentId],
      );
      await this.insertNativeState(client, {
        ...snapshot,
        nativeAgents: [],
        nativeInstances,
        nativeStatuses: [],
        nativeAssignmentVersions: [],
      });
      await client.query(
        `delete from native_probe_statuses as status
         where status.tenant_id = $1 and status.project_id = $2
           and status.environment_id = $3 and status.agent_id = $4
           and not exists (
             select 1 from native_instances as instance
             where instance.tenant_id = status.tenant_id
               and instance.project_id = status.project_id
               and instance.environment_id = status.environment_id
               and instance.agent_id = status.agent_id
               and instance.instance_id = status.instance_id
               and instance.build_id = status.build_id
           )`,
        [scope.tenantId, scope.projectId, scope.environmentId, agentId],
      );
      await client.query(
        `delete from services as service
         where service.tenant_id = $1 and service.project_id = $2
           and service.environment_id = $3
           and service.backend = 'native-ebpf'
           and not exists (
             select 1 from native_instances as instance
             where instance.tenant_id = service.tenant_id
               and instance.project_id = service.project_id
               and instance.environment_id = service.environment_id
               and instance.service_id = service.service_id
           )`,
        [scope.tenantId, scope.projectId, scope.environmentId],
      );
      await this.insertServices(client, nativeServices);
    });
  }

  public async persistNativeIngest(
    state: BrokerState,
    input: NativeIngestEnvelope,
    scope: ResourceScope,
  ): Promise<void> {
    const snapshot = state.snapshot();
    const probeIds = [...new Set(input.events.map((event) => event.probeId))];
    const events = snapshot.events.filter(
      (entry) =>
        probeIds.includes(entry.probeId) &&
        sameScope(entry.scope, scope),
    );
    const statuses = snapshot.statuses.filter(
      (entry) =>
        probeIds.includes(entry.probeId) &&
        sameScope(entry.scope, scope),
    );
    await this.withTransaction(async (client) => {
      await this.insertServices(
        client,
        snapshot.services.filter(
          (service) =>
            service.serviceId === input.serviceId &&
            sameScope(service, scope),
        ),
      );
      await this.insertNativeState(client, {
        ...snapshot,
        nativeAgents: snapshot.nativeAgents.filter(
          (agent) =>
            agent.agentId === input.agentId &&
            sameScope(agent, scope),
        ),
        nativeInstances: [],
        nativeStatuses: snapshot.nativeStatuses.filter(
          (status) =>
            status.agentId === input.agentId &&
            status.instanceId === input.instanceId &&
            status.buildId === input.buildId &&
            probeIds.includes(status.probeId) &&
            sameScope(status, scope),
        ),
        nativeAssignmentVersions: snapshot.nativeAssignmentVersions.filter(
          (version) =>
            version.agentId === input.agentId &&
            sameScope(version, scope),
        ),
      });
      if (probeIds.length > 0) {
        await client.query(
          `delete from probe_events where probe_id = any($1::text[])
             and tenant_id = $2`,
          [probeIds, scope.tenantId],
        );
      }
      await this.insertEvents(client, events);
      await this.insertStatuses(client, statuses);
    });
  }

  public async persistSourceMapSet(
    state: BrokerState,
    serviceId: string,
    commitSha: string,
    scope: ResourceScope,
  ): Promise<void> {
    const set = state.getSourceMapSet(serviceId, commitSha, scope);
    if (set === undefined) return;
    await this.ensureMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [1_276_638_214]);
      await client.query(
        `insert into source_map_sets (
           tenant_id, project_id, environment_id, service_id, commit_sha,
           complete, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7::timestamptz)
         on conflict (
           tenant_id, project_id, environment_id, service_id, commit_sha
         ) do update set
           complete = excluded.complete,
           updated_at = excluded.updated_at`,
        [
          set.tenantId,
          set.projectId,
          set.environmentId,
          set.serviceId,
          set.commitSha,
          set.complete,
          set.updatedAt,
        ],
      );
      await client.query(
        `delete from source_maps where tenant_id = $1 and project_id = $2
           and environment_id = $3 and service_id = $4 and commit_sha = $5`,
        [
          set.tenantId,
          set.projectId,
          set.environmentId,
          set.serviceId,
          set.commitSha,
        ],
      );
      if (set.maps.length > 0) {
        await client.query(
          `insert into source_maps (
             tenant_id, project_id, environment_id, service_id, commit_sha,
             map_path, source_map, uploaded_at
           )
           select tenant_id, project_id, environment_id, service_id,
             commit_sha, map_path, source_map, uploaded_at::timestamptz
           from jsonb_to_recordset($1::jsonb) as source_map(
             tenant_id text, project_id text, environment_id text,
             service_id text, commit_sha text, map_path text, source_map jsonb,
             uploaded_at text
           )`,
          [
            JSON.stringify(
              set.maps.map((map) => ({
                tenant_id: set.tenantId,
                project_id: set.projectId,
                environment_id: set.environmentId,
                service_id: set.serviceId,
                commit_sha: set.commitSha,
                map_path: map.mapPath,
                source_map: map.map,
                uploaded_at: map.uploadedAt,
              })),
            ),
          ],
        );
      }
      const retainedCommits = state
        .snapshot()
        .sourceMapSets.filter(
          (candidate) =>
            candidate.tenantId === scope.tenantId &&
            candidate.projectId === scope.projectId &&
            candidate.environmentId === scope.environmentId &&
            candidate.serviceId === serviceId,
        )
        .map((candidate) => candidate.commitSha);
      await client.query(
        `delete from source_map_sets
         where tenant_id = $1 and project_id = $2 and environment_id = $3
           and service_id = $4 and not (commit_sha = any($5::text[]))`,
        [
          scope.tenantId,
          scope.projectId,
          scope.environmentId,
          serviceId,
          retainedCommits,
        ],
      );
      await client.query("commit");
    } catch (error: unknown) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async createServiceCredential(
    credential: StoredServiceCredential,
  ): Promise<ServiceCredentialRecord> {
    await this.ensureMigrated();
    const result = await this.pool.query<ServiceCredentialRow>(
      `insert into service_credentials (
         credential_id, tenant_id, project_id, environment_id, service_id,
         label, key_prefix, secret_hash, created_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
       returning credential_id, tenant_id, project_id, environment_id,
         service_id, label, key_prefix, created_at, last_used_at, revoked_at`,
      [
        credential.credentialId,
        credential.tenantId,
        credential.projectId,
        credential.environmentId,
        credential.serviceId,
        credential.label,
        credential.keyPrefix,
        credential.secretHash,
        credential.createdAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("PostgreSQL did not return the created service credential");
    }
    return serviceCredentialRecord(row);
  }

  public async listServiceCredentials(
    scope: ResourceScope,
  ): Promise<ServiceCredentialRecord[]> {
    await this.ensureMigrated();
    const result = await this.pool.query<ServiceCredentialRow>(
      `select credential_id, tenant_id, project_id, environment_id,
         service_id, label, key_prefix, created_at, last_used_at, revoked_at
       from service_credentials
       where tenant_id = $1 and project_id = $2 and environment_id = $3
       order by created_at, credential_id`,
      [scope.tenantId, scope.projectId, scope.environmentId],
    );
    return result.rows.map(serviceCredentialRecord);
  }

  public async revokeServiceCredential(
    credentialId: string,
    scope: ResourceScope,
  ): Promise<boolean> {
    await this.ensureMigrated();
    const result = await this.pool.query(
      `update service_credentials set revoked_at = now()
       where credential_id = $1 and tenant_id = $2 and project_id = $3
         and environment_id = $4 and revoked_at is null
       returning credential_id`,
      [
        credentialId,
        scope.tenantId,
        scope.projectId,
        scope.environmentId,
      ],
    );
    return result.rowCount === 1;
  }

  public async authenticateServiceCredential(
    secretHash: string,
  ): Promise<ServiceCredentialRecord | undefined> {
    await this.ensureMigrated();
    const result = await this.pool.query<ServiceCredentialRow>(
      `select credential_id, tenant_id, project_id, environment_id,
         service_id, label, key_prefix, created_at, last_used_at, revoked_at
       from service_credentials
       where secret_hash = $1 and revoked_at is null`,
      [secretHash],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if (
      row.last_used_at === null ||
      row.last_used_at.getTime() < Date.now() - 5 * 60_000
    ) {
      await this.pool.query(
        `update service_credentials set last_used_at = now()
         where credential_id = $1 and revoked_at is null`,
        [row.credential_id],
      );
    }
    return serviceCredentialRecord(row);
  }

  public async createNativeCredential(
    credential: StoredNativeCredential,
  ): Promise<NativeCredentialRecord> {
    await this.ensureMigrated();
    const result = await this.pool.query<NativeCredentialRow>(
      `insert into native_credentials (
         tenant_id, project_id, environment_id, credential_id, agent_id,
         allowed_service_ids, label, key_prefix, secret_hash, created_at
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::timestamptz)
       returning credential_id, tenant_id, project_id, environment_id,
         agent_id, allowed_service_ids, label, key_prefix, created_at,
         last_used_at, revoked_at`,
      [
        credential.tenantId,
        credential.projectId,
        credential.environmentId,
        credential.credentialId,
        credential.agentId,
        JSON.stringify(credential.allowedServiceIds),
        credential.label,
        credential.keyPrefix,
        credential.secretHash,
        credential.createdAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("native credential insert failed");
    return nativeCredentialRecord(row);
  }

  public async listNativeCredentials(
    scope: ResourceScope,
  ): Promise<NativeCredentialRecord[]> {
    await this.ensureMigrated();
    const result = await this.pool.query<NativeCredentialRow>(
      `select credential_id, tenant_id, project_id, environment_id,
         agent_id, allowed_service_ids, label, key_prefix, created_at,
         last_used_at, revoked_at
       from native_credentials
       where tenant_id = $1 and project_id = $2 and environment_id = $3
       order by created_at, credential_id`,
      [scope.tenantId, scope.projectId, scope.environmentId],
    );
    return result.rows.map(nativeCredentialRecord);
  }

  public async revokeNativeCredential(
    credentialId: string,
    scope: ResourceScope,
  ): Promise<boolean> {
    await this.ensureMigrated();
    const result = await this.pool.query(
      `update native_credentials set revoked_at = now()
       where credential_id = $1 and tenant_id = $2 and project_id = $3
         and environment_id = $4 and revoked_at is null`,
      [credentialId, scope.tenantId, scope.projectId, scope.environmentId],
    );
    return result.rowCount === 1;
  }

  public async authenticateNativeCredential(
    secretHash: string,
  ): Promise<NativeCredentialRecord | undefined> {
    await this.ensureMigrated();
    const result = await this.pool.query<NativeCredentialRow>(
      `select credential_id, tenant_id, project_id, environment_id,
         agent_id, allowed_service_ids, label, key_prefix, created_at,
         last_used_at, revoked_at
       from native_credentials
       where secret_hash = $1 and revoked_at is null`,
      [secretHash],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    await this.pool.query(
      `update native_credentials set last_used_at = now()
       where tenant_id = $1 and project_id = $2 and environment_id = $3
         and credential_id = $4 and revoked_at is null`,
      [row.tenant_id, row.project_id, row.environment_id, row.credential_id],
    );
    return nativeCredentialRecord(row);
  }

  public async appendAuditEvent(event: AuditEventRecord): Promise<void> {
    await this.ensureMigrated();
    await this.pool.query(
      `insert into audit_events (
         audit_id, tenant_id, project_id, environment_id, occurred_at,
         request_id, actor_type, actor_id, actor_role, action, resource_type,
         resource_id, outcome, status_code, error_code, metadata
       ) values (
         $1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16::jsonb
       )`,
      [
        event.auditId,
        event.tenantId,
        event.projectId,
        event.environmentId,
        event.occurredAt,
        event.requestId,
        event.actorType,
        event.actorId,
        event.actorRole,
        event.action,
        event.resourceType,
        event.resourceId ?? null,
        event.outcome,
        event.statusCode ?? null,
        event.errorCode ?? null,
        JSON.stringify(event.metadata),
      ],
    );
  }

  public async listAuditEvents(
    scope: ResourceScope,
    options: AuditListOptions,
  ): Promise<AuditEventRecord[]> {
    await this.ensureMigrated();
    const result = await this.pool.query<AuditEventRow>(
      `select audit_id, tenant_id, project_id, environment_id, occurred_at,
         request_id, actor_type, actor_id, actor_role, action, resource_type,
         resource_id, outcome, status_code, error_code, metadata
       from audit_events
       where tenant_id = $1 and project_id = $2 and environment_id = $3
         and ($4::timestamptz is null or occurred_at < $4::timestamptz)
       order by occurred_at desc, audit_id desc
       limit $5`,
      [
        scope.tenantId,
        scope.projectId,
        scope.environmentId,
        options.before ?? null,
        options.limit,
      ],
    );
    return result.rows.map(auditEventRecord);
  }

  public close(): Promise<void> {
    this.closePromise ??= this.pool.end();
    return this.closePromise;
  }

  private async insertNativeState(
    client: PoolClient,
    snapshot: ReturnType<BrokerState["snapshot"]>,
  ): Promise<void> {
    for (const agent of snapshot.nativeAgents) {
      await client.query(
        `insert into native_agents (
           tenant_id, project_id, environment_id, agent_id, hostname,
           architecture, capabilities, agent_version, last_seen
         ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz)
         on conflict (tenant_id, project_id, environment_id, agent_id)
         do update set hostname=excluded.hostname,
           architecture=excluded.architecture,
           capabilities=excluded.capabilities,
           agent_version=excluded.agent_version,
           last_seen=excluded.last_seen
         where excluded.last_seen >= native_agents.last_seen`,
        [
          agent.tenantId, agent.projectId, agent.environmentId, agent.agentId,
          agent.hostname, agent.architecture, JSON.stringify(agent.capabilities),
          agent.agentVersion, agent.lastSeen,
        ],
      );
    }
    for (const instance of snapshot.nativeInstances) {
      await client.query(
        `insert into native_instances (
           tenant_id, project_id, environment_id, agent_id, instance_id,
           service_id, language, pid, process_start_time, executable_path,
           executable_device, executable_inode, build_id, architecture,
           capabilities, cgroup, container_id, last_seen
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,
           $18::timestamptz
         )
         on conflict (
           tenant_id, project_id, environment_id, agent_id, instance_id
         ) do update set
           service_id=excluded.service_id,
           language=excluded.language,
           pid=excluded.pid,
           process_start_time=excluded.process_start_time,
           executable_path=excluded.executable_path,
           executable_device=excluded.executable_device,
           executable_inode=excluded.executable_inode,
           build_id=excluded.build_id,
           architecture=excluded.architecture,
           capabilities=excluded.capabilities,
           cgroup=excluded.cgroup,
           container_id=excluded.container_id,
           last_seen=excluded.last_seen
         where excluded.last_seen >= native_instances.last_seen`,
        [
          instance.tenantId, instance.projectId, instance.environmentId,
          instance.agentId, instance.instanceId, instance.serviceId,
          instance.language, instance.pid, instance.processStartTime,
          instance.executablePath, instance.executableDevice ?? null,
          instance.executableInode ?? null, instance.buildId,
          instance.architecture, JSON.stringify(instance.capabilities),
          instance.cgroup ?? null, instance.containerId ?? null,
          instance.lastSeen,
        ],
      );
    }
    for (const status of snapshot.nativeStatuses) {
      await client.query(
        `insert into native_probe_statuses (
           tenant_id, project_id, environment_id, probe_id, probe_version,
           agent_id, instance_id, build_id, status
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         on conflict (
           tenant_id, project_id, environment_id, probe_id, probe_version,
           agent_id, instance_id, build_id
         ) do update set status=excluded.status
         where (excluded.status->>'updatedAt')::timestamptz >=
           (native_probe_statuses.status->>'updatedAt')::timestamptz`,
        [
          status.tenantId, status.projectId, status.environmentId,
          status.probeId, status.probeVersion, status.agentId,
          status.instanceId, status.buildId, JSON.stringify(status.value),
        ],
      );
    }
    for (const version of snapshot.nativeAssignmentVersions) {
      await client.query(
        `insert into native_assignment_versions (
           tenant_id, project_id, environment_id, agent_id, version
         ) values ($1,$2,$3,$4,$5)
         on conflict (tenant_id, project_id, environment_id, agent_id)
         do update set version = greatest(
           native_assignment_versions.version, excluded.version
         )`,
        [
          version.tenantId, version.projectId, version.environmentId,
          version.agentId, version.version,
        ],
      );
    }
  }

  private async insertServices(
    client: PoolClient,
    services: ReturnType<BrokerState["snapshot"]>["services"],
  ): Promise<void> {
    if (services.length === 0) return;
    await client.query(
      `insert into services (
         tenant_id, project_id, environment_id, service_id, last_seen, sdk,
         commit_sha, commit_source, capabilities, agent_status, backend,
         language, instance_count, build_ids, native_limitations
       )
       select tenant_id, project_id, environment_id, service_id,
         last_seen::timestamptz, sdk, commit_sha, commit_source, capabilities,
         agent_status, backend, language, instance_count, build_ids,
         native_limitations
       from jsonb_to_recordset($1::jsonb) as service(
         tenant_id text, project_id text, environment_id text, service_id text,
         last_seen text, sdk text, commit_sha text, commit_source text,
         capabilities jsonb, agent_status jsonb, backend text, language text,
         instance_count integer, build_ids jsonb, native_limitations jsonb
       )
       on conflict (
         tenant_id, project_id, environment_id, service_id
       ) do update set
         last_seen = excluded.last_seen,
         sdk = excluded.sdk,
         commit_sha = excluded.commit_sha,
         commit_source = excluded.commit_source,
         capabilities = excluded.capabilities,
         agent_status = excluded.agent_status,
         backend = excluded.backend,
         language = excluded.language,
         instance_count = excluded.instance_count,
         build_ids = excluded.build_ids,
         native_limitations = excluded.native_limitations`,
      [
        JSON.stringify(
          services.map((service) => ({
            tenant_id: service.tenantId,
            project_id: service.projectId,
            environment_id: service.environmentId,
            service_id: service.serviceId,
            last_seen: service.lastSeen,
            sdk: service.sdk ?? null,
            commit_sha: service.commitSha ?? null,
            commit_source: service.commitSource ?? null,
            capabilities: service.capabilities ?? [],
            agent_status: service.agentStatus ?? null,
            backend: service.backend ?? null,
            language: service.language ?? null,
            instance_count: service.instanceCount ?? null,
            build_ids: service.buildIds ?? null,
            native_limitations: service.nativeLimitations ?? null,
          })),
        ),
      ],
    );
  }

  private async insertProbes(
    client: PoolClient,
    probes: ReturnType<BrokerState["snapshot"]>["probes"],
  ): Promise<void> {
    if (probes.length === 0) return;
    await client.query(
      `insert into probes (
         tenant_id, project_id, environment_id, probe_id, service_id,
         definition, expires_at, expired
       )
       select tenant_id, project_id, environment_id, probe_id, service_id,
         definition, expires_at::timestamptz, expired
       from jsonb_to_recordset($1::jsonb) as probe(
         tenant_id text, project_id text, environment_id text, probe_id text,
         service_id text, definition jsonb, expires_at text, expired boolean
       )
       on conflict (probe_id) do update set
         tenant_id = excluded.tenant_id,
         project_id = excluded.project_id,
         environment_id = excluded.environment_id,
         service_id = excluded.service_id,
         definition = excluded.definition,
         expires_at = excluded.expires_at,
         expired = excluded.expired`,
      [
        JSON.stringify(
          probes.map((stored) => ({
            tenant_id: stored.scope.tenantId,
            project_id: stored.scope.projectId,
            environment_id: stored.scope.environmentId,
            probe_id: stored.probe.id,
            service_id: stored.probe.serviceId,
            definition: stored.probe,
            expires_at: new Date(stored.expiresAt).toISOString(),
            expired: stored.expired,
          })),
        ),
      ],
    );
  }

  private async insertEvents(
    client: PoolClient,
    events: ReturnType<BrokerState["snapshot"]>["events"],
  ): Promise<void> {
    const rows = events.flatMap((entry) =>
      entry.values.slice(-500).map((event, sequence) => ({
        tenant_id: entry.scope.tenantId,
        probe_id: entry.probeId,
        sequence,
        event_ts: event.ts,
        event,
      })),
    );
    if (rows.length === 0) return;
    await client.query(
      `insert into probe_events (
         tenant_id, probe_id, sequence, event_ts, event
       )
       select tenant_id, probe_id, sequence, event_ts::timestamptz, event
       from jsonb_to_recordset($1::jsonb) as probe_event(
         tenant_id text, probe_id text, sequence integer, event_ts text,
         event jsonb
       )
       on conflict (probe_id, sequence) do update set
         tenant_id = excluded.tenant_id,
         event_ts = excluded.event_ts,
         event = excluded.event`,
      [JSON.stringify(rows)],
    );
  }

  private async insertStatuses(
    client: PoolClient,
    statuses: ReturnType<BrokerState["snapshot"]>["statuses"],
  ): Promise<void> {
    if (statuses.length === 0) return;
    await client.query(
      `insert into probe_statuses (
         tenant_id, probe_id, status, updated_at, detail
       )
       select tenant_id, probe_id, status, updated_at::timestamptz, detail
       from jsonb_to_recordset($1::jsonb) as probe_status(
         tenant_id text, probe_id text, status text, updated_at text,
         detail text
       )
       on conflict (probe_id) do update set
         tenant_id = excluded.tenant_id,
         status = excluded.status,
         updated_at = excluded.updated_at,
         detail = excluded.detail
       where excluded.updated_at >= probe_statuses.updated_at`,
      [
        JSON.stringify(
          statuses.map((entry) => ({
            tenant_id: entry.scope.tenantId,
            probe_id: entry.probeId,
            status: entry.value.status,
            updated_at: entry.value.updatedAt,
            detail: entry.value.detail ?? null,
          })),
        ),
      ],
    );
  }

  private async insertVersions(
    client: PoolClient,
    versions: ReturnType<BrokerState["snapshot"]>["serviceVersions"],
  ): Promise<void> {
    if (versions.length === 0) return;
    await client.query(
      `insert into service_versions (
         tenant_id, project_id, environment_id, service_id, version
       )
       select tenant_id, project_id, environment_id, service_id, version
       from jsonb_to_recordset($1::jsonb) as service_version(
         tenant_id text, project_id text, environment_id text,
         service_id text, version integer
       )
       on conflict (
         tenant_id, project_id, environment_id, service_id
       ) do update set version = excluded.version`,
      [
        JSON.stringify(
          versions.map((entry) => ({
            tenant_id: entry.tenantId,
            project_id: entry.projectId,
            environment_id: entry.environmentId,
            service_id: entry.serviceId,
            version: entry.version,
          })),
        ),
      ],
    );
  }

  private async withTransaction<T>(
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    await this.ensureMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [1_276_638_214]);
      const result = await action(client);
      await client.query("commit");
      return result;
    } catch (error: unknown) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureMigrated(): Promise<void> {
    if (this.migrationPromise === undefined) {
      const migration = this.runMigration();
      this.migrationPromise = migration.catch((error: unknown) => {
        this.migrationPromise = undefined;
        throw error;
      });
    }
    await this.migrationPromise;
  }

  private async runMigration(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await this.migrate(client);
    } finally {
      client.release();
    }
  }

  private async migrate(client: PoolClient): Promise<void> {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock($1)", [
        1_276_638_214,
      ]);
      await client.query(POSTGRES_MIGRATION_SQL);
      await client.query(
        `insert into liveprobe_schema_migrations (version)
         values ($1) on conflict (version) do nothing`,
        [POSTGRES_SCHEMA_VERSION],
      );
      await client.query("commit");
    } catch (error: unknown) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  }
}
