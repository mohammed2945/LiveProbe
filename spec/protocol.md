# LiveProbe Protocol v1

This document is the canonical contract between the broker, MCP server, and
runtime agents. Implementations must conform to this document rather than infer
behavior from another implementation.

## 1. Invariants

1. Runtime agents are read-only. They must not evaluate expressions or invoke
   target-process methods while capturing data.
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
- All `/v1/*` routes require `Authorization: Bearer <key>` when the broker is
  configured with `LIVEPROBE_API_KEY`. `GET /healthz` is unauthenticated
  liveness only. Invalid or missing credentials return HTTP 401:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "missing or invalid Authorization bearer token"
  }
}
```

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

Type-specific fields:

- `snapshot`: optional `watchPaths`, an array of dot paths.
- `log`: required `template`, containing zero or more `${dot.path}`
  interpolations.
- `counter`: no additional fields.
- `metric`: required `metricPath`, a dot path resolving to a finite number.

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
  "commitSha": "4f3c2a1d9e8b7c6a5f4e3d2c1b0a9876543210ab",
  "commitSource": "env",
  "agentStatus": {
    "state": "green",
    "detail": "3 probes armed"
  },
  "events": []
}
```

- `sdk` is `node`, `python`, or `jvm`.
- `commitSha` is required, normalized lowercase hexadecimal, and must be sent
  on every heartbeat/ingest. It is agent-reported honesty metadata, not
  cryptographic proof of bytecode identity.
- `commitSource` is optional and is `env` or `config`.
- `agentStatus.state` is `green` or `red`.
- `agentStatus.detail` is optional.
- `events` may be empty; an empty ingest acts as a service heartbeat.

A successful ingest returns HTTP 202:

```json
{
  "accepted": 0
}
```

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

## 5. Client-facing broker API

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
        "updatedAt": "2026-07-19T18:30:00.123Z"
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
      "lastSeen": "2026-07-19T18:30:00.123Z",
      "agentStatus": {
        "state": "green"
      }
    }
  ]
}
```

Services are discovered through poll and ingest heartbeats.

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

### 5.6 MCP set-probe commit metadata

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
