# LiveProbe Protocol v1

This document is the canonical contract between the broker, MCP server, and
runtime agents. Implementations must conform to this document rather than infer
behavior from another implementation.

## 1. Invariants

1. Runtime agents are read-only. They must not evaluate source text, mutate
   target state, or invoke target-process methods while capturing data.
   Portable broker-compiled ASTs may be evaluated only over already captured
   values.
2. Redaction and structural limits are applied while traversing raw values.
   Only a `SanitizedSnapshot` may cross a process or network boundary.
3. Rate limits are checked before capture work.
4. Agents communicate only with the configured broker URL.
5. Agents refuse to start unless a concrete deployed commit SHA is supplied by
   config or environment.

## 2. Common conventions

- HTTP payloads are UTF-8 JSON with `Content-Type: application/json`.
- JSON field names use `camelCase`.
- Timestamps are RFC 3339 UTC strings, for example
  `2026-07-19T18:30:00.123Z`.
- Source lines are one-based positive integers.
- Runtime columns are zero-based non-negative integers, matching V8 Inspector.
- Probe IDs are broker-assigned ULIDs prefixed with `prb_`.
- `serviceId` is a non-empty, deployment-stable identifier supplied by the
  user.
- All `/v1/*` routes use `Authorization: Bearer <credential>`. Shared keys are
  break-glass admins in the `internal/default/default` scope. Verified Clerk
  tokens are checked against current Organization membership. During the
  pilot, every supported Organization role has the same human control-plane
  permissions. Historical `admin`, `operator`, and `viewer` values remain in
  the protocol for migration and audit compatibility but are not separate
  authorization levels. Unknown roles and removed memberships receive HTTP
  403. Clerk sessions without an active Organization return HTTP 403
  `organization_required`; pending enrollment returns HTTP 403
  `clerk_session_pending`. Per-service keys begin with `lp_service_` and can
  access only
  `GET /v1/ping` plus agent poll, ingest, and source-map routes for their exact
  `serviceId`. Human credentials cannot call agent routes. A service key
  receives HTTP 403 `forbidden` when it attempts a human route or names another
  service. `GET /healthz` is unauthenticated
  process liveness. `GET /readyz` is also unauthenticated and returns 200 only
  when the configured durable store is reachable. Neither endpoint exposes
  configuration or secrets. Invalid, revoked, or missing credentials return
  HTTP 401:

- Authenticated requests may select a resource scope with
  `LiveProbe-Project: <project-id>` and
  `LiveProbe-Environment: <environment-id>`. Missing headers select the
  principal's default scope for backward compatibility. Human principals may
  select any active environment in their tenant. Service credentials are
  issued for one tenant/project/environment and receive HTTP 403
  `scope_mismatch` if either header names another scope. Probe definitions,
  service heartbeats, source maps, captured events, safety state, and audit
  events are partitioned by the resolved scope.

```json
{
  "error": {
    "code": "unauthorized",
    "message": "missing or invalid Authorization bearer token"
  }
}
```

Native host-agent keys begin with `lp_native_` and bind an exact `agentId`, an
explicit service allowlist, and one tenant/project/environment scope. They can
call only `/v1/native/*`. Every route agent ID and reconciled or ingested
service must match that credential. Human and managed-service credentials
cannot call native runtime routes, and native credentials cannot call the
human control plane, MCP, or managed-runtime routes.

The canonical machine-readable schemas are in `packages/protocol`. Requests
are strict. Responses may add fields only where forward compatibility is
documented. Rust serde structures are checked against the shared JSON fixtures
in `packages/protocol/test/fixtures`.

Human permissions are:

| Role | Read diagnostics | Create/delete probes | Manage service credentials | Read audit events |
| --- | --- | --- | --- | --- |
| `admin` | yes | yes | yes | yes |
| `operator` | yes | yes | no | no |
| `viewer` | yes | no | no | no |
| `agent` | no | no | no | no |

Service credentials are random bearer secrets stored in PostgreSQL as SHA-256
hashes. The plaintext value is returned only by the create operation. Their
high entropy, rather than password hashing cost, protects against offline
guessing. Operators must transmit and store the returned value as a secret.

- Consumers must ignore unknown response fields. Producers must not emit
  undocumented fields in v1 requests.
- Errors use this envelope:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "line must be a positive integer"
  }
}
```

## 3. Probe definitions

A complete `ProbeDefinition` has this shape:

```json
{
  "id": "prb_01HZX3Y2M7QK6N4W5P8S9T0ABC",
  "serviceId": "payment-service",
  "sourceCommit": "4f3c2a1d9e8b7c6a5f4e3d2c1b0a9876543210ab",
  "type": "snapshot",
  "file": "src/payments.js",
  "line": 34,
  "condition": {
    "path": "user.tier",
    "op": "eq",
    "value": "free"
  },
  "watchPaths": [
    "user.tier",
    "db.pool.active"
  ],
  "hitLimit": 1,
  "ttlSeconds": 1800,
  "version": 42,
  "createdBy": "mcp:claude-code"
}
```

Required common fields:

- `id`: broker-assigned probe ID.
- `serviceId`: target service.
- `type`: `snapshot`, `log`, `counter`, or `metric`.
- `file`: non-empty path suffix. Agents match it against known source or script
  paths by suffix; they do not construct source URLs.
- `line`: one-based positive integer.
- `hitLimit`: positive integer.
- `ttlSeconds`: positive integer; the default is `1800`.
- `version`: positive per-service broker version.
- `createdBy`: non-empty audit identity.

Optional common fields:

- `condition`: a pure post-capture comparison with `path`, `op`, and `value`.
  `op` is one of `eq`, `ne`, `gt`, `gte`, `lt`, or `lte`. `value` is a JSON
  scalar.
- `sourceCommit`: the user-supplied commit SHA believed to identify the
  deployed source, retained as probe audit metadata. It is a lowercase
  hexadecimal Git object ID of 7 to 64 characters. It is not runtime proof or
  runtime verification of the code deployed by the target service.
- `runtimeLocation`, `runtimeLine`, and `runtimeColumn`: an optional complete
  trio added only to agent poll responses after broker-side source-map
  resolution. Operators continue to create and read probes using `file` and
  `line`; runtime coordinates identify the generated JavaScript location used
  by V8.

Agents report additive protocol support in the `capabilities` array on every
ingest heartbeat. Current capability identifiers are `log-levels-v1`,
`expression-ast-v1`, `frame-locals-v1`, and `safety-report-v1`. An omitted
array means a legacy agent with no advanced capabilities. The broker rejects
probes that require a capability the service has not reported instead of
silently degrading them.
Each running agent process also reports a stable-for-process `agentId`. For a
service with multiple active replicas, the broker exposes only the intersection
of capabilities reported within the 45-second activity window. Capability
claims are intentionally cleared after broker restore until agents heartbeat
again.

Type-specific fields:

- `snapshot`: optional `watchPaths`, optional compiled `watchExpressions`,
  `includeStackLocals` (default `false`), and `stackFrameLimit` (default `3`,
  maximum `8`).
- `log`: required `template`, containing zero or more `${dot.path}` or safe
  `${expression}` interpolations, plus `logLevel` (`debug`, `info`, `warn`, or
  `error`). `logLevel` defaults to `info` when omitted. Advanced templates
  include broker-generated `templateSegments`.
- `counter`: no additional fields.
- `metric`: exactly one of `metricPath` or compiled `metricExpression`,
  resolving to a finite number.

Type-specific default hit limits are `1` for snapshot, `100` for log, and
`10000` for counter and metric probes.

`POST /v1/probes` accepts the same object without `id` and `version`.
`hitLimit` and `ttlSeconds` may also be omitted and receive their defaults.
`sourceCommit` remains optional for direct HTTP clients. When supplied, the
broker validates it, normalizes it to lowercase, and retains it in the probe
definition, persistence snapshots, and probe list/data responses.

### 3.1 Dot paths and conditions

A dot path is a non-empty sequence of non-empty property segments separated by
`.`. Array indices are decimal segments. Missing segments do not throw.
Implementations resolve paths using data already captured with read-only field
or dictionary access; they never evaluate the path as source code.

`eq` and `ne` use strict JSON-scalar equality without coercion. Ordering
operators accept finite numbers only. A missing path or invalid operand makes
the condition false, including for `ne`.

Conditions are evaluated after capture. A false condition emits no probe data
event, but the hit still counts toward safety rate limits.

### 3.2 Safe expressions

Advanced probes may use broker-compiled expressions:

- `conditionExpression` on every probe type.
- `watchExpressions` on snapshots.
- `templateSegments` on logs, compiled from `${expression}` placeholders.
- `metricExpression` instead of `metricPath` on metrics.

A compiled expression contains the audited `source` string and a portable
`ast`. Supported AST nodes are JSON scalar literals, fixed reference paths,
unary `not`/`negate`, and bounded binary arithmetic, comparison, equality, and
boolean operators. References use fixed string or non-negative integer path
segments.

The grammar intentionally excludes calls, assignment, constructors, imports,
reflection, optional chaining, dynamic property expressions, and prototype
segments. The broker caps source length, AST depth, node count, and path depth.
Agents evaluate only the broker AST over already captured values using own
data properties or runtime-equivalent field access. They never pass expression
source to `eval` or a target-language interpreter.

Every reference applies the runtime's configured key and exact-value redaction
policy before returning a value. A redacted reference is an evaluation error,
so it cannot affect a condition or metric and cannot appear in a watch or log.

Types are strict and never coerced. Boolean operators require booleans,
ordering and numeric arithmetic require finite IEEE-754 values, and `add`
accepts two finite numbers or two strings. Integer inputs and integer-valued
results must remain within JavaScript's safe integer range
`[-9007199254740991, 9007199254740991]`; this gives Node, Python, and JVM the
same numeric domain. Missing values, unsafe integers, invalid types, division
by zero, and non-finite results are structured evaluation errors. Such errors
make a condition false, mark a watch unavailable, render an explicit log
placeholder, or reject a metric sample without escaping into the host
application.

### 3.3 Per-frame locals

Snapshot definitions accept `includeStackLocals` (default `false`) and
`stackFrameLimit` (default `3`, maximum `8`). When enabled, each retained stack
entry may include a `variables` serialized tree for that frame. Frame variables
use the same in-process redaction, depth, property, array, string, frame-count,
queue, and bandwidth boundaries as current-frame variables. Agents that do not
report `frame-locals-v1` cannot receive these probes.

## 4. Agent-facing broker API

Agents short-poll once per second.

### 4.1 Poll probes

`GET /v1/services/{serviceId}/probes?since={version}&commitSha={commitSha}`

When the service's current version is newer than `since`:

```json
{
  "version": 42,
  "probes": []
}
```

When the caller is current:

```json
{
  "version": 42,
  "unchanged": true
}
```

Both forms return HTTP 200. The `probes` form contains every currently active,
non-expired probe for that service, not a delta. A missing `since` is treated as
`0`.

Node agents include their deployed `commitSha`. When a complete source-map set
exists for that service and commit, each resolvable probe includes
`runtimeLocation`, `runtimeLine`, and `runtimeColumn`. Unmapped probes retain
only their source coordinates so the agent can apply normal runtime-path suffix
matching for untranspiled JavaScript.

The broker owns TTL enforcement. Creating, deleting, or expiring a probe
increments that service's monotonically increasing `version`. Completing a new
source-map set also increments the version so connected agents repoll resolved
coordinates.

### 4.2 Source-map handshake

Node agents coordinate one uploader per `serviceId` and `commitSha`:

- `POST /v1/source-maps/status` accepts `serviceId`, `commitSha`, and a unique
  per-process `uploaderId`. It returns `isUploader` and `isComplete`.
- `POST /v1/source-maps/upload` accepts that identity plus a logical
  `mapPath` ending in `.js.map` and a Source Map v3 JSON object. It returns HTTP
  202.
- `POST /v1/source-maps/complete` marks the set complete and returns HTTP 202.

Only the active uploader lease may upload or complete a set. Uploads are keyed
durably by service and commit. Agents remove every `sourcesContent` property
before transmission, and the broker repeats that removal defensively before
persistence. The broker decodes mappings and converts source file/line
coordinates into generated file/line/column coordinates; agents do not decode
maps locally.

### 4.3 Ingest events and status

`POST /v1/ingest`

```json
{
  "serviceId": "payment-service",
  "sdk": "node",
  "agentId": "9d33bcb7-83f8-4f70-929d-85d1e8432afe",
  "commitSha": "4f3c2a1d9e8b7c6a5f4e3d2c1b0a9876543210ab",
  "commitSource": "env",
  "capabilities": [
    "log-levels-v1",
    "expression-ast-v1",
    "frame-locals-v1",
    "safety-report-v1"
  ],
  "agentStatus": {
    "state": "red",
    "reasonCode": "event_loop_lag",
    "detail": "event-loop p95 exceeded 50ms",
    "limits": {
      "maxProbeHitsPerSecond": 10,
      "safetyCooldownMs": 10000,
      "maxTelemetryBytesPerSecond": 204800,
      "maxBufferedEventBytes": 1024000,
      "maxEventLoopLagMs": 50
    }
  },
  "events": []
}
```

- `sdk` is `node`, `python`, or `jvm`.
- `agentId` identifies one running agent process. Current agents generate a
  random UUID at startup. It is optional only for legacy agents.
- `commitSha` is required, normalized lowercase hexadecimal, and must be sent
  on every heartbeat/ingest. It is agent-reported honesty metadata, not
  cryptographic proof of bytecode identity.
- `commitSource` is optional and is `env` or `config`.
- `capabilities` is optional for legacy agents and otherwise contains the
  additive feature identifiers the current agent build implements. Unknown
  well-formed identifiers are retained for forward compatibility.
- `agentStatus.state` is `green` or `red`.
- `agentStatus.detail` is optional.
- `agentStatus.reasonCode` is omitted when green and otherwise one of
  `event_loop_lag`, `pause_budget`, `rate_limited`,
  `instrumentation_failure`, or `agent_worker_failure`.
- `agentStatus.limits` uses canonical cross-runtime names. Agents report only
  safeguards they enforce. Omitted fields are unsupported, not measurements
  of zero load.
- `events` may be empty; an empty ingest acts as a service heartbeat.

A successful ingest returns HTTP 202:

```json
{
  "accepted": 0
}
```

Ingest validates the whole request body, so a single malformed event returns
HTTP 400 for the entire batch without naming the offender. Agents must not treat
that as licence to discard the batch: on a 400 they retry the events in halves
until the rejection is isolated to the events that actually caused it, dropping
only those. A 400 whose cause lies outside `events` fails every subset equally,
so agents bound the number of retries per flush rather than splitting forever.

Every event has `probeId`, `type`, and `ts`. Event `type` is `snapshot`, `log`,
`counter`, `metric`, or `status`.

`GET /v1/services` includes `commitSha` and `commitSource` once an agent has
heartbeated.

`GET /v1/ping` is the authenticated connectivity check and returns
`{"ok":true}`. Use `GET /healthz` only for unauthenticated process liveness.

`GET /v1/safety` returns broker-derived per-service `online`, `agent`,
`probesSummary`, and `caveats`. The caveats are part of the contract: safety is
agent-reported LiveProbe runtime behavior, not a cross-runtime load metric.

Node agents scan `LIVEPROBE_SOURCE_MAP_DIR` (or the process working directory),
excluding hidden directories and `node_modules`, and upload external `.js.map`
files using `LIVEPROBE_DIST_LOCATION` and optional `LIVEPROBE_APP_ROOT` as the
logical deployment prefix. Python and JVM agents do not load source maps in v1;
probe `file` must match a runtime-known path suffix and JVM targets must include
line/local-variable debug information.

Snapshot event:

```json
{
  "probeId": "prb_01HZX3Y2M7QK6N4W5P8S9T0ABC",
  "type": "snapshot",
  "ts": "2026-07-19T18:30:00.123Z",
  "variables": {
    "t": "obj",
    "c": {}
  },
  "watches": {
    "user.tier": {
      "t": "str",
      "v": "free"
    }
  },
  "stack": [
    {
      "fn": "charge",
      "file": "src/payments.js",
      "line": 34
    }
  ]
}
```

`variables` is one serialized tree node. `watches` maps requested paths to
serialized tree nodes. `stack` contains at most eight frames by default.

Log event:

```json
{
  "probeId": "prb_01HZX3Y2M7QK6N4W5P8S9T0ABC",
  "type": "log",
  "ts": "2026-07-19T18:30:00.123Z",
  "message": "pool=5 user=u_123",
  "level": "info"
}
```

`level` is `debug`, `info`, `warn`, or `error`.

Counter event:

```json
{
  "probeId": "prb_01HZX3Y2M7QK6N4W5P8S9T0ABC",
  "type": "counter",
  "ts": "2026-07-19T18:30:02.000Z",
  "delta": 27
}
```

Counter deltas are positive integers pre-aggregated by the agent and normally
flushed every two seconds.

`maxProbeHitsPerSecond` bounds capture cost, not counting. A counter probe with
no condition reads no variables, so agents that have already paused for the hit
count it even when the hit budget is exhausted; such probes stay exact on hot
paths rather than sampling at the budget rate. A conditional counter has to
capture in order to evaluate its condition and is still subject to the budget.

The budget is charged per capture, not per probe. An agent that reads a frame
once and shares it across every probe on the line charges one hit for that
pause, so placing N probes on the same line does not leave each with 1/N of the
configured budget. The JVM bridge is the exception by construction: each probe
is its own breakpoint request and its own VM suspend, so there is no shared
capture to amortise and each probe is charged individually.

The JVM bridge also cannot make counters exact. Rather than resume immediately
it disables the breakpoint request until the budget window resets — a JVM
suspend per hit is too expensive to absorb — so hits during that window are
never delivered and cannot be counted. It counts the hit that tripped the
budget and reports `suspended` for the window, which makes a JVM counter under
sustained rate limiting a floor rather than an exact total.

Metric event:

```json
{
  "probeId": "prb_01HZX3Y2M7QK6N4W5P8S9T0ABC",
  "type": "metric",
  "ts": "2026-07-19T18:30:02.000Z",
  "count": 27,
  "sum": 102.5,
  "min": 1.5,
  "max": 8,
  "last": 3
}
```

Metric fields are finite numbers, `count` is a positive integer, and samples
are pre-aggregated by the agent.

Status event:

```json
{
  "probeId": "prb_01HZX3Y2M7QK6N4W5P8S9T0ABC",
  "type": "status",
  "ts": "2026-07-19T18:30:00.123Z",
  "status": "armed",
  "detail": "src/payments.js:34"
}
```

`status` is `armed`, `error`, `hit-limit-reached`, `suspended`, or `expired`.
`detail` is optional. Specific failures such as `line-not-found` are carried in
`detail`.

An agent that cannot reach a probe's file or line reports `error` with detail
`line-not-found: {file}:{line}` rather than `armed`. The check repeats on every
poll, so a probe placed on a module that has not been imported yet reports
`error` and flips to `armed` once the module loads.

Where the broker reports a probe's status it also carries `armedAt`, set the
first time an agent reports that probe as `armed` and preserved across later
transitions. `status` holds only the newest transition, so without `armedAt` a
probe that armed and immediately reached its hit limit would be
indistinguishable from one that never armed. `armedAt` is absent until the probe
first arms.

### 4.4 Native Linux agent reconciliation

Native Linux agents use the same logical probes and sanitized evidence model.
Raw ring-buffer records and target bytes never leave the host.

- `POST /v1/native/agents/register` verifies the native credential and exact
  agent ID, persists the heartbeat, and returns its bounded service allowlist.
- `PUT /v1/native/agents/{agentId}/instances` replaces only that scoped
  agent's complete instance set. Each instance includes language, PID and
  process start identity, executable identity, architecture, exact GNU build
  ID, capabilities, and last-seen time.
- `GET /v1/native/agents/{agentId}/assignments?since=N` returns complete
  desired state bound to exact instance and build IDs. When `N` equals the
  current durable version, `assignments` is empty.
- `POST /v1/native/ingest` validates the complete batch before mutation and
  verifies scope, agent, service, instance, build, probe ID, probe version, and
  event type.

Assignment versions are monotonically increasing and persisted independently
of managed service versions. Terminal state is keyed by tenant, project,
environment, probe ID/version, agent, instance, and build ID; one instance
cannot terminate another.

Native capability validation is broker-authoritative. The supported bounded
contract is source file/line, dot-path scalar/C-string/fixed-field watches,
simple path conditions, path-based log templates, counters, simple metric
paths, TTL/hit limits, and raw-hit protection. Arbitrary expressions,
stack-local expansion, unsupported log levels, deep or container traversal,
floating-register capture, STL traversal, and suspended Rust future inspection
return `unsupported_by_backend` before storage.

`sourceCommit` is user-supplied source/audit metadata. `buildId` is the
agent-reported identity of the executable actually attached by the loader.
They are never interchangeable.

## 5. Client-facing broker API

Every route in this section requires a human credential or the shared
break-glass admin key. Service credentials are rejected with HTTP 403. Probe
mutations require `admin` or `operator`; service-credential and audit routes
require `admin`; diagnostic reads permit `admin`, `operator`, and `viewer`.

### 5.1 Create a probe

`POST /v1/probes`

The request is the create form described in section 3. HTTP 201 returns:

```json
{
  "probe": {}
}
```

`probe` is the complete `ProbeDefinition`.

### 5.2 Delete a probe

`DELETE /v1/probes/{id}`

Deletion is idempotent and returns HTTP 204. Deleting an active probe increments
its service version.

### 5.3 List probes

`GET /v1/probes?serviceId={serviceId}`

`serviceId` is optional. HTTP 200 returns:

```json
{
  "probes": [
    {
      "probe": {},
      "status": {
        "status": "armed",
        "detail": "src/payments.js:34",
        "updatedAt": "2026-07-19T18:30:00.123Z",
        "armedAt": "2026-07-19T18:30:00.123Z"
      }
    }
  ]
}
```

### 5.4 List services

`GET /v1/services`

HTTP 200 returns:

```json
{
  "services": [
    {
      "serviceId": "payment-service",
      "sdk": "node",
      "capabilities": [
        "log-levels-v1",
        "expression-ast-v1",
        "frame-locals-v1"
      ],
      "lastSeen": "2026-07-19T18:30:00.123Z",
      "agentStatus": {
        "state": "green"
      }
    }
  ]
}
```

Services are discovered through poll and ingest heartbeats.
`capabilities` is the intersection reported by all active agent replicas and is
empty after broker restart until at least one current heartbeat is received.

### 5.5 Read probe data

`GET /v1/probes/{id}/data?waitSeconds=25`

`waitSeconds` is optional, defaults to `0`, and is clamped to `0..30`. If
retained events exist, the broker responds immediately. Otherwise it waits
until the first event arrives or the timeout elapses.

```json
{
  "probe": {},
  "status": {
    "status": "armed",
    "updatedAt": "2026-07-19T18:30:00.123Z"
  },
  "events": []
}
```

Events are retained, not consumed, in a per-probe ring buffer capped at 500
events. The oldest event is discarded first.

### 5.6 Resource catalog

The PostgreSQL-backed catalog separates project-level service identities from
environment-specific runtime deployments:

- `GET|POST /v1/projects`
- `DELETE /v1/projects/{projectId}`
- `GET|POST /v1/projects/{projectId}/environments`
- `DELETE /v1/projects/{projectId}/environments/{environmentId}`
- `GET|POST /v1/projects/{projectId}/services`
- `DELETE /v1/projects/{projectId}/services/{serviceId}`

Project and environment IDs are lowercase deployment-safe identifiers. A
registered service belongs to a project and may be deployed into multiple
environments. `DELETE` archives catalog records rather than deleting
diagnostic or audit history. Archiving revokes affected active service
credentials. Recreating an archived identifier restores it.

Catalog management is tenant-scoped from the authenticated Clerk organization
and never accepts a client-supplied tenant ID. It requires PostgreSQL and
returns `503 catalog_store_unavailable` with the JSON fallback.

### 5.7 Service credentials

`POST /v1/service-credentials` accepts:

```json
{
  "projectId": "acme",
  "environmentId": "production",
  "serviceId": "payment-service",
  "label": "Payments production"
}
```

It requires PostgreSQL and returns HTTP 201 with the plaintext `apiKey` exactly
once alongside its non-secret metadata:

```json
{
  "credential": {
    "credentialId": "svc_0123456789abcdef0123456789abcdef",
    "tenantId": "internal",
    "projectId": "default",
    "environmentId": "default",
    "serviceId": "payment-service",
    "label": "Payments production",
    "keyPrefix": "lp_service_AbCd1234",
    "createdAt": "2026-07-22T18:00:00.000Z"
  },
  "apiKey": "lp_service_<secret>"
}
```

`projectId` and `environmentId` default to the authenticated principal's scope
for compatibility with 0.2 clients. Current MCP clients require both fields.
The environment and project must be active. Previously unseen service IDs are
registered automatically for one compatibility release; new clients should
call `register_service` explicitly.

`GET /v1/service-credentials?projectId=...&environmentId=...&serviceId=...`
returns metadata only. It never returns a secret or secret hash.
`DELETE /v1/service-credentials/{credentialId}?projectId=...&environmentId=...`
revokes an active credential and returns HTTP 204. A revoked credential
immediately receives HTTP 401. Credential management returns HTTP 503
`credential_store_unavailable` when PostgreSQL is not configured.

Native host credentials use `POST`, `GET`, and `DELETE
/v1/native-credentials[/{credentialId}]`. Creation accepts `agentId`,
`allowedServiceIds`, and `label`. The returned secret has prefix `lp_native_`
and is shown once. Stored/listed records contain only the credential ID, scope,
exact agent ID, service allowlist, label, safe key prefix, creation/last-use
timestamps, and optional revocation timestamp.

### 5.8 Audit events

`GET /v1/audit-events?limit=50&before={timestamp}` requires `admin` and
PostgreSQL. `limit` is bounded to `1..100`; `before` is an optional RFC 3339
timestamp. Results are restricted to the authenticated tenant, project, and
environment and are ordered newest first.

Probe create/delete and service-credential create/revoke operations append an
`attempt` event followed by `success`, `denied`, or `error` with the same
request ID. Records contain actor identity and role, action, resource identity,
outcome, status/error code, and bounded non-secret metadata. They do not contain
bearer tokens, plaintext service keys, captured probe values, or full request
bodies.

PostgreSQL rejects `UPDATE`, `DELETE`, and `TRUNCATE` on `audit_events`. This is
an append-only application control, not cryptographic WORM storage: a database
owner can alter the trigger or drop the table. `audit_store_unavailable` is
returned when PostgreSQL audit storage is unavailable. MCP exposes the same
admin-only data through `list_audit_events`.

### 5.9 MCP set-probe commit metadata

The `set_snapshot_probe`, `set_log_probe`, `set_counter_probe`, and
`set_metric_probe` MCP tools require `commit_hash`, using snake_case at the MCP
boundary. It must be a 7-64 character hexadecimal Git object ID and is
normalized to lowercase before being sent to the broker as `sourceCommit`.

Before creating a probe, an MCP agent must ask the user for the deployed commit
SHA when it is not already known. When the relevant repository and revision are
available locally, the agent must validate that the revision exists and inspect
source at that exact revision before choosing `file` and `line`. The agent must
not automatically infer or discover a deployed revision as part of this
transitional flow.

`commit_hash` is user-supplied audit metadata. Neither the MCP server, broker,
nor runtime agents treat it as runtime proof or verify that the target process
is running that revision.

## 6. Sanitized variable tree

The serializer is the pure function:

```text
serialize(raw, config) -> SanitizedSnapshot
```

The transport layer may accept `SanitizedSnapshot`; it must not accept the raw
capture type.

### 6.1 Configuration

Defaults:

```json
{
  "maxDepth": 3,
  "maxArray": 3,
  "maxProps": 50,
  "maxString": 1024,
  "maxStackFrames": 8,
  "redactKeys": [
    "password",
    "secret",
    "token",
    "authorization",
    "cookie",
    "key",
    "signature",
    "ssn",
    "creditcard"
  ],
  "redactValues": []
}
```

Runtime-provided `redactKeys` extend, rather than replace, the defaults.
Duplicate patterns are ignored case-insensitively. Runtime-provided
`redactValues` are added as exact, case-sensitive string matches. Numeric limit
overrides replace their defaults and must be non-negative integers.

### 6.2 Node forms

Primitive nodes:

```json
{"t": "str", "v": "hello"}
{"t": "num", "v": 42}
{"t": "bool", "v": true}
{"t": "null", "v": null}
{"t": "fn"}
{"t": "redacted"}
{"t": "truncated", "v": "depth"}
```

Allowed truncation reasons are `depth`, `array`, `props`, `string`, `circular`,
and `unsupported`.

Object and array nodes:

```json
{
  "t": "obj",
  "c": {
    "name": {
      "t": "str",
      "v": "Ada"
    }
  }
}
```

```json
{
  "t": "arr",
  "c": [
    {
      "t": "num",
      "v": 1
    }
  ]
}
```

When a container limit omits children, the container has an `m` field whose
value is the corresponding truncation marker:

```json
{
  "t": "arr",
  "c": [],
  "m": {
    "t": "truncated",
    "v": "array"
  }
}
```

### 6.3 Traversal rules

Rules are applied in this order during one traversal:

1. Before reading a property value, compare its key case-insensitively against
   every redaction pattern using substring matching. On a match, emit
   `{"t":"redacted"}` and do not read or descend into the value.
2. If a string exactly matches a configured redaction value, emit
   `{"t":"redacted"}`.
3. The root is depth `0`. A value whose depth is greater than `maxDepth` becomes
   `{"t":"truncated","v":"depth"}`.
4. A string longer than `maxString` Unicode code points becomes
   `{"t":"truncated","v":"string"}`. No prefix is retained.
5. Arrays retain their first `maxArray` entries. If entries were omitted, add
   `m: {"t":"truncated","v":"array"}`.
6. Objects retain their first `maxProps` enumerable data properties in source
   iteration order. If properties were omitted, add
   `m: {"t":"truncated","v":"props"}`.
7. Track the identities of containers on the active ancestor path. Encountering
   an active ancestor again emits `{"t":"truncated","v":"circular"}`.
8. Functions become `{"t":"fn"}`. Unsupported values and non-finite numbers
   become `{"t":"truncated","v":"unsupported"}`.

Capture layers must not execute getters or descriptors. Node uses only values
returned in inspector property descriptors and represents accessors as the
literal string `[getter]`. Python uses dictionary items and static attribute
inspection. JVM uses field reads only.

## 7. Serializer fixture format

Every `spec/fixtures/serializer/*.json` file has exactly these top-level fields:

```json
{
  "input": {},
  "config": {},
  "expected": {}
}
```

Ordinary JSON values in `input` materialize directly. Reserved tagged objects
allow fixtures to represent values JSON cannot represent:

- `{"$fixture":"function","name":"handler"}` materializes as a callable or the
  implementation's raw-function sentinel.
- `{"$fixture":"object","id":"root","value":{...}}` allocates and registers an
  object before materializing `value`.
- `{"$fixture":"array","id":"root","value":[...]}` does the same for an array.
- `{"$fixture":"ref","id":"root"}` resolves to a previously registered
  container with that ID.

Fixture tags are test-harness notation only and can never appear in a
`SanitizedSnapshot`. `expected` is always an ordinary serialized tree.
