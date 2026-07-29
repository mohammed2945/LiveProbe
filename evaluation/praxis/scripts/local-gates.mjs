#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { readJson, sha256 } from "../src/core.mjs";

const evaluationRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(evaluationRoot, "../..");

function parseArgs(argv) {
  const result = {
    artifactRoot: undefined,
    artifactArchive: undefined,
    sourceRoot: resolve(repositoryRoot, ".eval-cache/praxis-sources"),
    python: "python3.12",
    output: resolve(evaluationRoot, "results/local-validation.json"),
    fixtureOutput: resolve(evaluationRoot, "results/fixture.json"),
    compatibilityOutput: resolve(
      evaluationRoot,
      "results/liveprobe-compatibility.json",
    ),
    praxisCompatibilityOutput: resolve(
      evaluationRoot,
      "results/praxis-artifact-compatibility.json",
    ),
    preflightOutput: resolve(
      evaluationRoot,
      "results/remote-preflight.json",
    ),
    oracleOutput: resolve(
      evaluationRoot,
      "results/official-oracle.json",
    ),
  };
  for (const argument of argv) {
    if (argument.startsWith("--artifact-root=")) {
      result.artifactRoot = resolve(argument.slice(16));
    } else if (argument.startsWith("--artifact-archive=")) {
      result.artifactArchive = resolve(argument.slice(19));
    } else if (argument.startsWith("--source-root=")) {
      result.sourceRoot = resolve(argument.slice(14));
    } else if (argument.startsWith("--python=")) {
      result.python = argument.slice(9);
    } else if (argument.startsWith("--output=")) {
      result.output = resolve(argument.slice(9));
    } else if (argument.startsWith("--fixture-output=")) {
      result.fixtureOutput = resolve(argument.slice(17));
    } else if (argument.startsWith("--compatibility-output=")) {
      result.compatibilityOutput = resolve(argument.slice(23));
    } else if (argument.startsWith("--praxis-compatibility-output=")) {
      result.praxisCompatibilityOutput = resolve(argument.slice(30));
    } else if (argument.startsWith("--preflight-output=")) {
      result.preflightOutput = resolve(argument.slice(19));
    } else if (argument.startsWith("--oracle-output=")) {
      result.oracleOutput = resolve(argument.slice(16));
    } else if (argument === "--help" || argument === "-h") {
      result.help = true;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return result;
}

function help() {
  return `Usage: node local-gates.mjs [options]

Runs only zero-token, non-cluster validation.

  --artifact-root=DIR
  --artifact-archive=FILE
  --source-root=DIR
  --python=python3.12
  --output=FILE
  --fixture-output=FILE
  --compatibility-output=FILE
  --praxis-compatibility-output=FILE
  --preflight-output=FILE
  --oracle-output=FILE`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, { cwd = repositoryRoot, env, timeoutMs } = {}) {
  return new Promise((resolveRun) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd,
      env: env === undefined ? process.env : { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveRun({
        ...result,
        stdout,
        stderr,
        duration_ms: Math.round(performance.now() - started),
      });
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      finish({ exit_code: null, error: String(error.message ?? error) });
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs ?? 300_000);
    timer.unref();
    child.once("exit", (code) => {
      clearTimeout(timer);
      finish({ exit_code: code, timed_out: timedOut });
    });
  });
}

function gateRecord(name, result, { required = true, acceptedCodes = [0] } = {}) {
  const passed =
    result.timed_out !== true && acceptedCodes.includes(result.exit_code);
  return {
    name,
    required,
    passed,
    exit_code: result.exit_code,
    timed_out: result.timed_out === true,
    duration_ms: result.duration_ms,
    stdout_sha256: sha256(result.stdout),
    stderr_sha256: sha256(result.stderr),
    ...(passed
      ? {}
      : {
          failure_tail: (result.stderr || result.stdout || result.error || "")
            .slice(-4_000),
        }),
  };
}

async function listModuleFiles(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => resolve(directory, entry.name))
    .sort();
}

async function writeState(state, output) {
  state.updated_at = new Date().toISOString();
  state.passed = state.gates
    .filter((gate) => gate.required)
    .every((gate) => gate.passed);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(state, null, 2)}\n`);
}

export async function runLocalGates(options) {
  const state = {
    schema_version: "liveprobe-praxis-local-validation/v1",
    generated_at: new Date().toISOString(),
    scope: "zero_token_non_cluster",
    model_calls: 0,
    paid_model_execution: false,
    artifact_root_supplied: options.artifactRoot !== undefined,
    source_root: options.sourceRoot,
    outputs: {
      fixture: options.fixtureOutput,
      compatibility: options.compatibilityOutput,
      praxis_artifact_compatibility:
        options.artifactRoot === undefined
          ? null
          : options.praxisCompatibilityOutput,
      preflight: options.preflightOutput,
      scorer_only_oracle:
        options.artifactRoot === undefined ? null : options.oracleOutput,
    },
    gates: [],
  };
  await writeState(state, options.output);

  async function commandGate(name, command, args, settings = {}) {
    const result = await run(command, args, settings);
    const record = gateRecord(name, result, settings);
    state.gates.push(record);
    await writeState(state, options.output);
    return { result, record };
  }

  const moduleFiles = [
    ...(await listModuleFiles(resolve(evaluationRoot, "src"))),
    ...(await listModuleFiles(resolve(evaluationRoot, "scripts"))),
  ];
  for (const file of moduleFiles) {
    await commandGate(
      `node_check:${file.slice(evaluationRoot.length + 1)}`,
      process.execPath,
      ["--check", file],
    );
  }

  const pythonFiles = (await readdir(resolve(evaluationRoot, "python")))
    .filter((name) => name.endsWith(".py"))
    .map((name) => resolve(evaluationRoot, "python", name))
    .sort();
  await commandGate(
    "python_compile:evaluation_adapters",
    options.python,
    ["-m", "py_compile", ...pythonFiles],
  );

  const analyzerTests = await commandGate(
    "analyzer_tests",
    "sh",
    [resolve(repositoryRoot, "scripts/python312.sh"), "-m", "pytest"],
    {
      cwd: resolve(repositoryRoot, "python/analyzer"),
      timeoutMs: 300_000,
    },
  );
  const analyzerPassed = analyzerTests.result.stdout.match(
    /(\d+)\s+passed\b/,
  );
  analyzerTests.record.measurements = {
    tests_passed:
      analyzerPassed === null ? null : Number(analyzerPassed[1]),
  };

  await commandGate(
    "mcp_server_build",
    "npm",
    ["--prefix", "packages/mcp-server", "run", "build"],
    { timeoutMs: 300_000 },
  );

  const mcpTests = await commandGate(
    "mcp_server_tests",
    "npm",
    ["--prefix", "packages/mcp-server", "test"],
    { timeoutMs: 300_000 },
  );
  const mcpPassed = mcpTests.result.stdout.match(
    /Tests\s+(\d+)\s+passed\b/,
  );
  mcpTests.record.measurements = {
    tests_passed: mcpPassed === null ? null : Number(mcpPassed[1]),
  };

  const evaluationContracts = await commandGate(
    "evaluation_contracts",
    process.execPath,
    ["--test", resolve(evaluationRoot, "test/contracts.test.mjs")],
    {
      timeoutMs: 60_000,
      env:
        options.artifactRoot === undefined
          ? undefined
          : { PRAXIS_ARTIFACT_ROOT: options.artifactRoot },
    },
  );
  const contractTests = evaluationContracts.result.stdout.match(
    /[ℹ#]\s*tests\s+(\d+)/,
  );
  const contractPassed = evaluationContracts.result.stdout.match(
    /[ℹ#]\s*pass\s+(\d+)/,
  );
  evaluationContracts.record.measurements = {
    tests: contractTests === null ? null : Number(contractTests[1]),
    tests_passed:
      contractPassed === null ? null : Number(contractPassed[1]),
  };

  await commandGate(
    "liveprobe_static_compatibility",
    options.python,
    [
      resolve(evaluationRoot, "python/check_liveprobe_compatibility.py"),
      "--source-root",
      options.sourceRoot,
      "--output",
      options.compatibilityOutput,
    ],
    { timeoutMs: 120_000 },
  );

  await commandGate(
    "deterministic_fixture_tripwire",
    process.execPath,
    [
      resolve(evaluationRoot, "src/benchmark.mjs"),
      "--mode=fixture",
      `--output=${options.fixtureOutput}`,
    ],
  );

  await commandGate(
    "campaign_plan_no_mutation",
    process.execPath,
    [
      resolve(evaluationRoot, "src/campaign.mjs"),
      `--artifact-root=${options.artifactRoot ?? "/plan-only"}`,
      "--tier=smoke",
      "--incidents=401",
      "--seeds=10",
    ],
  );

  await commandGate(
    "instrumented_image_plan",
    process.execPath,
    [
      resolve(evaluationRoot, "scripts/build-instrumented-images.mjs"),
      "--incidents=401",
      `--source-root=${options.sourceRoot}`,
      "--build-broker",
      "--load-into-kind",
    ],
  );

  if (options.artifactArchive !== undefined) {
    await commandGate(
      "locked_artifact_digest",
      process.execPath,
      [
        resolve(evaluationRoot, "scripts/fetch-artifact.mjs"),
        "--offline-archive",
        options.artifactArchive,
        "--verify-only",
      ],
      { timeoutMs: 60_000 },
    );
  }

  if (options.artifactRoot !== undefined) {
    const [lock, marker] = await Promise.all([
      readJson(resolve(evaluationRoot, "artifact.lock.json")),
      readJson(resolve(options.artifactRoot, ".liveprobe-artifact.json")),
    ]);
    state.artifact_identity = {
      expected_sha256: lock.artifact.sha256,
      extracted_marker_sha256: marker.sha256,
      matched: lock.artifact.sha256 === marker.sha256,
    };
    state.gates.push({
      name: "extracted_artifact_identity",
      required: true,
      passed: state.artifact_identity.matched,
      exit_code: null,
      timed_out: false,
      duration_ms: 0,
      stdout_sha256: sha256(marker),
      stderr_sha256: sha256(""),
    });
    await writeState(state, options.output);

    const praxisCompatibilityGate = await commandGate(
      "praxis_artifact_compatibility",
      options.python,
      [
        resolve(
          evaluationRoot,
          "python/check_praxis_artifact_compatibility.py",
        ),
        "--artifact-root",
        options.artifactRoot,
        "--output",
        options.praxisCompatibilityOutput,
        "--incidents",
        "401,402,403,404,405,406,407,408,409,410,411,412,413,414,415,416",
      ],
      { timeoutMs: 120_000 },
    );
    if (praxisCompatibilityGate.record.passed) {
      const compatibility = await readJson(
        options.praxisCompatibilityOutput,
      );
      praxisCompatibilityGate.record.measurements = {
        checks_passed: compatibility.summary?.checks_passed ?? null,
        checks: compatibility.summary?.checks ?? null,
        incident_assets_passed:
          compatibility.summary?.incident_assets_passed ?? null,
        incident_assets: compatibility.summary?.incident_assets ?? null,
      };
      await writeState(state, options.output);
    }

    await commandGate(
      "scorer_only_oracle_generation",
      process.execPath,
      [
        resolve(evaluationRoot, "scripts/build-official-oracle.mjs"),
        `--artifact-root=${options.artifactRoot}`,
        `--output=${options.oracleOutput}`,
        "--incidents=401,402,403,404,405,406,407,408,409,410,411,412,413,414,415,416",
      ],
    );
  }

  const preflight = await commandGate(
    "remote_host_eligibility",
    process.execPath,
    [resolve(evaluationRoot, "scripts/remote-preflight.mjs")],
    {
      required: false,
      acceptedCodes: [0, 1],
    },
  );
  let preflightPayload;
  try {
    preflightPayload = JSON.parse(preflight.result.stdout);
  } catch {
    preflightPayload = {
      schema_version: "praxis-remote-preflight/v1",
      supported: false,
      failures: ["preflight did not emit valid JSON"],
    };
  }
  await mkdir(dirname(options.preflightOutput), { recursive: true });
  await writeFile(
    options.preflightOutput,
    `${JSON.stringify(preflightPayload, null, 2)}\n`,
  );
  state.remote_host_supported = preflightPayload.supported === true;
  await writeState(state, options.output);

  return state;
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${help()}\n`);
  } else {
    runLocalGates(options)
      .then((result) => {
        process.stdout.write(
          `${JSON.stringify(
            {
              passed: result.passed,
              required_gates: result.gates.filter((gate) => gate.required)
                .length,
              remote_host_supported: result.remote_host_supported,
              model_calls: result.model_calls,
            },
            null,
            2,
          )}\n`,
        );
        if (!result.passed) process.exitCode = 1;
      })
      .catch((error) => {
        process.stderr.write(`local-gates: ${error.stack ?? error}\n`);
        process.exitCode = 1;
      });
  }
}
