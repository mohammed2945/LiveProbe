import { Pool, type PoolClient, type QueryResultRow } from "pg";

import type { BrokerState, IngestInput } from "../index.js";
import {
  POSTGRES_MIGRATION_SQL,
  POSTGRES_SCHEMA_VERSION,
} from "./migrations.js";

interface ServiceRow extends QueryResultRow {
  service_id: string;
  last_seen: Date;
  sdk: "node" | "python" | "jvm" | null;
  commit_sha: string | null;
  commit_source: "env" | "config" | null;
  agent_status: unknown | null;
}

interface ProbeRow extends QueryResultRow {
  definition: unknown;
  expires_at: Date;
  expired: boolean;
}

interface VersionRow extends QueryResultRow {
  service_id: string;
  version: number;
}

interface EventRow extends QueryResultRow {
  probe_id: string;
  event: unknown;
}

interface StatusRow extends QueryResultRow {
  probe_id: string;
  status: string;
  updated_at: Date;
  detail: string | null;
}

interface SourceMapSetRow extends QueryResultRow {
  service_id: string;
  commit_sha: string;
  complete: boolean;
  updated_at: Date;
}

interface SourceMapRow extends QueryResultRow {
  service_id: string;
  commit_sha: string;
  map_path: string;
  source_map: Record<string, unknown>;
  uploaded_at: Date;
}

export interface PostgresStoreOptions {
  maxConnections?: number;
}

export class PostgresStore {
  public readonly incremental = true;
  private readonly pool: Pool;
  private migrationPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

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

  public async restore(state: BrokerState): Promise<void> {
    await this.ensureMigrated();
    const client = await this.pool.connect();
    let restoredLegacySnapshot = false;
    try {
      const services = await client.query<ServiceRow>(
        `select service_id, last_seen, sdk, commit_sha, commit_source, agent_status
         from services order by service_id`,
      );
      const probes = await client.query<ProbeRow>(
        `select definition, expires_at, expired
         from probes order by probe_id`,
      );
      const versions = await client.query<VersionRow>(
        `select service_id, version
         from service_versions order by service_id`,
      );
      const events = await client.query<EventRow>(
        `select probe_id, event
         from probe_events order by probe_id, sequence`,
      );
      const statuses = await client.query<StatusRow>(
        `select probe_id, status, updated_at, detail
         from probe_statuses order by probe_id`,
      );
      const sourceMapSets = await client.query<SourceMapSetRow>(
        `select service_id, commit_sha, complete, updated_at
         from source_map_sets order by service_id, commit_sha`,
      );
      const sourceMaps = await client.query<SourceMapRow>(
        `select service_id, commit_sha, map_path, source_map, uploaded_at
         from source_maps order by service_id, commit_sha, map_path`,
      );

      const hasNormalizedState =
        services.rowCount !== 0 ||
        probes.rowCount !== 0 ||
        versions.rowCount !== 0;
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

      const mapsBySet = new Map<string, SourceMapRow[]>();
      for (const row of sourceMaps.rows) {
        const key = `${row.service_id}\u0000${row.commit_sha}`;
        const maps = mapsBySet.get(key) ?? [];
        maps.push(row);
        mapsBySet.set(key, maps);
      }

      state.loadSnapshot({
        formatVersion: 1,
        savedAt: new Date().toISOString(),
        probes: probes.rows.map((row) => ({
          probe: row.definition,
          expiresAt: row.expires_at.getTime(),
          expired: row.expired,
        })),
        serviceVersions: versions.rows.map((row) => [
          row.service_id,
          row.version,
        ]),
        events: probes.rows.map((row) => {
          const definition = row.definition as { id?: unknown };
          return {
            probeId: definition.id,
            values:
              typeof definition.id === "string"
                ? (eventsByProbe.get(definition.id) ?? [])
                : [],
          };
        }),
        services: services.rows.map((row) => ({
          serviceId: row.service_id,
          lastSeen: row.last_seen.toISOString(),
          ...(row.sdk === null ? {} : { sdk: row.sdk }),
          ...(row.commit_sha === null
            ? {}
            : { commitSha: row.commit_sha }),
          ...(row.commit_source === null
            ? {}
            : { commitSource: row.commit_source }),
          ...(row.agent_status === null
            ? {}
            : { agentStatus: row.agent_status }),
        })),
        statuses: statuses.rows.map((row) => [
          row.probe_id,
          {
            status: row.status,
            updatedAt: row.updated_at.toISOString(),
            ...(row.detail === null ? {} : { detail: row.detail }),
          },
        ]),
        sourceMapSets: sourceMapSets.rows.map((row) => ({
          serviceId: row.service_id,
          commitSha: row.commit_sha,
          complete: row.complete,
          updatedAt: row.updated_at.toISOString(),
          maps: (mapsBySet.get(`${row.service_id}\u0000${row.commit_sha}`) ?? [])
            .map((map) => ({
              mapPath: map.map_path,
              map: map.source_map,
              uploadedAt: map.uploaded_at.toISOString(),
            })),
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
      await client.query("commit");
    } catch (error: unknown) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async persistProbe(state: BrokerState, probeId: string): Promise<void> {
    const snapshot = state.snapshot();
    const probes = snapshot.probes.filter(({ probe }) => probe.id === probeId);
    if (probes.length === 0) return;
    const serviceId = probes[0]?.probe.serviceId;
    const versions = snapshot.serviceVersions.filter(
      ([candidate]) => candidate === serviceId,
    );
    await this.withTransaction(async (client) => {
      await this.insertProbes(client, probes);
      await this.insertVersions(client, versions);
    });
  }

  public async deleteProbe(state: BrokerState, probeId: string): Promise<void> {
    const snapshot = state.snapshot();
    await this.withTransaction(async (client) => {
      await client.query("delete from probes where probe_id = $1", [probeId]);
      await this.insertVersions(client, snapshot.serviceVersions);
    });
  }

  public async persistIngest(
    state: BrokerState,
    input: IngestInput,
  ): Promise<void> {
    const snapshot = state.snapshot();
    const services = snapshot.services.filter(
      ({ serviceId }) => serviceId === input.serviceId,
    );
    const probeIds = [...new Set(input.events.map(({ probeId }) => probeId))];
    const events = snapshot.events.filter(({ probeId }) =>
      probeIds.includes(probeId),
    );
    const statuses = snapshot.statuses.filter(([probeId]) =>
      probeIds.includes(probeId),
    );
    await this.withTransaction(async (client) => {
      await this.insertServices(client, services);
      if (probeIds.length > 0) {
        await client.query("delete from probe_events where probe_id = any($1::text[])", [
          probeIds,
        ]);
      }
      await this.insertEvents(client, events);
      await this.insertStatuses(client, statuses);
    });
  }

  public async persistSourceMapSet(
    state: BrokerState,
    serviceId: string,
    commitSha: string,
  ): Promise<void> {
    const set = state.getSourceMapSet(serviceId, commitSha);
    if (set === undefined) return;
    await this.ensureMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [1_276_638_214]);
      await client.query(
        `insert into source_map_sets (
           service_id, commit_sha, complete, updated_at
         ) values ($1, $2, $3, $4::timestamptz)
         on conflict (service_id, commit_sha) do update set
           complete = excluded.complete,
           updated_at = excluded.updated_at`,
        [set.serviceId, set.commitSha, set.complete, set.updatedAt],
      );
      await client.query(
        `delete from source_maps where service_id = $1 and commit_sha = $2`,
        [set.serviceId, set.commitSha],
      );
      if (set.maps.length > 0) {
        await client.query(
          `insert into source_maps (
             service_id, commit_sha, map_path, source_map, uploaded_at
           )
           select service_id, commit_sha, map_path, source_map,
             uploaded_at::timestamptz
           from jsonb_to_recordset($1::jsonb) as source_map(
             service_id text, commit_sha text, map_path text,
             source_map jsonb, uploaded_at text
           )`,
          [
            JSON.stringify(
              set.maps.map((map) => ({
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
        .sourceMapSets.filter((candidate) => candidate.serviceId === serviceId)
        .map((candidate) => candidate.commitSha);
      await client.query(
        `delete from source_map_sets
         where service_id = $1 and not (commit_sha = any($2::text[]))`,
        [serviceId, retainedCommits],
      );
      await client.query("commit");
    } catch (error: unknown) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public close(): Promise<void> {
    this.closePromise ??= this.pool.end();
    return this.closePromise;
  }

  private async insertServices(
    client: PoolClient,
    services: ReturnType<BrokerState["snapshot"]>["services"],
  ): Promise<void> {
    if (services.length === 0) return;
    await client.query(
      `insert into services (
         service_id, last_seen, sdk, commit_sha, commit_source, agent_status
       )
       select service_id, last_seen::timestamptz, sdk, commit_sha,
         commit_source, agent_status
       from jsonb_to_recordset($1::jsonb) as service(
         service_id text, last_seen text, sdk text, commit_sha text,
         commit_source text, agent_status jsonb
       )
       on conflict (service_id) do update set
         last_seen = excluded.last_seen,
         sdk = excluded.sdk,
         commit_sha = excluded.commit_sha,
         commit_source = excluded.commit_source,
         agent_status = excluded.agent_status`,
      [
        JSON.stringify(
          services.map((service) => ({
            service_id: service.serviceId,
            last_seen: service.lastSeen,
            sdk: service.sdk ?? null,
            commit_sha: service.commitSha ?? null,
            commit_source: service.commitSource ?? null,
            agent_status: service.agentStatus ?? null,
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
         probe_id, service_id, definition, expires_at, expired
       )
       select probe_id, service_id, definition, expires_at::timestamptz,
         expired
       from jsonb_to_recordset($1::jsonb) as probe(
         probe_id text, service_id text, definition jsonb,
         expires_at text, expired boolean
       )
       on conflict (probe_id) do update set
         service_id = excluded.service_id,
         definition = excluded.definition,
         expires_at = excluded.expires_at,
         expired = excluded.expired`,
      [
        JSON.stringify(
          probes.map((stored) => ({
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
        probe_id: entry.probeId,
        sequence,
        event_ts: event.ts,
        event,
      })),
    );
    if (rows.length === 0) return;
    await client.query(
      `insert into probe_events (probe_id, sequence, event_ts, event)
       select probe_id, sequence, event_ts::timestamptz, event
       from jsonb_to_recordset($1::jsonb) as probe_event(
         probe_id text, sequence integer, event_ts text, event jsonb
       )
       on conflict (probe_id, sequence) do update set
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
         probe_id, status, updated_at, detail
       )
       select probe_id, status, updated_at::timestamptz, detail
       from jsonb_to_recordset($1::jsonb) as probe_status(
         probe_id text, status text, updated_at text, detail text
       )
       on conflict (probe_id) do update set
         status = excluded.status,
         updated_at = excluded.updated_at,
         detail = excluded.detail`,
      [
        JSON.stringify(
          statuses.map(([probeId, status]) => ({
            probe_id: probeId,
            status: status.status,
            updated_at: status.updatedAt,
            detail: status.detail ?? null,
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
      `insert into service_versions (service_id, version)
       select service_id, version
       from jsonb_to_recordset($1::jsonb) as service_version(
         service_id text, version integer
       )
       on conflict (service_id) do update set version = excluded.version`,
      [
        JSON.stringify(
          versions.map(([serviceId, version]) => ({
            service_id: serviceId,
            version,
          })),
        ),
      ],
    );
  }

  private async withTransaction(
    action: (client: PoolClient) => Promise<void>,
  ): Promise<void> {
    await this.ensureMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [1_276_638_214]);
      await action(client);
      await client.query("commit");
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
