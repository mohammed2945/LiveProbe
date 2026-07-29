import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const EVIDENCE_SCHEMA_VERSION = "observability-snapshot/v1";
export const LEDGER_SCHEMA_VERSION = "liveprobe-eval-ledger/v1";
export const RESULT_SCHEMA_VERSION = "liveprobe-praxis-result/v1";

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  const encoded =
    typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(encoded).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertString(value, path) {
  assert(
    typeof value === "string" && value.length > 0,
    `${path} must be a non-empty string`,
  );
}

function collectKeys(value, prefix = "", output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectKeys(item, `${prefix}[${index}]`, output),
    );
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      output.push(path);
      collectKeys(item, path, output);
    }
  }
  return output;
}

export function validateEvidenceSnapshot(snapshot) {
  assert(
    snapshot?.schema_version === EVIDENCE_SCHEMA_VERSION,
    `snapshot.schema_version must be ${EVIDENCE_SCHEMA_VERSION}`,
  );
  for (const key of [
    "snapshot_id",
    "revision",
    "incident_id",
    "detected_at",
  ]) {
    assertString(snapshot[key], `snapshot.${key}`);
  }
  assert(
    Number.isFinite(Date.parse(snapshot.detected_at)),
    "snapshot.detected_at must be an ISO timestamp",
  );
  assertString(snapshot.window?.start, "snapshot.window.start");
  assertString(snapshot.window?.end, "snapshot.window.end");
  assert(
    Date.parse(snapshot.window.start) <= Date.parse(snapshot.window.end),
    "snapshot.window start must not be after end",
  );
  assert(typeof snapshot.synthetic === "boolean", "synthetic must be boolean");
  assert(Array.isArray(snapshot.bootstrap?.alerts), "bootstrap.alerts missing");
  assert(
    Array.isArray(snapshot.bootstrap?.failing_trace_summaries),
    "bootstrap.failing_trace_summaries missing",
  );
  assert(
    snapshot.bootstrap.failing_trace_summaries.length <= 3,
    "bootstrap may contain at most three failing trace summaries",
  );
  for (const key of [
    "logs",
    "traces",
    "metrics",
    "events",
    "resources",
    "deployments",
    "replay_recipes",
  ]) {
    assert(Array.isArray(snapshot[key]), `snapshot.${key} must be an array`);
  }
  assert(
    Array.isArray(snapshot.topology?.nodes) &&
      Array.isArray(snapshot.topology?.edges),
    "snapshot.topology must contain nodes and edges",
  );

  const forbidden = /(?:^|\.)(?:ground_?truth|oracle|fault_?injection|recommended_actions?|root_?cause)(?:\.|$)/i;
  const leaked = collectKeys(snapshot).find((path) => forbidden.test(path));
  assert(leaked === undefined, `oracle field leaked into snapshot: ${leaked}`);

  const evidenceIds = new Set();
  const evidenceCollections = [
    ...snapshot.bootstrap.alerts,
    ...snapshot.bootstrap.failing_trace_summaries,
    ...snapshot.logs,
    ...snapshot.traces,
    ...snapshot.metrics,
    ...snapshot.events,
    ...snapshot.resources,
    ...snapshot.deployments,
  ];
  for (const item of evidenceCollections) {
    assertString(item?.evidence_id, "evidence.evidence_id");
    assert(
      !evidenceIds.has(item.evidence_id),
      `duplicate evidence_id ${item.evidence_id}`,
    );
    evidenceIds.add(item.evidence_id);
  }
  return snapshot;
}

function normalizeLimit(value, fallback = 50, maximum = 200) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  assert(Number.isInteger(parsed) && parsed >= 1, "limit must be a positive integer");
  assert(parsed <= maximum, `limit must not exceed ${maximum}`);
  return parsed;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(cursor, revision, tool) {
  if (cursor === undefined) return 0;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor is malformed; repeat the query without it");
  }
  assert(
    parsed.revision === revision && parsed.tool === tool,
    "cursor belongs to a different snapshot revision or tool",
  );
  assert(
    Number.isInteger(parsed.offset) && parsed.offset >= 0,
    "cursor offset is invalid",
  );
  return parsed.offset;
}

function timestampInWindow(timestamp, window) {
  if (window === undefined || timestamp === undefined) return true;
  const value = Date.parse(timestamp);
  return (
    Number.isFinite(value) &&
    value >= Date.parse(window.start) &&
    value <= Date.parse(window.end)
  );
}

function validateWindow(window, snapshotWindow) {
  if (window === undefined) return snapshotWindow;
  assertString(window.start, "window.start");
  assertString(window.end, "window.end");
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  assert(Number.isFinite(start) && Number.isFinite(end), "window must use ISO timestamps");
  assert(start <= end, "window start must not be after end");
  assert(
    start >= Date.parse(snapshotWindow.start) &&
      end <= Date.parse(snapshotWindow.end),
    "window lies outside the immutable snapshot",
  );
  return window;
}

function includesCaseInsensitive(value, query) {
  return String(value ?? "").toLowerCase().includes(query.toLowerCase());
}

export class EvidenceStore {
  constructor(
    snapshot,
    {
      ledger,
      defaultPageSize = 50,
      maximumPageSize = 200,
      replayExecutor,
    } = {},
  ) {
    this.snapshot = validateEvidenceSnapshot(structuredClone(snapshot));
    this.ledger = ledger;
    this.defaultPageSize = defaultPageSize;
    this.maximumPageSize = maximumPageSize;
    this.replayExecutor = replayExecutor;
    this.replayCount = 0;
  }

  envelope(tool, args, payload) {
    const result = {
      snapshot_id: this.snapshot.snapshot_id,
      snapshot_revision: this.snapshot.revision,
      incident_id: this.snapshot.incident_id,
      query: { tool, arguments: args },
      ...payload,
    };
    this.ledger?.recordTool({
      server: "observability",
      tool,
      arguments: args,
      evidence_ids: result.evidence_ids ?? [],
      response_bytes: Buffer.byteLength(JSON.stringify(result)),
      snapshot_revision: this.snapshot.revision,
    });
    return result;
  }

  page(tool, args, items) {
    const limit = normalizeLimit(
      args.limit,
      this.defaultPageSize,
      this.maximumPageSize,
    );
    const offset = decodeCursor(args.cursor, this.snapshot.revision, tool);
    const selected = items.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    return this.envelope(tool, args, {
      items: selected,
      evidence_ids: selected
        .map((item) => item.evidence_id)
        .filter(Boolean),
      next_cursor:
        nextOffset < items.length
          ? encodeCursor({
              revision: this.snapshot.revision,
              tool,
              offset: nextOffset,
            })
          : null,
      truncated: nextOffset < items.length,
      total_matching: items.length,
    });
  }

  getBootstrap(args = {}) {
    assert(
      args.incident_id === undefined ||
        String(args.incident_id) === this.snapshot.incident_id,
      "incident_id does not match the loaded snapshot",
    );
    const bootstrap = structuredClone(this.snapshot.bootstrap);
    return this.envelope("get_incident_bootstrap", args, {
      detected_at: this.snapshot.detected_at,
      window: this.snapshot.window,
      synthetic: this.snapshot.synthetic,
      bootstrap,
      evidence_ids: [
        ...bootstrap.alerts,
        ...bootstrap.failing_trace_summaries,
      ].map((item) => item.evidence_id),
    });
  }

  searchLogs(args) {
    assertString(args.service, "service");
    const window = validateWindow(args.window, this.snapshot.window);
    const items = this.snapshot.logs.filter(
      (item) =>
        item.service === args.service &&
        (args.trace_id === undefined || item.trace_id === args.trace_id) &&
        (args.severity === undefined ||
          String(item.severity).toUpperCase() ===
            String(args.severity).toUpperCase()) &&
        (args.query === undefined ||
          includesCaseInsensitive(
            `${item.message} ${JSON.stringify(item.attributes ?? {})}`,
            args.query,
          )) &&
        timestampInWindow(item.timestamp, window),
    );
    return this.page("search_logs", { ...args, window }, items);
  }

  searchTraces(args) {
    const window = validateWindow(args.window, this.snapshot.window);
    const items = this.snapshot.traces.filter((trace) => {
      const spans = trace.spans ?? [];
      return (
        (args.service === undefined ||
          spans.some((span) => span.service === args.service)) &&
        (args.operation === undefined ||
          spans.some((span) => span.operation === args.operation)) &&
        (args.status === undefined ||
          String(trace.status).toUpperCase() ===
            String(args.status).toUpperCase()) &&
        timestampInWindow(trace.started_at, window)
      );
    });
    return this.page("search_traces", { ...args, window }, items);
  }

  getTrace(args) {
    assertString(args.trace_id, "trace_id");
    const trace = this.snapshot.traces.find(
      (item) => item.trace_id === args.trace_id,
    );
    assert(trace !== undefined, `trace_id ${args.trace_id} was not found`);
    return this.envelope("get_trace", args, {
      trace,
      evidence_ids: [trace.evidence_id],
    });
  }

  queryMetrics(args) {
    assertString(args.service, "service");
    assertString(args.metric_or_preset, "metric_or_preset");
    const window = validateWindow(args.window, this.snapshot.window);
    const items = this.snapshot.metrics
      .filter(
        (item) =>
          item.service === args.service &&
          item.name === args.metric_or_preset,
      )
      .map((item) => ({
        ...item,
        points: item.points.filter(([timestamp]) =>
          timestampInWindow(timestamp, window),
        ),
      }));
    return this.page("query_metrics", { ...args, window }, items);
  }

  getEvents(args) {
    assertString(args.namespace, "namespace");
    const window = validateWindow(args.window, this.snapshot.window);
    const items = this.snapshot.events.filter(
      (item) =>
        item.namespace === args.namespace &&
        (args.kind === undefined || item.kind === args.kind) &&
        (args.name === undefined || item.name === args.name) &&
        timestampInWindow(item.timestamp, window),
    );
    return this.page("get_kubernetes_events", { ...args, window }, items);
  }

  getResourceState(args) {
    for (const key of ["namespace", "kind", "name"]) {
      assertString(args[key], key);
    }
    const resource = this.snapshot.resources.find(
      (item) =>
        item.namespace === args.namespace &&
        item.kind === args.kind &&
        item.name === args.name,
    );
    assert(
      resource !== undefined,
      `${args.kind}/${args.name} was not found in namespace ${args.namespace}`,
    );
    return this.envelope("get_resource_state", args, {
      resource,
      evidence_ids: [resource.evidence_id],
    });
  }

  getDeploymentHistory(args) {
    assertString(args.service, "service");
    const window = validateWindow(args.window, this.snapshot.window);
    const items = this.snapshot.deployments.filter(
      (item) =>
        item.service === args.service &&
        timestampInWindow(item.deployed_at, window),
    );
    return this.page("get_deployment_history", { ...args, window }, items);
  }

  getTopology(args = {}) {
    const depth = args.depth === undefined ? 1 : Number(args.depth);
    assert(
      Number.isInteger(depth) && depth >= 0 && depth <= 5,
      "depth must be an integer from 0 through 5",
    );
    let nodes = this.snapshot.topology.nodes;
    let edges = this.snapshot.topology.edges;
    if (args.service !== undefined) {
      assertString(args.service, "service");
      const selected = new Set([args.service]);
      for (let step = 0; step < depth; step += 1) {
        for (const edge of edges) {
          if (selected.has(edge.from) || selected.has(edge.to)) {
            selected.add(edge.from);
            selected.add(edge.to);
          }
        }
      }
      nodes = nodes.filter((node) => selected.has(node.id));
      edges = edges.filter(
        (edge) => selected.has(edge.from) && selected.has(edge.to),
      );
    }
    return this.envelope("get_service_topology", args, {
      topology: { nodes, edges },
      evidence_ids: [],
    });
  }

  async replayIncident(args) {
    assertString(args.incident_id, "incident_id");
    assertString(args.recipe_id, "recipe_id");
    assert(
      args.incident_id === this.snapshot.incident_id,
      "incident_id does not match the loaded snapshot",
    );
    const recipe = this.snapshot.replay_recipes.find(
      (item) => item.recipe_id === args.recipe_id,
    );
    assert(recipe !== undefined, `unknown replay recipe ${args.recipe_id}`);
    assert(recipe.enabled === true, `replay recipe ${args.recipe_id} is disabled`);
    this.replayCount += 1;
    const suffix = String(this.replayCount).padStart(8, "0");
    const replayId = `replay-${this.snapshot.incident_id}-${suffix}`;
    const traceId = sha256(`${this.snapshot.snapshot_id}:${suffix}`).slice(0, 32);
    const execution =
      this.replayExecutor === undefined
        ? { synthetic: true, status: "accepted_fixture_replay" }
        : await this.replayExecutor({ recipe, replayId, traceId });
    return this.envelope("replay_incident", args, {
      replay: {
        replay_id: replayId,
        trace_id: traceId,
        recipe_id: recipe.recipe_id,
        ...execution,
      },
      evidence_ids: [],
    });
  }

  call(tool, args = {}) {
    switch (tool) {
      case "get_incident_bootstrap":
        return this.getBootstrap(args);
      case "search_logs":
        return this.searchLogs(args);
      case "search_traces":
        return this.searchTraces(args);
      case "get_trace":
        return this.getTrace(args);
      case "query_metrics":
        return this.queryMetrics(args);
      case "get_kubernetes_events":
        return this.getEvents(args);
      case "get_resource_state":
        return this.getResourceState(args);
      case "get_deployment_history":
        return this.getDeploymentHistory(args);
      case "get_service_topology":
        return this.getTopology(args);
      case "replay_incident":
        return this.replayIncident(args);
      default:
        throw new Error(`unknown observability tool ${tool}`);
    }
  }
}

export function zeroUsage() {
  return {
    model_calls: 0,
    model_samples: 0,
    retries: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    new_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    model_ms: 0,
    tool_calls: 0,
    tool_response_bytes: 0,
  };
}

export function normalizeUsage(usage = {}) {
  const input = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
  const cached = Number(
    usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0,
  );
  return {
    model_calls: Number(usage.model_calls ?? usage.calls ?? 1),
    model_samples: Number(
      usage.model_samples ?? usage.modelSamples ?? usage.calls ?? 1,
    ),
    retries: Number(usage.retries ?? 0),
    input_tokens: input,
    cached_input_tokens: cached,
    new_input_tokens: Number(
      usage.new_input_tokens ?? Math.max(0, input - cached),
    ),
    output_tokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0),
    reasoning_tokens: Number(
      usage.reasoning_tokens ?? usage.reasoningTokens ?? 0,
    ),
    model_ms: Number(usage.model_ms ?? usage.elapsedMs ?? 0),
    tool_calls: Number(usage.tool_calls ?? usage.toolCalls ?? 0),
    tool_response_bytes: Number(usage.tool_response_bytes ?? 0),
  };
}

function addUsage(target, delta) {
  for (const key of Object.keys(target)) target[key] += Number(delta[key] ?? 0);
  return target;
}

export class EvaluationLedger {
  constructor({
    run_id,
    arm,
    incident_id,
    seed,
    model,
    path,
    budget,
    clock = () => new Date().toISOString(),
  }) {
    this.context = { run_id, arm, incident_id, seed, model };
    this.path = path;
    this.budget = budget;
    this.clock = clock;
    this.records = [];
    this.usage = zeroUsage();
  }

  persist(record) {
    if (this.path !== undefined) {
      appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    }
  }

  makeRecord(kind, payload) {
    return {
      schema_version: LEDGER_SCHEMA_VERSION,
      timestamp: this.clock(),
      ...this.context,
      kind,
      ...payload,
    };
  }

  recordTool(payload) {
    const record = this.makeRecord("tool_call", payload);
    this.records.push(record);
    addUsage(this.usage, {
      tool_calls: 1,
      tool_response_bytes: payload.response_bytes ?? 0,
    });
    this.persist(record);
    this.assertBudget();
    return record;
  }

  recordModel(payload) {
    const normalized = normalizeUsage(payload.usage);
    const record = this.makeRecord("model_call", {
      phase: payload.phase,
      parent_turn: payload.parent_turn ?? null,
      request_id: payload.request_id ?? null,
      prompt_sha256: payload.prompt_sha256,
      system_sha256: payload.system_sha256,
      skill_sha256: payload.skill_sha256,
      tool_schema_sha256: payload.tool_schema_sha256,
      response_sha256: payload.response_sha256,
      status: payload.status ?? "completed",
      provider_reported: payload.provider_reported !== false,
      usage_scope: payload.usage_scope ?? "unspecified",
      model_sample_count_source:
        payload.model_sample_count_source ?? "unspecified",
      usage: normalized,
    });
    this.records.push(record);
    addUsage(this.usage, normalized);
    this.persist(record);
    this.assertBudget();
    return record;
  }

  assertBudget() {
    if (
      this.budget?.llm_total_tokens !== undefined &&
      this.usage.input_tokens + this.usage.output_tokens >
        this.budget.llm_total_tokens
    ) {
      throw new Error(
        `LLM token budget exceeded: ${
          this.usage.input_tokens + this.usage.output_tokens
        } > ${this.budget.llm_total_tokens}`,
      );
    }
    if (
      this.budget?.observability_queries !== undefined &&
      this.usage.tool_calls > this.budget.observability_queries
    ) {
      throw new Error(
        `tool-call budget exceeded: ${this.usage.tool_calls} > ${this.budget.observability_queries}`,
      );
    }
  }

  summary() {
    return structuredClone(this.usage);
  }
}

function normalizeIdentity(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\s+/g, "-");
}

function identityAliases(oracle) {
  const aliases = new Map();
  for (const group of oracle.entity_alias_groups ?? []) {
    const values = group.map(normalizeIdentity).filter(Boolean);
    const canonical = values[0];
    for (const value of values) aliases.set(value, canonical);
  }
  return aliases;
}

function canonicalIdentity(value, aliases) {
  const normalized = normalizeIdentity(value);
  return aliases.get(normalized) ?? normalized;
}

function locationMatches(actual, expected) {
  if (expected.locations === undefined || expected.locations.length === 0) {
    return true;
  }
  return expected.locations.some((location) => {
    if (
      location.file !== undefined &&
      !String(actual.file ?? "").replaceAll("\\", "/").endsWith(location.file)
    ) {
      return false;
    }
    if (
      location.lines !== undefined &&
      !location.lines.includes(Number(actual.line))
    ) {
      return false;
    }
    if (
      location.function !== undefined &&
      normalizeIdentity(actual.function) !==
        normalizeIdentity(location.function)
    ) {
      return false;
    }
    if (
      location.resource !== undefined &&
      normalizeIdentity(actual.resource) !==
        normalizeIdentity(location.resource)
    ) {
      return false;
    }
    if (
      location.config_path !== undefined &&
      normalizeIdentity(actual.config_path) !==
        normalizeIdentity(location.config_path)
    ) {
      return false;
    }
    return true;
  });
}

export function scoreDiagnosis(answer, oracle) {
  const aliases = identityAliases(oracle);
  const acceptedRoots =
    oracle.accepted_roots?.map((root) => ({
      entities: new Set(
        [root.entity, ...(root.aliases ?? [])].map((value) =>
          canonicalIdentity(value, aliases),
        ),
      ),
      kinds: new Set(
        (root.kinds ?? [root.kind]).map(normalizeIdentity),
      ),
    })) ?? [
      {
        entities: new Set(
          [oracle.entity, ...(oracle.aliases ?? [])].map((value) =>
            canonicalIdentity(value, aliases),
          ),
        ),
        kinds: new Set(
          (oracle.kinds ?? [oracle.kind]).map(normalizeIdentity),
        ),
      },
    ];
  const actualEntity = canonicalIdentity(
    answer?.root_cause?.entity,
    aliases,
  );
  const actualKind = normalizeIdentity(answer?.root_cause?.kind);
  const rci = acceptedRoots.some(
    (root) =>
      root.entities.has(actualEntity) &&
      (root.kinds.has(actualKind) ||
        (actualKind === "serviceboundary" && root.kinds.has("service")) ||
        (actualKind === "deploymentconfiguration" &&
          root.kinds.has("deployment"))),
  );
  const rcl = rci && locationMatches(answer?.root_cause ?? {}, oracle);
  const actualEdges = new Set(
    (answer?.propagation ?? []).map(
      (edge) =>
        `${canonicalIdentity(edge.from, aliases)}>${canonicalIdentity(
          edge.to,
          aliases,
        )}`,
    ),
  );
  const requiredEdges = (oracle.propagation ?? []).map(
    (edge) =>
      `${canonicalIdentity(edge.from, aliases)}>${canonicalIdentity(
        edge.to,
        aliases,
      )}`,
  );
  const rcr =
    requiredEdges.length === 0 ||
    requiredEdges.every((edge) => actualEdges.has(edge));
  const expectedTerminals = new Set(
    oracle.expected_statuses ??
      (oracle.expected_status === "HANDOFF_OR_NOT_STARTED"
        ? ["HANDOFF", "INSUFFICIENT"]
        : oracle.expected_status === "HANDOFF_OR_LOCALIZED"
          ? ["HANDOFF", "LOCALIZED"]
          : [oracle.expected_status]),
  );
  const terminal = expectedTerminals.has(answer?.status);
  const evidenceIds = new Set(
    (answer?.propagation ?? []).flatMap((edge) => edge.evidence_ids ?? []),
  );
  const evidenceBacked =
    evidenceIds.size > 0 ||
    oracle.allow_empty_evidence === true;
  return {
    rci_pass_at_1: rci,
    rcl_pass_at_1: rcl,
    rcr_pass_at_1: rcr,
    terminal_correct: terminal,
    evidence_backed: evidenceBacked,
    combined_pass_at_1: rci && rcl && rcr && terminal && evidenceBacked,
  };
}

export function summarizeResults(results) {
  const groups = new Map();
  for (const result of results) {
    const current = groups.get(result.arm) ?? [];
    current.push(result);
    groups.set(result.arm, current);
  }
  return [...groups.entries()].map(([arm, runs]) => {
    const usage = runs.reduce(
      (total, run) => addUsage(total, normalizeUsage(run.usage)),
      zeroUsage(),
    );
    const successful = runs.filter(
      (run) => run.score?.combined_pass_at_1,
    ).length;
    const scored = runs.filter((run) => run.score !== null && run.score !== undefined);
    const failed = runs.filter((run) => run.failure !== undefined).length;
    const timedOut = runs.filter((run) => run.failure?.timeout === true).length;
    const wall = runs.map((run) => Number(run.wall_ms ?? 0)).sort((a, b) => a - b);
    const modelWall = runs
      .map((run) => Number(run.model_wall_ms ?? run.usage?.model_ms ?? 0))
      .sort((a, b) => a - b);
    const runtimeWall = runs
      .map((run) => Number(run.runtime_wall_ms ?? 0))
      .sort((a, b) => a - b);
    const median = (values) =>
      values.length === 0
        ? 0
        : values.length % 2 === 0
          ? (values[values.length / 2 - 1] + values[values.length / 2]) / 2
          : values[Math.floor(values.length / 2)];
    return {
      arm,
      runs: runs.length,
      scored_runs: scored.length,
      combined_pass_at_1:
        scored.length === runs.length ? successful / runs.length : null,
      successes: successful,
      failures: failed,
      failure_rate: failed / runs.length,
      timeouts: timedOut,
      timeout_rate: timedOut / runs.length,
      median_wall_ms: median(wall),
      median_model_wall_ms: median(modelWall),
      median_runtime_wall_ms: median(runtimeWall),
      total_model_calls: usage.model_calls,
      total_model_samples: usage.model_samples,
      total_input_tokens: usage.input_tokens,
      total_cached_input_tokens: usage.cached_input_tokens,
      total_new_input_tokens: usage.new_input_tokens,
      total_output_tokens: usage.output_tokens,
      total_reasoning_tokens: usage.reasoning_tokens,
      total_tool_calls: usage.tool_calls,
      total_tool_response_bytes: usage.tool_response_bytes,
      mean_model_calls: usage.model_calls / runs.length,
      mean_input_tokens: usage.input_tokens / runs.length,
      mean_cached_input_tokens: usage.cached_input_tokens / runs.length,
      mean_new_input_tokens: usage.new_input_tokens / runs.length,
      mean_output_tokens: usage.output_tokens / runs.length,
      mean_reasoning_tokens: usage.reasoning_tokens / runs.length,
      mean_model_samples: usage.model_samples / runs.length,
      mean_tool_calls: usage.tool_calls / runs.length,
    };
  });
}
