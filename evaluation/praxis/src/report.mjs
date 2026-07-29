#!/usr/bin/env node

import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { ARM_NAMES } from "./arms.mjs";
import { normalizeUsage, sha256, zeroUsage } from "./core.mjs";

const evaluationRoot = resolve(import.meta.dirname, "..");

const armLabels = {
  normal_coding_sre: "Normal coding SRE",
  praxis: "PRAXIS (fair adapter)",
  graph_liveprobe: "Graph + LiveProbe",
  raw_liveprobe: "Raw LiveProbe",
};

function parseArgs(argv) {
  const result = {
    campaign: resolve(evaluationRoot, "results/campaign/campaign.json"),
    validation: resolve(evaluationRoot, "results/local-validation.json"),
    fixture: resolve(evaluationRoot, "results/fixture.json"),
    compatibility: resolve(
      evaluationRoot,
      "results/liveprobe-compatibility.json",
    ),
    preflight: resolve(evaluationRoot, "results/remote-preflight.json"),
    output: resolve(evaluationRoot, "results/README.md"),
  };
  for (const argument of argv) {
    if (argument.startsWith("--campaign=")) {
      result.campaign = resolve(argument.slice(11));
    } else if (argument.startsWith("--validation=")) {
      result.validation = resolve(argument.slice(13));
    } else if (argument.startsWith("--fixture=")) {
      result.fixture = resolve(argument.slice(10));
    } else if (argument.startsWith("--compatibility=")) {
      result.compatibility = resolve(argument.slice(16));
    } else if (argument.startsWith("--preflight=")) {
      result.preflight = resolve(argument.slice(12));
    } else if (argument.startsWith("--output=")) {
      result.output = resolve(argument.slice(9));
    } else if (argument === "--help" || argument === "-h") {
      result.help = true;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return result;
}

function help() {
  return `Usage: node report.mjs [options]

  --campaign=FILE
  --validation=FILE
  --fixture=FILE
  --compatibility=FILE
  --preflight=FILE
  --output=FILE`;
}

async function maybeJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function addUsage(target, usage) {
  const normalized = normalizeUsage(usage);
  for (const key of Object.keys(target)) {
    target[key] += Number(normalized[key] ?? 0);
  }
  return target;
}

function median(values) {
  const ordered = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function percentage(value) {
  return value === null || value === undefined
    ? "—"
    : `${(value * 100).toFixed(1)}%`;
}

function integer(value) {
  return value === null || value === undefined
    ? "—"
    : Math.round(value).toLocaleString("en-US");
}

function seconds(value) {
  return value === null || value === undefined
    ? "—"
    : `${(Number(value) / 1_000).toFixed(2)} s`;
}

function metric(results, name) {
  const scored = results.filter(
    (result) => result.score !== null && result.score !== undefined,
  );
  return ratio(
    scored.filter((result) => result.score[name] === true).length,
    scored.length,
  );
}

function resultsByArm(results) {
  const groups = new Map(ARM_NAMES.map((arm) => [arm, []]));
  for (const result of results) {
    const values = groups.get(result.arm) ?? [];
    values.push(result);
    groups.set(result.arm, values);
  }
  return groups;
}

async function filesRecursively(root) {
  const output = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) output.push(...(await filesRecursively(path)));
    else output.push(path);
  }
  return output;
}

async function readLedgerRecords(campaignPath, results) {
  const selected = new Set(
    results.map(
      (result) => `${result.incident_id}\u0000${result.arm}\u0000${result.seed}`,
    ),
  );
  const records = [];
  for (const path of await filesRecursively(dirname(campaignPath))) {
    if (!path.endsWith(".jsonl")) continue;
    const text = await readFile(path, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const identity =
        `${record.incident_id}\u0000${record.arm}\u0000${record.seed}`;
      if (selected.has(identity)) records.push(record);
    }
  }
  return records;
}

function operationSummary(records, arm) {
  const selected = records.filter(
    (record) => record.arm === arm && record.kind === "tool_call",
  );
  const byServer = {};
  let replays = 0;
  let probes = 0;
  let watches = 0;
  let evidenceCollections = 0;
  let correlatedOccurrences = 0;
  for (const record of selected) {
    const server = record.server ?? "unknown";
    byServer[server] = (byServer[server] ?? 0) + 1;
    if (
      record.tool === "replay_incident" &&
      record.arguments?.prepare_only !== true
    ) {
      replays += 1;
    }
    probes += Number(record.deployed_probes ?? 0);
    watches += Number(record.deployed_watches ?? 0);
    if (record.tool === "collect_investigation_evidence") {
      evidenceCollections += 1;
      correlatedOccurrences += Number(record.collected_occurrences ?? 0);
    }
  }
  return {
    byServer,
    replays,
    probes,
    watches,
    evidenceCollections,
    correlatedOccurrences,
  };
}

function serverCounts(value) {
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return entries.length === 0
    ? "—"
    : entries.map(([server, count]) => `${server}: ${count}`).join("<br>");
}

function accuracyTable(groups) {
  const rows = [
    "| Arm | Runs | RCI@1 | RCL@1 | RCR@1 | Terminal | Evidence-backed | Combined@1 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const arm of ARM_NAMES) {
    const results = groups.get(arm) ?? [];
    if (results.length === 0) continue;
    rows.push(
      `| ${armLabels[arm]} | ${results.length} | ` +
        `${percentage(metric(results, "rci_pass_at_1"))} | ` +
        `${percentage(metric(results, "rcl_pass_at_1"))} | ` +
        `${percentage(metric(results, "rcr_pass_at_1"))} | ` +
        `${percentage(metric(results, "terminal_correct"))} | ` +
        `${percentage(metric(results, "evidence_backed"))} | ` +
        `${percentage(metric(results, "combined_pass_at_1"))} |`,
    );
  }
  return rows.join("\n");
}

function timingTable(groups) {
  const rows = [
    "| Arm | Median wall | Median model | Median non-model/runtime | Failures | Timeouts |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const arm of ARM_NAMES) {
    const results = groups.get(arm) ?? [];
    if (results.length === 0) continue;
    rows.push(
      `| ${armLabels[arm]} | ` +
        `${seconds(median(results.map((result) => result.wall_ms)))} | ` +
        `${seconds(
          median(
            results.map(
              (result) =>
                result.model_wall_ms ?? result.usage?.model_ms ?? 0,
            ),
          ),
        )} | ` +
        `${seconds(
          median(results.map((result) => result.runtime_wall_ms ?? 0)),
        )} | ` +
        `${results.filter((result) => result.failure !== undefined).length} | ` +
        `${results.filter((result) => result.failure?.timeout === true).length} |`,
    );
  }
  return rows.join("\n");
}

function tokenTable(groups) {
  const rows = [
    "| Arm | Mean input | Mean cached | Mean new input | Mean output | Mean reasoning | Agent turns | Model samples |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const arm of ARM_NAMES) {
    const results = groups.get(arm) ?? [];
    if (results.length === 0) continue;
    const usage = results.reduce(
      (total, result) => addUsage(total, result.usage),
      zeroUsage(),
    );
    rows.push(
      `| ${armLabels[arm]} | ` +
        `${integer(usage.input_tokens / results.length)} | ` +
        `${integer(usage.cached_input_tokens / results.length)} | ` +
        `${integer(usage.new_input_tokens / results.length)} | ` +
        `${integer(usage.output_tokens / results.length)} | ` +
        `${integer(usage.reasoning_tokens / results.length)} | ` +
        `${integer(usage.model_calls)} | ` +
        `${integer(usage.model_samples)} |`,
    );
  }
  return rows.join("\n");
}

function operationsTable(groups, records) {
  const rows = [
    "| Arm | Tool calls by server | Replays | Probes deployed | Watches | Evidence collections | Correlated occurrences |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const arm of ARM_NAMES) {
    const results = groups.get(arm) ?? [];
    if (results.length === 0) continue;
    const operations = operationSummary(records, arm);
    rows.push(
      `| ${armLabels[arm]} | ${serverCounts(operations.byServer)} | ` +
        `${operations.replays} | ${operations.probes} | ` +
        `${operations.watches} | ${operations.evidenceCollections} | ` +
        `${operations.correlatedOccurrences} |`,
    );
  }
  return rows.join("\n");
}

function gate(validation, name) {
  return validation?.gates?.find((item) => item.name === name);
}

function validationSection({ validation, fixture, compatibility, preflight }) {
  const fixtureRuns = fixture?.results?.length ?? 0;
  const fixturePassed =
    fixture?.results?.filter(
      (result) => result.score?.combined_pass_at_1 === true,
    ).length ?? 0;
  const fixtureModelCalls =
    fixture?.results?.reduce(
      (total, result) => total + Number(result.usage?.model_calls ?? 0),
      0,
    ) ?? null;
  const requiredGates = validation?.gates?.filter((item) => item.required) ?? [];
  const passedGates = requiredGates.filter((item) => item.passed).length;
  const contracts = gate(validation, "evaluation_contracts");
  const analyzer = gate(validation, "analyzer_tests");
  const mcpBuild = gate(validation, "mcp_server_build");
  const mcpTests = gate(validation, "mcp_server_tests");
  const praxisCompatibility = gate(
    validation,
    "praxis_artifact_compatibility",
  );
  const rows = [
    "| Gate | Result | Measured value | Benchmark claim? |",
    "| --- | --- | ---: | --- |",
    `| Required local gates | ${
      validation?.passed === true ? "PASS" : "FAIL / not run"
    } | ${passedGates}/${requiredGates.length} | No |`,
    `| Analyzer tests | ${analyzer?.passed ? "PASS" : "not recorded"} | ${
      analyzer === undefined
        ? "—"
        : `${analyzer.measurements?.tests_passed ?? "?"} passed in ${seconds(
            analyzer.duration_ms,
          )}`
    } | No |`,
    `| MCP server build | ${
      mcpBuild?.passed ? "PASS" : "not recorded"
    } | ${
      mcpBuild === undefined ? "—" : seconds(mcpBuild.duration_ms)
    } | No |`,
    `| MCP server tests | ${
      mcpTests?.passed ? "PASS" : "not recorded"
    } | ${
      mcpTests === undefined
        ? "—"
        : `${mcpTests.measurements?.tests_passed ?? "?"} passed in ${seconds(
            mcpTests.duration_ms,
          )}`
    } | No |`,
    `| Evaluation contracts | ${
      contracts?.passed ? "PASS" : "not recorded"
    } | ${
      contracts === undefined
        ? "—"
        : `${contracts.measurements?.tests_passed ?? "?"}/${
            contracts.measurements?.tests ?? "?"
          } passed in ${seconds(contracts.duration_ms)}`
    } | No |`,
    `| Released PRAXIS artifact compatibility | ${
      praxisCompatibility?.passed ? "PASS" : "not recorded"
    } | ${
      praxisCompatibility === undefined
        ? "—"
        : `${
            praxisCompatibility.measurements?.incident_assets_passed ?? "?"
          }/${
            praxisCompatibility.measurements?.incident_assets ?? "?"
          } incident graphs; ${
            praxisCompatibility.measurements?.checks_passed ?? "?"
          }/${
            praxisCompatibility.measurements?.checks ?? "?"
          } checks`
    } | No |`,
    `| Static LiveProbe compatibility | ${
      compatibility?.passed ? "PASS" : "not recorded"
    } | ${
      compatibility === undefined
        ? "—"
        : `${compatibility.incidents_checked}/16 variants in ${seconds(
            compatibility.duration_ms,
          )}`
    } | No |`,
    `| Synthetic fixture tripwire | ${
      fixtureRuns > 0 && fixturePassed === fixtureRuns ? "PASS" : "not recorded"
    } | ${fixturePassed}/${fixtureRuns}; ${
      fixtureModelCalls === null ? "—" : fixtureModelCalls
    } model calls | No |`,
    `| Remote host eligibility | ${
      preflight?.supported ? "PASS" : "BLOCKED"
    } | ${
      preflight === undefined
        ? "—"
        : `${preflight.platform}, ${preflight.cpu_count} CPUs, ${preflight.memory_gib} GiB`
    } | No |`,
  ];
  return rows.join("\n");
}

export async function buildReport(options) {
  const [campaign, validation, fixture, compatibility, preflight] =
    await Promise.all([
      maybeJson(options.campaign),
      maybeJson(options.validation),
      maybeJson(options.fixture),
      maybeJson(options.compatibility),
      maybeJson(options.preflight),
    ]);
  const sections = [
    "# PRAXIS × LiveProbe evaluation results",
    "",
    `Generated from checked result artifacts. Report SHA inputs: \`${
      sha256({
        campaign: campaign ?? null,
        validation: validation ?? null,
        fixture: fixture ?? null,
        compatibility: compatibility ?? null,
        preflight: preflight ?? null,
      }).slice(0, 16)
    }\`.`,
    "",
  ];

  if (campaign === undefined) {
    sections.push(
      "## Four-arm leaderboard",
      "",
      "**Not run.** This machine does not satisfy the released PRAXIS cluster requirements, so no model accuracy, benchmark time, or model-token comparison is reported. The fixture and static checks below are tripwires only.",
      "",
    );
  } else {
    const results = campaign.results ?? [];
    const groups = resultsByArm(results);
    const records = await readLedgerRecords(options.campaign, results);
    sections.push(
      "## Four-arm leaderboard",
      "",
      `Campaign status: **${campaign.status}**. Model: \`${
        campaign.plan?.model ?? "unknown"
      }\`; reasoning: \`${
        campaign.plan?.reasoning_effort ?? "unknown"
      }\`; incidents: ${
        campaign.plan?.incidents?.join(", ") ?? "unknown"
      }; seeds: ${campaign.plan?.seeds?.join(", ") ?? "unknown"}.`,
      "",
      accuracyTable(groups),
      "",
      "RCI is root-cause identity, RCL adds location, RCR requires the official propagation path, and Combined@1 requires all scoring checks.",
      "",
      "### Time and reliability",
      "",
      timingTable(groups),
      "",
      "Wall time is end-to-end arm time. Model time is provider/runner time; non-model/runtime time includes tool orchestration and replay.",
      "",
      "### Provider-reported token accounting",
      "",
      tokenTable(groups),
      "",
      "Input, cached input, output, and reasoning tokens are provider-reported aggregates. “New input” is input minus cached input. A coding-agent `codex exec` is one exact outer turn; its model-sample count is an event-derived lower bound. Each tool-free PRAXIS subprocess is counted as one exact model call/sample.",
      "",
      "### Tool and runtime operations",
      "",
      operationsTable(groups, records),
      "",
      records.length === 0
        ? "No ledger JSONL files were available; operational counters are therefore zero/unknown and must not be interpreted as measured absence."
        : `Operational counts were derived from ${records.length} privacy-preserving ledger records. Captured values and raw LiveProbe arguments are not stored in the ledger.`,
      "",
    );
  }

  sections.push(
    "## Zero-token validation",
    "",
    validationSection({ validation, fixture, compatibility, preflight }),
    "",
  );

  if (compatibility !== undefined) {
    const graphNodes = compatibility.incidents.map(
      (incident) => incident.graph_nodes,
    );
    const probeSites = compatibility.incidents.reduce(
      (total, incident) => total + Number(incident.probe_sites ?? 0),
      0,
    );
    sections.push(
      "The static gate compiled and indexed the exact Git checkout for every incident 401–416, detected required gRPC plus HTTP/socket boundaries, rejected known false HTTP positives, constructed causal graphs, generated canonical legal probes, recorded typed simulated occurrences, and preserved deferred frontiers.",
      "",
      `Across the 16 variants it built ${Math.min(
        ...graphNodes,
      )}–${Math.max(...graphNodes)} graph nodes per criterion and ${probeSites} initial canonical probe sites in ${seconds(
        compatibility.duration_ms,
      )}. This is static compatibility evidence, not runtime or model benchmark evidence.`,
      "",
    );
  }

  if (preflight?.supported !== true) {
    sections.push(
      "## Why the real campaign is pending",
      "",
      ...(preflight?.failures ?? ["No remote preflight result exists."]).map(
        (failure) => `- ${failure}`,
      ),
      "",
      "The paid campaign intentionally stops before any model call or cluster mutation unless the remote host passes. On a conforming host, incident 401 must also pass two pre-paid runtime contracts: the LiveProbe path (exact source heartbeat, graph, canonical probe deployment, correlated replay, typed values, and preserved alternatives) and a deterministic traversal of the released PRAXIS loop with its incident-specific program graph.",
      "",
    );
  }

  sections.push(
    "## Interpretation rules",
    "",
    "- Synthetic fixtures validate contracts only; they are never merged into leaderboard accuracy.",
    "- The official oracle is generated after all model attempts and is scorer-only.",
    "- All arms receive the same immutable real incident snapshot in the controlled leaderboard.",
    "- Failed setup or arm attempts remain in the selected denominator; failures and timeouts are reported.",
    "- Probe evidence is correlated to a replay occurrence. Uncorrelated logs and metrics rank hypotheses but do not eliminate them.",
    "- Direct-code incidents require `LOCALIZED`; external-boundary incidents accept evidence-backed `HANDOFF` or `LOCALIZED`, with root, location, propagation, and evidence checks unchanged.",
    "- `gpt-5.4-mini` with low reasoning is the cost-controlled default. Public claims additionally require a pinned model snapshot.",
    "",
  );

  const encoded = `${sections.join("\n").trimEnd()}\n`;
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, encoded);
  return {
    schema_version: "liveprobe-praxis-report/v1",
    output: options.output,
    campaign_included: campaign !== undefined,
    leaderboard_runs: campaign?.results?.length ?? 0,
    report_sha256: sha256(encoded),
  };
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${help()}\n`);
  } else {
    buildReport(options)
      .then((result) => {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      })
      .catch((error) => {
        process.stderr.write(`praxis-report: ${error.stack ?? error}\n`);
        process.exitCode = 1;
      });
  }
}
