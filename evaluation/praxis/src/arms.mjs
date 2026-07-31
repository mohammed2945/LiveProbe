import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { OBSERVABILITY_TOOL_SCHEMA_SHA256 } from "./observability-mcp.mjs";

const evaluationRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const repositoryRoot = resolve(evaluationRoot, "../..");

/** The canonical leaderboard arms. This is the default set for a campaign. */
export const ARM_NAMES = [
  "normal_coding_sre",
  "praxis",
  "graph_liveprobe",
  "raw_liveprobe",
];

/**
 * Forced-probe experiment arms, opt-in via --arms and deliberately NOT in the
 * default set.
 *
 * Both are graph_liveprobe with probing made an assignment rather than a
 * choice. Probing is normally the agent's own decision, which makes "runs that
 * probed did worse" uninterpretable, because the runs that reach for a probe
 * may be the runs that were already stuck. Forcing the assignment makes the
 * difference between these two arms the causal effect of runtime observation.
 */
export const EXPERIMENT_ARM_NAMES = ["graph_probe_off", "graph_probe_on"];

/** Every arm the harness can run, canonical plus experimental. */
export const ALL_ARM_NAMES = [...ARM_NAMES, ...EXPERIMENT_ARM_NAMES];

/** Arms that carry the analyzer investigation surface. */
export const GRAPH_ARMS = new Set([
  "graph_liveprobe",
  "graph_probe_off",
  "graph_probe_on",
]);

/** Arms that talk to the LiveProbe broker and therefore need its isolation. */
export const LIVEPROBE_ARMS = new Set([...GRAPH_ARMS, "raw_liveprobe"]);

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
  if (GRAPH_ARMS.has(arm)) {
    const graph = await readFile(
      resolve(repositoryRoot, "skills/liveprobe-investigation/SKILL.md"),
      "utf8",
    );
    if (arm === "graph_probe_off") {
      return `${common}\n\n${graph}\n\n## Probe deployment is unavailable in this configuration\n\nThe probe-deploying tools are not present. Use the analyzer graph, the investigation frontier and observability, and return an honest \`HANDOFF\` or \`INSUFFICIENT\` when a runtime value would be required to separate the remaining explanations. Do not report a localization you could not support.`;
    }
    if (arm === "graph_probe_on") {
      return `${common}\n\n${graph}\n\n## Deploy at least one probe before answering\n\nThis configuration requires runtime observation: deploy at least one probe and collect its evidence before returning a diagnosis. Choose the site that best separates the explanations you are still weighing rather than a site that restates something already established.`;
    }
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
  if (!ALL_ARM_NAMES.includes(arm)) throw new Error(`unknown arm ${arm}`);
  return {
    repository: arm !== "praxis",
    observability: true,
    replay: arm !== "praxis",
    raw_liveprobe: arm === "raw_liveprobe",
    graph_liveprobe: GRAPH_ARMS.has(arm),
    probe_deployment: arm !== "praxis" && arm !== "normal_coding_sre" && arm !== "graph_probe_off",
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

This is a bounded evaluation with a hard shared Codex rollout budget of ${tokenBudget} tokens. Treat the limit as a ceiling, not a target. Do not create a todo list. Batch source inspection into as few shell calls as practical and make only tool calls that can change the diagnosis. When a rollout-budget reminder appears, stop using tools and return the best evidence-backed structured result immediately unless one already-started observation is sufficient to finish; return an honest INSUFFICIENT if the remaining evidence cannot support localization.

Use only evidence and source exposed to this arm. Return exactly the structured diagnosis required by the output schema. Do not modify code, configuration, cluster state, or benchmark data.`;
}
