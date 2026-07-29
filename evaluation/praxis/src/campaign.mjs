#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { ARM_NAMES } from "./arms.mjs";
import {
  RESULT_SCHEMA_VERSION,
  readJson,
  scoreDiagnosis,
  sha256,
  summarizeResults,
  zeroUsage,
} from "./core.mjs";
import { inspectHost } from "../scripts/remote-preflight.mjs";

const evaluationRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(evaluationRoot, "../..");

function list(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function numbers(value) {
  return list(value).map((item) => Number(item));
}

function parseArgs(argv) {
  const result = {
    artifactRoot: undefined,
    sourceRoot: resolve(repositoryRoot, ".eval-cache/praxis-sources"),
    resultsRoot: resolve(evaluationRoot, "results/campaign"),
    tier: "smoke",
    incidents: undefined,
    seeds: undefined,
    arms: [...ARM_NAMES],
    model: "gpt-5.4-mini",
    python: "python3.12",
    namespace: "otel-demo",
    registry: "liveprobe-praxis",
    kindCluster: "kind-cluster",
    brokerUrl: "http://127.0.0.1:7070",
    prometheusUrl: "http://127.0.0.1:8080",
    clickhouseUrl: "http://127.0.0.1:8080/clickhouse",
    replayBaseUrl: "http://127.0.0.1:8080",
    alertTimeoutMs: 600_000,
    execute: false,
    allowPaidModel: false,
  };
  for (const argument of argv) {
    if (argument.startsWith("--artifact-root=")) {
      result.artifactRoot = resolve(argument.slice(16));
    } else if (argument.startsWith("--source-root=")) {
      result.sourceRoot = resolve(argument.slice(14));
    } else if (argument.startsWith("--results-root=")) {
      result.resultsRoot = resolve(argument.slice(15));
    } else if (argument.startsWith("--tier=")) {
      result.tier = argument.slice(7);
    } else if (argument.startsWith("--incidents=")) {
      result.incidents = list(argument.slice(12));
    } else if (argument.startsWith("--seeds=")) {
      result.seeds = numbers(argument.slice(8));
    } else if (argument.startsWith("--arms=")) {
      result.arms = list(argument.slice(7));
    } else if (argument.startsWith("--model=")) {
      result.model = argument.slice(8);
    } else if (argument.startsWith("--python=")) {
      result.python = argument.slice(9);
    } else if (argument.startsWith("--namespace=")) {
      result.namespace = argument.slice(12);
    } else if (argument.startsWith("--registry=")) {
      result.registry = argument.slice(11);
    } else if (argument.startsWith("--kind-cluster=")) {
      result.kindCluster = argument.slice(15);
    } else if (argument.startsWith("--broker-url=")) {
      result.brokerUrl = argument.slice(13);
    } else if (argument.startsWith("--prometheus-url=")) {
      result.prometheusUrl = argument.slice(17);
    } else if (argument.startsWith("--clickhouse-url=")) {
      result.clickhouseUrl = argument.slice(17);
    } else if (argument.startsWith("--replay-base-url=")) {
      result.replayBaseUrl = argument.slice(18);
    } else if (argument.startsWith("--alert-timeout-ms=")) {
      result.alertTimeoutMs = Number(argument.slice(19));
    } else if (argument === "--execute") result.execute = true;
    else if (argument === "--allow-paid-model") {
      result.allowPaidModel = true;
    } else if (argument === "--help" || argument === "-h") result.help = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  return result;
}

function help() {
  return `Usage: node campaign.mjs --artifact-root=DIR [options]

The default is a no-mutation plan. Real execution requires both --execute and
--allow-paid-model.

  --tier=smoke|pilot|claim
  --incidents=401,402
  --seeds=10,20
  --arms=normal_coding_sre,praxis,graph_liveprobe,raw_liveprobe
  --model=gpt-5.4-mini
  --source-root=DIR
  --results-root=DIR
  --python=python3.12
  --namespace=otel-demo
  --registry=liveprobe-praxis
  --kind-cluster=kind-cluster
  --broker-url=http://127.0.0.1:7070
  --prometheus-url=http://127.0.0.1:8080
  --clickhouse-url=http://127.0.0.1:8080/clickhouse
  --replay-base-url=http://127.0.0.1:8080
  --alert-timeout-ms=600000
  --execute --allow-paid-model`;
}

function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export function deterministicShuffle(values, seed) {
  const random = seededRandom(seed);
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

function run(command, args, { cwd, env, timeoutMs, logPath } = {}) {
  return new Promise((resolveRun, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd,
      env: env === undefined ? process.env : { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs ?? 3_600_000);
    timer.unref();
    child.once("exit", (code) => {
      clearTimeout(timer);
      void (async () => {
        const elapsedMs = Math.round(performance.now() - started);
        if (logPath !== undefined) {
          await appendFile(
            logPath,
            [
              `$ ${command} ${args.join(" ")}`,
              stdout,
              stderr,
              `[exit=${code} elapsed_ms=${elapsedMs}]`,
              "",
            ].join("\n"),
          );
        }
        if (code === 0 && !timedOut) {
          resolveRun({ stdout, stderr, elapsedMs });
        } else {
          const error = new Error(
            timedOut
              ? `${command} timed out after ${timeoutMs}ms`
              : `${command} exited ${code}: ${(stderr || stdout).slice(-8000)}`,
          );
          error.stdout = stdout;
          error.stderr = stderr;
          error.elapsedMs = elapsedMs;
          error.timedOut = timedOut;
          reject(error);
        }
      })().catch(reject);
    });
  });
}

async function firingAlerts(prometheusUrl) {
  const response = await fetch(
    `${prometheusUrl.replace(/\/+$/, "")}/prometheus/api/v1/alerts`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    throw new Error(`Prometheus alerts returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  return (payload.data?.alerts ?? []).filter(
    (alert) => String(alert.state).toLowerCase() === "firing",
  );
}

function alertKey(alert) {
  return sha256({
    labels: alert.labels ?? {},
    annotations: alert.annotations ?? {},
  });
}

async function waitForNewAlert(prometheusUrl, baseline, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const alerts = await firingAlerts(prometheusUrl);
      const fresh = alerts.filter((alert) => !baseline.has(alertKey(alert)));
      if (fresh.length > 0) return { alerts, fresh };
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
  }
  throw new Error(
    `no new firing alert within ${timeoutMs}ms` +
      (lastError === undefined ? "" : `: ${String(lastError)}`),
  );
}

async function waitForAlertKeysAbsent(prometheusUrl, keys, timeoutMs) {
  if (keys.size === 0) return;
  const deadline = Date.now() + timeoutMs;
  let present = [];
  let lastError;
  while (Date.now() < deadline) {
    try {
      present = (await firingAlerts(prometheusUrl))
        .map(alertKey)
        .filter((key) => keys.has(key));
      if (present.length === 0) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
  }
  throw new Error(
    `previous incident alerts did not clear within ${timeoutMs}ms` +
      (present.length === 0 ? "" : ` (${present.length} still firing)`) +
      (lastError === undefined ? "" : `: ${String(lastError)}`),
  );
}

async function waitForHttp(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(
    `${url} did not become ready` +
      (lastError === undefined ? "" : `: ${String(lastError)}`),
  );
}

async function resetBroker(options, logPath) {
  await run(
    "kubectl",
    [
      "-n",
      options.namespace,
      "rollout",
      "restart",
      "deployment/liveprobe-broker",
    ],
    { cwd: repositoryRoot, logPath },
  );
  await run(
    "kubectl",
    [
      "-n",
      options.namespace,
      "rollout",
      "status",
      "deployment/liveprobe-broker",
      "--timeout=120s",
    ],
    { cwd: repositoryRoot, logPath },
  );
  await waitForHttp(`${options.brokerUrl.replace(/\/+$/, "")}/v1/ping`);
}

async function cleanAgentClone(source, expectedCommit) {
  const temporary = await mkdtemp(
    join(tmpdir(), "liveprobe-praxis-agent-source-"),
  );
  const checkout = join(temporary, "source");
  await run(
    "git",
    ["clone", "--quiet", "--no-hardlinks", source, checkout],
    { timeoutMs: 120_000 },
  );
  const head = (
    await run("git", ["rev-parse", "HEAD"], { cwd: checkout })
  ).stdout.trim();
  if (head !== expectedCommit) {
    await rm(temporary, { recursive: true, force: true });
    throw new Error(`clean clone commit ${head} != ${expectedCommit}`);
  }
  const status = (
    await run(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: checkout },
    )
  ).stdout.trim();
  if (status !== "") {
    await rm(temporary, { recursive: true, force: true });
    throw new Error(`clean agent clone is dirty: ${status}`);
  }
  return { temporary, checkout };
}

function failureResult({ incidentId, arm, seed, model, error }) {
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    run_id: `failed-${incidentId}-${arm}-${seed}`,
    benchmark_mode: "controlled_campaign",
    synthetic_evidence: false,
    incident_id: incidentId,
    arm,
    seed,
    model,
    answer: {
      status: "INSUFFICIENT",
      root_cause: { entity: "unknown", kind: "Unknown" },
      mechanism: "The evaluation run failed before a diagnosis was returned.",
      propagation: [],
      remediation: "Retry only after resolving the recorded runner failure.",
      confidence: 0,
    },
    score: null,
    usage: error.usage ?? zeroUsage(),
    wall_ms: Number(error.elapsedMs ?? 0),
    model_wall_ms: Number(error.usage?.model_ms ?? 0),
    runtime_wall_ms: 0,
    tool_calls: Number(error.usage?.tool_calls ?? 0),
    failure: {
      type: error.name ?? "Error",
      message: String(error.message ?? error),
      timeout: error.timedOut === true,
    },
  };
}

async function writeState(state, output) {
  state.updated_at = new Date().toISOString();
  state.summary = summarizeResults(state.results);
  await writeFile(output, `${JSON.stringify(state, null, 2)}\n`);
}

function tierDefaults(config, tier) {
  if (!["smoke", "pilot", "claim"].includes(tier)) {
    throw new Error("--tier must be smoke, pilot, or claim");
  }
  return {
    seeds: config.seeds[tier],
    budgetTier: tier === "smoke" ? "smoke" : "full",
    tokenBudget:
      tier === "smoke"
        ? config.budgets.smoke_llm_total_tokens
        : config.budgets.llm_total_tokens,
    timeoutMs:
      tier === "smoke"
        ? config.budgets.smoke_wall_time_ms
        : config.budgets.wall_time_ms,
  };
}

function runIdentity(incidentId, arm, seed) {
  return `${incidentId}\u0000${arm}\u0000${seed}`;
}

function fillMissingIncidentResults({
  state,
  incidentState,
  options,
  incidentId,
  error,
}) {
  const recorded = new Set(
    state.results.map((result) =>
      runIdentity(result.incident_id, result.arm, result.seed),
    ),
  );
  for (const seed of options.seeds) {
    let runState = incidentState.runs.find((run) => run.seed === seed);
    if (runState === undefined) {
      runState = {
        seed,
        order: deterministicShuffle(
          options.arms,
          Number(seed) ^ Number(incidentId),
        ),
        completed: [],
      };
      incidentState.runs.push(runState);
    }
    for (const arm of options.arms) {
      const identity = runIdentity(incidentId, arm, seed);
      if (recorded.has(identity)) continue;
      state.results.push(
        failureResult({
          incidentId,
          arm,
          seed,
          model: options.model,
          error,
        }),
      );
      runState.completed.push(arm);
      recorded.add(identity);
    }
  }
}

function validateOptions(options, scenarios, config) {
  if (options.artifactRoot === undefined) {
    throw new Error("--artifact-root is required");
  }
  for (const arm of options.arms) {
    if (!ARM_NAMES.includes(arm)) throw new Error(`unknown arm ${arm}`);
  }
  const defaults = tierDefaults(config, options.tier);
  options.seeds ??= defaults.seeds;
  options.incidents ??=
    options.tier === "smoke"
      ? ["401"]
      : scenarios.incidents
          .filter((incident) => incident.four_arm)
          .map((incident) => String(incident.id));
  if (options.arms.length === 0) throw new Error("select at least one arm");
  if (options.incidents.length === 0) {
    throw new Error("select at least one incident");
  }
  if (options.seeds.length === 0) throw new Error("select at least one seed");
  for (const [label, values] of [
    ["arms", options.arms],
    ["incidents", options.incidents],
    ["seeds", options.seeds],
  ]) {
    if (new Set(values.map(String)).size !== values.length) {
      throw new Error(`${label} must not contain duplicates`);
    }
  }
  const allowed = new Set(
    scenarios.incidents
      .filter((incident) => incident.four_arm)
      .map((incident) => String(incident.id)),
  );
  for (const incident of options.incidents) {
    if (!allowed.has(String(incident))) {
      throw new Error(`incident ${incident} is not in the four-arm panel`);
    }
  }
  if (!options.seeds.every(Number.isInteger)) {
    throw new Error("all seeds must be integers");
  }
  if (!Number.isInteger(options.alertTimeoutMs) || options.alertTimeoutMs < 1) {
    throw new Error("--alert-timeout-ms must be a positive integer");
  }
  if (options.execute && !options.allowPaidModel) {
    throw new Error("--execute also requires --allow-paid-model");
  }
  if (
    options.execute &&
    !options.incidents.includes("401")
  ) {
    throw new Error(
      "campaign execution must include incident 401 as the representative " +
        "runtime tripwire before paid arms",
    );
  }
  return defaults;
}

async function verifyArtifact(options, lock) {
  const marker = await readJson(
    resolve(options.artifactRoot, ".liveprobe-artifact.json"),
  );
  if (marker.sha256 !== lock.artifact.sha256) {
    throw new Error("artifact cache marker does not match artifact.lock.json");
  }
}

async function executeCodingArm({
  options,
  defaults,
  incidentId,
  arm,
  seed,
  snapshotPath,
  source,
  metadata,
  runDirectory,
  logPath,
}) {
  const clone = await cleanAgentClone(source, metadata.git_commit);
  try {
    const output = resolve(runDirectory, `${arm}.json`);
    const ledgerCache = resolve(runDirectory, `${arm}-analysis.sqlite3`);
    await run(
      process.execPath,
      [
        resolve(evaluationRoot, "src/benchmark.mjs"),
        "--mode=codex",
        `--incidents=${incidentId}`,
        `--arms=${arm}`,
        `--seed=${seed}`,
        `--model=${options.model}`,
        `--source-root=${clone.checkout}`,
        `--snapshot=${snapshotPath}`,
        `--broker-url=${options.brokerUrl}`,
        `--budget-tier=${defaults.budgetTier}`,
        "--enable-live-replay",
        "--defer-scoring",
        `--output=${output}`,
        "--allow-paid-model",
      ],
      {
        cwd: repositoryRoot,
        timeoutMs: defaults.timeoutMs + 60_000,
        logPath,
        env: {
          LIVEPROBE_ANALYSIS_CACHE: ledgerCache,
        },
      },
    );
    const artifact = await readJson(output);
    if (artifact.results.length !== 1) {
      throw new Error("coding arm did not emit exactly one result");
    }
    return artifact.results[0];
  } finally {
    await rm(clone.temporary, { recursive: true, force: true });
  }
}

async function executePraxisArm({
  options,
  defaults,
  incidentId,
  seed,
  snapshotPath,
  runDirectory,
  logPath,
}) {
  const output = resolve(runDirectory, "praxis.json");
  const ledger = resolve(runDirectory, "praxis.ledger.jsonl");
  await run(
    process.execPath,
    [
      resolve(evaluationRoot, "src/praxis-runner.mjs"),
      "--mode=fair",
      `--artifact-root=${options.artifactRoot}`,
      `--snapshot=${snapshotPath}`,
      `--output=${output}`,
      `--ledger=${ledger}`,
      `--model=${options.model}`,
      `--seed=${seed}`,
      `--python=${options.python}`,
      `--timeout-ms=${defaults.timeoutMs}`,
      `--token-budget=${defaults.tokenBudget}`,
      "--allow-paid-model",
    ],
    {
      cwd: repositoryRoot,
      timeoutMs: defaults.timeoutMs + 60_000,
      logPath,
      env: {
        EVAL_INCIDENT_ID: incidentId,
      },
    },
  );
  return readJson(output);
}

async function executePraxisContractTripwire({
  options,
  snapshotPath,
  logPath,
}) {
  const output = resolve(
    options.resultsRoot,
    "praxis-adapter-tripwire.json",
  );
  const ledger = resolve(
    options.resultsRoot,
    "praxis-adapter-tripwire.ledger.jsonl",
  );
  await run(
    options.python,
    [
      resolve(evaluationRoot, "python/fair_tap_agent.py"),
      "--artifact-root",
      options.artifactRoot,
      "--snapshot",
      snapshotPath,
      "--output",
      output,
      "--ledger",
      ledger,
      "--model",
      "deterministic-contract-backend",
      "--seed",
      "0",
      "--token-budget",
      "1",
      "--contract-backend",
    ],
    {
      cwd: resolve(options.artifactRoot, "praxis-ae"),
      timeoutMs: 300_000,
      logPath,
      env: {
        EVAL_RUN_ID: "praxis-adapter-tripwire-401",
        EVAL_INCIDENT_ID: "401",
        INCIDENT_NUMBER: "401",
        SEED: "0",
      },
    },
  );
  const artifact = await readJson(output);
  const entities = Object.values(artifact.raw?.exploration_graph ?? {});
  const codeContextLoaded = entities.some(
    (entity) =>
      typeof entity?.code_context_insights?.code_insights_response ===
        "string" &&
      entity.code_context_insights.code_insights_response.length > 0,
  );
  if (
    artifact.contract_backend !== true ||
    artifact.benchmark_result !== false ||
    Number(artifact.deterministic_inference_steps) < 1 ||
    entities.length < 1 ||
    artifact.normalized?.root_cause?.entity === "unknown" ||
    !codeContextLoaded
  ) {
    throw new Error(
      "deterministic PRAXIS adapter tripwire did not traverse snapshot, " +
        "exploration graph, and incident-specific program analysis",
    );
  }
  return {
    schema_version: "liveprobe-praxis-adapter-tripwire/v1",
    benchmark_result: false,
    status: "passed",
    incident_id: "401",
    deterministic_inference_steps:
      artifact.deterministic_inference_steps,
    explored_entity_count: entities.length,
    incident_program_analysis_loaded: codeContextLoaded,
    normalized_status: artifact.normalized.status,
    normalized_root_kind: artifact.normalized.root_cause.kind,
    output_sha256: sha256(artifact),
  };
}

async function scoreAfterAllModels(state, options, campaignPath, logPath) {
  const oraclePath = resolve(options.resultsRoot, "scorer-only-oracle.json");
  await run(
    process.execPath,
    [
      resolve(evaluationRoot, "scripts/build-official-oracle.mjs"),
      `--artifact-root=${options.artifactRoot}`,
      `--output=${oraclePath}`,
      `--incidents=${options.incidents.join(",")}`,
    ],
    { cwd: repositoryRoot, logPath },
  );
  const oracle = await readJson(oraclePath);
  for (const result of state.results) {
    result.score = scoreDiagnosis(
      result.answer,
      oracle.incidents[result.incident_id],
    );
  }
  state.oracle = {
    generated_after_all_model_runs: true,
    sha256: sha256(oracle),
    path: oraclePath,
  };
  await writeState(state, campaignPath);
}

export async function runCampaign(options) {
  const [config, scenarios, lock] = await Promise.all([
    readJson(resolve(evaluationRoot, "benchmark.config.json")),
    readJson(resolve(evaluationRoot, "scenarios.json")),
    readJson(resolve(evaluationRoot, "artifact.lock.json")),
  ]);
  const defaults = validateOptions(options, scenarios, config);
  const plan = {
    schema_version: "liveprobe-praxis-campaign-plan/v1",
    tier: options.tier,
    incidents: options.incidents,
    seeds: options.seeds,
    arms: options.arms,
    model: options.model,
    reasoning_effort: config.decision_model.reasoning_effort,
    estimated_model_runs:
      options.incidents.length * options.seeds.length * options.arms.length,
    token_budget_per_run: defaults.tokenBudget,
    execute: options.execute,
  };
  if (!options.execute) return plan;

  const host = await inspectHost();
  if (!host.supported) {
    throw new Error(
      `remote preflight failed: ${host.failures.join("; ")}`,
    );
  }
  await verifyArtifact(options, lock);
  await mkdir(options.resultsRoot, { recursive: true });
  const existingResults = await readdir(options.resultsRoot);
  if (existingResults.length > 0) {
    throw new Error(
      `--results-root must be empty for an independent campaign; found ` +
        existingResults.slice(0, 8).join(", "),
    );
  }
  const campaignPath = resolve(options.resultsRoot, "campaign.json");
  const campaignLog = resolve(options.resultsRoot, "campaign.log");
  const state = {
    schema_version: "liveprobe-praxis-campaign/v1",
    generated_at: new Date().toISOString(),
    status: "RUNNING",
    plan,
    host,
    results: [],
    incidents: {},
    scoring_deferred_until_all_models_complete: true,
  };
  await writeState(state, campaignPath);

  const praxisCompatibilityPath = resolve(
    options.resultsRoot,
    "praxis-artifact-compatibility.json",
  );
  await run(
    options.python,
    [
      resolve(
        evaluationRoot,
        "python/check_praxis_artifact_compatibility.py",
      ),
      "--artifact-root",
      options.artifactRoot,
      "--output",
      praxisCompatibilityPath,
      "--incidents",
      options.incidents.join(","),
    ],
    { cwd: repositoryRoot, logPath: campaignLog },
  );
  const praxisCompatibility = await readJson(praxisCompatibilityPath);
  state.praxis_artifact_compatibility = {
    compatible: praxisCompatibility.compatible,
    summary: praxisCompatibility.summary,
    sha256: sha256(praxisCompatibility),
  };
  await writeState(state, campaignPath);
  await run(
    options.python,
    [
      "-c",
      [
        "import sys",
        "sys.path.insert(0, sys.argv[1])",
        "import praxis.agent.rca_langgraph_v2 as rca",
        "assert hasattr(rca, 'RCAAgentV2')",
        "assert hasattr(rca.RCAAgentV2, 'run_rca')",
      ].join("; "),
      resolve(options.artifactRoot, "praxis-ae/src"),
    ],
    {
      cwd: resolve(options.artifactRoot, "praxis-ae"),
      env: {
        API_KEY: "praxis-import-contract-no-provider-call",
        SEED: "0",
      },
      timeoutMs: 60_000,
      logPath: campaignLog,
    },
  );
  state.praxis_import_contract = {
    passed: true,
    provider_call: false,
  };
  await writeState(state, campaignPath);

  const compatibilityPath = resolve(
    options.resultsRoot,
    "liveprobe-compatibility.json",
  );
  await run(
    options.python,
    [
      resolve(
        evaluationRoot,
        "python/check_liveprobe_compatibility.py",
      ),
      "--source-root",
      options.sourceRoot,
      "--output",
      compatibilityPath,
    ],
    { cwd: repositoryRoot, logPath: campaignLog },
  );
  await run(
    "npm",
    ["--prefix", "packages/mcp-server", "run", "build"],
    { cwd: repositoryRoot, logPath: campaignLog },
  );
  await run(
    process.execPath,
    [
      resolve(
        evaluationRoot,
        "scripts/build-instrumented-images.mjs",
      ),
      `--incidents=${options.incidents.join(",")}`,
      `--source-root=${options.sourceRoot}`,
      `--registry=${options.registry}`,
      `--kind-cluster=${options.kindCluster}`,
      "--build-broker",
      "--load-into-kind",
      "--execute",
    ],
    { cwd: repositoryRoot, logPath: campaignLog },
  );
  await run(
    "kubectl",
    ["apply", "-f", resolve(evaluationRoot, "instrumentation/liveprobe-broker.yaml")],
    { cwd: repositoryRoot, logPath: campaignLog },
  );
  await run(
    "kubectl",
    [
      "-n",
      options.namespace,
      "rollout",
      "status",
      "deployment/liveprobe-broker",
      "--timeout=120s",
    ],
    { cwd: repositoryRoot, logPath: campaignLog },
  );
  await waitForHttp(`${options.brokerUrl.replace(/\/+$/, "")}/v1/ping`);
  await firingAlerts(options.prometheusUrl);

  let runtimeTripwirePassed = false;
  let praxisAdapterTripwirePassed = false;
  let previousIncidentAlertKeys = new Set();
  const orderedIncidents = [
    "401",
    ...options.incidents.filter((incident) => incident !== "401"),
  ].filter((incident, index, values) => values.indexOf(incident) === index);
  for (const incidentId of orderedIncidents) {
    if (!options.incidents.includes(incidentId)) continue;
    const incidentStarted = performance.now();
    const incidentDirectory = resolve(
      options.resultsRoot,
      `incident-${incidentId}`,
    );
    await mkdir(incidentDirectory, { recursive: true });
    const incidentLog = resolve(incidentDirectory, "incident.log");
    const source = resolve(options.sourceRoot, incidentId);
    const incidentState = {
      status: "PREPARING",
      runs: [],
    };
    state.incidents[incidentId] = incidentState;
    await writeState(state, campaignPath);
    let injected = false;
    let baseline;
    let detectedAlertKeys = new Set();
    try {
      await waitForAlertKeysAbsent(
        options.prometheusUrl,
        previousIncidentAlertKeys,
        options.alertTimeoutMs,
      );
      previousIncidentAlertKeys = new Set();
      const metadata = await readJson(
        resolve(source, "source-metadata.json"),
      );
      baseline = new Set(
        (await firingAlerts(options.prometheusUrl)).map(alertKey),
      );
      incidentState.status = "INJECTING";
      incidentState.baseline_firing_alerts = baseline.size;
      await writeState(state, campaignPath);
      await run(
        "make",
        ["-C", resolve(options.artifactRoot, "itbench-lite-ae/sre"), "inject_incident_fault"],
        {
          env: { INCIDENT_NUMBER: incidentId },
          logPath: incidentLog,
        },
      );
      injected = true;
      await run(
        process.execPath,
        [
          resolve(evaluationRoot, "scripts/enable-liveprobe.mjs"),
          `--incident=${incidentId}`,
          `--namespace=${options.namespace}`,
          `--registry=${options.registry}`,
          `--source-root=${source}`,
          "--allow-unready",
          "--execute",
        ],
        { cwd: repositoryRoot, logPath: incidentLog },
      );
      incidentState.status = "WAITING_FOR_ALERT";
      await writeState(state, campaignPath);
      const alertResult = await waitForNewAlert(
        options.prometheusUrl,
        baseline,
        options.alertTimeoutMs,
      );
      incidentState.new_firing_alerts = alertResult.fresh.length;
      detectedAlertKeys = new Set(alertResult.fresh.map(alertKey));
      incidentState.detected_alert_keys = [...detectedAlertKeys].sort();

      const snapshotPath = resolve(
        incidentDirectory,
        `incident-${incidentId}.snapshot.json`,
      );
      await run(
        options.python,
        [
          resolve(evaluationRoot, "python/collect_snapshot.py"),
          "--incident-id",
          incidentId,
          "--output",
          snapshotPath,
          "--services",
          "frontend-proxy,frontend,recommendation,product-catalog,neo4j-productdb",
          "--prometheus-url",
          options.prometheusUrl,
          "--clickhouse-url",
          options.clickhouseUrl,
          "--replay-base-url",
          options.replayBaseUrl,
        ],
        { cwd: repositoryRoot, logPath: incidentLog },
      );
      await chmod(snapshotPath, 0o444);
      const snapshot = await readJson(snapshotPath);
      if (snapshot.synthetic || snapshot.incident_id !== incidentId) {
        throw new Error("collector did not produce the expected real snapshot");
      }
      incidentState.snapshot = {
        path: snapshotPath,
        revision: snapshot.revision,
        sha256: sha256(snapshot),
      };

      if (!runtimeTripwirePassed && incidentId === "401") {
        const runtimeOutput = resolve(
          options.resultsRoot,
          "liveprobe-runtime-tripwire.json",
        );
        await run(
          process.execPath,
          [
            resolve(
              evaluationRoot,
              "scripts/remote-liveprobe-tripwire.mjs",
            ),
            "--incident=401",
            `--source-root=${source}`,
            `--compatibility-report=${compatibilityPath}`,
            `--broker-url=${options.brokerUrl}`,
            `--replay-base-url=${options.replayBaseUrl}`,
            `--output=${runtimeOutput}`,
            `--python=${options.python}`,
          ],
          { cwd: repositoryRoot, logPath: incidentLog },
        );
        runtimeTripwirePassed = true;
        state.runtime_tripwire = await readJson(runtimeOutput);
        await resetBroker(options, incidentLog);
      }
      if (!praxisAdapterTripwirePassed && incidentId === "401") {
        state.praxis_adapter_tripwire =
          await executePraxisContractTripwire({
            options,
            snapshotPath,
            logPath: incidentLog,
          });
        praxisAdapterTripwirePassed = true;
        await writeState(state, campaignPath);
      }
      if (!runtimeTripwirePassed || !praxisAdapterTripwirePassed) {
        throw new Error(
          "paid arms cannot start before both incident-401 runtime tripwires",
        );
      }

      incidentState.status = "RUNNING_ARMS";
      for (const seed of options.seeds) {
        const runDirectory = resolve(
          incidentDirectory,
          `seed-${seed}`,
        );
        await mkdir(runDirectory, { recursive: true });
        const order = deterministicShuffle(
          options.arms,
          Number(seed) ^ Number(incidentId),
        );
        incidentState.runs.push({ seed, order, completed: [] });
        for (const arm of order) {
          const runLog = resolve(runDirectory, `${arm}.log`);
          let result;
          const usesLiveProbe =
            arm === "graph_liveprobe" || arm === "raw_liveprobe";
          try {
            if (usesLiveProbe) {
              await resetBroker(options, runLog);
            }
            result =
              arm === "praxis"
                ? await executePraxisArm({
                    options,
                    defaults,
                    incidentId,
                    seed,
                    snapshotPath,
                    runDirectory,
                    logPath: runLog,
                  })
                : await executeCodingArm({
                    options,
                    defaults,
                    incidentId,
                    arm,
                    seed,
                    snapshotPath,
                    source,
                    metadata,
                    runDirectory,
                    logPath: runLog,
                  });
          } catch (error) {
            result = failureResult({
              incidentId,
              arm,
              seed,
              model: options.model,
              error,
            });
          } finally {
            if (usesLiveProbe) {
              try {
                await resetBroker(options, runLog);
              } catch (cleanupError) {
                incidentState.isolation_failures ??= [];
                incidentState.isolation_failures.push({
                  arm,
                  seed,
                  message: String(
                    cleanupError.message ?? cleanupError,
                  ),
                });
                if (result?.failure === undefined) {
                  cleanupError.usage = result?.usage;
                  cleanupError.elapsedMs = result?.wall_ms;
                  const priorResultSha256 = sha256(result ?? {});
                  result = failureResult({
                    incidentId,
                    arm,
                    seed,
                    model: options.model,
                    error: cleanupError,
                  });
                  result.failure.phase = "post_arm_isolation";
                  result.failure.prior_result_sha256 = priorResultSha256;
                } else {
                  result.failure.isolation_cleanup = String(
                    cleanupError.message ?? cleanupError,
                  );
                }
              }
            }
          }
          if (result.failure !== undefined) {
            await writeFile(
              resolve(runDirectory, `${arm}.failure.json`),
              `${JSON.stringify(result, null, 2)}\n`,
            );
          }
          state.results.push(result);
          incidentState.runs.at(-1).completed.push(arm);
          await writeState(state, campaignPath);
        }
      }
      incidentState.status = "COMPLETE";
    } catch (error) {
      incidentState.status = "FAILED";
      incidentState.failure = {
        type: error.name ?? "Error",
        message: String(error.message ?? error),
      };
      fillMissingIncidentResults({
        state,
        incidentState,
        options,
        incidentId,
        error,
      });
    } finally {
      incidentState.elapsed_ms = Math.round(
        performance.now() - incidentStarted,
      );
      if (injected) {
        previousIncidentAlertKeys = new Set(detectedAlertKeys);
        try {
          await run(
            "make",
            [
              "-C",
              resolve(options.artifactRoot, "itbench-lite-ae/sre"),
              "remove_incident_fault",
            ],
            {
              env: { INCIDENT_NUMBER: incidentId },
              logPath: incidentLog,
            },
          );
          incidentState.fault_removed = true;
        } catch (error) {
          incidentState.fault_removed = false;
          incidentState.cleanup_error = String(error.message ?? error);
          if (incidentState.status === "COMPLETE") {
            incidentState.status = "FAILED";
          }
        }
        if (incidentState.fault_removed) {
          try {
            if (baseline !== undefined) {
              const now = await firingAlerts(options.prometheusUrl);
              for (const alert of now) {
                const key = alertKey(alert);
                if (!baseline.has(key)) detectedAlertKeys.add(key);
              }
            }
            previousIncidentAlertKeys = new Set(detectedAlertKeys);
            await waitForAlertKeysAbsent(
              options.prometheusUrl,
              previousIncidentAlertKeys,
              options.alertTimeoutMs,
            );
            previousIncidentAlertKeys = new Set();
            incidentState.alerts_cleared = true;
          } catch (error) {
            incidentState.alerts_cleared = false;
            incidentState.alert_cleanup_error = String(
              error.message ?? error,
            );
            if (incidentState.status === "COMPLETE") {
              incidentState.status = "FAILED";
            }
          }
        }
      }
      await writeState(state, campaignPath);
    }
  }

  const expectedRuns =
    options.incidents.length * options.seeds.length * options.arms.length;
  state.accounting = {
    expected_runs: expectedRuns,
    recorded_runs: state.results.length,
    failed_runs: state.results.filter(
      (result) => result.failure !== undefined,
    ).length,
  };
  try {
    await scoreAfterAllModels(state, options, campaignPath, campaignLog);
  } catch (error) {
    state.status = "PARTIAL";
    state.scoring_failure = {
      type: error.name ?? "Error",
      message: String(error.message ?? error),
    };
    await writeState(state, campaignPath);
    return state;
  }
  const incidentFailures = Object.values(state.incidents).filter(
    (incident) => incident.status !== "COMPLETE",
  ).length;
  state.status =
    state.results.length === expectedRuns &&
    state.accounting.failed_runs === 0 &&
    incidentFailures === 0
      ? "COMPLETE"
      : "PARTIAL";
  await writeState(state, campaignPath);
  return state;
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(`${help()}\n`);
  else {
    runCampaign(options)
      .then((result) => {
        const summary =
          result.schema_version === "liveprobe-praxis-campaign-plan/v1"
            ? result
            : {
                status: result.status,
                results: result.results.length,
                summary: result.summary,
              };
        process.stdout.write(
          `${JSON.stringify(summary, null, 2)}\n`,
        );
      })
      .catch((error) => {
        process.stderr.write(`praxis-campaign: ${error.stack ?? error}\n`);
        process.exitCode = 1;
      });
  }
}
