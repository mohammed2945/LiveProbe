import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { OBSERVABILITY_TOOL_SCHEMA_SHA256 } from "./observability-mcp.mjs";

const evaluationRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const repositoryRoot = resolve(evaluationRoot, "../..");

export const ARM_NAMES = [
  "normal_coding_sre",
  "praxis",
  "graph_liveprobe",
  "raw_liveprobe",
];

export async function loadGuidance(arm) {
  const common = await readFile(
    resolve(evaluationRoot, "guidance/observability-sre.md"),
    "utf8",
  );
  if (arm === "raw_liveprobe") {
    const raw = await readFile(
      resolve(repositoryRoot, "skills/liveprobe-raw-investigation/SKILL.md"),
      "utf8",
    );
    return `${common}\n\n${raw}`;
  }
  if (arm === "graph_liveprobe") {
    const graph = await readFile(
      resolve(repositoryRoot, "skills/liveprobe-investigation/SKILL.md"),
      "utf8",
    );
    return `${common}\n\n${graph}`;
  }
  return common;
}

export function observabilityMcpServer({
  snapshotPath,
  ledgerPath,
  arm,
  runId,
  seed,
  model,
  enableLiveReplay = false,
}) {
  const args = [
    resolve(evaluationRoot, "src/observability-mcp.mjs"),
    "--snapshot",
    resolve(snapshotPath),
    "--ledger",
    resolve(ledgerPath),
    "--arm",
    arm,
    "--run-id",
    runId,
    "--seed",
    String(seed),
    "--model",
    model,
  ];
  if (enableLiveReplay) args.push("--enable-live-replay");
  return {
    name: "observability",
    command: process.execPath,
    args,
    startupTimeoutSec: 10,
    toolTimeoutSec: 60,
  };
}

export function liveProbeMcpServer({
  brokerUrl,
  profile = "graph",
  ledgerPath,
  arm,
  runId,
  incidentId,
  seed,
  model,
}) {
  const cli = resolve(repositoryRoot, "packages/mcp-server/dist/cli.js");
  const auditArgs = [
    resolve(evaluationRoot, "src/mcp-filter-proxy.mjs"),
    "--profile",
    profile,
  ];
  if (ledgerPath !== undefined) auditArgs.push("--ledger", resolve(ledgerPath));
  if (arm !== undefined) auditArgs.push("--arm", arm);
  if (runId !== undefined) auditArgs.push("--run-id", runId);
  if (incidentId !== undefined) auditArgs.push("--incident-id", String(incidentId));
  if (seed !== undefined) auditArgs.push("--seed", String(seed));
  if (model !== undefined) auditArgs.push("--model", model);
  return {
    name: "liveprobe",
    command: process.execPath,
    args: [
      ...auditArgs,
      "--",
      process.execPath,
      cli,
      "--broker-url",
      brokerUrl,
    ],
    startupTimeoutSec: 15,
    toolTimeoutSec: 60,
  };
}

export function armCapabilities(arm) {
  if (!ARM_NAMES.includes(arm)) throw new Error(`unknown arm ${arm}`);
  return {
    repository: arm !== "praxis",
    observability: true,
    replay: arm !== "praxis",
    raw_liveprobe: arm === "raw_liveprobe",
    graph_liveprobe: arm === "graph_liveprobe",
    praxis_graphs: arm === "praxis",
    observability_tool_schema_sha256: OBSERVABILITY_TOOL_SCHEMA_SHA256,
  };
}

export function buildTaskPrompt({ arm, guidance, bootstrap, tokenBudget }) {
  const capability = armCapabilities(arm);
  return `${guidance}

# Assigned incident

Diagnose incident ${bootstrap.incident_id}. The initial immutable evidence envelope is:

${JSON.stringify(bootstrap, null, 2)}

Your available capability profile is:

${JSON.stringify(capability, null, 2)}

This is a bounded evaluation with a hard Codex rollout budget of ${tokenBudget} provider tokens, including repeated context and output. Treat the limit as a ceiling, not a target. Batch source inspection when practical and make only tool calls that can change the diagnosis. When a rollout-budget reminder appears, stop using tools and return the best evidence-backed structured result immediately; return an honest INSUFFICIENT if the remaining evidence cannot support localization.

Use only evidence and source exposed to this arm. Return exactly the structured diagnosis required by the output schema. Do not modify code, configuration, cluster state, or benchmark data.`;
}
