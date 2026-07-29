#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { armCapabilities } from "./arms.mjs";
import {
  RESULT_SCHEMA_VERSION,
  normalizeUsage,
  scoreDiagnosis,
  sha256,
  zeroUsage,
} from "./core.mjs";

const evaluationRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

function parseArgs(argv) {
  const result = {
    mode: undefined,
    artifactRoot: undefined,
    snapshot: undefined,
    output: undefined,
    ledger: undefined,
    oracle: undefined,
    model: "gpt-5.4-mini",
    seed: 10,
    allowPaidModel: false,
    python: "python3.12",
    timeoutMs: 3_000_000,
    tokenBudget: 250_000,
  };
  for (const argument of argv) {
    if (argument.startsWith("--mode=")) result.mode = argument.slice(7);
    else if (argument.startsWith("--artifact-root=")) {
      result.artifactRoot = resolve(argument.slice(16));
    } else if (argument.startsWith("--snapshot=")) {
      result.snapshot = resolve(argument.slice(11));
    } else if (argument.startsWith("--output=")) {
      result.output = resolve(argument.slice(9));
    } else if (argument.startsWith("--ledger=")) {
      result.ledger = resolve(argument.slice(9));
    } else if (argument.startsWith("--oracle=")) {
      result.oracle = resolve(argument.slice(9));
    } else if (argument.startsWith("--model=")) result.model = argument.slice(8);
    else if (argument.startsWith("--seed=")) result.seed = Number(argument.slice(7));
    else if (argument.startsWith("--python=")) result.python = argument.slice(9);
    else if (argument.startsWith("--timeout-ms=")) {
      result.timeoutMs = Number(argument.slice(13));
    } else if (argument.startsWith("--token-budget=")) {
      result.tokenBudget = Number(argument.slice(15));
    } else if (argument === "--allow-paid-model") result.allowPaidModel = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  return result;
}

function help() {
  return `Usage: node praxis-runner.mjs --mode=native|fair --artifact-root=DIR --output=FILE [options]

  --snapshot=FILE       Required for fair mode
  --ledger=FILE         Required for fair mode
  --oracle=FILE         Scorer-only oracle for common leaderboard output
  --model=NAME          Fair model (default: gpt-5.4-mini)
  --seed=NUMBER
  --python=COMMAND      Python 3.12 interpreter
  --timeout-ms=NUMBER
  --token-budget=NUMBER
  --allow-paid-model    Required for either real PRAXIS mode`;
}

function addUsage(target, delta) {
  for (const key of Object.keys(target)) {
    target[key] += Number(delta[key] ?? 0);
  }
  return target;
}

async function readLedger(path) {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function usageFromLedger(records) {
  const usage = zeroUsage();
  for (const record of records) {
    if (record.kind === "model_call") {
      addUsage(usage, normalizeUsage(record.usage));
    } else if (record.kind === "tool_call") {
      usage.tool_calls += 1;
      usage.tool_response_bytes += Number(record.response_bytes ?? 0);
    }
  }
  return usage;
}

function run(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
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
    }, timeoutMs);
    timer.unref();
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolveRun({ stdout, stderr });
      else {
        reject(
          new Error(
            timedOut
              ? `PRAXIS timed out after ${timeoutMs}ms`
              : `PRAXIS exited ${code}: ${(stderr || stdout).slice(-8_000)}`,
          ),
        );
      }
    });
  });
}

export async function runPraxis(options) {
  if (!["native", "fair"].includes(options.mode)) {
    throw new Error("--mode must be native or fair");
  }
  if (!options.allowPaidModel) {
    throw new Error("real PRAXIS execution requires --allow-paid-model");
  }
  if (!Number.isInteger(options.tokenBudget) || options.tokenBudget < 1) {
    throw new Error("--token-budget must be a positive integer");
  }
  if (options.artifactRoot === undefined || options.output === undefined) {
    throw new Error("--artifact-root and --output are required");
  }
  if (
    options.mode === "fair" &&
    (options.snapshot === undefined || options.ledger === undefined)
  ) {
    throw new Error("--snapshot and --ledger are required for fair mode");
  }
  const snapshot =
    options.snapshot === undefined
      ? undefined
      : JSON.parse(await readFile(options.snapshot, "utf8"));
  if (
    options.mode === "fair" &&
    (snapshot === undefined || snapshot.synthetic === true)
  ) {
    throw new Error(
      "fair PRAXIS leaderboard runs require a real immutable snapshot",
    );
  }
  await mkdir(dirname(options.output), { recursive: true });
  if (options.mode === "fair") {
    await mkdir(dirname(options.ledger), { recursive: true });
    await writeFile(options.ledger, "");
  }
  const started = performance.now();
  let commandArgs;
  let cwd;
  const env = {
    ...process.env,
    SEED: String(options.seed),
    EVAL_RUN_ID:
      `praxis-${options.mode}-` +
      `${snapshot?.incident_id ?? "native"}-${options.seed}`,
    ...(snapshot === undefined
      ? {}
      : {
          // The released PRAXIS code-analysis selector uses this ID to load
          // the matching precomputed incident graph instead of fault-free
          // analysis.
          INCIDENT_NUMBER: String(snapshot.incident_id),
        }),
  };
  if (options.mode === "native") {
    cwd = resolve(options.artifactRoot, "praxis-ae");
    commandArgs = [
      resolve(cwd, "bin/tap_agent.py"),
      "--info",
      "--logs-dir",
      dirname(options.output),
    ];
  } else {
    // PRAXIS resolves its released program-analysis assets relative to this
    // directory. Running elsewhere silently disables its code-enhanced arm.
    cwd = resolve(options.artifactRoot, "praxis-ae");
    commandArgs = [
      resolve(evaluationRoot, "python/fair_tap_agent.py"),
      "--artifact-root",
      options.artifactRoot,
      "--snapshot",
      options.snapshot,
      "--output",
      options.output,
      "--ledger",
      options.ledger,
      "--model",
      options.model,
      "--seed",
      String(options.seed),
      "--token-budget",
      String(options.tokenBudget),
    ];
  }
  const result = await run(options.python, commandArgs, {
    cwd,
    env,
    timeoutMs: options.timeoutMs,
  });
  const metadata = {
    schema_version: "liveprobe-praxis-launch/v1",
    mode: options.mode,
    model:
      options.mode === "native"
        ? process.env.MODEL ?? "artifact-configured"
        : options.model,
    seed: options.seed,
    wall_ms: Math.round(performance.now() - started),
    artifact_root_sha256: sha256(options.artifactRoot),
    stdout_sha256: sha256(result.stdout),
    stderr_sha256: sha256(result.stderr),
  };
  if (options.mode === "native") {
    await writeFile(
      options.output,
      `${JSON.stringify(
        {
          ...metadata,
          accounting:
            "Native artifact does not expose per-call provider usage; this track is not used for leaderboard cost claims.",
          stdout: result.stdout,
          stderr: result.stderr,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const fair = JSON.parse(await readFile(options.output, "utf8"));
    const records = await readLedger(options.ledger);
    const usage = usageFromLedger(records);
    const oracleDocument =
      options.oracle === undefined
        ? undefined
        : JSON.parse(await readFile(options.oracle, "utf8"));
    const oracle = oracleDocument?.incidents?.[snapshot.incident_id];
    if (options.oracle !== undefined && oracle === undefined) {
      throw new Error(
        `selected oracle has no incident ${snapshot.incident_id}`,
      );
    }
    const common = {
      schema_version: RESULT_SCHEMA_VERSION,
      run_id: env.EVAL_RUN_ID,
      benchmark_mode: "controlled_praxis_fair",
      synthetic_evidence: false,
      incident_id: snapshot.incident_id,
      arm: "praxis",
      seed: options.seed,
      model: options.model,
      capability_profile: armCapabilities("praxis"),
      answer: fair.normalized,
      score:
        oracle === undefined
          ? null
          : scoreDiagnosis(fair.normalized, oracle),
      usage,
      wall_ms: metadata.wall_ms,
      model_wall_ms: usage.model_ms,
      runtime_wall_ms: Math.max(0, metadata.wall_ms - usage.model_ms),
      tool_calls: usage.tool_calls,
      records_sha256: sha256(records),
    };
    await writeFile(
      options.output,
      `${JSON.stringify(
        {
          ...common,
          praxis: {
            launch: metadata,
            normalization: fair.normalization,
            raw: fair.raw,
          },
        },
        null,
        2,
      )}\n`,
    );
    return common;
  }
  return metadata;
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(`${help()}\n`);
  else {
    runPraxis(options)
      .then((metadata) => process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`))
      .catch((error) => {
        process.stderr.write(`praxis-runner: ${error.stack ?? error}\n`);
        process.exitCode = 1;
      });
  }
}
