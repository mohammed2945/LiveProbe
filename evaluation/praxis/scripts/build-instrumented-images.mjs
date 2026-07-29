#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const evaluationRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const repositoryRoot = resolve(evaluationRoot, "../..");

function parseArgs(argv) {
  const result = {
    incidents: undefined,
    registry: "liveprobe-praxis",
    kindCluster: "kind-cluster",
    loadIntoKind: false,
    buildBroker: false,
    execute: false,
    sourceRoot: resolve(repositoryRoot, ".eval-cache/praxis-sources"),
  };
  for (const argument of argv) {
    if (argument.startsWith("--incidents=")) {
      result.incidents = argument.slice(12).split(",").filter(Boolean);
    } else if (argument.startsWith("--registry=")) {
      result.registry = argument.slice(11);
    } else if (argument.startsWith("--kind-cluster=")) {
      result.kindCluster = argument.slice(15);
    } else if (argument.startsWith("--source-root=")) {
      result.sourceRoot = resolve(argument.slice(14));
    } else if (argument === "--load-into-kind") result.loadIntoKind = true;
    else if (argument === "--build-broker") result.buildBroker = true;
    else if (argument === "--execute") result.execute = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  return result;
}

function run(command, args, { execute, capture = false }) {
  if (!execute) {
    process.stdout.write(`${JSON.stringify([command, ...args])}\n`);
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
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
    child.once("exit", (code) =>
      code === 0
        ? resolveRun({ stdout, stderr })
        : reject(
            new Error(
              `${command} exited ${code}: ${(stderr || stdout).slice(-4000)}`,
            ),
          ),
    );
  });
}

function commandPathTokens(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    String(item)
      .split(/\s+/u)
      .map((token) => token.replace(/^['"]|['",;]$/gu, ""))
      .filter(Boolean),
  );
}

export function runtimePathCandidates(imageConfig, artifactPath) {
  const filename = posix.basename(artifactPath);
  const workingDirectory =
    typeof imageConfig?.WorkingDir === "string" &&
    imageConfig.WorkingDir.startsWith("/")
      ? imageConfig.WorkingDir
      : "/";
  const entrypointPaths = commandPathTokens([
    ...(imageConfig?.Entrypoint ?? []),
    ...(imageConfig?.Cmd ?? []),
  ])
    .filter(
      (token) =>
        token === filename ||
        token.endsWith(`/${filename}`),
    )
    .map((token) =>
      token.startsWith("/")
        ? posix.normalize(token)
        : posix.resolve(workingDirectory, token),
    );
  return [
    ...new Set([
      ...entrypointPaths,
      posix.resolve(workingDirectory, filename),
      posix.normalize(artifactPath),
    ]),
  ];
}

async function runtimeSourcePath(target, artifactPath, sourceSha256, options) {
  const inspected = await run(
    "docker",
    ["image", "inspect", target, "--format={{json .Config}}"],
    { ...options, capture: true },
  );
  const imageConfig = JSON.parse(inspected.stdout);
  const candidates = runtimePathCandidates(imageConfig, artifactPath);
  const filename = posix.basename(artifactPath);
  try {
    const discovered = await run(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "find",
        target,
        "/",
        "-type",
        "f",
        "-name",
        filename,
        "-print",
      ],
      { ...options, capture: true },
    );
    for (const path of discovered.stdout.split("\n").map((line) => line.trim())) {
      if (path.startsWith("/")) candidates.push(posix.normalize(path));
    }
  } catch {
    // Entrypoint and working-directory candidates remain authoritative for
    // minimal/distroless images that do not carry `find`.
  }

  const checked = [];
  for (const path of new Set(candidates)) {
    try {
      const result = await run(
        "docker",
        ["run", "--rm", "--entrypoint", "sha256sum", target, path],
        { ...options, capture: true },
      );
      const sha256 = result.stdout.trim().split(/\s+/, 1)[0];
      checked.push({ path, sha256 });
      if (sha256 === sourceSha256) {
        return {
          path,
          artifact_path: artifactPath,
          resolution:
            path === posix.normalize(artifactPath)
              ? "artifact_path"
              : "image_runtime_discovery",
          checked,
        };
      }
    } catch {
      checked.push({ path, sha256: null });
    }
  }
  throw new Error(
    `instrumented image ${target} does not contain the locked source hash ` +
      `${sourceSha256}; checked ${JSON.stringify(checked)}`,
  );
}

export async function buildImages(options) {
  const imageMap = JSON.parse(
    await readFile(
      resolve(evaluationRoot, "instrumentation/image-map.json"),
      "utf8",
    ),
  );
  const incidents =
    options.incidents ?? Object.keys(imageMap.incidents);
  const unknown = incidents.filter((id) => imageMap.incidents[id] === undefined);
  if (unknown.length > 0) throw new Error(`unknown incidents: ${unknown.join(",")}`);
  const images = [];
  if (options.buildBroker) {
    await run(
      "docker",
      [
        "build",
        "-t",
        "liveprobe-broker:praxis-eval",
        "-f",
        "packages/broker/Dockerfile",
        ".",
      ],
      options,
    );
    if (options.loadIntoKind) {
      await run(
        "kind",
        [
          "load",
          "docker-image",
          "liveprobe-broker:praxis-eval",
          "--name",
          options.kindCluster,
        ],
        options,
      );
    }
  }
  for (const incident of incidents) {
    const base = `${imageMap.registry}:${imageMap.incidents[incident]}`;
    const incidentSourceRoot = resolve(options.sourceRoot, incident);
    const [metadata, source] = await Promise.all([
      readFile(resolve(incidentSourceRoot, "source-metadata.json"), "utf8").then(
        JSON.parse,
      ),
      readFile(resolve(incidentSourceRoot, "recommendation_server.py")),
    ]);
    if (
      metadata.incident_id !== incident ||
      !/^[0-9a-f]{40,64}$/.test(metadata.git_commit)
    ) {
      throw new Error(`source metadata is invalid for incident ${incident}`);
    }
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const target = `${options.registry}:incident-${incident}`;
    await run(
      "docker",
      [
        "build",
        "--build-arg",
        `BASE_IMAGE=${base}`,
        "--label",
        `dev.liveprobe.praxis.incident=${incident}`,
        "--label",
        `dev.liveprobe.praxis.base=${base}`,
        "--label",
        `dev.liveprobe.source.commit=${metadata.git_commit}`,
        "--label",
        `dev.liveprobe.source.sha256=${sourceSha256}`,
        "-t",
        target,
        "-f",
        "evaluation/praxis/instrumentation/Dockerfile",
        ".",
      ],
      options,
    );
    let runtimeSource = {
      path: metadata.deployed_file,
      artifact_path: metadata.deployed_file,
      resolution: "planned",
      checked: [],
    };
    if (options.execute) {
      runtimeSource = await runtimeSourcePath(
        target,
        metadata.deployed_file,
        sourceSha256,
        options,
      );
    }
    if (options.loadIntoKind) {
      await run(
        "kind",
        [
          "load",
          "docker-image",
          target,
          "--name",
          options.kindCluster,
        ],
        options,
      );
    }
    images.push({
      incident,
      base,
      target,
      commit_sha: metadata.git_commit,
      source_sha256: sourceSha256,
      artifact_deployed_file: metadata.deployed_file,
      runtime_deployed_file: runtimeSource.path,
      runtime_source_resolution: runtimeSource.resolution,
      source_verified: options.execute,
    });
  }
  return images;
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node build-instrumented-images.mjs [--incidents=401,402] [--source-root=DIR] [--build-broker] [--load-into-kind] [--execute]\n",
    );
  } else {
    buildImages(options)
      .then((images) => process.stdout.write(`${JSON.stringify(images, null, 2)}\n`))
      .catch((error) => {
        process.stderr.write(`build-instrumented-images: ${error.stack ?? error}\n`);
        process.exitCode = 1;
      });
  }
}
