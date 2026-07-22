export const POSTGRES_SCHEMA_VERSION = 3;

export const DEFAULT_TENANT_ID = "internal";
export const DEFAULT_PROJECT_ID = "default";
export const DEFAULT_ENVIRONMENT_ID = "default";

export const POSTGRES_MIGRATION_SQL = `
  create table if not exists liveprobe_schema_migrations (
    version integer primary key,
    applied_at timestamptz not null default now()
  );

  create table if not exists tenants (
    tenant_id text primary key,
    display_name text not null,
    created_at timestamptz not null default now()
  );

  create table if not exists projects (
    tenant_id text not null references tenants(tenant_id) on delete cascade,
    project_id text not null,
    display_name text not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, project_id)
  );

  create table if not exists environments (
    tenant_id text not null,
    project_id text not null,
    environment_id text not null,
    display_name text not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, project_id, environment_id),
    foreign key (tenant_id, project_id)
      references projects(tenant_id, project_id) on delete cascade
  );

  insert into tenants (tenant_id, display_name)
  values ('${DEFAULT_TENANT_ID}', 'Internal')
  on conflict (tenant_id) do nothing;

  insert into projects (tenant_id, project_id, display_name)
  values ('${DEFAULT_TENANT_ID}', '${DEFAULT_PROJECT_ID}', 'Default')
  on conflict (tenant_id, project_id) do nothing;

  insert into environments (
    tenant_id, project_id, environment_id, display_name
  ) values (
    '${DEFAULT_TENANT_ID}', '${DEFAULT_PROJECT_ID}',
    '${DEFAULT_ENVIRONMENT_ID}', 'Default'
  ) on conflict (tenant_id, project_id, environment_id) do nothing;

  create table if not exists services (
    tenant_id text not null default '${DEFAULT_TENANT_ID}',
    project_id text not null default '${DEFAULT_PROJECT_ID}',
    environment_id text not null default '${DEFAULT_ENVIRONMENT_ID}',
    service_id text primary key,
    last_seen timestamptz not null,
    sdk text,
    commit_sha text,
    commit_source text,
    agent_status jsonb
  );

  create table if not exists probes (
    tenant_id text not null default '${DEFAULT_TENANT_ID}',
    project_id text not null default '${DEFAULT_PROJECT_ID}',
    environment_id text not null default '${DEFAULT_ENVIRONMENT_ID}',
    probe_id text primary key,
    service_id text not null,
    definition jsonb not null,
    expires_at timestamptz not null,
    expired boolean not null default false
  );
  create index if not exists probes_service_id_idx on probes (service_id);

  create table if not exists probe_events (
    tenant_id text not null default '${DEFAULT_TENANT_ID}',
    probe_id text not null references probes(probe_id) on delete cascade,
    sequence integer not null,
    event_ts timestamptz not null,
    event jsonb not null,
    primary key (probe_id, sequence)
  );

  create table if not exists probe_statuses (
    tenant_id text not null default '${DEFAULT_TENANT_ID}',
    probe_id text primary key references probes(probe_id) on delete cascade,
    status text not null,
    updated_at timestamptz not null,
    detail text
  );

  create table if not exists service_versions (
    tenant_id text not null default '${DEFAULT_TENANT_ID}',
    project_id text not null default '${DEFAULT_PROJECT_ID}',
    environment_id text not null default '${DEFAULT_ENVIRONMENT_ID}',
    service_id text primary key,
    version integer not null
  );

  create table if not exists source_map_sets (
    tenant_id text not null default '${DEFAULT_TENANT_ID}',
    project_id text not null default '${DEFAULT_PROJECT_ID}',
    environment_id text not null default '${DEFAULT_ENVIRONMENT_ID}',
    service_id text not null,
    commit_sha text not null,
    complete boolean not null default false,
    updated_at timestamptz not null,
    primary key (service_id, commit_sha)
  );

  create table if not exists source_maps (
    tenant_id text not null default '${DEFAULT_TENANT_ID}',
    project_id text not null default '${DEFAULT_PROJECT_ID}',
    environment_id text not null default '${DEFAULT_ENVIRONMENT_ID}',
    service_id text not null,
    commit_sha text not null,
    map_path text not null,
    source_map jsonb not null,
    uploaded_at timestamptz not null,
    primary key (service_id, commit_sha, map_path),
    foreign key (service_id, commit_sha)
      references source_map_sets(service_id, commit_sha) on delete cascade
  );

  alter table services
    add column if not exists tenant_id text not null default '${DEFAULT_TENANT_ID}',
    add column if not exists project_id text not null default '${DEFAULT_PROJECT_ID}',
    add column if not exists environment_id text not null default '${DEFAULT_ENVIRONMENT_ID}';
  alter table probes
    add column if not exists tenant_id text not null default '${DEFAULT_TENANT_ID}',
    add column if not exists project_id text not null default '${DEFAULT_PROJECT_ID}',
    add column if not exists environment_id text not null default '${DEFAULT_ENVIRONMENT_ID}';
  alter table probe_events
    add column if not exists tenant_id text not null default '${DEFAULT_TENANT_ID}';
  alter table probe_statuses
    add column if not exists tenant_id text not null default '${DEFAULT_TENANT_ID}';
  alter table service_versions
    add column if not exists tenant_id text not null default '${DEFAULT_TENANT_ID}',
    add column if not exists project_id text not null default '${DEFAULT_PROJECT_ID}',
    add column if not exists environment_id text not null default '${DEFAULT_ENVIRONMENT_ID}';
  alter table source_map_sets
    add column if not exists tenant_id text not null default '${DEFAULT_TENANT_ID}',
    add column if not exists project_id text not null default '${DEFAULT_PROJECT_ID}',
    add column if not exists environment_id text not null default '${DEFAULT_ENVIRONMENT_ID}';
  alter table source_maps
    add column if not exists tenant_id text not null default '${DEFAULT_TENANT_ID}',
    add column if not exists project_id text not null default '${DEFAULT_PROJECT_ID}',
    add column if not exists environment_id text not null default '${DEFAULT_ENVIRONMENT_ID}';

  do $migration$
  begin
    if not exists (
      select 1 from pg_constraint where conname = 'services_scope_fk'
    ) then
      alter table services add constraint services_scope_fk
        foreign key (tenant_id, project_id, environment_id)
        references environments(tenant_id, project_id, environment_id);
    end if;
    if not exists (
      select 1 from pg_constraint where conname = 'probes_scope_fk'
    ) then
      alter table probes add constraint probes_scope_fk
        foreign key (tenant_id, project_id, environment_id)
        references environments(tenant_id, project_id, environment_id);
    end if;
    if not exists (
      select 1 from pg_constraint where conname = 'probe_events_tenant_fk'
    ) then
      alter table probe_events add constraint probe_events_tenant_fk
        foreign key (tenant_id) references tenants(tenant_id);
    end if;
    if not exists (
      select 1 from pg_constraint where conname = 'probe_statuses_tenant_fk'
    ) then
      alter table probe_statuses add constraint probe_statuses_tenant_fk
        foreign key (tenant_id) references tenants(tenant_id);
    end if;
    if not exists (
      select 1 from pg_constraint where conname = 'service_versions_scope_fk'
    ) then
      alter table service_versions add constraint service_versions_scope_fk
        foreign key (tenant_id, project_id, environment_id)
        references environments(tenant_id, project_id, environment_id);
    end if;
    if not exists (
      select 1 from pg_constraint where conname = 'source_map_sets_scope_fk'
    ) then
      alter table source_map_sets add constraint source_map_sets_scope_fk
        foreign key (tenant_id, project_id, environment_id)
        references environments(tenant_id, project_id, environment_id);
    end if;
    if not exists (
      select 1 from pg_constraint where conname = 'source_maps_scope_fk'
    ) then
      alter table source_maps add constraint source_maps_scope_fk
        foreign key (tenant_id, project_id, environment_id)
        references environments(tenant_id, project_id, environment_id);
    end if;
  end
  $migration$;

  create index if not exists services_scope_idx
    on services (tenant_id, project_id, environment_id, service_id);
  create index if not exists probes_scope_idx
    on probes (tenant_id, project_id, environment_id, service_id);
  create index if not exists probe_events_tenant_idx
    on probe_events (tenant_id, probe_id);
  create index if not exists probe_statuses_tenant_idx
    on probe_statuses (tenant_id, probe_id);
  create index if not exists service_versions_scope_idx
    on service_versions (tenant_id, project_id, environment_id, service_id);
  create index if not exists source_map_sets_scope_idx
    on source_map_sets (
      tenant_id, project_id, environment_id, service_id, commit_sha
    );
  create index if not exists source_maps_scope_idx
    on source_maps (
      tenant_id, project_id, environment_id, service_id, commit_sha
    );
`;
