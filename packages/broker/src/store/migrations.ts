export const POSTGRES_SCHEMA_VERSION = 9;

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

  alter table projects
    add column if not exists archived_at timestamptz;
  alter table environments
    add column if not exists archived_at timestamptz;

  create table if not exists registered_services (
    tenant_id text not null,
    project_id text not null,
    service_id text not null,
    display_name text not null,
    created_at timestamptz not null default now(),
    archived_at timestamptz,
    primary key (tenant_id, project_id, service_id),
    foreign key (tenant_id, project_id)
      references projects(tenant_id, project_id)
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
    service_id text not null,
    last_seen timestamptz not null,
    sdk text,
    commit_sha text,
    commit_source text,
    capabilities jsonb not null default '[]'::jsonb,
    agent_status jsonb,
    backend text,
    language text,
    instance_count integer,
    build_ids jsonb,
    native_limitations jsonb,
    primary key (tenant_id, project_id, environment_id, service_id)
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
    service_id text not null,
    version integer not null,
    primary key (tenant_id, project_id, environment_id, service_id)
  );

  create table if not exists source_map_sets (
    tenant_id text not null default '${DEFAULT_TENANT_ID}',
    project_id text not null default '${DEFAULT_PROJECT_ID}',
    environment_id text not null default '${DEFAULT_ENVIRONMENT_ID}',
    service_id text not null,
    commit_sha text not null,
    complete boolean not null default false,
    updated_at timestamptz not null,
    primary key (
      tenant_id, project_id, environment_id, service_id, commit_sha
    )
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
    primary key (
      tenant_id, project_id, environment_id, service_id, commit_sha, map_path
    ),
    foreign key (
      tenant_id, project_id, environment_id, service_id, commit_sha
    ) references source_map_sets(
      tenant_id, project_id, environment_id, service_id, commit_sha
    ) on delete cascade
  );

  create table if not exists service_credentials (
    credential_id text primary key,
    tenant_id text not null default '${DEFAULT_TENANT_ID}',
    project_id text not null default '${DEFAULT_PROJECT_ID}',
    environment_id text not null default '${DEFAULT_ENVIRONMENT_ID}',
    service_id text not null,
    label text not null,
    key_prefix text not null,
    secret_hash text not null unique,
    created_at timestamptz not null,
    last_used_at timestamptz,
    revoked_at timestamptz,
    constraint service_credentials_scope_fk
      foreign key (tenant_id, project_id, environment_id)
      references environments(tenant_id, project_id, environment_id)
  );

  create table if not exists audit_events (
    audit_id text primary key,
    tenant_id text not null,
    project_id text not null,
    environment_id text not null,
    occurred_at timestamptz not null,
    request_id text not null,
    actor_type text not null,
    actor_id text not null,
    actor_role text not null,
    action text not null,
    resource_type text not null,
    resource_id text,
    outcome text not null check (
      outcome in ('attempt', 'success', 'denied', 'error')
    ),
    status_code integer,
    error_code text,
    metadata jsonb not null default '{}'::jsonb,
    constraint audit_events_scope_fk
      foreign key (tenant_id, project_id, environment_id)
      references environments(tenant_id, project_id, environment_id)
  );

  create table if not exists native_credentials (
    tenant_id text not null,
    project_id text not null,
    environment_id text not null,
    credential_id text not null,
    agent_id text not null,
    allowed_service_ids jsonb not null,
    label text not null,
    key_prefix text not null,
    secret_hash text not null unique,
    created_at timestamptz not null,
    last_used_at timestamptz,
    revoked_at timestamptz,
    primary key (
      tenant_id, project_id, environment_id, credential_id
    ),
    foreign key (tenant_id, project_id, environment_id)
      references environments(tenant_id, project_id, environment_id)
  );

  create table if not exists native_assignment_versions (
    tenant_id text not null,
    project_id text not null,
    environment_id text not null,
    agent_id text not null,
    version bigint not null default 0 check (version >= 0),
    primary key (tenant_id, project_id, environment_id, agent_id),
    foreign key (tenant_id, project_id, environment_id)
      references environments(tenant_id, project_id, environment_id)
  );

  create table if not exists native_agents (
    tenant_id text not null,
    project_id text not null,
    environment_id text not null,
    agent_id text not null,
    hostname text not null,
    architecture text not null,
    capabilities jsonb not null,
    agent_version text not null,
    last_seen timestamptz not null,
    primary key (tenant_id, project_id, environment_id, agent_id),
    foreign key (tenant_id, project_id, environment_id)
      references environments(tenant_id, project_id, environment_id)
  );

  create table if not exists native_instances (
    tenant_id text not null,
    project_id text not null,
    environment_id text not null,
    agent_id text not null,
    instance_id text not null,
    service_id text not null,
    language text not null,
    pid bigint not null,
    process_start_time text not null,
    executable_path text not null,
    executable_device text,
    executable_inode text,
    build_id text not null,
    architecture text not null,
    capabilities jsonb not null,
    cgroup text,
    container_id text,
    last_seen timestamptz not null,
    primary key (
      tenant_id, project_id, environment_id, agent_id, instance_id
    ),
    foreign key (tenant_id, project_id, environment_id, agent_id)
      references native_agents(
        tenant_id, project_id, environment_id, agent_id
      ) on delete cascade
  );

  create table if not exists native_probe_statuses (
    tenant_id text not null,
    project_id text not null,
    environment_id text not null,
    probe_id text not null,
    probe_version integer not null,
    agent_id text not null,
    instance_id text not null,
    build_id text not null,
    status jsonb not null,
    primary key (
      tenant_id, project_id, environment_id, probe_id, probe_version,
      agent_id, instance_id, build_id
    )
  );

  create or replace function liveprobe_reject_audit_mutation()
  returns trigger language plpgsql as $audit_immutable$
  begin
    raise exception 'audit_events is append-only';
  end
  $audit_immutable$;

  do $audit_trigger$
  begin
    if not exists (
      select 1 from pg_trigger
      where tgname = 'audit_events_immutable'
        and tgrelid = 'audit_events'::regclass
    ) then
      create trigger audit_events_immutable
        before update or delete or truncate on audit_events
        for each statement execute function liveprobe_reject_audit_mutation();
    end if;
  end
  $audit_trigger$;

  alter table services
    add column if not exists tenant_id text not null default '${DEFAULT_TENANT_ID}',
    add column if not exists project_id text not null default '${DEFAULT_PROJECT_ID}',
    add column if not exists environment_id text not null default '${DEFAULT_ENVIRONMENT_ID}',
    add column if not exists capabilities jsonb not null default '[]'::jsonb,
    add column if not exists backend text,
    add column if not exists language text,
    add column if not exists instance_count integer,
    add column if not exists build_ids jsonb,
    add column if not exists native_limitations jsonb;
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

  do $tenant_keys$
  declare
    legacy_fk text;
  begin
    select constraint_name into legacy_fk
    from information_schema.referential_constraints
    where constraint_schema = current_schema()
      and unique_constraint_name = 'source_map_sets_pkey'
      and constraint_name in (
        select conname from pg_constraint
        where conrelid = 'source_maps'::regclass
          and contype = 'f'
          and position('tenant_id' in pg_get_constraintdef(oid)) = 0
      )
    limit 1;
    if legacy_fk is not null then
      execute format(
        'alter table source_maps drop constraint %I',
        legacy_fk
      );
    end if;

    if exists (
      select 1 from pg_constraint
      where conrelid = 'services'::regclass and contype = 'p'
        and position('tenant_id' in pg_get_constraintdef(oid)) = 0
    ) then
      alter table services drop constraint services_pkey;
      alter table services add primary key (
        tenant_id, project_id, environment_id, service_id
      );
    end if;
    if exists (
      select 1 from pg_constraint
      where conrelid = 'service_versions'::regclass and contype = 'p'
        and position('tenant_id' in pg_get_constraintdef(oid)) = 0
    ) then
      alter table service_versions drop constraint service_versions_pkey;
      alter table service_versions add primary key (
        tenant_id, project_id, environment_id, service_id
      );
    end if;
    if exists (
      select 1 from pg_constraint
      where conrelid = 'source_map_sets'::regclass and contype = 'p'
        and position('tenant_id' in pg_get_constraintdef(oid)) = 0
    ) then
      alter table source_map_sets drop constraint source_map_sets_pkey;
      alter table source_map_sets add primary key (
        tenant_id, project_id, environment_id, service_id, commit_sha
      );
    end if;
    if exists (
      select 1 from pg_constraint
      where conrelid = 'source_maps'::regclass and contype = 'p'
        and position('tenant_id' in pg_get_constraintdef(oid)) = 0
    ) then
      alter table source_maps drop constraint source_maps_pkey;
      alter table source_maps add primary key (
        tenant_id, project_id, environment_id, service_id, commit_sha,
        map_path
      );
    end if;
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'source_maps'::regclass and contype = 'f'
        and confrelid = 'source_map_sets'::regclass
        and position('tenant_id' in pg_get_constraintdef(oid)) > 0
    ) then
      alter table source_maps add constraint source_maps_scoped_set_fk
        foreign key (
          tenant_id, project_id, environment_id, service_id, commit_sha
        ) references source_map_sets (
          tenant_id, project_id, environment_id, service_id, commit_sha
        ) on delete cascade;
    end if;
  end
  $tenant_keys$;

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
  create index if not exists service_credentials_scope_idx
    on service_credentials (
      tenant_id, project_id, environment_id, service_id, created_at
    );
  create index if not exists audit_events_scope_time_idx
    on audit_events (
      tenant_id, project_id, environment_id, occurred_at desc, audit_id desc
    );
  create index if not exists registered_services_scope_idx
    on registered_services (tenant_id, project_id, service_id);

  insert into registered_services (
    tenant_id, project_id, service_id, display_name, created_at
  )
  select discovered.tenant_id, discovered.project_id, discovered.service_id,
    discovered.service_id, min(discovered.discovered_at)
  from (
    select tenant_id, project_id, service_id,
      last_seen as discovered_at
    from services
    union all
    select tenant_id, project_id, service_id,
      created_at as discovered_at
    from service_credentials
  ) discovered
  group by discovered.tenant_id, discovered.project_id, discovered.service_id
  on conflict (tenant_id, project_id, service_id) do nothing;

  create index if not exists native_credentials_scope_idx
    on native_credentials (
      tenant_id, project_id, environment_id, agent_id, created_at
    );
  create index if not exists native_instances_service_idx
    on native_instances (
      tenant_id, project_id, environment_id, service_id, build_id
    );
  create unique index if not exists native_instances_scope_instance_uidx
    on native_instances (
      tenant_id, project_id, environment_id, instance_id
    );
  create index if not exists native_status_instance_idx
    on native_probe_statuses (
      tenant_id, project_id, environment_id, agent_id, instance_id, build_id
    );
`;
