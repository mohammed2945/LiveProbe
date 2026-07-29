#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

import {
  deploymentSelector,
  waitForRecommendationConvergence,
} from "./kubernetes-convergence.mjs";

const evaluationRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

function run(command, args, execute) {
  if (!execute) {
    process.stdout.write(`${JSON.stringify([command, ...args])}\n`);
    return Promise.resolve();
  }
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

function capture(command, args) {
  return new Promise((resolveCapture, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolveCapture(output);
      else {
        reject(
          new Error(
            `${command} exited ${code}: ${errors.trim() || output.trim()}`,
          ),
        );
      }
    });
  });
}

async function kubectlJson(namespace, args) {
  return JSON.parse(
    await capture("kubectl", [
      "-n",
      namespace,
      ...args,
      "-o",
      "json",
      "--request-timeout=10s",
    ]),
  );
}

async function readRecommendationState(namespace) {
  const deployment = await kubectlJson(namespace, [
    "get",
    "deployment/recommendation",
  ]);
  const selector = deploymentSelector(deployment);
  const [pods, endpointSlices] = await Promise.all([
    kubectlJson(namespace, ["get", "pods", "-l", selector]),
    kubectlJson(namespace, [
      "get",
      "endpointslices.discovery.k8s.io",
      "-l",
      "kubernetes.io/service-name=recommendation",
    ]),
  ]);
  return { deployment, pods, endpointSlices };
}

async function main(argv) {
  let incident;
  let namespace = "otel-demo";
  let registry = "liveprobe-praxis";
  let sourceRoot;
  let execute = false;
  let allowUnready = false;
  let convergenceTimeoutMs = 180_000;
  for (const argument of argv) {
    if (argument.startsWith("--incident=")) incident = argument.slice(11);
    else if (argument.startsWith("--namespace=")) namespace = argument.slice(12);
    else if (argument.startsWith("--registry=")) registry = argument.slice(11);
    else if (argument.startsWith("--source-root=")) {
      sourceRoot = resolve(argument.slice(14));
    }
    else if (argument === "--execute") execute = true;
    else if (argument === "--allow-unready") allowUnready = true;
    else if (argument.startsWith("--convergence-timeout-ms=")) {
      convergenceTimeoutMs = Number(argument.slice(25));
    }
    else throw new Error(`unknown argument ${argument}`);
  }
  if (
    !Number.isSafeInteger(convergenceTimeoutMs) ||
    convergenceTimeoutMs < 1_000
  ) {
    throw new Error("--convergence-timeout-ms must be an integer >= 1000");
  }
  const imageMap = JSON.parse(
    await readFile(
      resolve(evaluationRoot, "instrumentation/image-map.json"),
      "utf8",
    ),
  );
  if (imageMap.incidents[incident] === undefined) {
    throw new Error("--incident must select one of 401 through 416");
  }
  if (sourceRoot === undefined) {
    throw new Error(
      "--source-root must be the reproducible Git checkout for this incident",
    );
  }
  const metadata = JSON.parse(
    await readFile(resolve(sourceRoot, "source-metadata.json"), "utf8"),
  );
  if (
    metadata.incident_id !== incident ||
    !/^[0-9a-f]{40,64}$/.test(metadata.git_commit)
  ) {
    throw new Error(
      "source metadata does not match the incident or lacks a Git commit",
    );
  }
  const image = `${registry}:incident-${incident}`;
  const commit = metadata.git_commit;
  await run(
    "kubectl",
    [
      "-n",
      namespace,
      "set",
      "image",
      "deployment/recommendation",
      `recommendation=${image}`,
    ],
    execute,
  );
  await run(
    "kubectl",
    [
      "-n",
      namespace,
      "patch",
      "deployment/recommendation",
      "--type=strategic",
      "-p",
      JSON.stringify({
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: "recommendation",
                  imagePullPolicy: "IfNotPresent",
                },
              ],
            },
          },
        },
      }),
    ],
    execute,
  );
  await run(
    "kubectl",
    [
      "-n",
      namespace,
      "set",
      "env",
      "deployment/recommendation",
      "LIVEPROBE_ENABLED=on",
      "LIVEPROBE_SERVICE_ID=recommendation",
      "LIVEPROBE_BROKER_URL=http://liveprobe-broker.otel-demo.svc.cluster.local:7070",
      `LIVEPROBE_COMMIT_SHA=${commit}`,
    ],
    execute,
  );
  try {
    await run(
      "kubectl",
      [
        "-n",
        namespace,
        "rollout",
        "status",
        "deployment/recommendation",
        "--timeout=180s",
      ],
      execute,
    );
  } catch (error) {
    if (!allowUnready) throw error;
    process.stderr.write(
      `enable-liveprobe: rollout remained unready as allowed: ${error}\n`,
    );
  }
  if (execute) {
    const convergence = await waitForRecommendationConvergence(
      () => readRecommendationState(namespace),
      {
        image,
        commit,
        allowUnready,
        timeoutMs: convergenceTimeoutMs,
      },
    );
    process.stdout.write(
      `enable-liveprobe: stable runtime route ${JSON.stringify(convergence)}\n`,
    );
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`enable-liveprobe: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
