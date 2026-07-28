#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
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
  process.env["LIVEPROBE_E2E_RESULT"] ??
    "demo/ride-analysis/results/latest-e2e.json",
);

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
      if (code === 0) {
        resolveRun(stdout.trim());
      } else {
        reject(
          new Error(
            `${command} exited ${String(code)}: ${(stderr || stdout).slice(-2000)}`,
          ),
        );
      }
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
  const port = address.port;
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return port;
}

async function waitFor(check, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `${label} did not become ready${lastError ? `: ${String(lastError)}` : ""}`,
  );
}

function typedStrings(value, found = []) {
  if (Array.isArray(value)) {
    for (const child of value) typedStrings(child, found);
    return found;
  }
  if (value === null || typeof value !== "object") return found;
  if (value.t === "str" && typeof value.v === "string") found.push(value.v);
  for (const child of Object.values(value)) typedStrings(child, found);
  return found;
}

function classifyOccurrence(plan, occurrence) {
  const byCandidate = new Map();
  for (const item of occurrence?.events ?? []) {
    if (item.candidateId === undefined || item.event?.type !== "snapshot") continue;
    const values = typedStrings(item.event.watches ?? {});
    const state = values.includes("US-CA:1.0825") ? "bad" : "good";
    const prior = byCandidate.get(item.candidateId);
    if (prior !== "bad") byCandidate.set(item.candidateId, state);
  }
  return plan.frontier
    .filter((candidate) => byCandidate.has(candidate.candidate_id))
    .map((candidate) => ({
      candidate_id: candidate.candidate_id,
      classification: byCandidate.get(candidate.candidate_id),
      occurrence_id: occurrence.occurrenceId,
      reason:
        byCandidate.get(candidate.candidate_id) === "bad"
          ? "captured the malformed string US-CA:1.0825"
          : "captured values but not the malformed string",
    }));
}

async function main() {
  const started = performance.now();
  const commit = await run("git", ["rev-parse", "HEAD"], { cwd: rideRoot });
  const targetPort = await freePort();
  const broker = await buildBroker({ persistence: false });
  await broker.listen({ host: "127.0.0.1", port: 0 });
  const address = broker.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("broker did not expose a TCP address");
  }
  const brokerUrl = `http://127.0.0.1:${address.port}`;
  const python =
    process.env["RIDERUSH_PYTHON"] ??
    resolve(rideRoot, ".venv/bin/python");
  const sdkPath = resolve(root, "python/sdk/src");
  const target = spawn(
    python,
    [
      resolve(root, "demo/ride-analysis/target.py"),
      "--ride-root",
      rideRoot,
      "--broker-url",
      brokerUrl,
      "--commit",
      commit,
      "--port",
      String(targetPort),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: [sdkPath, rideRoot, process.env["PYTHONPATH"]]
          .filter(Boolean)
          .join(":"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let targetLogs = "";
  target.stdout.on("data", (chunk) => {
    targetLogs += String(chunk);
  });
  target.stderr.on("data", (chunk) => {
    targetLogs += String(chunk);
  });

  const handlers = createToolHandlers(
    new BrokerClient(brokerUrl),
    new AnalyzerRunner({
      pythonCommand: process.env["LIVEPROBE_ANALYZER_PYTHON"] ?? "python3.12",
      pythonPath: resolve(root, "python/analyzer/src"),
    }),
  );
  const deployedProbeIds = new Set();
  const rounds = [];
  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${targetPort}/healthz`);
      return response.ok;
    }, "RideRush payments");
    await waitFor(async () => {
      const listed = await handlers.list_services({});
      return listed.services.some(
        (service) =>
          service.serviceId === "payments-e2e" &&
          service.commitSha === commit &&
          service.online,
      );
    }, "LiveProbe SDK heartbeat");

    const prepared = await handlers.prepare_repository_analysis({
      repository_root: rideRoot,
      commit_hash: commit,
    });
    let plan = await handlers.analyze_probe_candidates({
      repository_root: rideRoot,
      commit_hash: commit,
      service_id: "payments-e2e",
      file: "services/payments/app.py",
      line: 65,
      watch_path: "amount",
      probe_budget: 6,
      source_roots: ["services/payments", "services/pricing"],
    });
    const initialNodes = plan.slice_node_ids.length;
    let malformedProof;

    for (let attempt = 0; attempt < 3 && plan.status === "ACTIVE"; attempt += 1) {
      const deployed = await handlers.deploy_probe_frontier({
        repository_root: rideRoot,
        plan_id: plan.plan_id,
        service_map: [
          { source_root: "services/payments", service_id: "payments-e2e" },
          { source_root: "services/pricing", service_id: "payments-e2e" },
        ],
        ttl_seconds: 30,
        hit_limit: 1,
        created_by: "ride-analysis-e2e",
      });
      for (const item of deployed.probes) deployedProbeIds.add(item.probe.id);
      const executablePaymentsProbes = deployed.probes.filter(
        (item) => item.probe.file === "services/payments/app.py",
      );
      await waitFor(async () => {
        const states = await Promise.all(
          executablePaymentsProbes.map((item) =>
            handlers.get_probe_data({
              probe_id: item.probe.id,
              wait_seconds: 0,
            }),
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
        const ready = states.every((state) =>
          state.events.some(
            (event) => event.type === "status" && event.status === "armed",
          ),
        );
        if (!ready) {
          throw new Error(
            `waiting for probe arm states: ${JSON.stringify(
              states.map((state) =>
                state.events
                  .filter((event) => event.type === "status")
                  .map((event) => ({
                    status: event.status,
                    detail: event.detail,
                  })),
              ),
            )}`,
          );
        }
        return true;
      }, "RideRush payment probes", 10_000);

      const replayId = `ride-e2e-${plan.round}`;
      const response = await fetch(`http://127.0.0.1:${targetPort}/capture`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-liveprobe-replay-id": replayId,
        },
        body: JSON.stringify({
          trip_id: `ride-e2e-${plan.round}`,
          distance: 8,
          surge: 1.0,
        }),
      });
      const responseText = await response.text();
      if (response.status < 500) {
        throw new Error(
          `expected malformed RideRush fare to fail, got ${response.status}: ${responseText}`,
        );
      }
      await waitFor(async () => {
        const states = await Promise.all(
          executablePaymentsProbes.map((item) =>
            handlers.get_probe_data({
              probe_id: item.probe.id,
              wait_seconds: 0,
            }),
          ),
        );
        return states.some((state) =>
          state.events.some((event) => event.type === "snapshot"),
        );
      }, "RideRush probe captures", 10_000);

      const observed = await handlers.refine_probe_candidates({
        repository_root: rideRoot,
        plan_id: plan.plan_id,
        wait_seconds: 4,
        assessments: [],
      });
      const occurrence = observed.occurrences.find(
        (item) => item.occurrenceId === `trace:${replayId}`,
      );
      if (occurrence === undefined || !occurrence.correlated) {
        throw new Error(
          `no explicitly correlated occurrence for ${replayId}; observed=${JSON.stringify(
            observed.occurrences.map((item) => ({
              occurrenceId: item.occurrenceId,
              correlated: item.correlated,
              events: item.events.map((event) => ({
                candidateId: event.candidateId,
                type: event.event?.type,
                status: event.event?.status,
                detail: event.event?.detail,
                correlation: event.event?.correlation,
              })),
            })),
          )}; response=${response.status}:${responseText}; target=${targetLogs.slice(-2000)}`,
        );
      }
      const assessments = classifyOccurrence(plan, occurrence);
      const bad = assessments.filter((item) => item.classification === "bad");
      if (bad.length > 0) {
        malformedProof = {
          operand: "tax_multiplier",
          value: "US-CA:1.0825",
          runtimeType: "str",
          occurrenceId: occurrence.occurrenceId,
          candidateIds: bad.map((item) => item.candidate_id),
        };
      }
      if (assessments.length === 0) {
        throw new Error(`round ${plan.round} produced no assessable snapshots`);
      }
      const before = plan;
      plan = (
        await handlers.refine_probe_candidates({
          repository_root: rideRoot,
          plan_id: plan.plan_id,
          assessments,
          wait_seconds: 0,
        })
      ).plan;
      rounds.push({
        round: before.round,
        statusBefore: before.status,
        frontier: before.frontier.map((candidate) => ({
          candidateId: candidate.candidate_id,
          file: candidate.file,
          line: candidate.line,
          certainty: candidate.certainty,
        })),
        occurrenceId: occurrence.occurrenceId,
        assessments,
        statusAfter: plan.status,
        retainedNodes: plan.slice_node_ids.length,
      });
    }

    if (malformedProof === undefined) {
      throw new Error("probe rounds never captured the malformed fare operand");
    }
    if (plan.slice_node_ids.length >= initialNodes) {
      throw new Error("runtime assessments did not narrow the static slice");
    }

    const result = {
      status: "passed",
      repository: rideRoot,
      commit,
      broker: "local-real",
      target: "actual services/payments/app.py with deterministic local data",
      initialSliceNodes: initialNodes,
      finalSliceNodes: plan.slice_node_ids.length,
      finalStatus: plan.status,
      likelyHammockId: plan.likely_hammock_id ?? null,
      malformedProof,
      rounds,
      elapsedMs: Math.round(performance.now() - started),
    };
    await mkdir(resolve(resultPath, ".."), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    target.kill("SIGTERM");
    await new Promise((resolveExit) => {
      if (target.exitCode !== null) resolveExit();
      else {
        target.once("exit", resolveExit);
        setTimeout(() => {
          target.kill("SIGKILL");
          resolveExit();
        }, 3_000).unref();
      }
    });
    for (const probeId of deployedProbeIds) {
      await handlers.remove_probe({ probe_id: probeId }).catch(() => undefined);
    }
    await broker.close();
    if (targetLogs.includes("Traceback") && !targetLogs.includes("fare calculation failed")) {
      process.stderr.write(targetLogs.slice(-4000));
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
