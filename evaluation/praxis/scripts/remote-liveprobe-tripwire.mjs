#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import {
  AnalyzerRunner,
  BrokerClient,
  createToolHandlers,
} from "../../../packages/mcp-server/dist/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

function parseArgs(argv) {
  const result = {
    incident: "401",
    sourceRoot: undefined,
    compatibilityReport: undefined,
    brokerUrl: "http://127.0.0.1:7070",
    replayBaseUrl: "http://127.0.0.1:8081",
    replayPath: "/api/recommendations?productIds=0PUK6V6EV0",
    output: undefined,
    python: "python3.12",
    timeoutMs: 120_000,
  };
  for (const argument of argv) {
    if (argument.startsWith("--incident=")) result.incident = argument.slice(11);
    else if (argument.startsWith("--source-root=")) {
      result.sourceRoot = resolve(argument.slice(14));
    } else if (argument.startsWith("--compatibility-report=")) {
      result.compatibilityReport = resolve(argument.slice(23));
    } else if (argument.startsWith("--broker-url=")) {
      result.brokerUrl = argument.slice(13);
    } else if (argument.startsWith("--replay-base-url=")) {
      result.replayBaseUrl = argument.slice(18);
    } else if (argument.startsWith("--replay-path=")) {
      result.replayPath = argument.slice(14);
    } else if (argument.startsWith("--output=")) {
      result.output = resolve(argument.slice(9));
    } else if (argument.startsWith("--python=")) {
      result.python = argument.slice(9);
    } else if (argument.startsWith("--timeout-ms=")) {
      result.timeoutMs = Number(argument.slice(13));
    } else if (argument === "--help" || argument === "-h") result.help = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  return result;
}

function help() {
  return `Usage: node remote-liveprobe-tripwire.mjs [options]

Required:
  --source-root=DIR             Exact extracted Git checkout for one incident
  --compatibility-report=FILE   Passing static compatibility report
  --output=FILE

Runtime:
  --incident=401
  --broker-url=http://127.0.0.1:7070
  --replay-base-url=http://127.0.0.1:8081
  --replay-path=/api/recommendations?productIds=0PUK6V6EV0
  --python=python3.12
  --timeout-ms=120000`;
}

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(
      `${message}${details === undefined ? "" : `: ${JSON.stringify(details)}`}`,
    );
  }
}

async function waitFor(check, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `${label} did not complete within ${timeoutMs}ms` +
      (lastError === undefined ? "" : `: ${String(lastError)}`),
  );
}

function exactTraceIdentity(incident) {
  const nonce = `${incident}:${randomUUID()}`;
  const digest = createHash("sha256").update(nonce).digest("hex");
  return {
    traceId: digest.slice(0, 32),
    spanId: digest.slice(32, 48),
  };
}

async function removeProbes(handlers, probeIds) {
  for (const probeId of probeIds) {
    await handlers.remove_probe({ probe_id: probeId }).catch(() => undefined);
  }
}

export async function runRemoteTripwire(options) {
  for (const key of ["sourceRoot", "compatibilityReport", "output"]) {
    if (options[key] === undefined) throw new Error(`--${key} is required`);
  }
  const started = performance.now();
  const [metadata, compatibility] = await Promise.all([
    readFile(resolve(options.sourceRoot, "source-metadata.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(options.compatibilityReport, "utf8").then(JSON.parse),
  ]);
  assert(compatibility.passed === true, "static compatibility gate did not pass");
  const incidentCompatibility = compatibility.incidents.find(
    (item) => item.incident_id === options.incident,
  );
  assert(
    incidentCompatibility !== undefined,
    "compatibility report does not contain the selected incident",
  );
  assert(
    metadata.incident_id === options.incident &&
      metadata.git_commit === incidentCompatibility.git_commit,
    "runtime source identity does not match the static gate",
  );

  const handlers = createToolHandlers(
    new BrokerClient(options.brokerUrl),
    new AnalyzerRunner({
      pythonCommand: options.python,
      pythonPath: resolve(repositoryRoot, "python/analyzer/src"),
      timeoutMs: options.timeoutMs,
    }),
  );
  const probeIds = new Set();
  try {
    await handlers.ping_broker({});
    const service = await waitFor(async () => {
      const listed = await handlers.list_services({});
      return listed.services.find(
        (item) =>
          item.serviceId === "recommendation" &&
          item.online === true &&
          item.commitSha === metadata.git_commit,
      );
    }, "exact recommendation runtime heartbeat", options.timeoutMs);
    assert(
      service.commitSha === metadata.git_commit,
      "runtime reported the wrong source commit",
      service,
    );

    await handlers.prepare_repository_analysis({
      repository_root: options.sourceRoot,
      commit_hash: metadata.git_commit,
    });
    let investigation = await handlers.start_probe_investigation({
      repository_root: options.sourceRoot,
      commit_hash: metadata.git_commit,
      service_id: "recommendation",
      file: incidentCompatibility.criterion.file,
      line: incidentCompatibility.criterion.line,
      watch_path: incidentCompatibility.criterion.watch_path,
      symptom: "runtime compatibility tripwire for correlated PRAXIS request",
      failure_class:
        incidentCompatibility.criterion.failure_class ?? "type_shape",
      expected_type:
        incidentCompatibility.criterion.expected_type ?? "mapping",
      probe_budget: 5,
      source_roots: [],
      ownership_map: [],
    });
    assert(
      investigation.probe_bundle?.sites?.length > 0,
      "investigation did not generate a probe frontier",
      investigation,
    );
    assert(
      Number(investigation.stats?.graphNodes) > 0 &&
        Number(investigation.stats?.graphEdges) > 0,
      "investigation graph is empty",
      investigation.stats,
    );
    const legalSites = new Map(
      investigation.probe_bundle.sites.map((site) => [site.site_id, site]),
    );
    const deployed = await handlers.deploy_investigation_probes({
      repository_root: options.sourceRoot,
      investigation_id: investigation.investigation_id,
      service_map: [],
      ttl_seconds: Math.ceil(options.timeoutMs / 1000) + 60,
      hit_limit: 100,
      created_by: "praxis-runtime-tripwire",
    });
    for (const item of deployed.probes) {
      probeIds.add(item.probe.id);
      const site = legalSites.get(item.siteId);
      assert(site !== undefined, "deployed probe was not a legal graph action", item);
      assert(
        item.commitMismatch === undefined &&
          item.probe.sourceCommit === metadata.git_commit &&
          item.probe.file === site.file &&
          item.probe.line === site.line &&
          JSON.stringify(item.probe.watchPaths ?? []) ===
            JSON.stringify(site.watch_paths),
        "deployed probe diverged from the canonical site",
        { item, site },
      );
    }
    await waitFor(async () => {
      const states = await Promise.all(
        deployed.probes.map((item) =>
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
      assert(errors.length === 0, "runtime rejected a canonical probe", errors);
      return states.every((state) =>
        state.events.some(
          (event) => event.type === "status" && event.status === "armed",
        ),
      );
    }, "probe arming", options.timeoutMs);

    const identity = exactTraceIdentity(options.incident);
    const response = await fetch(
      new URL(options.replayPath, options.replayBaseUrl),
      {
        headers: {
          traceparent: `00-${identity.traceId}-${identity.spanId}-01`,
          "x-liveprobe-replay-id": identity.traceId,
        },
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    );
    await response.arrayBuffer();

    const snapshots = await waitFor(async () => {
      const states = await Promise.all(
        deployed.probes.map((item) =>
          handlers.get_probe_data({
            probe_id: item.probe.id,
            wait_seconds: 0,
          }),
        ),
      );
      const matching = states.flatMap((state) =>
        state.events.filter(
          (event) =>
            event.type === "snapshot" &&
            event.correlation?.quality === "exact-execution" &&
            event.correlation?.traceId === identity.traceId,
        ),
      );
      return matching.length > 0 ? matching : false;
    }, "correlated runtime snapshot", options.timeoutMs);

    const collected = await handlers.collect_investigation_evidence({
      repository_root: options.sourceRoot,
      investigation_id: investigation.investigation_id,
      occurrences: [
        {
          occurrence_id: `trace:${identity.traceId}`,
        },
      ],
      wait_seconds: 2,
    });
    investigation = collected.investigation;
    const occurrence = collected.occurrences.find(
      (item) => item.occurrenceId === `trace:${identity.traceId}`,
    );
    assert(
      occurrence?.correlated === true,
      "collector lost exact occurrence identity",
      collected.occurrences,
    );
    const dossiers = investigation.value_dossiers.filter(
      (item) => item.occurrence_id === `trace:${identity.traceId}`,
    );
    assert(dossiers.length > 0, "correlated occurrence produced no dossiers");
    assert(
      dossiers.every(
        (item) =>
          item.value !== null &&
          typeof item.value === "object" &&
          typeof item.value.t === "string",
      ),
      "runtime values were not typed",
      dossiers,
    );
    assert(
      investigation.judgments.length > 0,
      "typed values did not receive mechanical/UNKNOWN judgments",
      investigation,
    );
    const activeActionIds = new Set(
      investigation.actions.map((action) => action.action_id),
    );
    assert(
      activeActionIds.size === investigation.actions.length,
      "agent action menu contains duplicate or invalid actions",
    );
    assert(
      Number(investigation.decision_context?.deferred?.count ?? 0) > 0,
      "unchosen frontier state was not preserved",
      investigation.decision_context,
    );

    const result = {
      schema_version: "liveprobe-praxis-runtime-tripwire/v1",
      generated_at: new Date().toISOString(),
      benchmark_result: false,
      status: "passed",
      incident_id: options.incident,
      source_commit: metadata.git_commit,
      source_variant: metadata.source_variant,
      service_id: service.serviceId,
      replay: {
        url: new URL(options.replayPath, options.replayBaseUrl).toString(),
        http_status: response.status,
        trace_id: identity.traceId,
      },
      graph: {
        nodes: investigation.stats.graphNodes,
        edges: investigation.stats.graphEdges,
      },
      frontier: {
        canonical_sites: legalSites.size,
        deployed_probes: deployed.probes.length,
        correlated_snapshots: snapshots.length,
        typed_dossiers: dossiers.length,
        judgments: investigation.judgments.length,
        active_actions: investigation.actions.length,
        deferred_actions:
          investigation.decision_context?.deferred?.count ?? 0,
      },
      elapsed_ms: Math.round(performance.now() - started),
    };
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await removeProbes(handlers, probeIds);
  }
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(`${help()}\n`);
  else {
    runRemoteTripwire(options)
      .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => {
        process.stderr.write(
          `remote-liveprobe-tripwire: ${error.stack ?? error}\n`,
        );
        process.exitCode = 1;
      });
  }
}
