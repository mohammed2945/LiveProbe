#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { buildBroker } from "../../packages/broker/dist/src/index.js";
import {
  AnalyzerRunner,
  BrokerClient,
  createToolHandlers,
} from "../../packages/mcp-server/dist/index.js";
import {
  CodexSession,
  addUsage,
  buildSourceHierarchy,
  compactCapturedValue,
  exactRootCause,
  mean,
  median,
  removeProbes,
  replayFailingRequest,
  run,
  startRideTargets,
  waitForArmed,
  waitForSnapshots,
  zeroUsage,
} from "./benchmark-support.mjs";

const root = resolve(import.meta.dirname, "../..");
const rideRoot = resolve(root, "../ride_sharing_probe_demo");
const methodNames = [
  "normal_codex",
  "praxis_style",
  "react_liveprobe",
  "graph_liveprobe",
];

const incident = {
  title: "RideRush returned an implausibly high quote",
  deployedCommit: undefined,
  request: {
    method: "POST",
    route: "/request_ride",
    rider_id: "rider-benchmark",
    x: 16,
    y: 16,
    dest_x: 22,
    dest_y: 24,
  },
  observedResponse: {
    status: 200,
    quote: 1718.5,
  },
  logs: [
    "gateway request completed status=200 route=/request_ride",
    "pricing request completed status=200 route=/quote",
    "matching request completed status=200 route=/assign",
    "trips request completed status=200 route=/trips",
    "no exception, timeout, or failed health check was recorded",
  ],
  trace: [
    "gateway POST /request_ride",
    "gateway -> pricing GET /quote status=200",
    "gateway -> matching POST /assign status=200",
    "gateway -> trips POST /trips status=200",
    "gateway response status=200 quote=1718.5",
  ],
};

const diagnosisSchema = {
  type: "object",
  properties: {
    root_cause_file: { type: "string" },
    root_cause_line: { type: "integer" },
    mechanism: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "root_cause_file",
    "root_cause_line",
    "mechanism",
    "confidence",
  ],
  additionalProperties: false,
};

function parseArguments(argv) {
  const result = {
    decisionMode: "oracle",
    repetitions: undefined,
    model: process.env["LIVEPROBE_BENCHMARK_MODEL"],
    methods: [...methodNames],
  };
  for (const argument of argv) {
    if (argument.startsWith("--decision-mode=")) {
      result.decisionMode = argument.slice("--decision-mode=".length);
    } else if (argument.startsWith("--repetitions=")) {
      result.repetitions = Number(argument.slice("--repetitions=".length));
    } else if (argument.startsWith("--model=")) {
      result.model = argument.slice("--model=".length);
    } else if (argument.startsWith("--methods=")) {
      result.methods = argument
        .slice("--methods=".length)
        .split(",")
        .filter(Boolean);
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
    throw new Error("--repetitions must be between 1 and 10");
  }
  const unknown = result.methods.filter(
    (method) => !methodNames.includes(method),
  );
  if (unknown.length > 0 || result.methods.length === 0) {
    throw new Error(`unknown or empty methods: ${unknown.join(", ")}`);
  }
  return result;
}

function oracleDiagnosis() {
  return {
    root_cause_file: "services/pricing/app.py",
    root_cause_line: 74,
    mechanism:
      "surge_poison selects a surge multiplier of 50 before quote arithmetic",
    confidence: 1,
  };
}

function resultBase({
  method,
  started,
  usage,
  turns,
  answer,
  replayRounds = 0,
  probes = 0,
  runtimeMs = 0,
  deterministicActions = 0,
  localizationMs,
  verificationMs = null,
  status,
}) {
  const wallMs = Math.round(performance.now() - started);
  const localized = exactRootCause(answer);
  return {
    method,
    status:
      status ?? (localized ? "localized" : "incorrect"),
    exactRootCause: localized,
    answer,
    usage,
    wallMs,
    localizationMs: localizationMs ?? (localized ? wallMs : null),
    verificationMs,
    modelMs: usage.elapsedMs,
    runtimeMs,
    replayRounds,
    probes,
    deterministicActions,
    promptBytes: turns.reduce(
      (total, turn) => total + Number(turn.packetBytes ?? 0),
      0,
    ),
    promptTextBytes: turns.reduce(
      (total, turn) => total + Number(turn.promptBytes ?? 0),
      0,
    ),
    schemaBytes: turns.reduce(
      (total, turn) => total + Number(turn.schemaBytes ?? 0),
      0,
    ),
    turns,
  };
}

async function runNormalCodex({ decisionMode, model }) {
  const started = performance.now();
  if (decisionMode === "oracle") {
    const answer = oracleDiagnosis();
    return resultBase({
      method: "normal_codex",
      started,
      usage: zeroUsage(),
      turns: [],
      answer,
    });
  }
  const session = new CodexSession({
    model,
    cwd: rideRoot,
    allowRepositoryTools: true,
  });
  try {
    const turn = await session.decide({
      schema: diagnosisSchema,
      prompt:
        "Act as a normal coding-agent SRE. Investigate the incident below in " +
        "the current RideRush checkout and identify the earliest code statement " +
        "that creates the wrong value, not merely where it is logged or returned. " +
        "You may use ordinary read-only repository tools. Do not inspect sibling " +
        "repositories, benchmark harnesses, or prior benchmark results. You have " +
        "no LiveProbe runtime values and no precomputed dependency graph.\n\n" +
        JSON.stringify(incident),
    });
    return resultBase({
      method: "normal_codex",
      started,
      usage: turn.usage,
      turns: [turn],
      answer: turn.answer,
    });
  } finally {
    await session.close();
  }
}

async function runPraxisStyle({
  decisionMode,
  model,
  hierarchy,
}) {
  const started = performance.now();
  if (decisionMode === "oracle") {
    const answer = oracleDiagnosis();
    return resultBase({
      method: "praxis_style",
      started,
      usage: zeroUsage(),
      turns: [],
      answer,
    });
  }
  const session = new CodexSession({
    model,
    cwd: rideRoot,
    allowRepositoryTools: false,
  });
  let usage = zeroUsage();
  const turns = [];
  try {
    const communityOptions = hierarchy.communities.map((community) => ({
      id: community.id,
      files: community.files,
      functionCount: community.functions.length,
    }));
    const communityTurn = await session.decide({
      schema: {
        type: "object",
        properties: {
          community_id: {
            type: "string",
            enum: communityOptions.map((option) => option.id),
          },
          rationale: { type: "string" },
        },
        required: ["community_id", "rationale"],
        additionalProperties: false,
      },
      prompt:
        "Perform a controlled PRAXIS-style hierarchical investigation. You " +
        "receive logs/traces and a service/source hierarchy, but no LiveProbe " +
        "values, dependency graph, shell, or repository tools. Select the one " +
        "code community most likely to contain the earliest producer of the " +
        "wrong quote.\n\nIncident:\n" +
        JSON.stringify(incident) +
        "\n\nCommunities:\n" +
        JSON.stringify(communityOptions),
    });
    turns.push(communityTurn);
    usage = addUsage(usage, communityTurn.usage);
    const selectedCommunity = hierarchy.communities.find(
      (community) =>
        community.id === communityTurn.answer.community_id,
    );
    if (selectedCommunity === undefined) {
      throw new Error("PRAXIS-style model selected an unknown community");
    }
    const functionOptions = selectedCommunity.functions.map((entry) => ({
      id: entry.id,
      file: entry.file,
      startLine: entry.startLine,
      signature: entry.signature,
    }));
    const functionTurn = await session.decide({
      schema: {
        type: "object",
        properties: {
          function_id: {
            type: "string",
            enum: functionOptions.map((option) => option.id),
          },
          rationale: { type: "string" },
        },
        required: ["function_id", "rationale"],
        additionalProperties: false,
      },
      prompt:
        "Continue the same hierarchy traversal. Select one function from the " +
        "chosen community to expand. Do not use tools.\n\nFunctions:\n" +
        JSON.stringify(functionOptions),
    });
    turns.push(functionTurn);
    usage = addUsage(usage, functionTurn.usage);
    const selectedFunction = selectedCommunity.functions.find(
      (entry) => entry.id === functionTurn.answer.function_id,
    );
    if (selectedFunction === undefined) {
      throw new Error("PRAXIS-style model selected an unknown function");
    }
    const diagnosisTurn = await session.decide({
      schema: diagnosisSchema,
      prompt:
        "This is the selected leaf source block. Identify the exact earliest " +
        "root-cause statement if it is present. If the traversal chose the wrong " +
        "leaf, report the best supported location in this leaf; do not use tools " +
        "or invent unseen source.\n\n" +
        selectedFunction.source,
    });
    turns.push(diagnosisTurn);
    usage = addUsage(usage, diagnosisTurn.usage);
    return resultBase({
      method: "praxis_style",
      started,
      usage,
      turns,
      answer: diagnosisTurn.answer,
    });
  } finally {
    await session.close();
  }
}

function validateProbePlan(plan) {
  const serviceRoots = {
    "gateway-e2e": "services/gateway/",
    "pricing-e2e": "services/pricing/",
  };
  const rootPrefix = serviceRoots[plan.service_id];
  if (
    rootPrefix === undefined ||
    typeof plan.file !== "string" ||
    !plan.file.startsWith(rootPrefix) ||
    !Number.isInteger(plan.line) ||
    plan.line < 1 ||
    !Array.isArray(plan.watch_paths) ||
    plan.watch_paths.length < 1 ||
    plan.watch_paths.length > 4 ||
    plan.watch_paths.some(
      (path) =>
        typeof path !== "string" ||
        !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(
          path,
        ),
    )
  ) {
    throw new Error(`invalid simple LiveProbe plan: ${JSON.stringify(plan)}`);
  }
}

const probePlanSchema = {
  type: "object",
  properties: {
    probes: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          service_id: {
            type: "string",
            enum: ["gateway-e2e", "pricing-e2e"],
          },
          file: { type: "string" },
          line: { type: "integer", minimum: 1 },
          watch_paths: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "string",
              pattern:
                "^[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*$",
            },
          },
        },
        required: ["service_id", "file", "line", "watch_paths"],
        additionalProperties: false,
      },
    },
    rationale: { type: "string" },
  },
  required: ["probes", "rationale"],
  additionalProperties: false,
};

async function deploySimpleProbeRound({
  handlers,
  commit,
  plans,
  gatewayPort,
  repetition,
  round,
}) {
  const deployed = [];
  for (const plan of plans) {
    validateProbePlan(plan);
    const created = await handlers.set_snapshot_probe({
      service_id: plan.service_id,
      commit_hash: commit,
      file: plan.file,
      line: plan.line,
      watch_paths: plan.watch_paths,
      hit_limit: 1,
      ttl_seconds: 120,
      created_by: "benchmark:react-liveprobe",
    });
    deployed.push({ probe: created.probe, plan });
  }
  try {
    await waitForArmed(handlers, deployed);
    const replayId = `four-arm-react-fail-${repetition}-${round}`;
    const replay = await replayFailingRequest(gatewayPort, replayId);
    const snapshots = await waitForSnapshots(
      handlers,
      deployed,
      replay.traceId,
    );
    const evidence = snapshots.map(({ plan, event }) => {
      const watches = event.watches ?? {};
      const requested = Object.fromEntries(
        plan.watch_paths
          .filter((path) => Object.hasOwn(watches, path))
          .map((path) => [path, compactCapturedValue(watches[path])]),
      );
      const primitiveFallback = Object.fromEntries(
        Object.entries(watches)
          .filter(
            ([key, value]) =>
              !Object.hasOwn(requested, key) &&
              (value === null ||
                typeof value !== "object" ||
                ["num", "str", "bool", "null"].includes(value?.t)),
          )
          .slice(0, 8)
          .map(([key, value]) => [key, compactCapturedValue(value)]),
      );
      return {
        service_id: plan.service_id,
        file: plan.file,
        line: plan.line,
        requested_watch_paths: plan.watch_paths,
        values: { ...requested, ...primitiveFallback },
        capture_status: event.capture?.status ?? "complete",
      };
    });
    return {
      replay,
      evidence,
      probeCount: deployed.length,
    };
  } finally {
    await removeProbes(handlers, deployed);
  }
}

async function runReactLiveProbe({
  handlers,
  commit,
  gatewayPort,
  decisionMode,
  model,
  repetition,
}) {
  const started = performance.now();
  let usage = zeroUsage();
  let runtimeMs = 0;
  let replayRounds = 0;
  let probeCount = 0;
  const turns = [];
  const session = new CodexSession({
    model,
    cwd: rideRoot,
    allowRepositoryTools: true,
  });
  try {
    let plans;
    if (decisionMode === "oracle") {
      plans = [
        {
          service_id: "pricing-e2e",
          file: "services/pricing/app.py",
          line: 75,
          watch_paths: ["surge", "amount", "config.surge"],
        },
      ];
    } else {
      const turn = await session.decide({
        schema: probePlanSchema,
        prompt:
          "Act as a simple ReAct-style AI SRE with ordinary read-only access " +
          "to the current RideRush checkout and raw LiveProbe snapshots, but no " +
          "dependency graph, analyzer, candidate list, or static slice. Inspect " +
          "only this repository. Choose 1-4 snapshot probes for the next failing " +
          "replay. A probe is a service, exact source line, and simple dot-path " +
          "watches. You must gather fresh runtime evidence before diagnosing.\n\n" +
          JSON.stringify(incident),
      });
      turns.push(turn);
      usage = addUsage(usage, turn.usage);
      plans = turn.answer.probes;
    }

    let answer;
    for (let round = 1; round <= 4; round += 1) {
      let capture;
      try {
        capture = await deploySimpleProbeRound({
          handlers,
          commit,
          plans,
          gatewayPort,
          repetition,
          round,
        });
      } catch (error) {
        capture = {
          replay: { elapsedMs: 0 },
          evidence: [{ probe_error: String(error) }],
          probeCount: 0,
          didReplay: false,
        };
      }
      replayRounds += capture.didReplay === false ? 0 : 1;
      probeCount += capture.probeCount;
      runtimeMs += capture.replay.elapsedMs;
      if (decisionMode === "oracle") {
        answer = oracleDiagnosis();
        break;
      }
      const turn = await session.decide({
        schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["probe", "diagnose"] },
            probes: probePlanSchema.properties.probes,
            root_cause_file: { type: ["string", "null"] },
            root_cause_line: { type: ["integer", "null"] },
            mechanism: { type: ["string", "null"] },
            confidence: {
              type: ["number", "null"],
              minimum: 0,
              maximum: 1,
            },
            rationale: { type: "string" },
          },
          required: [
            "action",
            "probes",
            "root_cause_file",
            "root_cause_line",
            "mechanism",
            "confidence",
            "rationale",
          ],
          additionalProperties: false,
        },
        prompt:
          "Continue the same simple LiveProbe investigation. The following " +
          "values came from one fresh failing replay. Diagnose only when they " +
          "support the earliest producer; otherwise return another probe plan. " +
          "You may continue using ordinary read-only repository tools. You still " +
          "have no dependency graph or analyzer.\n\nRuntime evidence:\n" +
          JSON.stringify(capture.evidence),
      });
      turns.push(turn);
      usage = addUsage(usage, turn.usage);
      if (turn.answer.action === "diagnose") {
        answer = {
          root_cause_file: turn.answer.root_cause_file ?? "",
          root_cause_line: turn.answer.root_cause_line ?? 0,
          mechanism: turn.answer.mechanism ?? "",
          confidence: turn.answer.confidence ?? 0,
        };
        break;
      }
      plans = turn.answer.probes;
    }
    if (answer === undefined && decisionMode === "codex") {
      const finalTurn = await session.decide({
        schema: diagnosisSchema,
        prompt:
          "Stop probing and provide the best exact root-cause diagnosis " +
          "supported by the repository and accumulated LiveProbe evidence.",
      });
      turns.push(finalTurn);
      usage = addUsage(usage, finalTurn.usage);
      answer = finalTurn.answer;
    }
    return resultBase({
      method: "react_liveprobe",
      started,
      usage,
      turns,
      answer,
      replayRounds,
      probes: probeCount,
      runtimeMs,
    });
  } catch (error) {
    if (error !== null && typeof error === "object") {
      error.benchmarkMetrics = {
        usage: error.usage ?? usage,
        turns: error.turns ?? turns,
        replayRounds,
        probes: probeCount,
        runtimeMs,
      };
    }
    throw error;
  } finally {
    await session.close();
  }
}

function findOracleExplorationAction(investigation) {
  return (
    investigation.actions.find(
      (action) =>
        action.kind === "FOLLOW_PATH" &&
        action.boundary_kind === "http" &&
        action.target_service_id === "pricing-e2e",
    ) ??
    investigation.actions.find(
      (action) =>
        action.kind === "PROBE_REGION" &&
        action.label.includes("services/pricing/app.py:74"),
    ) ??
    investigation.actions.find(
      (action) =>
        action.kind === "FOLLOW_PATH" &&
        String(action.function_id).includes("is_active") &&
        String(action.anchor_node_id).includes(":74:"),
    ) ??
    investigation.actions.find(
      (action) => action.kind === "INSPECT_MECHANISM",
    )
  );
}

function candidateFromOracle(investigation) {
  const context = investigation.mechanism_context;
  const rootStatement = context.statements.find(
    (statement) =>
      statement.file === "services/pricing/app.py" &&
      statement.line === 74 &&
      statement.source.includes("surge_poison"),
  );
  if (rootStatement === undefined) {
    throw new Error("oracle mechanism context omitted the root statement");
  }
  const surgeSite = context.probeCandidates.find((site) =>
    site.watch_paths.includes("surge"),
  );
  if (surgeSite === undefined) {
    throw new Error("oracle mechanism context has no surge candidate");
  }
  return {
    statement:
      "surge_poison selects surge 50 before the quote amount is calculated",
    anchor_node_ids: [rootStatement.node_id],
    traversal_id: context.traversalIds[0],
    predictions: [
      {
        probe_candidate_id: surgeSite.site_id,
        watch_path: "surge",
        operator: "eq",
        expected_value: 50,
      },
    ],
  };
}

function candidateRequest(investigation) {
  const context = investigation.mechanism_context;
  const aliases = investigation.decision_aliases;
  const statementAliasById = new Map(
    Object.entries(aliases.statements).map(([alias, nodeId]) => [
      nodeId,
      alias,
    ]),
  );
  const traversalAliasById = new Map(
    Object.entries(aliases.traversals).map(([alias, traversalId]) => [
      traversalId,
      alias,
    ]),
  );
  const allowedSites = new Map(
    context.probeCandidates.map((site) => [site.site_id, site]),
  );
  const options = [];
  const seen = new Set();
  for (const dossier of [...investigation.value_dossiers].reverse()) {
    const site = allowedSites.get(dossier.site_id);
    const value = dossier.value;
    const key = `${dossier.site_id}\0${dossier.watch_path}`;
    if (
      site === undefined ||
      seen.has(key) ||
      !site.watch_paths.includes(dossier.watch_path) ||
      typeof value !== "object" ||
      value === null ||
      !["num", "str", "bool"].includes(value.t)
    ) {
      continue;
    }
    seen.add(key);
    options.push({
      id: `q${options.length + 1}`,
      probe_candidate_id: dossier.site_id,
      at: dossier.location,
      path: dossier.watch_path,
      value: value.v,
    });
    if (options.length >= 16) break;
  }
  if (options.length === 0) {
    throw new Error(
      "mechanism reveal has no previously observed scalar prediction options",
    );
  }
  return {
    options,
    schema: {
      type: "object",
      properties: {
        statement: { type: "string" },
        anchors: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "string",
            enum: [...statementAliasById.values()],
          },
        },
        traversal: {
          type: "string",
          enum: context.traversalIds
            .map((traversalId) => traversalAliasById.get(traversalId))
            .filter(Boolean),
        },
        predictions: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: {
            type: "string",
            enum: options.map((option) => option.id),
          },
        },
      },
      required: [
        "statement",
        "anchors",
        "traversal",
        "predictions",
      ],
      additionalProperties: false,
    },
    statementIds: Object.fromEntries(
      [...statementAliasById.entries()].map(([nodeId, alias]) => [
        alias,
        nodeId,
      ]),
    ),
    traversalIds: Object.fromEntries(
      [...traversalAliasById.entries()].map(([traversalId, alias]) => [
        alias,
        traversalId,
      ]),
    ),
  };
}

async function deployGraphRound({
  handlers,
  investigation,
  gatewayPort,
  repetition,
  round,
}) {
  const deployed = await handlers.deploy_investigation_probes({
    repository_root: rideRoot,
    investigation_id: investigation.investigation_id,
    hit_limit: 1,
    ttl_seconds: 120,
    created_by: "benchmark:graph-liveprobe",
  });
  const probes = deployed.probes.map((item) => ({
    ...item,
    probe: item.probe,
  }));
  try {
    await waitForArmed(handlers, probes);
    const replayId = `four-arm-graph-fail-${repetition}-${round}`;
    const replay = await replayFailingRequest(gatewayPort, replayId);
    await waitForSnapshots(handlers, probes, replay.traceId, {
      requireAll: investigation.phase === "CONFIRMING",
    });
    const collected = await handlers.collect_investigation_evidence({
      repository_root: rideRoot,
      investigation_id: investigation.investigation_id,
      occurrences: [{ occurrence_id: `trace:${replayId}` }],
      wait_seconds: 4,
    });
    return {
      investigation: collected.investigation,
      replay,
      probeCount: probes.length,
    };
  } finally {
    await removeProbes(handlers, probes);
  }
}

async function runGraphLiveProbe({
  handlers,
  commit,
  gatewayPort,
  decisionMode,
  model,
  repetition,
}) {
  const started = performance.now();
  let usage = zeroUsage();
  let runtimeMs = 0;
  let replayRounds = 0;
  let probeCount = 0;
  let deterministicActions = 0;
  let localizationMs;
  let verificationMs = null;
  const turns = [];
  const session = new CodexSession({
    model,
    cwd: rideRoot,
    allowRepositoryTools: false,
    persistent: false,
  });
  try {
    let investigation = await handlers.start_probe_investigation({
      repository_root: rideRoot,
      commit_hash: commit,
      service_id: "gateway-e2e",
      file: "services/gateway/app.py",
      line: 83,
      watch_path: "pricing.quote",
      symptom: "the customer quote is implausibly high",
      failure_class: "semantic",
      probe_budget: 10,
      source_roots: ["services/gateway", "services/pricing"],
      ownership_map: [
        {
          source_root: "services/gateway",
          service_id: "gateway-e2e",
        },
        {
          source_root: "services/pricing",
          service_id: "pricing-e2e",
        },
      ],
    });
    for (let iteration = 1; iteration <= 12; iteration += 1) {
      if (
        investigation.phase === "AWAITING_EVIDENCE" ||
        investigation.phase === "CONFIRMING"
      ) {
        const captured = await deployGraphRound({
          handlers,
          investigation,
          gatewayPort,
          repetition,
          round: replayRounds + 1,
        });
        investigation = captured.investigation;
        runtimeMs += captured.replay.elapsedMs;
        replayRounds += 1;
        probeCount += captured.probeCount;
      }
      const complete = investigation.actions.find(
        (action) => action.kind === "COMPLETE_LOCALIZATION",
      );
      if (complete !== undefined) {
        const evidence = [...investigation.decision_log]
          .reverse()
          .find((entry) => entry.kind === "EVIDENCE_RECORDED");
        investigation = await handlers.apply_investigation_decision({
          repository_root: rideRoot,
          investigation_id: investigation.investigation_id,
          based_on_revision: investigation.revision,
          action_ids: [complete.action_id],
          evidence_refs: evidence?.observationIds ?? [],
        });
        deterministicActions += 1;
        verificationMs = Math.round(performance.now() - started);
        break;
      }
      if (investigation.phase === "MECHANISM") {
        const confirm = investigation.actions.find(
          (action) => action.kind === "CONFIRM_CANDIDATE",
        );
        if (confirm === undefined) {
          throw new Error("graph method has no candidate confirmation action");
        }
        let candidate;
        if (decisionMode === "oracle") {
          candidate = candidateFromOracle(investigation);
        } else {
          const request = candidateRequest(investigation);
          const turn = await session.decide({
            schema: request.schema,
            prompt:
              "Continue the unknown-first graph+LiveProbe investigation. This " +
              "is the bounded mechanism reveal. Submit one concrete mechanism " +
              "anchored only to supplied statements and select the smallest " +
              "sufficient set of one or two validated scalar prediction IDs. " +
              "Every option was already observed at that exact probe site and " +
              "will be recaptured narrowly on a fresh failing replay. Do not " +
              "add unobserved values or invented IDs. Return only the requested " +
              "fields; no rationale. Do not use tools.\n\nDecision brief:\n" +
              JSON.stringify(investigation.decision_context) +
              "\n\nPrediction options:\n" +
              JSON.stringify(
                request.options.map(({ id, at, path, value }) => ({
                  id,
                  at,
                  path,
                  value,
                })),
              ),
          });
          turns.push(turn);
          usage = addUsage(usage, turn.usage);
          const selectedOptions = turn.answer.predictions.map(
            (predictionId) =>
              request.options.find(
                (option) => option.id === predictionId,
              ),
          );
          if (selectedOptions.some((option) => option === undefined)) {
            throw new Error("model selected an unknown prediction option");
          }
          candidate = {
            statement: turn.answer.statement,
            anchor_node_ids: turn.answer.anchors.map(
              (alias) => request.statementIds[alias],
            ),
            traversal_id: request.traversalIds[turn.answer.traversal],
            predictions: selectedOptions.map((option) => ({
              probe_candidate_id: option.probe_candidate_id,
              watch_path: option.path,
              operator: "eq",
              expected_value: option.value,
            })),
          };
        }
        investigation = await handlers.apply_investigation_decision({
          repository_root: rideRoot,
          investigation_id: investigation.investigation_id,
          based_on_revision: investigation.revision,
          action_ids: [confirm.action_id],
          candidate_mechanism: candidate,
        });
        localizationMs = Math.round(performance.now() - started);
        continue;
      }
      const legal = investigation.actions.filter((action) =>
        [
          "FOLLOW_PATH",
          "PROBE_REGION",
          "INSPECT_MECHANISM",
          "HANDOFF_BOUNDARY",
        ].includes(action.kind),
      );
      if (legal.length === 0) break;
      let selected;
      if (decisionMode === "oracle") {
        selected = findOracleExplorationAction(investigation);
      } else if (legal.length === 1) {
        [selected] = legal;
        deterministicActions += 1;
      } else {
        const actionAliases = investigation.decision_aliases.actions;
        const turn = await session.decide({
          schema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: Object.keys(actionAliases),
              },
            },
            required: ["action"],
            additionalProperties: false,
          },
          prompt:
            (turns.length === 0
              ? "Begin"
              : "Continue") +
            " the unknown-first graph+LiveProbe investigation. Choose exactly " +
            "one validated action that most efficiently distinguishes the " +
            "earliest producer of the wrong quote. Values are semantic UNKNOWN; " +
            "do not infer a good/bad label. Prefer a producer over a downstream " +
            "consumer. The packet is bounded and source-free until mechanism " +
            "inspection. Return only the requested action alias; no rationale. " +
            "Do not use tools or invent IDs.\n\nDecision brief:\n" +
            JSON.stringify(investigation.decision_context),
        });
        turns.push(turn);
        usage = addUsage(usage, turn.usage);
        selected = legal.find(
          (action) =>
            action.action_id === actionAliases[turn.answer.action],
        );
      }
      if (selected === undefined) {
        throw new Error("graph method selected no valid exploration action");
      }
      investigation = await handlers.apply_investigation_decision({
        repository_root: rideRoot,
        investigation_id: investigation.investigation_id,
        based_on_revision: investigation.revision,
        action_ids: [selected.action_id],
      });
    }
    const candidate = investigation.candidate_mechanism;
    const anchors = candidate?.anchor_node_ids ?? [];
    const hasExpectedAnchor = anchors.some(
      (anchor) =>
        anchor.includes("services/pricing/app.py") &&
        anchor.includes(":74:"),
    );
    const answer = {
      root_cause_file: hasExpectedAnchor
        ? "services/pricing/app.py"
        : "",
      root_cause_line: hasExpectedAnchor ? 74 : 0,
      mechanism: candidate?.statement ?? "",
      confidence: investigation.status === "LOCALIZED" ? 1 : 0,
    };
    return resultBase({
      method: "graph_liveprobe",
      started,
      usage,
      turns,
      answer,
      replayRounds,
      probes: probeCount,
      runtimeMs,
      deterministicActions,
      localizationMs,
      verificationMs,
      status:
        investigation.status === "LOCALIZED" && exactRootCause(answer)
          ? "localized"
          : investigation.status.toLowerCase(),
    });
  } catch (error) {
    if (error !== null && typeof error === "object") {
      error.benchmarkMetrics = {
        usage: error.usage ?? usage,
        turns: error.turns ?? turns,
        replayRounds,
        probes: probeCount,
        runtimeMs,
        deterministicActions,
        localizationMs,
        verificationMs,
      };
    }
    throw error;
  } finally {
    await session.close();
  }
}

function summarize(runs) {
  return Object.fromEntries(
    methodNames.map((method) => {
      const values = runs.flatMap((run) =>
        run.methods.filter((entry) => entry.method === method),
      );
      const measured = values.filter(
        (value) => value.metricsAvailable !== false,
      );
      return [
        method,
        {
          runs: values.length,
          successes: values.filter((value) => value.exactRootCause).length,
          successRate:
            values.length === 0
              ? 0
              : values.filter((value) => value.exactRootCause).length /
                values.length,
          medianWallMs: Math.round(
            median(values.map((value) => value.wallMs)),
          ),
          medianCompletedWallMs: Math.round(
            median(measured.map((value) => value.wallMs)),
          ),
          medianModelMs: Math.round(
            median(measured.map((value) => value.modelMs)),
          ),
          medianRuntimeMs: Math.round(
            median(measured.map((value) => value.runtimeMs)),
          ),
          medianLocalizationMs: Math.round(
            median(
              measured
                .map((value) => value.localizationMs)
                .filter((value) => Number.isFinite(value)),
            ),
          ),
          medianVerificationMs: Math.round(
            median(
              measured
                .map((value) => value.verificationMs)
                .filter((value) => Number.isFinite(value)),
            ),
          ),
          meanInputTokens: Math.round(
            mean(measured.map((value) => value.usage.inputTokens)),
          ),
          meanNewInputTokens: Math.round(
            mean(measured.map((value) => value.usage.newInputTokens)),
          ),
          meanOutputTokens: Math.round(
            mean(measured.map((value) => value.usage.outputTokens)),
          ),
          meanModelCalls: Number(
            mean(measured.map((value) => value.usage.calls)).toFixed(2),
          ),
          meanModelSamples: Number(
            mean(
              measured.map((value) =>
                Number(value.usage.modelSamples ?? value.usage.calls),
              ),
            ).toFixed(2),
          ),
          meanOuterTurns: Number(
            mean(
              measured.map((value) =>
                Number(value.usage.outerTurns ?? 0),
              ),
            ).toFixed(2),
          ),
          meanToolCalls: Number(
            mean(
              measured.map((value) =>
                Number(value.usage.toolCalls ?? 0),
              ),
            ).toFixed(2),
          ),
          meanPromptBytes: Math.round(
            mean(measured.map((value) => value.promptBytes)),
          ),
          meanSchemaBytes: Math.round(
            mean(measured.map((value) => value.schemaBytes ?? 0)),
          ),
          medianReplayRounds: median(
            measured.map((value) => value.replayRounds),
          ),
          medianProbes: median(measured.map((value) => value.probes)),
          metricsRuns: measured.length,
        },
      ];
    }),
  );
}

function failedMethodResult(method, started, error) {
  const metrics =
    error !== null && typeof error === "object"
      ? (error.benchmarkMetrics ?? error)
      : {};
  const usage = metrics.usage ?? zeroUsage();
  const turns = metrics.turns ?? [];
  const hasPartialMetrics =
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.elapsedMs > 0 ||
    turns.length > 0;
  return {
    method,
    status: error?.timedOut ? "timeout" : "error",
    exactRootCause: false,
    metricsAvailable: hasPartialMetrics,
    error: error instanceof Error ? error.message : String(error),
    usage,
    wallMs: Math.round(performance.now() - started),
    localizationMs: metrics.localizationMs ?? null,
    verificationMs: metrics.verificationMs ?? null,
    modelMs: usage.elapsedMs,
    runtimeMs: metrics.runtimeMs ?? 0,
    replayRounds: metrics.replayRounds ?? 0,
    probes: metrics.probes ?? 0,
    deterministicActions: metrics.deterministicActions ?? 0,
    promptBytes: turns.reduce(
      (total, turn) => total + Number(turn.packetBytes ?? 0),
      0,
    ),
    promptTextBytes: turns.reduce(
      (total, turn) => total + Number(turn.promptBytes ?? 0),
      0,
    ),
    schemaBytes: turns.reduce(
      (total, turn) => total + Number(turn.schemaBytes ?? 0),
      0,
    ),
    turns,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const resultPath = resolve(
    root,
    process.env["LIVEPROBE_FOUR_METHOD_RESULT"] ??
      (args.decisionMode === "oracle"
        ? "demo/ride-analysis/results/latest-four-method-oracle.json"
        : "demo/ride-analysis/results/latest-four-method-benchmark.json"),
  );
  const benchmarkStarted = performance.now();
  const commit = await run("git", ["rev-parse", "HEAD"], { cwd: rideRoot });
  incident.deployedCommit = commit;
  const cliVersion = await run("codex", ["--version"]).catch(
    () => "unavailable",
  );
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
  let targets;
  try {
    const hierarchyStarted = performance.now();
    const hierarchy = await buildSourceHierarchy(rideRoot);
    const hierarchyIndexMs = Math.round(
      performance.now() - hierarchyStarted,
    );
    const graphStarted = performance.now();
    const graphPreparation = await handlers.prepare_repository_analysis({
      repository_root: rideRoot,
      commit_hash: commit,
    });
    const graphIndexMs = Math.round(performance.now() - graphStarted);
    targets = await startRideTargets({
      root,
      rideRoot,
      brokerUrl,
      commit,
      handlers,
    });
    const runs = [];
    for (let repetition = 1; repetition <= args.repetitions; repetition += 1) {
      const baseline = await replayFailingRequest(
        targets.gatewayPort,
        `four-arm-baseline-fail-${repetition}`,
      );
      if (Number(baseline.body.quote) !== incident.observedResponse.quote) {
        throw new Error("shared incident response changed");
      }
      const offset = (repetition - 1) % args.methods.length;
      const order = [
        ...args.methods.slice(offset),
        ...args.methods.slice(0, offset),
      ];
      const methods = [];
      for (const method of order) {
        process.stderr.write(
          `[four-method] repetition=${repetition} method=${method}\n`,
        );
        const methodStarted = performance.now();
        try {
          if (method === "normal_codex") {
            methods.push(
              await runNormalCodex({
                decisionMode: args.decisionMode,
                model: args.model,
              }),
            );
          } else if (method === "praxis_style") {
            methods.push(
              await runPraxisStyle({
                decisionMode: args.decisionMode,
                model: args.model,
                hierarchy,
              }),
            );
          } else if (method === "react_liveprobe") {
            methods.push(
              await runReactLiveProbe({
                handlers,
                commit,
                gatewayPort: targets.gatewayPort,
                decisionMode: args.decisionMode,
                model: args.model,
                repetition,
              }),
            );
          } else if (method === "graph_liveprobe") {
            methods.push(
              await runGraphLiveProbe({
                handlers,
                commit,
                gatewayPort: targets.gatewayPort,
                decisionMode: args.decisionMode,
                model: args.model,
                repetition,
              }),
            );
          }
        } catch (error) {
          process.stderr.write(
            `[four-method] method=${method} failed: ${String(error)}\n`,
          );
          methods.push(failedMethodResult(method, methodStarted, error));
        }
      }
      runs.push({
        repetition,
        order,
        sharedIncidentAcquisitionMs: baseline.elapsedMs,
        methods,
      });
    }
    const summary = summarize(runs);
    const selectedSummary = Object.fromEntries(
      args.methods.map((method) => [method, summary[method]]),
    );
    const result = {
      status: Object.values(selectedSummary).every(
        (entry) => entry.successes === entry.runs,
      )
        ? "passed"
        : "completed_with_failures",
      validity:
        args.decisionMode === "codex"
          ? "external-model-controlled-comparison"
          : "oracle-harness-validation-only",
      decisionMode: args.decisionMode,
      model: args.model ?? "codex-default",
      codexCli: cliVersion,
      repository: rideRoot,
      commit,
      hiddenGroundTruth: {
        file: "services/pricing/app.py",
        line: 74,
        mechanism: "surge_poison selects multiplier 50",
        includedInModelPackets: false,
      },
      controls: {
        sameIncidentPacket: true,
        sameRepositoryCommit: true,
        sameModelConfiguration: true,
        exactLineSuccessRequired: true,
        downstreamLine75Rejected: true,
        passingExecutionProvided: false,
        mutationProvided: false,
        methodOrderRotated: true,
        repetitions: args.repetitions,
      },
      methodBoundaries: {
        normal_codex:
          "logs/traces + ordinary read-only coding-agent repository tools",
        praxis_style:
          "logs/traces + generated service/function/source hierarchy; no runtime probes or dependency graph",
        react_liveprobe:
          "ordinary read-only repository tools + raw probe/replay loop; no analyzer or dependency graph",
        graph_liveprobe:
          "bounded validated graph decision context + probe/replay loop; source only at mechanism reveal",
      },
      setup: {
        hierarchyIndexMs,
        hierarchyCommunities: hierarchy.communities.length,
        hierarchyFunctions: hierarchy.functions.length,
        graphIndexMs,
        graphPreparation,
        setupExcludedFromWarmMethodWallTime: true,
      },
      summary: selectedSummary,
      runs,
      elapsedMs: Math.round(performance.now() - benchmarkStarted),
    };
    await mkdir(resolve(resultPath, ".."), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    if (targets !== undefined) await targets.close();
    await broker.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
