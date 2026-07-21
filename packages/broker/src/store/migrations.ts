export const POSTGRES_SCHEMA_VERSION = 2;

export const POSTGRES_MIGRATION_SQL = `
  create table if not exists liveprobe_schema_migrations (
    version integer primary key,
    applied_at timestamptz not null default now()
  );

  create table if not exists services (
    service_id text primary key,
    last_seen timestamptz not null,
    sdk text,
    commit_sha text,
    commit_source text,
    agent_status jsonb
  );

  create table if not exists probes (
    probe_id text primary key,
    service_id text not null,
    definition jsonb not null,
    expires_at timestamptz not null,
    expired boolean not null default false
  );
  create index if not exists probes_service_id_idx on probes (service_id);

  create table if not exists probe_events (
    probe_id text not null references probes(probe_id) on delete cascade,
    sequence integer not null,
    event_ts timestamptz not null,
    event jsonb not null,
    primary key (probe_id, sequence)
  );

  create table if not exists probe_statuses (
    probe_id text primary key references probes(probe_id) on delete cascade,
    status text not null,
    updated_at timestamptz not null,
    detail text
  );

  create table if not exists service_versions (
    service_id text primary key,
    version integer not null
  );

  create table if not exists source_map_sets (
    service_id text not null,
    commit_sha text not null,
    complete boolean not null default false,
    updated_at timestamptz not null,
    primary key (service_id, commit_sha)
  );

  create table if not exists source_maps (
    service_id text not null,
    commit_sha text not null,
    map_path text not null,
    source_map jsonb not null,
    uploaded_at timestamptz not null,
    primary key (service_id, commit_sha, map_path),
    foreign key (service_id, commit_sha)
      references source_map_sets(service_id, commit_sha) on delete cascade
  );
`;
