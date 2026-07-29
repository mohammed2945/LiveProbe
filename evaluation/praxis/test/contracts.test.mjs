import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  EvidenceStore,
  EvaluationLedger,
  scoreDiagnosis,
  summarizeResults,
  validateEvidenceSnapshot,
  zeroUsage,
} from "../src/core.mjs";
import { deterministicShuffle } from "../src/campaign.mjs";
import { usageFromEvents } from "../src/agent-runner.mjs";
import { ARM_NAMES, armCapabilities, loadGuidance } from "../src/arms.mjs";
import {
  RAW_LIVEPROBE_TOOLS,
  toolCostCounters,
} from "../src/mcp-filter-proxy.mjs";
import { OBSERVABILITY_TOOLS } from "../src/observability-mcp.mjs";
import { buildOfficialOracle } from "../scripts/build-official-oracle.mjs";
import { runtimePathCandidates } from "../scripts/build-instrumented-images.mjs";
import { extractSources } from "../scripts/extract-sources.mjs";

const execFile = promisify(execFileCallback);
const evaluationRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(evaluationRoot, "../..");
const fixture401Path = resolve(
  evaluationRoot,
  "fixtures/incident-401.snapshot.json",
);

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function expectCommandFailure(command, args, pattern, options = {}) {
  await assert.rejects(
    execFile(command, args, {
      cwd: repositoryRoot,
      timeout: 15_000,
      ...options,
    }),
    (error) => {
      const output = `${error.stderr ?? ""}\n${error.stdout ?? ""}`;
      assert.match(output, pattern);
      return true;
    },
  );
}

function rpcProcess(command, args) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const waiters = new Map();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  void (async () => {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter !== undefined) {
        waiters.delete(message.id);
        waiter.resolve(message);
      }
    }
    for (const waiter of waiters.values()) {
      waiter.reject(new Error(`MCP process ended early: ${stderr}`));
    }
  })();
  let nextId = 1;
  return {
    async request(method, params = {}) {
      const id = nextId++;
      const response = new Promise((resolveRequest, reject) => {
        waiters.set(id, { resolve: resolveRequest, reject });
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      return response;
    },
    async close() {
      child.stdin.end();
      const result = await Promise.race([
        new Promise((resolveExit) => {
          child.once("exit", (code) => resolveExit(code));
        }),
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error(`MCP process did not exit: ${stderr}`)),
            5_000,
          ).unref();
        }),
      ]);
      assert.equal(result, 0, stderr);
    },
  };
}

test("instrumented image source discovery follows the runtime entrypoint", () => {
  const candidates = runtimePathCandidates(
    {
      WorkingDir: "/usr/src/app/",
      Entrypoint: [
        "opentelemetry-instrument",
        "python",
        "recommendation_server.py",
      ],
      Cmd: null,
    },
    "/root/Workspace/opentelemetry-demo/src/recommendation/recommendation_server.py",
  );
  assert.deepEqual(candidates, [
    "/usr/src/app/recommendation_server.py",
    "/root/Workspace/opentelemetry-demo/src/recommendation/recommendation_server.py",
  ]);
});

test("instrumented image source discovery preserves absolute runtime commands", () => {
  const candidates = runtimePathCandidates(
    {
      WorkingDir: "/workspace",
      Entrypoint: ["python", "/opt/service/recommendation_server.py"],
      Cmd: [],
    },
    "/source/recommendation_server.py",
  );
  assert.deepEqual(candidates, [
    "/opt/service/recommendation_server.py",
    "/workspace/recommendation_server.py",
    "/source/recommendation_server.py",
  ]);
});

test("isolated eval broker explicitly opts out of production auth mode", async () => {
  const manifest = await readFile(
    resolve(evaluationRoot, "instrumentation/liveprobe-broker.yaml"),
    "utf8",
  );
  assert.match(
    manifest,
    /- name: NODE_ENV\s+value: "development"/u,
  );
  assert.doesNotMatch(manifest, /LIVEPROBE_REQUIRE_AUTH/u);
});

test("Kind rollout uses the locally loaded instrumented image", async () => {
  const enableScript = await readFile(
    resolve(evaluationRoot, "scripts/enable-liveprobe.mjs"),
    "utf8",
  );
  assert.match(enableScript, /imagePullPolicy: "IfNotPresent"/u);
  assert.match(
    enableScript,
    /"patch",\s+"deployment\/recommendation",\s+"--type=strategic"/u,
  );
});

test("Python bootstrap coexists with OpenTelemetry auto-instrumentation", async () => {
  const [dockerfile, bootstrapHook] = await Promise.all([
    readFile(resolve(evaluationRoot, "instrumentation/Dockerfile"), "utf8"),
    readFile(
      resolve(
        evaluationRoot,
        "instrumentation/liveprobe_bootstrap.pth",
      ),
      "utf8",
    ),
  ]);
  assert.match(
    dockerfile,
    /sitecustomize\.py \/opt\/liveprobe-bootstrap\/liveprobe_bootstrap\.py/u,
  );
  assert.match(
    dockerfile,
    /site\.getsitepackages\(\)\[0\] \+ '\/liveprobe_bootstrap\.pth'/u,
  );
  assert.doesNotMatch(
    dockerfile,
    /\/opt\/liveprobe-bootstrap\/sitecustomize\.py/u,
  );
  assert.equal(bootstrapHook.trim(), "import liveprobe_bootstrap");
});

test("runtime tripwire replays the failing recommendation route", async () => {
  const [tripwire, campaign, collector, compatibility] = await Promise.all([
    readFile(
      resolve(evaluationRoot, "scripts/remote-liveprobe-tripwire.mjs"),
      "utf8",
    ),
    readFile(resolve(evaluationRoot, "src/campaign.mjs"), "utf8"),
    readFile(
      resolve(evaluationRoot, "python/collect_snapshot.py"),
      "utf8",
    ),
    json(resolve(evaluationRoot, "liveprobe-compatibility.json")),
  ]);
  assert.match(
    tripwire,
    /replayPath: "\/api\/recommendations\?productIds=0PUK6V6EV0"/u,
  );
  assert.doesNotMatch(
    tripwire,
    /replayPath: "\/api\/products\//u,
  );
  assert.equal(compatibility.criterion.assignment_name, "cat_response");
  assert.equal(compatibility.criterion.watch_path, "cat_response");
  assert.equal(compatibility.criterion.expected_type, "mapping");
  assert.equal(compatibility.criterion.return_name, undefined);
  assert.match(
    tripwire,
    /incidentCompatibility\.criterion\.expected_type \?\? "mapping"/u,
  );
  assert.match(tripwire, /hit_limit: 100/u);
  assert.match(
    tripwire,
    /replayBaseUrl: "http:\/\/127\.0\.0\.1:8081"/u,
  );
  assert.match(
    tripwire,
    /liveprobe-praxis-runtime-tripwire:\$\{incident\}/u,
  );
  assert.match(tripwire, /"x-trace-id": identity\.traceId/u);
  assert.doesNotMatch(tripwire, /randomUUID/u);
  assert.match(
    campaign,
    /replayBaseUrl: "http:\/\/127\.0\.0\.1:8081"/u,
  );
  assert.match(
    collector,
    /"--replay-base-url", default="http:\/\/localhost:8081"/u,
  );
  assert.match(
    collector,
    /"recipe_id": "astronomy-recommendations"/u,
  );
  assert.match(
    collector,
    /"path": "\/api\/recommendations\?productIds=0PUK6V6EV0"/u,
  );
  assert.doesNotMatch(
    collector,
    /"path": "\/api\/products\//u,
  );
});

test("snapshot collector accepts timezone-qualified ClickHouse windows", async () => {
  const collector = await readFile(
    resolve(evaluationRoot, "python/collect_snapshot.py"),
    "utf8",
  );
  assert.match(
    collector,
    /Timestamp >= parseDateTime64BestEffort\('\{start\.isoformat\(\)\}', 9\)/u,
  );
  assert.match(
    collector,
    /Timestamp <= parseDateTime64BestEffort\('\{end\.isoformat\(\)\}', 9\)/u,
  );
  assert.doesNotMatch(
    collector,
    /Timestamp (?:>=|<=) toDateTime64\('\{(?:start|end)\.isoformat\(\)\}', 9\)/u,
  );
});

test("evidence snapshots reject scorer leakage and preserve revisioned paging", async () => {
  const snapshot = await json(fixture401Path);
  validateEvidenceSnapshot(snapshot);

  const leaked = structuredClone(snapshot);
  leaked.bootstrap.root_cause = "recommendation";
  assert.throws(
    () => validateEvidenceSnapshot(leaked),
    /oracle field leaked/,
  );

  const store = new EvidenceStore(snapshot, {
    defaultPageSize: 1,
    maximumPageSize: 2,
  });
  const first = store.searchLogs({ service: "recommendation", limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.truncated, true);
  const second = store.searchLogs({
    service: "recommendation",
    limit: 1,
    cursor: first.next_cursor,
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.truncated, false);
  assert.throws(
    () => store.searchTraces({ cursor: first.next_cursor }),
    /different snapshot revision or tool/,
  );
});

test("registered replay identities are fresh and deterministic", async () => {
  const snapshot = await json(fixture401Path);
  const store = new EvidenceStore(snapshot);
  const first = await store.replayIncident({
    incident_id: "401",
    recipe_id: "browse-product",
  });
  const second = await store.replayIncident({
    incident_id: "401",
    recipe_id: "browse-product",
  });
  assert.equal(first.replay.replay_id, "replay-401-00000001");
  assert.equal(first.replay.trace_id.length, 32);
  assert.notEqual(first.replay.trace_id, second.replay.trace_id);
  await assert.rejects(
    store.replayIncident({
      incident_id: "401",
      recipe_id: "invented-command",
    }),
    /unknown replay recipe/,
  );
});

test("observability MCP exposes the immutable tool contract", async () => {
  const server = rpcProcess(process.execPath, [
    resolve(evaluationRoot, "src/observability-mcp.mjs"),
    "--snapshot",
    fixture401Path,
  ]);
  try {
    const initialized = await server.request("initialize", {
      protocolVersion: "2025-06-18",
    });
    assert.equal(
      initialized.result.serverInfo.name,
      "liveprobe-praxis-observability",
    );
    const listed = await server.request("tools/list");
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      OBSERVABILITY_TOOLS.map((tool) => tool.name),
    );
    const called = await server.request("tools/call", {
      name: "get_trace",
      arguments: {
        trace_id: "4c010000000000000000000000000001",
      },
    });
    assert.equal(called.result.isError, false);
    assert.equal(
      called.result.structuredContent.snapshot_revision,
      "sha256:fixture401",
    );
    assert.deepEqual(called.result.structuredContent.evidence_ids, [
      "trace_401",
    ]);
  } finally {
    await server.close();
  }
});

const fakeUpstream = `
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
(async () => {
  for await (const line of input) {
    const request = JSON.parse(line);
    let result = {};
    if (request.method === "initialize") {
      result = { instructions: "fake", capabilities: { tools: {} } };
    } else if (request.method === "tools/list") {
      result = { tools: [
        { name: "set_snapshot_probe" },
        { name: "remove_probe" },
        { name: "start_probe_investigation" },
        { name: "get_investigation_context" }
      ] };
    } else if (request.method === "tools/call") {
      result = { content: [{ type: "text", text: "forwarded" }], isError: false };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  }
})();
`;

async function proxy(profile) {
  return rpcProcess(process.execPath, [
    resolve(evaluationRoot, "src/mcp-filter-proxy.mjs"),
    "--profile",
    profile,
    "--",
    process.execPath,
    "-e",
    fakeUpstream,
  ]);
}

test("raw LiveProbe profile removes and rejects graph capabilities", async () => {
  const server = await proxy("raw");
  try {
    const listed = await server.request("tools/list");
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["set_snapshot_probe", "remove_probe"],
    );
    const denied = await server.request("tools/call", {
      name: "start_probe_investigation",
      arguments: {},
    });
    assert.equal(denied.result.isError, true);
    assert.match(
      denied.result.content[0].text,
      /capability_denied/,
    );
  } finally {
    await server.close();
  }
  assert.equal(RAW_LIVEPROBE_TOOLS.has("start_probe_investigation"), false);
});

test("graph LiveProbe profile forwards graph capabilities", async () => {
  const server = await proxy("graph");
  try {
    const listed = await server.request("tools/list");
    assert.ok(
      listed.result.tools.some(
        (tool) => tool.name === "start_probe_investigation",
      ),
    );
    const forwarded = await server.request("tools/call", {
      name: "start_probe_investigation",
      arguments: {},
    });
    assert.equal(forwarded.result.isError, false);
    assert.equal(forwarded.result.content[0].text, "forwarded");
  } finally {
    await server.close();
  }
});

test("LiveProbe ledger counters retain costs without raw probe values", () => {
  const counters = toolCostCounters(
    {
      name: "deploy_investigation_probes",
      arguments: { investigation_id: "investigation-secret" },
    },
    {
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              round: 2,
              probes: [
                { probe: { config: { watchPaths: ["value", "value.id"] } } },
                { probe: { config: { watchPaths: ["flag"] } } },
              ],
            }),
          },
        ],
        isError: false,
      },
    },
  );
  assert.deepEqual(counters, {
    deployed_probes: 2,
    deployed_watches: 3,
    investigation_round: 2,
  });
  assert.equal(JSON.stringify(counters).includes("investigation-secret"), false);
});

test("ledger accounts exact aggregate tokens and enforces budgets", () => {
  const ledger = new EvaluationLedger({
    run_id: "contract",
    arm: "normal_coding_sre",
    incident_id: "401",
    seed: 10,
    model: "contract-model",
    budget: {
      llm_total_tokens: 100,
      observability_queries: 2,
    },
    clock: () => "2026-07-28T00:00:00.000Z",
  });
  ledger.recordTool({
    server: "observability",
    tool: "get_trace",
    response_bytes: 123,
  });
  ledger.recordModel({
    phase: "diagnosis",
    usage_scope: "codex_turn_aggregate",
    model_sample_count_source: "event_lower_bound",
    usage: {
      model_calls: 1,
      model_samples: 3,
      input_tokens: 70,
      cached_input_tokens: 20,
      output_tokens: 10,
      reasoning_tokens: 4,
    },
  });
  assert.deepEqual(ledger.summary(), {
    model_calls: 1,
    model_samples: 3,
    retries: 0,
    input_tokens: 70,
    cached_input_tokens: 20,
    new_input_tokens: 50,
    output_tokens: 10,
    reasoning_tokens: 4,
    model_ms: 0,
    tool_calls: 1,
    tool_response_bytes: 123,
  });
  assert.throws(
    () =>
      ledger.recordModel({
        phase: "diagnosis",
        usage: { input_tokens: 21, output_tokens: 0 },
      }),
    /LLM token budget exceeded/,
  );
});

test("Codex event accounting separates exact tokens from sample lower bound", () => {
  const usage = usageFromEvents([
    {
      type: "item.completed",
      item: { type: "reasoning" },
    },
    {
      type: "item.completed",
      item: { type: "mcp_tool_call" },
    },
    {
      type: "item.completed",
      item: { type: "agent_message" },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 80,
        output_tokens: 15,
        reasoning_output_tokens: 7,
      },
    },
  ]);
  assert.equal(usage.model_calls, 1);
  assert.equal(usage.model_samples, 2);
  assert.equal(usage.input_tokens, 120);
  assert.equal(usage.new_input_tokens, 40);
  assert.equal(usage.reasoning_tokens, 7);
  assert.equal(usage.tool_calls, 1);
});

test("alias-aware multi-root scoring accepts only evidence-backed answers", () => {
  const oracle = {
    accepted_roots: [
      {
        entity: "neo4j-productdb",
        aliases: ["neo4j-productdb-service-1"],
        kinds: ["Service", "ServiceBoundary"],
      },
      {
        entity: "recommendation",
        aliases: ["recommendation-service-1"],
        kinds: ["Service"],
      },
    ],
    entity_alias_groups: [
      ["neo4j-productdb", "neo4j-productdb-service-1"],
      ["recommendation", "recommendation-service-1"],
      ["frontend", "frontend-service-1"],
    ],
    propagation: [
      { from: "neo4j-productdb", to: "recommendation" },
      { from: "recommendation", to: "frontend" },
    ],
    expected_status: "LOCALIZED",
  };
  const answer = {
    status: "LOCALIZED",
    root_cause: {
      entity: "neo4j-productdb-service-1",
      kind: "ServiceBoundary",
    },
    propagation: [
      {
        from: "neo4j-productdb-service-1",
        to: "recommendation-service-1",
        evidence_ids: ["trace-a"],
      },
      {
        from: "recommendation-service-1",
        to: "frontend-service-1",
        evidence_ids: ["trace-a"],
      },
    ],
  };
  assert.equal(scoreDiagnosis(answer, oracle).combined_pass_at_1, true);
  answer.propagation.forEach((edge) => {
    edge.evidence_ids = [];
  });
  assert.equal(scoreDiagnosis(answer, oracle).evidence_backed, false);
});

test("boundary handoff earns credit only with the required diagnosis evidence", () => {
  const oracle = {
    entity: "neo4j-productdb",
    aliases: ["neo4j-productdb-service-1"],
    kinds: ["Service", "ServiceBoundary"],
    locations: [{ resource: "neo4j-productdb" }],
    propagation: [
      { from: "neo4j-productdb", to: "recommendation" },
      { from: "recommendation", to: "frontend" },
    ],
    expected_statuses: ["HANDOFF", "LOCALIZED"],
  };
  const answer = {
    status: "HANDOFF",
    root_cause: {
      entity: "neo4j-productdb-service-1",
      kind: "ServiceBoundary",
      resource: "neo4j-productdb",
    },
    propagation: [
      {
        from: "neo4j-productdb",
        to: "recommendation",
        evidence_ids: ["trace-405"],
      },
      {
        from: "recommendation",
        to: "frontend",
        evidence_ids: ["trace-405"],
      },
    ],
  };
  assert.equal(scoreDiagnosis(answer, oracle).combined_pass_at_1, true);

  const insufficient = structuredClone(answer);
  insufficient.status = "INSUFFICIENT";
  assert.equal(scoreDiagnosis(insufficient, oracle).terminal_correct, false);

  const wrongLocation = structuredClone(answer);
  wrongLocation.root_cause.resource = "different-database";
  assert.equal(scoreDiagnosis(wrongLocation, oracle).rcl_pass_at_1, false);

  const unsupported = structuredClone(answer);
  unsupported.propagation.forEach((edge) => {
    edge.evidence_ids = [];
  });
  assert.equal(scoreDiagnosis(unsupported, oracle).evidence_backed, false);
  assert.equal(scoreDiagnosis(unsupported, oracle).combined_pass_at_1, false);
});

test("summaries report failures, time, and all token categories", () => {
  const usage = {
    ...zeroUsage(),
    model_calls: 1,
    model_samples: 2,
    input_tokens: 100,
    cached_input_tokens: 40,
    new_input_tokens: 60,
    output_tokens: 20,
    reasoning_tokens: 5,
    model_ms: 50,
    tool_calls: 3,
    tool_response_bytes: 400,
  };
  const summary = summarizeResults([
    {
      arm: "normal_coding_sre",
      score: { combined_pass_at_1: true },
      usage,
      wall_ms: 100,
      model_wall_ms: 50,
      runtime_wall_ms: 50,
    },
    {
      arm: "normal_coding_sre",
      score: { combined_pass_at_1: false },
      usage: zeroUsage(),
      wall_ms: 200,
      model_wall_ms: 0,
      runtime_wall_ms: 200,
      failure: { timeout: true },
    },
  ])[0];
  assert.equal(summary.combined_pass_at_1, 0.5);
  assert.equal(summary.failure_rate, 0.5);
  assert.equal(summary.timeout_rate, 0.5);
  assert.equal(summary.median_wall_ms, 150);
  assert.equal(summary.total_input_tokens, 100);
  assert.equal(summary.total_cached_input_tokens, 40);
  assert.equal(summary.total_reasoning_tokens, 5);
});

test("four arm capabilities and guidance remain intentionally distinct", async () => {
  assert.deepEqual(ARM_NAMES, [
    "normal_coding_sre",
    "praxis",
    "graph_liveprobe",
    "raw_liveprobe",
  ]);
  assert.equal(armCapabilities("normal_coding_sre").raw_liveprobe, false);
  assert.equal(armCapabilities("praxis").repository, false);
  assert.equal(armCapabilities("graph_liveprobe").graph_liveprobe, true);
  assert.equal(armCapabilities("raw_liveprobe").graph_liveprobe, false);

  const graph = await loadGuidance("graph_liveprobe");
  const raw = await loadGuidance("raw_liveprobe");
  assert.match(graph, /liveprobe-investigation\/v1\.1/);
  for (const action of [
    "FOLLOW_PATH",
    "PROBE_REGION",
    "INSPECT_MECHANISM",
    "CONFIRM_CANDIDATE",
    "COMPLETE_LOCALIZATION",
    "HANDOFF_BOUNDARY",
  ]) {
    assert.match(graph, new RegExp(`\\b${action}\\b`));
  }
  assert.match(graph, /Expand without probing/);
  assert.match(raw, /model-selected raw-LiveProbe evidence/);
});

test("the source panel, image map, and compatibility matrix cover 401-416", async () => {
  const [scenarios, imageMap, compatibility] = await Promise.all([
    json(resolve(evaluationRoot, "scenarios.json")),
    json(resolve(evaluationRoot, "instrumentation/image-map.json")),
    json(resolve(evaluationRoot, "liveprobe-compatibility.json")),
  ]);
  const expected = Array.from({ length: 16 }, (_, index) =>
    String(401 + index),
  );
  const panel = scenarios.incidents
    .filter((incident) => incident.four_arm)
    .map((incident) => String(incident.id));
  assert.deepEqual(panel, expected);
  assert.deepEqual(Object.keys(imageMap.incidents), expected);
  assert.deepEqual(Object.keys(compatibility.incidents), expected);
  for (const id of expected) {
    assert.ok(
      compatibility.incidents[id].required_boundaries.includes(
        "service:rpc:ListProducts",
      ),
    );
  }
});

test("official oracle is scorer-only, multi-root capable, and private", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "liveprobe-oracle-test-"));
  try {
    const artifact = resolve(temporary, "artifact");
    const truthDirectory = resolve(artifact, "itbench-lite-ae/sre");
    const output = resolve(temporary, "oracle.json");
    await mkdir(truthDirectory, { recursive: true });
    await writeFile(
      resolve(truthDirectory, "ground_truths_all.json"),
      `${JSON.stringify([
        {
          id: 401,
          groups: [
            {
              id: "recommendation-service-1",
              kind: "Service",
              root_cause: true,
              filter: ["recommendation-service-1"],
            },
            {
              id: "neo4j-productdb-service-1",
              kind: "Service",
              root_cause: true,
              filter: ["neo4j-productdb-service-1"],
            },
            {
              id: "frontend-service-1",
              kind: "Service",
              root_cause: false,
            },
          ],
          aliases: [
            ["recommendation-service-1", "recommendation"],
            ["neo4j-productdb-service-1", "neo4j-productdb"],
          ],
          propagations: [
            {
              source: "recommendation-service-1",
              target: "frontend-service-1",
            },
          ],
        },
        {
          id: 405,
          groups: [
            {
              id: "neo4j-productdb-service-1",
              kind: "Service",
              root_cause: true,
              filter: ["neo4j-productdb-service-1"],
            },
            {
              id: "recommendation-service-1",
              kind: "Service",
              root_cause: false,
            },
            {
              id: "frontend-service-1",
              kind: "Service",
              root_cause: false,
            },
          ],
          aliases: [
            ["neo4j-productdb-service-1", "neo4j-productdb"],
            ["recommendation-service-1", "recommendation"],
          ],
          propagations: [
            {
              source: "neo4j-productdb-service-1",
              target: "recommendation-service-1",
            },
            {
              source: "recommendation-service-1",
              target: "frontend-service-1",
            },
          ],
        },
      ])}\n`,
    );
    await buildOfficialOracle({
      artifactRoot: artifact,
      output,
      incidents: ["401", "405"],
    });
    const oracle = await json(output);
    assert.equal(oracle.scorer_only, true);
    assert.equal(oracle.incidents["401"].accepted_roots.length, 2);
    assert.deepEqual(oracle.incidents["401"].expected_statuses, [
      "LOCALIZED",
    ]);
    assert.deepEqual(oracle.incidents["405"].expected_statuses, [
      "HANDOFF",
      "LOCALIZED",
    ]);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
  } finally {
    await chmod(temporary, 0o700).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
});

test("campaign ordering is deterministic and the default path is non-mutating", async () => {
  const first = deterministicShuffle(ARM_NAMES, 411);
  const second = deterministicShuffle(ARM_NAMES, 411);
  assert.deepEqual(first, second);
  assert.deepEqual([...first].sort(), [...ARM_NAMES].sort());

  const { stdout } = await execFile(
    process.execPath,
    [
      resolve(evaluationRoot, "src/campaign.mjs"),
      "--artifact-root=/does/not/need/to/exist/in/plan-mode",
      "--incidents=401",
      "--seeds=10",
    ],
    { cwd: repositoryRoot, timeout: 10_000 },
  );
  const plan = JSON.parse(stdout);
  assert.equal(plan.execute, false);
  assert.equal(plan.model, "gpt-5.4-mini");
  assert.equal(plan.reasoning_effort, "low");
  assert.equal(plan.estimated_model_runs, 4);
});

test("fair PRAXIS wiring pins release cwd, incident graph, and pre-paid gates", async () => {
  const [runner, fairTap, campaign] = await Promise.all([
    readFile(resolve(evaluationRoot, "src/praxis-runner.mjs"), "utf8"),
    readFile(resolve(evaluationRoot, "python/fair_tap_agent.py"), "utf8"),
    readFile(resolve(evaluationRoot, "src/campaign.mjs"), "utf8"),
  ]);
  assert.match(
    runner,
    /cwd = resolve\(options\.artifactRoot, "praxis-ae"\)/,
  );
  assert.match(
    runner,
    /INCIDENT_NUMBER: String\(snapshot\.incident_id\)/,
  );
  assert.match(
    fairTap,
    /os\.environ\["INCIDENT_NUMBER"\] = str\(snapshot\.data\["incident_id"\]\)/,
  );
  assert.match(fairTap, /fair-adapter-no-provider-call/);
  assert.match(fairTap, /no-current-incident\.env/);

  const artifactGate = campaign.indexOf(
    "python/check_praxis_artifact_compatibility.py",
  );
  const releaseImportGate = campaign.indexOf(
    "praxis-import-contract-no-provider-call",
  );
  const imageBuild = campaign.indexOf(
    "scripts/build-instrumented-images.mjs",
  );
  assert.ok(artifactGate >= 0);
  assert.ok(releaseImportGate > artifactGate);
  assert.ok(imageBuild > releaseImportGate);
  assert.match(
    campaign,
    /paid arms cannot start before both incident-401 runtime tripwires/,
  );
});

test("all paid paths require explicit consent and real evidence", async () => {
  await expectCommandFailure(
    process.execPath,
    [
      resolve(evaluationRoot, "src/campaign.mjs"),
      "--artifact-root=/not-used",
      "--execute",
    ],
    /--execute also requires --allow-paid-model/,
  );
  await expectCommandFailure(
    process.execPath,
    [
      resolve(evaluationRoot, "src/benchmark.mjs"),
      "--mode=codex",
      "--incidents=401",
      "--arms=normal_coding_sre",
      "--source-root=/not-used",
    ],
    /paid model execution is disabled/,
  );
  const temporary = await mkdtemp(join(tmpdir(), "praxis-paid-guard-"));
  try {
    await expectCommandFailure(
      process.execPath,
      [
        resolve(evaluationRoot, "src/praxis-runner.mjs"),
        "--mode=fair",
        "--artifact-root=/not-used",
        `--snapshot=${fixture401Path}`,
        `--output=${resolve(temporary, "result.json")}`,
        `--ledger=${resolve(temporary, "ledger.jsonl")}`,
        "--allow-paid-model",
      ],
      /require a real immutable snapshot/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("dirty source metadata is rejected before a coding agent can start", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "praxis-dirty-source-"));
  try {
    await execFile("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: temporary,
    });
    await writeFile(resolve(temporary, "recommendation_server.py"), "x = 1\n");
    await execFile("git", ["add", "recommendation_server.py"], {
      cwd: temporary,
    });
    await execFile(
      "git",
      [
        "-c",
        "user.name=LiveProbe Test",
        "-c",
        "user.email=test@liveprobe.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: temporary },
    );
    await writeFile(
      resolve(temporary, "source-metadata.json"),
      '{"root_cause":"leak"}\n',
    );
    await expectCommandFailure(
      process.execPath,
      [
        resolve(evaluationRoot, "src/benchmark.mjs"),
        "--mode=codex",
        "--incidents=401",
        "--arms=normal_coding_sre",
        `--source-root=${temporary}`,
        `--snapshot=${fixture401Path}`,
        `--output=${resolve(temporary, "outside-result.json")}`,
        "--defer-scoring",
        "--allow-paid-model",
      ],
      /agent source checkout must contain tracked source only/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("fixture tripwire covers every arm without model usage", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "praxis-fixture-run-"));
  try {
    const output = resolve(temporary, "fixture.json");
    await execFile(
      process.execPath,
      [
        resolve(evaluationRoot, "src/benchmark.mjs"),
        "--mode=fixture",
        `--output=${output}`,
      ],
      { cwd: repositoryRoot, timeout: 15_000 },
    );
    const artifact = await json(output);
    assert.equal(artifact.results.length, 12);
    assert.ok(
      artifact.results.every(
        (result) =>
          result.score.combined_pass_at_1 &&
          result.usage.model_calls === 0 &&
          result.usage.input_tokens === 0 &&
          result.usage.output_tokens === 0,
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test(
  "locked PRAXIS sources extract reproducibly when an artifact is supplied",
  {
    skip:
      process.env.PRAXIS_ARTIFACT_ROOT === undefined
        ? "set PRAXIS_ARTIFACT_ROOT for the offline artifact contract"
        : false,
  },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "praxis-extract-test-"));
    try {
      const firstRoot = resolve(temporary, "first");
      const secondRoot = resolve(temporary, "second");
      const first = await extractSources({
        artifactRoot: resolve(process.env.PRAXIS_ARTIFACT_ROOT),
        output: firstRoot,
      });
      const second = await extractSources({
        artifactRoot: resolve(process.env.PRAXIS_ARTIFACT_ROOT),
        output: secondRoot,
      });
      assert.equal(first.length, 16);
      assert.deepEqual(
        first.map((item) => item.git_commit),
        second.map((item) => item.git_commit),
      );
      assert.equal(
        new Set(first.map((item) => item.git_commit)).size,
        16,
      );
      const compatibilityOutput = resolve(
        temporary,
        "praxis-artifact-compatibility.json",
      );
      await execFile(
        "python3.12",
        [
          resolve(
            evaluationRoot,
            "python/check_praxis_artifact_compatibility.py",
          ),
          "--artifact-root",
          resolve(process.env.PRAXIS_ARTIFACT_ROOT),
          "--output",
          compatibilityOutput,
        ],
        { cwd: repositoryRoot, timeout: 30_000 },
      );
      const compatibility = await json(compatibilityOutput);
      assert.equal(compatibility.compatible, true);
      assert.equal(compatibility.summary.incident_assets_passed, 16);
      assert.ok(
        Object.values(compatibility.incidents).every(
          (incident) =>
            incident.anchor_present &&
            incident.source_variant_matches,
        ),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
