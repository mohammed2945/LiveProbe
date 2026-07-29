#!/usr/bin/env node

import {
  access,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { promisify } from "node:util";

import {
  ARM_NAMES,
  armCapabilities,
  buildTaskPrompt,
  liveProbeMcpServer,
  loadGuidance,
  observabilityMcpServer,
} from "./arms.mjs";
import { runCodexAgent } from "./agent-runner.mjs";
import {
  EvidenceStore,
  EvaluationLedger,
  RESULT_SCHEMA_VERSION,
  readJson,
  scoreDiagnosis,
  sha256,
  summarizeResults,
  zeroUsage,
} from "./core.mjs";
import { fixtureDiagnosis } from "./fixture-policy.mjs";

const evaluationRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const repositoryRoot = resolve(evaluationRoot, "../..");
const executeFile = promisify(execFile);

function parseList(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const result = {
    mode: "fixture",
    incidents: ["3", "401", "405"],
    arms: [...ARM_NAMES],
    seed: 10,
    model: undefined,
    allowPaidModel: false,
    output: resolve(evaluationRoot, "results/latest.json"),
    sourceRoot: undefined,
    snapshot: undefined,
    snapshotRoot: undefined,
    oracle: undefined,
    brokerUrl: "http://127.0.0.1:7070",
    enableLiveReplay: false,
    budgetTier: "smoke",
    deferScoring: false,
  };
  for (const argument of argv) {
    if (argument.startsWith("--mode=")) result.mode = argument.slice(7);
    else if (argument.startsWith("--incidents=")) {
      result.incidents = parseList(argument.slice(12));
    } else if (argument.startsWith("--arms=")) {
      result.arms = parseList(argument.slice(7));
    } else if (argument.startsWith("--seed=")) {
      result.seed = Number(argument.slice(7));
    } else if (argument.startsWith("--model=")) {
      result.model = argument.slice(8);
    } else if (argument.startsWith("--output=")) {
      result.output = resolve(argument.slice(9));
    } else if (argument.startsWith("--source-root=")) {
      result.sourceRoot = resolve(argument.slice(14));
    } else if (argument.startsWith("--snapshot=")) {
      result.snapshot = resolve(argument.slice(11));
    } else if (argument.startsWith("--snapshot-root=")) {
      result.snapshotRoot = resolve(argument.slice(16));
    } else if (argument.startsWith("--oracle=")) {
      result.oracle = resolve(argument.slice(9));
    } else if (argument.startsWith("--broker-url=")) {
      result.brokerUrl = argument.slice(13);
    } else if (argument === "--enable-live-replay") {
      result.enableLiveReplay = true;
    } else if (argument.startsWith("--budget-tier=")) {
      result.budgetTier = argument.slice(14);
    } else if (argument === "--defer-scoring") {
      result.deferScoring = true;
    } else if (argument === "--allow-paid-model") {
      result.allowPaidModel = true;
    } else if (argument === "--help" || argument === "-h") {
      result.help = true;
    } else throw new Error(`unknown argument ${argument}`);
  }
  return result;
}

function help() {
  return `Usage: node benchmark.mjs [options]

Modes:
  fixture  Deterministic no-model contract run (default)
  codex    One budgeted coding-agent decision per selected non-PRAXIS arm

Options:
  --incidents=3,401,405
  --arms=normal_coding_sre,praxis,graph_liveprobe,raw_liveprobe
  --seed=10
  --model=gpt-5.4-mini
  --source-root=DIR
  --snapshot=FILE       One selected incident only
  --snapshot-root=DIR   Reads incident-ID.snapshot.json
  --oracle=FILE         Scorer-only official oracle
  --broker-url=URL
  --enable-live-replay  Execute only snapshot-registered replay recipes
  --budget-tier=smoke|full
  --defer-scoring     Do not load any oracle during agent execution
  --output=FILE
  --allow-paid-model   Required for mode=codex
  -h, --help`;
}

function validateOptions(options, config) {
  if (!["fixture", "codex"].includes(options.mode)) {
    throw new Error("--mode must be fixture or codex");
  }
  for (const arm of options.arms) {
    if (!ARM_NAMES.includes(arm)) throw new Error(`unknown arm ${arm}`);
  }
  if (!Number.isInteger(options.seed)) throw new Error("--seed must be an integer");
  if (options.mode === "codex") {
    if (!options.allowPaidModel) {
      throw new Error(
        "paid model execution is disabled; pass --allow-paid-model explicitly",
      );
    }
    if (options.sourceRoot === undefined) {
      throw new Error("--source-root is required for mode=codex");
    }
    if (options.arms.includes("praxis")) {
      throw new Error(
        "the PRAXIS arm requires the remote native/fair launcher; remove it from this local Codex run",
      );
    }
  }
  if (options.snapshot !== undefined && options.incidents.length !== 1) {
    throw new Error("--snapshot requires exactly one selected incident");
  }
  if (
    options.snapshot !== undefined &&
    options.snapshotRoot !== undefined
  ) {
    throw new Error("provide --snapshot or --snapshot-root, not both");
  }
  if (options.enableLiveReplay && options.mode !== "codex") {
    throw new Error("--enable-live-replay is valid only in codex mode");
  }
  if (!["smoke", "full"].includes(options.budgetTier)) {
    throw new Error("--budget-tier must be smoke or full");
  }
  if (options.deferScoring && options.mode !== "codex") {
    throw new Error("--defer-scoring is valid only in codex mode");
  }
  options.model ??= config.decision_model.default;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sourceRootForIncident(sourceRoot, incidentId, incidentCount) {
  if (sourceRoot === undefined) return undefined;
  const selected =
    incidentCount === 1 && (await pathExists(resolve(sourceRoot, ".git")))
      ? sourceRoot
      : resolve(sourceRoot, incidentId);
  if (!(await pathExists(resolve(selected, ".git")))) {
    throw new Error(
      `source root ${sourceRoot} has no checkout for incident ${incidentId}`,
    );
  }
  const { stdout: status } = await executeFile(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: selected },
  );
  if (status.trim() !== "") {
    throw new Error(
      `agent source checkout must contain tracked source only; dirty paths: ` +
        status.trim().split("\n").slice(0, 8).join(", "),
    );
  }
  return selected;
}

function snapshotPathForIncident(options, incidentId) {
  if (options.snapshot !== undefined) return options.snapshot;
  if (options.snapshotRoot !== undefined) {
    return resolve(options.snapshotRoot, `incident-${incidentId}.snapshot.json`);
  }
  return resolve(
    evaluationRoot,
    `fixtures/incident-${incidentId}.snapshot.json`,
  );
}

async function fixtureRun({ incidentId, arm, snapshot, oracle, seed, model }) {
  const started = performance.now();
  const runId = `fixture-${incidentId}-${arm}-${seed}`;
  const ledger = new EvaluationLedger({
    run_id: runId,
    arm,
    incident_id: incidentId,
    seed,
    model: "deterministic-fixture-policy",
  });
  const store = new EvidenceStore(snapshot, { ledger });
  store.getBootstrap({ incident_id: incidentId });
  if (incidentId === "401") {
    store.getTrace({
      trace_id: snapshot.bootstrap.failing_trace_summaries[0].trace_id,
    });
    store.searchLogs({
      service: "recommendation",
      trace_id: snapshot.bootstrap.failing_trace_summaries[0].trace_id,
    });
  } else if (incidentId === "405") {
    store.getTrace({
      trace_id: snapshot.bootstrap.failing_trace_summaries[0].trace_id,
    });
  } else if (incidentId === "3") {
    store.queryMetrics({
      service: "ad",
      metric_or_preset: "container_cpu_utilization",
    });
    store.getEvents({ namespace: "otel-demo", kind: "ConfigMap" });
  }
  const answer = fixtureDiagnosis(incidentId, arm);
  const wallMs = Math.round(performance.now() - started);
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    run_id: runId,
    benchmark_mode: "deterministic_fixture",
    synthetic_evidence: true,
    incident_id: incidentId,
    arm,
    seed,
    model: "deterministic-fixture-policy",
    capability_profile: armCapabilities(arm),
    answer,
    score: scoreDiagnosis(answer, oracle),
    usage: ledger.summary(),
    wall_ms: wallMs,
    model_wall_ms: 0,
    runtime_wall_ms: 0,
    tool_calls: ledger.records.filter((item) => item.kind === "tool_call").length,
    records_sha256: sha256(ledger.records),
  };
}

async function codexRun({
  incidentId,
  arm,
  snapshotPath,
  snapshot,
  oracle,
  options,
  sourceRoot,
  config,
  schema,
  ledgerPath,
}) {
  const runId = `codex-${incidentId}-${arm}-${options.seed}`;
  const ledger = new EvaluationLedger({
    run_id: runId,
    arm,
    incident_id: incidentId,
    seed: options.seed,
    model: options.model,
    path: ledgerPath,
    budget: {
      llm_total_tokens:
        options.budgetTier === "smoke"
          ? config.budgets.smoke_llm_total_tokens
          : config.budgets.llm_total_tokens,
      observability_queries: config.budgets.observability_queries,
    },
  });
  const store = new EvidenceStore(snapshot);
  const bootstrap = store.getBootstrap({ incident_id: incidentId });
  const guidance = await loadGuidance(arm);
  const prompt = buildTaskPrompt({ arm, guidance, bootstrap });
  const mcpServers = [
    observabilityMcpServer({
      snapshotPath,
      ledgerPath,
      arm,
      runId,
      seed: options.seed,
      model: options.model,
      enableLiveReplay: options.enableLiveReplay,
    }),
  ];
  if (arm === "raw_liveprobe") {
    mcpServers.push(
      liveProbeMcpServer({
        brokerUrl: options.brokerUrl,
        profile: "raw",
        ledgerPath,
        arm,
        runId,
        incidentId,
        seed: options.seed,
        model: options.model,
      }),
    );
  } else if (arm === "graph_liveprobe") {
    mcpServers.push(
      liveProbeMcpServer({
        brokerUrl: options.brokerUrl,
        profile: "graph",
        ledgerPath,
        arm,
        runId,
        incidentId,
        seed: options.seed,
        model: options.model,
      }),
    );
  }
  const executed = await runCodexAgent({
    arm,
    model: options.model,
    reasoningEffort: config.decision_model.reasoning_effort,
    cwd: sourceRoot,
    prompt,
    schema,
    skill: guidance,
    mcpServers,
    timeoutMs:
      options.budgetTier === "smoke"
        ? config.budgets.smoke_wall_time_ms
        : config.budgets.wall_time_ms,
    ledger,
  });
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    run_id: runId,
    benchmark_mode: "budgeted_codex_smoke",
    synthetic_evidence: snapshot.synthetic,
    incident_id: incidentId,
    arm,
    seed: options.seed,
    model: options.model,
    capability_profile: armCapabilities(arm),
    answer: executed.answer,
    score:
      oracle === undefined
        ? null
        : scoreDiagnosis(executed.answer, oracle),
    usage: executed.usage,
    wall_ms: executed.wall_ms,
    model_wall_ms: executed.wall_ms,
    runtime_wall_ms: 0,
    tool_calls: executed.usage.tool_calls,
    records_sha256: sha256(ledger.records),
  };
}

export async function runBenchmark(options) {
  const [config, oracleDocument, schema] = await Promise.all([
    readJson(resolve(evaluationRoot, "benchmark.config.json")),
    options.deferScoring
      ? Promise.resolve(null)
      : readJson(
          options.oracle ??
            resolve(evaluationRoot, "oracle/fixtures.json"),
        ),
    readJson(resolve(evaluationRoot, "schemas/diagnosis.schema.json")),
  ]);
  validateOptions(options, config);
  await mkdir(dirname(options.output), { recursive: true });
  const results = [];
  for (const incidentId of options.incidents) {
    const oracle = oracleDocument?.incidents?.[incidentId];
    if (oracle === undefined && !options.deferScoring) {
      throw new Error(
        `incident ${incidentId} is absent from the selected scorer oracle`,
      );
    }
    const snapshotPath = snapshotPathForIncident(options, incidentId);
    const incidentSourceRoot = await sourceRootForIncident(
      options.sourceRoot,
      incidentId,
      options.incidents.length,
    );
    const snapshot = await readJson(snapshotPath);
    if (String(snapshot.incident_id) !== String(incidentId)) {
      throw new Error(
        `snapshot ${snapshotPath} belongs to incident ` +
          `${snapshot.incident_id}, not ${incidentId}`,
      );
    }
    for (const arm of options.arms) {
      const result =
        options.mode === "fixture"
          ? await fixtureRun({
              incidentId,
              arm,
              snapshot,
              oracle,
              seed: options.seed,
              model: options.model,
            })
          : await codexRun({
              incidentId,
              arm,
              snapshotPath,
              snapshot,
              oracle,
              options,
              sourceRoot: incidentSourceRoot,
              config,
              schema,
              ledgerPath: options.output.replace(/\.json$/, `.${incidentId}.${arm}.jsonl`),
            });
      results.push(result);
    }
  }
  const artifact = {
    schema_version: "liveprobe-praxis-eval-results/v1",
    generated_at: new Date().toISOString(),
    mode: options.mode,
    model: options.mode === "fixture" ? "none" : options.model,
    seed: options.seed,
    incidents: options.incidents,
    arms: options.arms,
    config_sha256: sha256(config),
    oracle_sha256:
      oracleDocument === null ? null : sha256(oracleDocument),
    snapshots: Object.fromEntries(
      options.incidents.map((incidentId) => [
        incidentId,
        snapshotPathForIncident(options, incidentId),
      ]),
    ),
    results,
    summary: summarizeResults(results),
  };
  await writeFile(options.output, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(`${help()}\n`);
  else {
    runBenchmark(options)
      .then((artifact) => {
        process.stdout.write(`${JSON.stringify(artifact.summary, null, 2)}\n`);
      })
      .catch((error) => {
        process.stderr.write(`praxis-benchmark: ${error.stack ?? error}\n`);
        process.exitCode = 1;
      });
  }
}
