#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const evaluationRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

function run(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun(stdout.trim());
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited ${code}: ${stderr || stdout}`,
          ),
        );
      }
    });
  });
}

async function prepareGitCheckout(incidentRoot) {
  let repositoryRoot;
  try {
    repositoryRoot = await run("git", ["rev-parse", "--show-toplevel"], {
      cwd: incidentRoot,
    });
  } catch {
    repositoryRoot = undefined;
  }
  if (repositoryRoot === undefined || resolve(repositoryRoot) !== incidentRoot) {
    await run("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: incidentRoot,
    });
  }
  const status = await run(
    "git",
    ["status", "--porcelain", "--", "recommendation_server.py"],
    { cwd: incidentRoot },
  );
  if (status !== "") {
    await run("git", ["add", "--", "recommendation_server.py"], {
      cwd: incidentRoot,
    });
    const fixedDate = "2026-01-01T00:00:00Z";
    await run(
      "git",
      [
        "-c",
        "user.name=LiveProbe Evaluation",
        "-c",
        "user.email=evaluation@liveprobe.invalid",
        "commit",
        "--quiet",
        "--date",
        fixedDate,
        "-m",
        "Import locked PRAXIS incident source",
      ],
      {
        cwd: incidentRoot,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: fixedDate,
          GIT_COMMITTER_DATE: fixedDate,
        },
      },
    );
  }
  return run("git", ["rev-parse", "HEAD"], { cwd: incidentRoot });
}

function parseArgs(argv) {
  const result = {
    artifactRoot: undefined,
    output: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--artifact-root") {
      result.artifactRoot = resolve(argv[++index]);
    } else if (argv[index] === "--output") {
      result.output = resolve(argv[++index]);
    } else if (argv[index] === "--help" || argv[index] === "-h") {
      result.help = true;
    } else throw new Error(`unknown argument ${argv[index]}`);
  }
  return result;
}

export async function extractSources({ artifactRoot, output }) {
  const scenarios = JSON.parse(
    await readFile(resolve(evaluationRoot, "scenarios.json"), "utf8"),
  );
  const sourceBase = resolve(
    artifactRoot,
    "praxis-ae/examples/technology_codebase/opentelemetry-demo/src/recommendation",
  );
  await mkdir(output, { recursive: true });
  const results = [];
  for (const incident of scenarios.incidents.filter((item) => item.four_arm)) {
    const analysisPath = resolve(
      sourceBase,
      incident.source_variant,
      "analysis_processed.json",
    );
    const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
    const symbols = Object.values(analysis.symbol_table ?? {});
    if (symbols.length !== 1) {
      throw new Error(
        `${analysisPath} must contain exactly one recommendation source module`,
      );
    }
    const blocks = symbols[0].module_hammock_blocks ?? [];
    const wholeFile = blocks
      .filter((block) => block.start_line === 1)
      .sort((left, right) => right.end_line - left.end_line)[0];
    if (
      wholeFile === undefined ||
      typeof wholeFile.code_snippet !== "string" ||
      wholeFile.code_snippet.split("\n").length < 100
    ) {
      throw new Error(`${analysisPath} did not contain a complete source block`);
    }
    const incidentRoot = resolve(output, incident.id);
    await mkdir(incidentRoot, { recursive: true });
    const sourcePath = resolve(incidentRoot, "recommendation_server.py");
    await writeFile(sourcePath, `${wholeFile.code_snippet.trimEnd()}\n`);
    const gitCommit = await prepareGitCheckout(incidentRoot);
    const metadata = {
      schema_version: "praxis-extracted-source/v1",
      incident_id: incident.id,
      source_variant: incident.source_variant,
      artifact_analysis_path: analysisPath,
      deployed_file: symbols[0].file_path,
      source_line_count: wholeFile.end_line,
      git_commit: gitCommit,
    };
    await writeFile(
      resolve(incidentRoot, "source-metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    results.push({ ...metadata, source_path: sourcePath });
  }
  return results;
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node extract-sources.mjs --artifact-root DIR --output DIR\n",
    );
  } else if (options.artifactRoot === undefined || options.output === undefined) {
    process.stderr.write(
      "extract-sources: --artifact-root and --output are required\n",
    );
    process.exitCode = 2;
  } else {
    extractSources(options)
      .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => {
        process.stderr.write(`extract-sources: ${error.stack ?? error}\n`);
        process.exitCode = 1;
      });
  }
}
