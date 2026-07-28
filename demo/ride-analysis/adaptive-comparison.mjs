#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { buildBroker } from "../../packages/broker/dist/src/index.js";
import {
  AnalyzerRunner,
  BrokerClient,
  createToolHandlers,
} from "../../packages/mcp-server/dist/index.js";

const root = resolve(import.meta.dirname, "../..");
const rideRoot = resolve(root, "../ride_sharing_probe_demo");
const resultPath = resolve(
  root,
  process.env["LIVEPROBE_ADAPTIVE_COMPARISON_RESULT"] ??
    "demo/ride-analysis/results/latest-adaptive-comparison.json",
);
const sourceRoots = ["services/gateway", "services/pricing"];
const serviceMap = [
  { source_root: "services/gateway", service_id: "gateway-e2e" },
  { source_root: "services/pricing", service_id: "pricing-e2e" },
];
const captureModelPackets =
  process.env["LIVEPROBE_CAPTURE_MODEL_PACKETS"] === "1";

function parseArguments(argv) {
  const result = {
    decisionMode: "oracle",
    model: undefined,
    repetitions: undefined,
  };
  for (const argument of argv) {
    if (argument === "--allow-external-dossiers") {
      // Retained as a backwards-compatible no-op. External dossier runs for
      // this repository have standing user authorization.
    } else if (argument.startsWith("--decision-mode=")) {
      result.decisionMode = argument.slice("--decision-mode=".length);
    } else if (argument.startsWith("--model=")) {
      result.model = argument.slice("--model=".length);
    } else if (argument.startsWith("--repetitions=")) {
      result.repetitions = Number(argument.slice("--repetitions=".length));
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  if (!["oracle", "codex"].includes(result.decisionMode)) {
    throw new Error("--decision-mode must be oracle or codex");
  }
  result.repetitions ??= result.decisionMode === "codex" ? 3 : 1;
  if (
    !Number.isInteger(result.repetitions) ||
    result.repetitions < 1 ||
    result.repetitions > 10
  ) {
    throw new Error("--repetitions must be an integer between 1 and 10");
  }
  return result;
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun(stdout.trim());
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to reserve a local port");
  }
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

function startTarget({ scenario, port, brokerUrl, commit, pricingUrl }) {
  const python =
    process.env["RIDERUSH_PYTHON"] ?? resolve(rideRoot, ".venv/bin/python");
  const sdkPath = resolve(root, "python/sdk/src");
  const args = [
    resolve(root, "demo/ride-analysis/target.py"),
    "--ride-root",
    rideRoot,
    "--broker-url",
    brokerUrl,
    "--commit",
    commit,
    "--port",
    String(port),
    "--scenario",
    scenario,
  ];
  if (pricingUrl !== undefined) {
    args.push("--pricing-url", pricingUrl);
  }
  const child = spawn(python, args, {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: [sdkPath, rideRoot, process.env["PYTHONPATH"]]
        .filter(Boolean)
        .join(":"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    logs += String(chunk);
  });
  return { child, logs: () => logs };
}

async function stopTarget(target) {
  target.child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (target.child.exitCode !== null) resolveExit();
    else {
      target.child.once("exit", resolveExit);
      setTimeout(() => {
        target.child.kill("SIGKILL");
        resolveExit();
      }, 3_000).unref();
    }
  });
}

async function waitFor(check, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `${label} did not become ready${lastError ? `: ${String(lastError)}` : ""}`,
  );
}

async function waitForService(handlers, serviceId, port) {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    return response.ok;
  }, `${serviceId} HTTP`);
  await waitFor(async () => {
    const response = await handlers.list_services({});
    return response.services.some(
      (service) => service.serviceId === serviceId && service.online,
    );
  }, `${serviceId} heartbeat`);
}

async function waitForArmed(handlers, deployed) {
  await waitFor(async () => {
    const states = await Promise.all(
      deployed.probes.map(({ probe }) =>
        handlers.get_probe_data({ probe_id: probe.id, wait_seconds: 0 }),
      ),
    );
    const errors = states.flatMap((state) =>
      state.events.filter(
        (event) => event.type === "status" && event.status === "error",
      ),
    );
    if (errors.length > 0) {
      throw new Error(`probe arm error: ${JSON.stringify(errors)}`);
    }
    return states.every((state) =>
      state.events.some(
        (event) => event.type === "status" && event.status === "armed",
      ),
    );
  }, "comparison probes");
}

async function waitForSnapshots(handlers, deployed, traceIds) {
  let previousCount = -1;
  let stablePolls = 0;
  await waitFor(async () => {
    const states = await Promise.all(
      deployed.probes.map(({ probe }) =>
        handlers.get_probe_data({ probe_id: probe.id, wait_seconds: 0 }),
      ),
    );
    const snapshots = states.flatMap((state, index) =>
      state.events
        .filter((event) => event.type === "snapshot")
        .map((event) => ({
          serviceId: deployed.probes[index].probe.serviceId,
          traceId: event.correlation?.traceId,
        })),
    );
    const representedServices = new Set(
      deployed.probes.map(({ probe }) => probe.serviceId),
    );
    const complete = [...representedServices].every((serviceId) =>
      traceIds.every((traceId) =>
        snapshots.some(
          (snapshot) =>
            snapshot.serviceId === serviceId &&
            snapshot.traceId === traceId,
        ),
      ),
    );
    if (!complete) {
      previousCount = snapshots.length;
      stablePolls = 0;
      return false;
    }
    if (snapshots.length === previousCount) stablePolls += 1;
    else stablePolls = 0;
    previousCount = snapshots.length;
    // The SDK flush interval is 100 ms. Requiring three quiet polls prevents
    // a gateway batch from winning the race against its pricing batch.
    return stablePolls >= 3;
  }, `snapshots for ${traceIds.join(", ")}`);
}

async function removeAll(handlers, probeIds) {
  for (const probeId of [...probeIds]) {
    await handlers.remove_probe({ probe_id: probeId }).catch(() => undefined);
    probeIds.delete(probeId);
  }
}

function structuralNode(node) {
  const {
    source: _source,
    ...structure
  } = node;
  return structure;
}

function graphEdgeKey(edge) {
  return JSON.stringify([
    edge.source,
    edge.target,
    edge.kind,
    edge.variable ?? null,
  ]);
}

function createPacketState() {
  return {
    initialized: false,
    nodeIds: new Set(),
    edgeKeys: new Set(),
    collapsedFunctionIds: new Set(),
    coverageNotes: new Set(),
  };
}

function modelDossier(dossier) {
  const {
    sequence_index: _sequenceIndex,
    sequence_scope: _sequenceScope,
    timestamp: _timestamp,
    ...rest
  } = dossier;
  return rest;
}

function compactDecisionPacket(investigation, occurrenceId, packetState) {
  const valueDossiers = investigation.value_dossiers
    .filter((dossier) => dossier["occurrence_id"] === occurrenceId)
    .map(modelDossier);
  const dossierIds = new Set(
    valueDossiers.map((dossier) => dossier["dossier_id"]),
  );
  const nodes = (investigation.graph["nodes"] ?? [])
    .filter((node) => !packetState.nodeIds.has(node.node_id))
    .map(structuralNode);
  for (const node of nodes) packetState.nodeIds.add(node.node_id);
  const edges = (investigation.graph["edges"] ?? []).filter((edge) => {
    const key = graphEdgeKey(edge);
    if (packetState.edgeKeys.has(key)) return false;
    packetState.edgeKeys.add(key);
    return true;
  });
  const collapsedFunctions = (
    investigation.graph["collapsedFunctions"] ?? []
  ).filter((summary) => {
    if (packetState.collapsedFunctionIds.has(summary.functionId)) {
      return false;
    }
    packetState.collapsedFunctionIds.add(summary.functionId);
    return true;
  });
  const coverageNotes = investigation.coverage_notes.filter((note) => {
    if (packetState.coverageNotes.has(note)) return false;
    packetState.coverageNotes.add(note);
    return true;
  });
  const initial = !packetState.initialized;
  packetState.initialized = true;
  return {
    protocol: "liveprobe-investigation-delta-v1",
    orderingSemantics:
      "Use causal graph edges for cross-service order; incomparable agent-local sequence counters are omitted.",
    ...(initial
      ? {
          incident: {
            symptom: investigation.criterion["symptom"],
            failureClass: investigation.criterion["failure_class"],
          },
        }
      : {}),
    phase: investigation.phase,
    round: investigation.round,
    graphDelta: {
      nodes,
      edges,
      collapsedFunctions,
      unresolvedBranches: investigation.graph["unresolvedBranches"],
    },
    currentRoundValueDossiers: valueDossiers,
    currentRoundJudgments: investigation.judgments.filter((judgment) =>
      dossierIds.has(judgment["dossier_id"]),
    ),
    actions: investigation.actions,
    newCoverageNotes: coverageNotes,
  };
}

function compactMechanismPacket(investigation) {
  return {
    protocol: "liveprobe-final-mechanism-v1",
    mechanismContext: investigation.mechanism_context,
    actions: investigation.actions.filter(
      (action) => action.kind === "VERIFY_MECHANISM",
    ),
  };
}

function parseCodexEvents(stdout) {
  const events = [];
  for (const line of stdout.split("\n")) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Codex JSONL can contain non-event diagnostic lines.
    }
  }
  return events;
}

function usageFromEvents(events, elapsedMs) {
  let raw = {};
  for (const event of events) {
    if (event.type === "turn.completed" && event.usage) {
      raw = event.usage;
    }
  }
  const inputTokens = Number(raw.input_tokens ?? 0);
  const cachedInputTokens = Number(raw.cached_input_tokens ?? 0);
  return {
    calls: 1,
    inputTokens,
    cachedInputTokens,
    newInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens: Number(raw.output_tokens ?? 0),
    reasoningTokens: Number(raw.reasoning_output_tokens ?? 0),
    elapsedMs,
  };
}

function addUsage(left, right) {
  return {
    calls: left.calls + right.calls,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    newInputTokens: left.newInputTokens + right.newInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    elapsedMs: left.elapsedMs + right.elapsedMs,
  };
}

const zeroUsage = () => ({
  calls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  newInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  elapsedMs: 0,
});

class CodexInvestigationSession {
  constructor({ model }) {
    this.model = model;
    this.temporaryRoot = undefined;
    this.sessionId = undefined;
    this.turn = 0;
  }

  async initialize() {
    this.temporaryRoot = await mkdtemp(
      join(tmpdir(), "liveprobe-investigation-"),
    );
  }

  async decide({ prompt, schema }) {
    if (this.temporaryRoot === undefined) await this.initialize();
    this.turn += 1;
    const schemaPath = join(
      this.temporaryRoot,
      `schema-${this.turn}.json`,
    );
    const answerPath = join(
      this.temporaryRoot,
      `answer-${this.turn}.json`,
    );
    await writeFile(schemaPath, JSON.stringify(schema));
    const common = [
      "--skip-git-repo-check",
      "--config",
      'web_search="disabled"',
      "--config",
      "agents.enabled=false",
      "--config",
      "mcp_servers={}",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      answerPath,
    ];
    if (this.model !== undefined) common.push("--model", this.model);
    const args =
      this.sessionId === undefined
        ? [
            "exec",
            "--ignore-user-config",
            "--ignore-rules",
            "--json",
            "--sandbox",
            "read-only",
            "--cd",
            this.temporaryRoot,
            ...common,
            prompt,
          ]
        : [
            "exec",
            "resume",
            "--ignore-user-config",
            "--ignore-rules",
            "--json",
            ...common,
            this.sessionId,
            prompt,
          ];
    const started = performance.now();
    const stdout = await run("codex", args, {
      cwd: this.temporaryRoot,
    });
    const elapsedMs = Math.round(performance.now() - started);
    const events = parseCodexEvents(stdout);
    if (this.sessionId === undefined) {
      const startedEvent = events.find(
        (event) => event.type === "thread.started",
      );
      this.sessionId =
        startedEvent?.thread_id ??
        startedEvent?.session_id ??
        startedEvent?.thread?.id;
      if (typeof this.sessionId !== "string") {
        throw new Error(
          `Codex did not report a persistent session id: ${stdout}`,
        );
      }
    }
    return {
      answer: JSON.parse(await readFile(answerPath, "utf8")),
      usage: usageFromEvents(events, elapsedMs),
      sessionTurn: this.turn,
    };
  }

  async close() {
    if (this.temporaryRoot !== undefined) {
      await rm(this.temporaryRoot, { recursive: true, force: true });
      this.temporaryRoot = undefined;
    }
  }
}

function oracleAction(investigation) {
  const follow = investigation.actions.find(
    (action) =>
      action.kind === "FOLLOW_PATH" &&
      action.function_id?.includes("services/pricing/app.py:quote"),
  );
  if (follow !== undefined) {
    return {
      selected_action_id: follow.action_id,
      rationale: "oracle harness: cross the pricing response boundary",
    };
  }
  const nodes = new Map(
    (investigation.graph["nodes"] ?? []).map((node) => [
      node.node_id,
      node,
    ]),
  );
  const inspect = investigation.actions.find(
    (action) =>
      action.kind === "INSPECT_MECHANISM" &&
      String(nodes.get(action.anchor_node_id)?.source ?? "").includes(
        "surge =",
      ),
  );
  if (inspect !== undefined) {
    return {
      selected_action_id: inspect.action_id,
      rationale: "oracle harness: select the earliest divergent surge producer",
    };
  }
  throw new Error(
    `oracle found no expected legal action: ${JSON.stringify(
      investigation.actions,
    )}`,
  );
}

async function chooseAction({
  investigation,
  occurrenceId,
  packetState,
  decisionMode,
  codexSession,
  policy,
}) {
  const legalActions = investigation.actions.filter((action) =>
    ["FOLLOW_PATH", "INSPECT_MECHANISM", "HANDOFF_BOUNDARY"].includes(
      action.kind,
    ),
  );
  if (legalActions.length === 1) {
    const [action] = legalActions;
    return {
      answer: {
        selected_action_id: action.action_id,
        rationale:
          "deterministic single legal action; no frontier-ranking call needed",
      },
      usage: zeroUsage(),
      packetBytes: 0,
      packetStats: {
        modelPacketElided: true,
        legalActions: 1,
      },
      ...(captureModelPackets
        ? { modelPacket: { elided: true, reason: "single legal action" } }
        : {}),
      sessionTurn: 0,
    };
  }
  const packet = compactDecisionPacket(
    investigation,
    occurrenceId,
    packetState,
  );
  const packetText = JSON.stringify(packet);
  const packetStats = {
    graphDeltaNodes: packet.graphDelta.nodes.length,
    graphDeltaEdges: packet.graphDelta.edges.length,
    graphDeltaCollapsedFunctions:
      packet.graphDelta.collapsedFunctions.length,
    currentRoundDossiers: packet.currentRoundValueDossiers.length,
    currentRoundJudgments: packet.currentRoundJudgments.length,
    containsGraphSource: packet.graphDelta.nodes.some(
      (node) => Object.hasOwn(node, "source"),
    ),
  };
  if (decisionMode === "oracle") {
    return {
      answer: oracleAction(investigation),
      usage: zeroUsage(),
      packetBytes: Buffer.byteLength(packetText),
      packetStats,
      ...(captureModelPackets ? { modelPacket: packet } : {}),
    };
  }
  const actionIds = legalActions.map((action) => action.action_id);
  const result = await codexSession.decide({
    schema: {
      type: "object",
      properties: {
        selected_action_id: { type: "string", enum: actionIds },
        rationale: { type: "string" },
      },
      required: ["selected_action_id", "rationale"],
      additionalProperties: false,
    },
    prompt:
      (packet.incident === undefined
        ? "Continue the same persistent investigation. This packet contains " +
          "only newly expanded graph structure and the current replay evidence. "
        : "Begin a persistent production-debugging investigation. Future turns " +
          "will provide graph deltas and current replay evidence only. ") +
      "Select " +
      "exactly one supplied legal action using only this packet. Prefer an " +
      "earlier observed divergence over its downstream consequences. FOLLOW_PATH " +
      "does not discard other paths. Structural graph nodes intentionally omit " +
      "source; source is revealed only for final mechanism adjudication. Keep " +
      "prior evidence and decisions in session memory. Do not use tools or invent IDs.\n\n" +
      `Policy under test: ${policy}\n\n` +
      packetText,
  });
  return {
    ...result,
    packetBytes: Buffer.byteLength(packetText),
    packetStats,
    ...(captureModelPackets ? { modelPacket: packet } : {}),
  };
}

async function chooseVerification({
  investigation,
  decisionMode,
  codexSession,
}) {
  const packet = compactMechanismPacket(investigation);
  const packetText = JSON.stringify(packet);
  const verifyActions = investigation.actions.filter(
    (action) => action.kind === "VERIFY_MECHANISM",
  );
  if (verifyActions.length !== 1) {
    throw new Error("expected exactly one verification action");
  }
  if (decisionMode === "oracle") {
    return {
      answer: {
        selected_action_id: verifyActions[0].action_id,
        mechanism:
          "surge_poison replaces the configured multiplier with 50.0 before amount is calculated",
      },
      usage: zeroUsage(),
      packetBytes: Buffer.byteLength(packetText),
      packetStats: {
        finalHammockReveal: true,
        containsMechanismSource:
          investigation.mechanism_context !== null,
      },
      ...(captureModelPackets ? { modelPacket: packet } : {}),
    };
  }
  const result = await codexSession.decide({
    schema: {
      type: "object",
      properties: {
        selected_action_id: {
          type: "string",
          enum: verifyActions.map((action) => action.action_id),
        },
        mechanism: { type: "string" },
      },
      required: ["selected_action_id", "mechanism"],
      additionalProperties: false,
    },
    prompt:
      "Continue the same persistent investigation. This is the one final " +
      "bounded source reveal: use the newly revealed hammock to describe the " +
      "Describe the concrete mechanism supported by runtime evidence and choose " +
      "the supplied verification action. Do not use tools.\n\n" +
      packetText,
  });
  return {
    ...result,
    packetBytes: Buffer.byteLength(packetText),
    packetStats: {
      finalHammockReveal: true,
      containsMechanismSource:
        investigation.mechanism_context !== null,
    },
    ...(captureModelPackets ? { modelPacket: packet } : {}),
  };
}

async function replayPair({ gatewayPort, prefix }) {
  const body = {
    rider_id: "rider-e2e",
    x: 16,
    y: 16,
    dest_x: 22,
    dest_y: 24,
  };
  const execute = async (role) => {
    const traceId = `${prefix}-${role}`;
    const response = await fetch(
      `http://127.0.0.1:${gatewayPort}/request_ride`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-liveprobe-replay-id": traceId,
          "x-trace-id": `${prefix}-business-trace`,
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(
        `${role} gateway replay failed: ${response.status} ${await response.text()}`,
      );
    }
    return { traceId, body: await response.json() };
  };
  const passing = await execute("pass");
  const failing = await execute("fail");
  if (!(Number(failing.body.quote) > Number(passing.body.quote) * 10)) {
    throw new Error("surge fault did not create a large quote divergence");
  }
  return { passing, failing };
}

async function deployAndCollectPair({
  handlers,
  investigation,
  deployedIds,
  gatewayPort,
  tracePrefix,
}) {
  const deployed = await handlers.deploy_investigation_probes({
    repository_root: rideRoot,
    investigation_id: investigation.investigation_id,
    service_map: serviceMap,
    hit_limit: 2,
  });
  for (const { probe } of deployed.probes) deployedIds.add(probe.id);
  await waitForArmed(handlers, deployed);
  const replay = await replayPair({ gatewayPort, prefix: tracePrefix });
  await waitForSnapshots(handlers, deployed, [
    replay.passing.traceId,
    replay.failing.traceId,
  ]);
  const collected = await handlers.collect_investigation_evidence({
    repository_root: rideRoot,
    investigation_id: investigation.investigation_id,
    occurrences: [
      {
        occurrence_id: `trace:${replay.passing.traceId}`,
        role: "passing",
        pair_id: tracePrefix,
      },
      {
        occurrence_id: `trace:${replay.failing.traceId}`,
        role: "failing",
        pair_id: tracePrefix,
      },
    ],
    wait_seconds: 4,
  });
  return {
    investigation: collected.investigation,
    replay,
    probes: deployed.probes.length,
  };
}

async function verifyAndComplete({
  handlers,
  investigation,
  mechanism,
  deployedIds,
  gatewayPort,
  tracePrefix,
}) {
  const deployed = await handlers.deploy_investigation_probes({
    repository_root: rideRoot,
    investigation_id: investigation.investigation_id,
    service_map: serviceMap,
    hit_limit: 1,
  });
  for (const { probe } of deployed.probes) deployedIds.add(probe.id);
  await waitForArmed(handlers, deployed);
  const traceId = `${tracePrefix}-verify-fail`;
  const response = await fetch(
    `http://127.0.0.1:${gatewayPort}/request_ride`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-liveprobe-replay-id": traceId,
        "x-trace-id": `${tracePrefix}-business-trace`,
      },
      body: JSON.stringify({
        rider_id: "rider-e2e",
        x: 16,
        y: 16,
        dest_x: 22,
        dest_y: 24,
      }),
    },
  );
  if (!response.ok) throw new Error("verification replay failed");
  await waitForSnapshots(handlers, deployed, [traceId]);
  const collected = await handlers.collect_investigation_evidence({
    repository_root: rideRoot,
    investigation_id: investigation.investigation_id,
    occurrences: [
      {
        occurrence_id: `trace:${traceId}`,
        role: "failing",
      },
    ],
    wait_seconds: 4,
  });
  investigation = collected.investigation;
  const complete = investigation.actions.find(
    (action) => action.kind === "COMPLETE_LOCALIZATION",
  );
  if (complete === undefined) {
    throw new Error("verification produced no completion action");
  }
  const evidence = [...investigation.decision_log]
    .reverse()
    .find((entry) => entry["kind"] === "EVIDENCE_RECORDED");
  investigation = await handlers.apply_investigation_decision({
    repository_root: rideRoot,
    investigation_id: investigation.investigation_id,
    action_ids: [complete.action_id],
    mechanism,
    evidence_refs: evidence?.["observationIds"] ?? [],
  });
  return { investigation, probes: deployed.probes.length };
}

async function startInvestigation(handlers, commit) {
  let investigation = await handlers.start_probe_investigation({
    repository_root: rideRoot,
    commit_hash: commit,
    service_id: "gateway-e2e",
    file: "services/gateway/app.py",
    line: 83,
    watch_path: "pricing.quote",
    symptom: "a rider received an implausibly high quote",
    failure_class: "semantic",
    probe_budget: 10,
    source_roots: sourceRoots,
    ownership_map: serviceMap,
  });
  const differential = investigation.actions.find(
    (action) => action.kind === "REQUEST_DIFFERENTIAL",
  );
  if (differential === undefined) {
    throw new Error("investigation did not offer a differential capture");
  }
  investigation = await handlers.apply_investigation_decision({
    repository_root: rideRoot,
    investigation_id: investigation.investigation_id,
    action_ids: [differential.action_id],
  });
  return investigation;
}

async function runPolicy({
  policy,
  handlers,
  commit,
  gatewayPort,
  decisionMode,
  model,
  deployedIds,
}) {
  const started = performance.now();
  const codexSession =
    decisionMode === "codex"
      ? new CodexInvestigationSession({ model })
      : undefined;
  const packetState = createPacketState();
  const steps = [];
  let usage = zeroUsage();
  let totalProbes = 0;
  let replayRounds = 0;
  try {
    let investigation = await startInvestigation(handlers, commit);

    if (policy === "eager_full_graph") {
      while (true) {
        const follow = investigation.actions.find(
          (action) => action.kind === "FOLLOW_PATH",
        );
        if (follow === undefined) break;
        investigation = await handlers.apply_investigation_decision({
          repository_root: rideRoot,
          investigation_id: investigation.investigation_id,
          action_ids: [follow.action_id],
        });
        steps.push({
          stage: "deterministic-eager-expansion",
          actionId: follow.action_id,
          label: follow.label,
          graphNodes: investigation.stats["graphNodes"],
        });
      }
    }

    let mechanism;
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const captured = await deployAndCollectPair({
        handlers,
        investigation,
        deployedIds,
        gatewayPort,
        tracePrefix: `${policy}-round-${iteration + 1}`,
      });
      investigation = captured.investigation;
      totalProbes += captured.probes;
      replayRounds += 1;

      const decision = await chooseAction({
        investigation,
        occurrenceId: `trace:${captured.replay.failing.traceId}`,
        packetState,
        decisionMode,
        codexSession,
        policy,
      });
      usage = addUsage(usage, decision.usage);
      const selected = investigation.actions.find(
        (action) =>
          action.action_id === decision.answer.selected_action_id,
      );
      if (selected === undefined) {
        throw new Error("decision selected an unavailable action");
      }
      steps.push({
        stage: "runtime-decision",
        round: investigation.round,
        replay: {
          passingQuote: captured.replay.passing.body.quote,
          failingQuote: captured.replay.failing.body.quote,
        },
        probes: captured.probes,
        graphNodes: investigation.stats["graphNodes"],
        expandedFunctions: investigation.stats["expandedFunctions"],
        packetBytes: decision.packetBytes,
        packetStats: decision.packetStats,
        ...(decision.modelPacket === undefined
          ? {}
          : { modelPacket: decision.modelPacket }),
        modelTurnUsage: decision.usage,
        sessionTurn: decision.sessionTurn,
        actionId: selected.action_id,
        actionKind: selected.kind,
        actionLabel: selected.label,
        rationale: decision.answer.rationale,
        suspiciousLocations: investigation.judgments
          .filter(
            (judgment) =>
              judgment["basis"] === "DIFFERENTIAL" &&
              judgment["classification"] === "SUSPICIOUS",
          )
          .map((judgment) => {
            const dossier = investigation.value_dossiers.find(
              (value) => value["dossier_id"] === judgment["dossier_id"],
            );
            return dossier?.["location"];
          })
          .filter(Boolean),
      });
      investigation = await handlers.apply_investigation_decision({
        repository_root: rideRoot,
        investigation_id: investigation.investigation_id,
        action_ids: [selected.action_id],
      });
      if (selected.kind === "FOLLOW_PATH") continue;
      if (selected.kind !== "INSPECT_MECHANISM") {
        throw new Error(`unexpected terminal action ${selected.kind}`);
      }

      const verification = await chooseVerification({
        investigation,
        decisionMode,
        codexSession,
      });
      usage = addUsage(usage, verification.usage);
      mechanism = verification.answer.mechanism;
      steps.push({
        stage: "mechanism-and-verification",
        packetBytes: verification.packetBytes,
        packetStats: verification.packetStats,
        ...(verification.modelPacket === undefined
          ? {}
          : { modelPacket: verification.modelPacket }),
        modelTurnUsage: verification.usage,
        sessionTurn: verification.sessionTurn,
        actionId: verification.answer.selected_action_id,
        mechanism,
      });
      investigation = await handlers.apply_investigation_decision({
        repository_root: rideRoot,
        investigation_id: investigation.investigation_id,
        action_ids: [verification.answer.selected_action_id],
        mechanism,
      });
      break;
    }
    if (investigation.phase !== "VERIFYING" || mechanism === undefined) {
      throw new Error(`${policy} did not reach verification`);
    }

    const verified = await verifyAndComplete({
      handlers,
      investigation,
      mechanism,
      deployedIds,
      gatewayPort,
      tracePrefix: policy,
    });
    investigation = verified.investigation;
    totalProbes += verified.probes;
    replayRounds += 1;
    if (investigation.status !== "LOCALIZED") {
      throw new Error(`${policy} ended ${investigation.status}`);
    }
    const selectedSurge = steps.some(
      (step) =>
        step.stage === "runtime-decision" &&
        step.actionKind === "INSPECT_MECHANISM" &&
        step.actionLabel.includes("services/pricing/app.py:74"),
    );
    return {
      policy,
      decisionMode,
      success: selectedSurge,
      finalStatus: investigation.status,
      replayRounds,
      totalProbes,
      modelUsage: usage,
      modelProtocol:
        decisionMode === "codex"
          ? "persistent-session-graph-delta-v1"
          : "deterministic-oracle",
      sessionTurns: codexSession?.turn ?? 0,
      finalGraphNodes: investigation.stats["graphNodes"],
      expandedFunctions: investigation.stats["expandedFunctions"],
      elapsedMs: Math.round(performance.now() - started),
      steps,
    };
  } finally {
    await codexSession?.close();
  }
}

async function withTargets({
  handlers,
  brokerUrl,
  commit,
  callback,
}) {
  const pricingPort = await freePort();
  const gatewayPort = await freePort();
  const pricing = startTarget({
    scenario: "pricing",
    port: pricingPort,
    brokerUrl,
    commit,
  });
  const gateway = startTarget({
    scenario: "gateway",
    port: gatewayPort,
    brokerUrl,
    commit,
    pricingUrl: `http://127.0.0.1:${pricingPort}`,
  });
  const deployedIds = new Set();
  try {
    await waitForService(handlers, "pricing-e2e", pricingPort);
    await waitForService(handlers, "gateway-e2e", gatewayPort);
    return await callback({ gatewayPort, deployedIds });
  } finally {
    await stopTarget(gateway);
    await stopTarget(pricing);
    await removeAll(handlers, deployedIds);
    const logs = `${gateway.logs()}\n${pricing.logs()}`;
    if (logs.includes("Traceback")) {
      process.stderr.write(logs.slice(-6_000));
    }
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function summarizeRuns(runs) {
  const policies = ["adaptive_lazy", "eager_full_graph"];
  return Object.fromEntries(
    policies.map((policy) => {
      const values = runs
        .flatMap((runResult) => runResult.policies)
        .filter((result) => result.policy === policy);
      return [
        policy,
        {
          runs: values.length,
          successes: values.filter((value) => value.success).length,
          medianReplayRounds: median(
            values.map((value) => value.replayRounds),
          ),
          medianProbes: median(
            values.map((value) => value.totalProbes),
          ),
          medianElapsedMs: median(
            values.map((value) => value.elapsedMs),
          ),
          modelCalls: values.reduce(
            (total, value) => total + value.modelUsage.calls,
            0,
          ),
          inputTokens: values.reduce(
            (total, value) => total + value.modelUsage.inputTokens,
            0,
          ),
          cachedInputTokens: values.reduce(
            (total, value) =>
              total + value.modelUsage.cachedInputTokens,
            0,
          ),
          newInputTokens: values.reduce(
            (total, value) =>
              total + value.modelUsage.newInputTokens,
            0,
          ),
          outputTokens: values.reduce(
            (total, value) => total + value.modelUsage.outputTokens,
            0,
          ),
          modelElapsedMs: values.reduce(
            (total, value) => total + value.modelUsage.elapsedMs,
            0,
          ),
          decisionPacketBytes: values.reduce(
            (total, value) =>
              total +
              value.steps.reduce(
                (subtotal, step) =>
                  subtotal + Number(step.packetBytes ?? 0),
                0,
              ),
            0,
          ),
        },
      ];
    }),
  );
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const started = performance.now();
  const commit = await run("git", ["rev-parse", "HEAD"], { cwd: rideRoot });
  const broker = await buildBroker({ persistence: false });
  await broker.listen({ host: "127.0.0.1", port: 0 });
  const address = broker.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("broker did not expose a TCP address");
  }
  const brokerUrl = `http://127.0.0.1:${address.port}`;
  const handlers = createToolHandlers(
    new BrokerClient(brokerUrl),
    new AnalyzerRunner({
      pythonCommand:
        process.env["LIVEPROBE_ANALYZER_PYTHON"] ?? "python3.12",
      pythonPath: resolve(root, "python/analyzer/src"),
    }),
  );
  try {
    await handlers.prepare_repository_analysis({
      repository_root: rideRoot,
      commit_hash: commit,
    });
    const runs = [];
    for (let repetition = 1; repetition <= args.repetitions; repetition += 1) {
      const order =
        repetition % 2 === 1
          ? ["adaptive_lazy", "eager_full_graph"]
          : ["eager_full_graph", "adaptive_lazy"];
      const policies = [];
      for (const policy of order) {
        policies.push(
          await withTargets({
            handlers,
            brokerUrl,
            commit,
            callback: ({ gatewayPort, deployedIds }) =>
              runPolicy({
                policy,
                handlers,
                commit,
                gatewayPort,
                decisionMode: args.decisionMode,
                model: args.model,
                deployedIds,
              }),
          }),
        );
      }
      runs.push({ repetition, order, policies });
    }
    const summary = summarizeRuns(runs);
    const result = {
      status: Object.values(summary).every(
        (policy) => policy.successes === policy.runs,
      )
        ? "passed"
        : "failed",
      validity:
        args.decisionMode === "codex"
          ? "external-model-comparison"
          : "oracle-harness-validation-only",
      decisionMode: args.decisionMode,
      model: args.model ?? "codex-default",
      repository: rideRoot,
      commit,
      hiddenGroundTruth: {
        file: "services/pricing/app.py",
        sourceLine: 74,
        mechanism:
          "surge_poison replaces the configured surge with 50.0",
        includedInModelPackets: false,
      },
      controls: {
        sameIncident: true,
        sameProbeBudgetPerRound: 10,
        samePassingAndFailingInputs: true,
        sameVerificationRequirement: true,
        unchosenAdaptivePathsPruned: false,
        methodOrderAlternated: true,
        modelProtocol:
          args.decisionMode === "codex"
            ? "one persistent session per investigation; structural graph " +
              "deltas and current-round dossiers; one final hammock reveal"
            : "deterministic oracle over the same legal actions",
        repetitions: args.repetitions,
      },
      summary,
      runs,
      elapsedMs: Math.round(performance.now() - started),
    };
    await mkdir(resolve(resultPath, ".."), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "passed") process.exitCode = 1;
  } finally {
    await broker.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
