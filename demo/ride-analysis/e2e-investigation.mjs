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
  process.env["LIVEPROBE_INVESTIGATION_E2E_RESULT"] ??
    "demo/ride-analysis/results/latest-investigation-e2e.json",
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
  const child = spawn(
    python,
    args,
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
  }, "investigation probes");
}

async function waitForSnapshots(
  handlers,
  deployed,
  expectedTraceIds = [],
  requireEveryProbe = false,
) {
  return waitFor(async () => {
    const states = await Promise.all(
      deployed.probes.map(({ probe }) =>
        handlers.get_probe_data({ probe_id: probe.id, wait_seconds: 0 }),
      ),
    );
    const snapshots = states.flatMap((state) =>
      state.events.filter((event) => event.type === "snapshot"),
    );
    if (expectedTraceIds.length === 0) {
      return snapshots.length > 0 ? snapshots : false;
    }
    const observed = new Set(
      snapshots
        .map((event) => event.correlation?.traceId)
        .filter((traceId) => typeof traceId === "string"),
    );
    if (requireEveryProbe) {
      const everyProbeObserved = states.every((state) => {
        const probeTraceIds = new Set(
          state.events
            .filter((event) => event.type === "snapshot")
            .map((event) => event.correlation?.traceId)
            .filter((traceId) => typeof traceId === "string"),
        );
        return expectedTraceIds.every((traceId) =>
          probeTraceIds.has(traceId),
        );
      });
      if (!everyProbeObserved) return false;
    }
    return expectedTraceIds.every((traceId) => observed.has(traceId))
      ? snapshots
      : false;
  }, "investigation snapshots");
}

function assertTripwire(condition, message, details) {
  if (!condition) {
    throw new Error(
      `${message}${details === undefined ? "" : `: ${JSON.stringify(details)}`}`,
    );
  }
}

function assertGraphAndFrontier(investigation) {
  assertTripwire(
    Number(investigation.stats?.graphNodes) > 0 &&
      Number(investigation.stats?.graphEdges) > 0,
    "criterion did not build a nonempty causal graph",
    investigation.stats,
  );
  assertTripwire(
    Array.isArray(investigation.graph?.runtimeTraversals) &&
      investigation.graph.runtimeTraversals.length > 0,
    "graph omitted runtime traversal identity",
    investigation.graph,
  );
  assertTripwire(
    investigation.probe_bundle?.sites?.length > 0,
    "graph did not generate a deployable frontier",
    investigation.probe_bundle,
  );
}

function assertCanonicalDeployment(investigation, deployed) {
  const bundle = investigation.probe_bundle;
  assertTripwire(
    bundle !== null && deployed.bundleId === bundle.bundle_id,
    "deployment did not use the current immutable bundle",
    { deployedBundle: deployed.bundleId, currentBundle: bundle?.bundle_id },
  );
  const sites = new Map(bundle.sites.map((site) => [site.site_id, site]));
  assertTripwire(
    deployed.probes.length === bundle.sites.length,
    "deployment did not preserve the complete canonical frontier",
    { deployed: deployed.probes.length, expected: bundle.sites.length },
  );
  for (const item of deployed.probes) {
    const site = sites.get(item.siteId);
    assertTripwire(site !== undefined, "deployed probe was not a legal site", item);
    assertTripwire(
      item.probe.candidateId === site.site_id &&
        item.probe.serviceId === site.service_id &&
        item.probe.file === site.file &&
        item.probe.line === site.line &&
        JSON.stringify(item.probe.watchPaths ?? []) ===
          JSON.stringify(site.watch_paths),
      "deployed probe location diverged from its canonical site",
      { probe: item.probe, site },
    );
    assertTripwire(
      typeof site.node_id === "string" &&
        typeof site.function_id === "string" &&
        site.traversal_ids.length > 0,
      "canonical site lost graph or traversal provenance",
      site,
    );
  }
}

function assertLegalAction(investigation, action) {
  assertTripwire(
    action !== undefined &&
      investigation.actions.some(
        (candidate) =>
          candidate.action_id === action.action_id &&
          candidate.kind === action.kind,
      ),
    "decision did not come from the current legal action menu",
    { selected: action, legal: investigation.actions },
  );
}

async function removeAll(handlers, deployedIds) {
  // The target flushes captures asynchronously. Let the final batch reach the
  // broker before deleting probe metadata, otherwise a valid pre-removal hit
  // can race the DELETE and be rejected as an unknown probe.
  if (deployedIds.size > 0) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  for (const probeId of [...deployedIds]) {
    await handlers.remove_probe({ probe_id: probeId }).catch(() => undefined);
    deployedIds.delete(probeId);
  }
}

async function paymentsCase({ handlers, brokerUrl, commit }) {
  const started = performance.now();
  const port = await freePort();
  const target = startTarget({
    scenario: "payments",
    port,
    brokerUrl,
    commit,
  });
  const deployedIds = new Set();
  try {
    await waitForService(handlers, "payments-e2e", port);
    let investigation = await handlers.start_probe_investigation({
      repository_root: rideRoot,
      commit_hash: commit,
      service_id: "payments-e2e",
      file: "services/payments/app.py",
      line: 65,
      watch_path: "amount",
      symptom: "fare calculation failed: non-numeric operand",
      failure_class: "type_shape",
      expected_type: "numeric",
      probe_budget: 8,
      source_roots: ["services/payments", "services/pricing"],
      ownership_map: [
        {
          source_root: "services/payments",
          service_id: "payments-e2e",
        },
        {
          source_root: "services/pricing",
          service_id: "payments-e2e",
        },
      ],
    });
    const deployed = await handlers.deploy_investigation_probes({
      repository_root: rideRoot,
      investigation_id: investigation.investigation_id,
      service_map: [
        {
          source_root: "services/payments",
          service_id: "payments-e2e",
        },
        {
          source_root: "services/pricing",
          service_id: "payments-e2e",
        },
      ],
      hit_limit: 1,
    });
    for (const { probe } of deployed.probes) deployedIds.add(probe.id);
    await waitForArmed(handlers, deployed);
    const replayId = "investigation-type-shape";
    const response = await fetch(`http://127.0.0.1:${port}/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-liveprobe-replay-id": replayId,
      },
      body: JSON.stringify({
        trip_id: "investigation-type-shape",
        distance: 8,
        surge: 1,
      }),
    });
    if (response.status < 500) {
      throw new Error(`expected payment failure, got ${response.status}`);
    }
    await waitForSnapshots(handlers, deployed, [replayId]);
    const collected = await handlers.collect_investigation_evidence({
      repository_root: rideRoot,
      investigation_id: investigation.investigation_id,
      occurrences: [
        {
          occurrence_id: `trace:${replayId}`,
        },
      ],
      wait_seconds: 4,
    });
    investigation = collected.investigation;
    const violation = investigation.judgments.find(
      (judgment) =>
        judgment["basis"] === "MECHANICAL" &&
        judgment["classification"] === "VIOLATES",
    );
    if (violation === undefined) {
      throw new Error(
        `type-shape run produced no mechanical violation: ${JSON.stringify({
          occurrences: collected.occurrences,
          dossiers: investigation.value_dossiers,
          judgments: investigation.judgments,
        })}`,
      );
    }
    const handoff = investigation.actions.find(
      (action) =>
        action.kind === "HANDOFF_BOUNDARY" &&
        action.reason.includes("fare_runtime_config"),
    );
    if (handoff === undefined) {
      throw new Error(
        `type-shape run produced no durable handoff: ${JSON.stringify(investigation.actions)}`,
      );
    }
    investigation = await handlers.apply_investigation_decision({
      repository_root: rideRoot,
      investigation_id: investigation.investigation_id,
      based_on_revision: investigation.revision,
      action_ids: [handoff.action_id],
    });
    if (investigation.status !== "HANDOFF") {
      throw new Error(`expected HANDOFF, got ${investigation.status}`);
    }
    return {
      class: 1,
      status: investigation.status,
      rounds: investigation.round,
      probes: deployed.probes.length,
      judgmentBasis: "MECHANICAL",
      elapsedMs: Math.round(performance.now() - started),
    };
  } finally {
    await stopTarget(target);
    await removeAll(handlers, deployedIds);
    if (
      target.logs().includes("Traceback") &&
      !target.logs().includes("fare calculation failed")
    ) {
      process.stderr.write(target.logs().slice(-4_000));
    }
  }
}

async function semanticCase({ handlers, brokerUrl, commit }) {
  const started = performance.now();
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
    assertGraphAndFrontier(investigation);
    let totalProbes = 0;
    let failingExecutions = 0;
    let failingQuote;
    let correlatedOccurrences = 0;
    let typedValues = 0;
    let maximumDeferredFrontier = 0;
    const appliedLegalActionKinds = new Set();
    const replay = async (label, requireEveryProbe = false) => {
      assertGraphAndFrontier(investigation);
      const deployed = await handlers.deploy_investigation_probes({
        repository_root: rideRoot,
        investigation_id: investigation.investigation_id,
        hit_limit: 1,
      });
      assertCanonicalDeployment(investigation, deployed);
      totalProbes += deployed.probes.length;
      for (const { probe } of deployed.probes) deployedIds.add(probe.id);
      await waitForArmed(handlers, deployed);
      const replayId = `investigation-semantic-fail-${label}`;
      const response = await fetch(
        `http://127.0.0.1:${gatewayPort}/request_ride`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-liveprobe-replay-id": replayId,
            "x-trace-id": "unknown-first-business-trace",
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
      if (!response.ok) throw new Error(`${label} replay failed`);
      failingQuote = Number((await response.json()).quote);
      if (failingQuote < 1_000) {
        throw new Error("semantic fault did not produce the inflated quote");
      }
      failingExecutions += 1;
      const snapshots = await waitForSnapshots(
        handlers,
        deployed,
        [replayId],
        requireEveryProbe,
      );
      assertTripwire(
        snapshots.length > 0 &&
          snapshots.every(
            (event) =>
              event.correlation?.quality === "exact-execution" &&
              event.correlation?.traceId === replayId,
          ),
        "runtime captures lost the replay correlation identity",
        snapshots.map((event) => event.correlation),
      );
      const collected = await handlers.collect_investigation_evidence({
        repository_root: rideRoot,
        investigation_id: investigation.investigation_id,
        occurrences: [{ occurrence_id: `trace:${replayId}` }],
        wait_seconds: 4,
      });
      investigation = collected.investigation;
      const occurrenceId = `trace:${replayId}`;
      const selectedOccurrence = collected.occurrences.find(
        (occurrence) => occurrence.occurrenceId === occurrenceId,
      );
      assertTripwire(
        selectedOccurrence?.correlated === true,
        "collector did not preserve the exact failing occurrence",
        collected.occurrences,
      );
      const occurrenceDossiers = investigation.value_dossiers.filter(
        (dossier) => dossier["occurrence_id"] === occurrenceId,
      );
      assertTripwire(
        occurrenceDossiers.length > 0 &&
          occurrenceDossiers.every(
            (dossier) =>
              typeof dossier["value"] === "object" &&
              dossier["value"] !== null &&
              typeof dossier["value"]["t"] === "string",
          ),
        "correlated occurrence did not produce typed values",
        occurrenceDossiers,
      );
      const evidenceLog = [...investigation.decision_log]
        .reverse()
        .find((entry) => entry["kind"] === "EVIDENCE_RECORDED");
      assertTripwire(
        evidenceLog?.["occurrenceId"] === occurrenceId &&
          evidenceLog["observationIds"].length > 0,
        "evidence ledger lost occurrence or observation identity",
        evidenceLog,
      );
      correlatedOccurrences += 1;
      typedValues += occurrenceDossiers.length;
      maximumDeferredFrontier = Math.max(
        maximumDeferredFrontier,
        Number(investigation.decision_context?.deferred?.count ?? 0),
      );
    };

    await replay("initial");
    if (
      !investigation.value_dossiers.every(
        (dossier) => dossier["interpretation"] === "UNKNOWN",
      )
    ) {
      throw new Error("semantic values were prematurely classified");
    }

    let inspect;
    for (let round = 0; round < 4; round += 1) {
      inspect = investigation.actions.find(
        (action) => action.kind === "INSPECT_MECHANISM",
      );
      if (inspect !== undefined) break;
      const next =
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
        );
      if (next === undefined) {
        throw new Error(
          `no useful unknown-first frontier: ${JSON.stringify(investigation.actions)}`,
        );
      }
      assertLegalAction(investigation, next);
      appliedLegalActionKinds.add(next.kind);
      investigation = await handlers.apply_investigation_decision({
        repository_root: rideRoot,
        investigation_id: investigation.investigation_id,
        based_on_revision: investigation.revision,
        action_ids: [next.action_id],
        exploration_question:
          "Which dependency selects the unexpectedly large surge value?",
      });
      await replay(`explore-${round + 1}`);
    }
    inspect ??= investigation.actions.find(
      (action) => action.kind === "INSPECT_MECHANISM",
    );
    if (inspect === undefined) {
      throw new Error(
        `unknown-first loop did not localize the surge region: ${JSON.stringify(investigation.actions)}`,
      );
    }
    assertLegalAction(investigation, inspect);
    appliedLegalActionKinds.add(inspect.kind);
    investigation = await handlers.apply_investigation_decision({
      repository_root: rideRoot,
      investigation_id: investigation.investigation_id,
      based_on_revision: investigation.revision,
      action_ids: [inspect.action_id],
    });
    const context = investigation.mechanism_context;
    const rootStatement = context["statements"].find(
      (statement) =>
        statement.file === "services/pricing/app.py" &&
        statement.line === 74 &&
        statement.source.includes("surge_poison"),
    );
    if (rootStatement === undefined) {
      throw new Error(
        `mechanism reveal omitted the witnessed surge producer: ${JSON.stringify(context["statements"])}`,
      );
    }
    const predictions = [];
    for (const site of context["probeCandidates"]) {
      if (site.watch_paths.includes("active")) {
        predictions.push({
          probe_candidate_id: site.site_id,
          watch_path: "active",
          operator: "truthy",
        });
      } else if (site.watch_paths.includes("surge")) {
        predictions.push({
          probe_candidate_id: site.site_id,
          watch_path: "surge",
          operator: "eq",
          expected_value: 50,
        });
      } else if (site.watch_paths.includes("amount")) {
        predictions.push({
          probe_candidate_id: site.site_id,
          watch_path: "amount",
          operator: "eq",
          expected_value: 1718.5,
        });
      }
    }
    if (predictions.length === 0) {
      throw new Error("mechanism reveal produced no confirmable values");
    }
    const confirm = investigation.actions.find(
      (action) => action.kind === "CONFIRM_CANDIDATE",
    );
    if (confirm === undefined) throw new Error("candidate action missing");
    assertLegalAction(investigation, confirm);
    appliedLegalActionKinds.add(confirm.kind);
    investigation = await handlers.apply_investigation_decision({
      repository_root: rideRoot,
      investigation_id: investigation.investigation_id,
      based_on_revision: investigation.revision,
      action_ids: [confirm.action_id],
      candidate_mechanism: {
        statement:
          "surge_poison selects surge 50 before the quote amount is calculated",
        anchor_node_ids: [rootStatement.node_id],
        traversal_id: context["traversalIds"][0],
        predictions,
      },
    });
    await replay("confirm", true);
    assertTripwire(
      investigation.candidate_mechanism?.status === "SUPPORTED" &&
        investigation.candidate_mechanism.confirmation?.manifestation_seen ===
          true &&
        investigation.candidate_mechanism.confirmation?.predictions?.every(
          (prediction) => prediction.matched === true,
        ),
      "fresh replay did not assign a supported candidate verdict",
      investigation.candidate_mechanism,
    );
    const complete = investigation.actions.find(
      (action) => action.kind === "COMPLETE_LOCALIZATION",
    );
    if (complete === undefined) {
      throw new Error(
        `completion action missing: ${JSON.stringify({
          phase: investigation.phase,
          candidateStatus: investigation.candidate_mechanism?.status,
          confirmation: investigation.candidate_mechanism?.confirmation,
        })}`,
      );
    }
    const evidenceLog = [...investigation.decision_log]
      .reverse()
      .find((entry) => entry["kind"] === "EVIDENCE_RECORDED");
    const evidenceRefs = evidenceLog?.["observationIds"] ?? [];
    assertLegalAction(investigation, complete);
    appliedLegalActionKinds.add(complete.kind);
    investigation = await handlers.apply_investigation_decision({
      repository_root: rideRoot,
      investigation_id: investigation.investigation_id,
      based_on_revision: investigation.revision,
      action_ids: [complete.action_id],
      evidence_refs: evidenceRefs,
    });
    if (investigation.status !== "LOCALIZED") {
      throw new Error(`expected LOCALIZED, got ${investigation.status}`);
    }
    assertTripwire(
      maximumDeferredFrontier > 0,
      "unchosen frontier alternatives were not preserved as deferred work",
      investigation.decision_context,
    );
    return {
      class: 4,
      status: investigation.status,
      rounds: investigation.round,
      failingExecutions,
      passingExecutions: 0,
      totalProbes,
      judgmentBasis: "UNKNOWN_THEN_CONFIRMED_CANDIDATE",
      failingQuote,
      tripwire: {
        graphNodes: investigation.stats.graphNodes,
        graphEdges: investigation.stats.graphEdges,
        correlatedOccurrences,
        typedValues,
        maximumDeferredFrontier,
        appliedLegalActionKinds: [...appliedLegalActionKinds].sort(),
        canonicalDeployments: true,
        terminalOutcome: "LOCALIZED",
      },
      elapsedMs: Math.round(performance.now() - started),
    };
  } finally {
    await stopTarget(gateway);
    await stopTarget(pricing);
    await removeAll(handlers, deployedIds);
    const logs = `${gateway.logs()}\n${pricing.logs()}`;
    if (logs.includes("Traceback")) {
      process.stderr.write(logs.slice(-4_000));
    }
  }
}

async function main() {
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
    const cases = [await semanticCase({ handlers, brokerUrl, commit })];
    const result = {
      status: "passed",
      repository: rideRoot,
      commit,
      cases,
      elapsedMs: Math.round(performance.now() - started),
    };
    await mkdir(resolve(resultPath, ".."), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await broker.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
