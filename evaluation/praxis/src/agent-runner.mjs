import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";

import { sha256 } from "./core.mjs";

function tomlString(value) {
  return JSON.stringify(String(value));
}

export function mcpConfigArgs(servers) {
  return servers.flatMap((server) => {
    const prefix = `mcp_servers.${server.name}`;
    const args = [
      "--config",
      `${prefix}.command=${tomlString(server.command)}`,
      "--config",
      `${prefix}.args=[${server.args.map(tomlString).join(",")}]`,
      "--config",
      `${prefix}.startup_timeout_sec=${server.startupTimeoutSec ?? 10}`,
      "--config",
      `${prefix}.tool_timeout_sec=${server.toolTimeoutSec ?? 60}`,
      "--config",
      `${prefix}.required=true`,
      "--config",
      `${prefix}.default_tools_approval_mode="approve"`,
    ];
    if (server.env !== undefined) {
      const entries = Object.entries(server.env).map(
        ([key, value]) => `${key}=${tomlString(value)}`,
      );
      args.push("--config", `${prefix}.env={${entries.join(",")}}`);
    }
    return args;
  });
}

/**
 * The Codex event stream carries prompt and response text verbatim. It is
 * evaluation-side forensic data with exactly the same handling rules as the
 * operation ledger: it may never be reachable from the directory the agent is
 * pointed at, or an arm could read its own trace (and, through it, another
 * arm's) as evidence. `core.mjs` refuses snapshots whose keys leak oracle
 * fields; this is the same discipline applied to a filesystem path.
 */
export function assertOutsideAgentWorkspace(label, path, agentCwd) {
  if (path === undefined || path === null || agentCwd === undefined) return;
  const target = resolve(String(path));
  const workspace = resolve(String(agentCwd));
  const offset = relative(workspace, target);
  if (offset === "" || (!offset.startsWith("..") && !isAbsolute(offset))) {
    throw new Error(
      `${label} must never be written inside the agent working directory: ` +
        `${target} is inside ${workspace}`,
    );
  }
}

/**
 * Persist the raw stdout verbatim rather than re-serialising parsed events, so
 * that non-JSON diagnostics stay in the record and the artifact survives a
 * change to Codex's event schema.
 */
async function persistEventStream(path, stdout) {
  if (path === undefined || path === null) return null;
  const text = String(stdout ?? "");
  await mkdir(dirname(resolve(path)), { recursive: true });
  const encoded = Buffer.from(text, "utf8");
  await writeFile(
    path,
    String(path).endsWith(".gz") ? gzipSync(encoded, { level: 9 }) : encoded,
  );
  return { path, sha256: sha256(text), bytes: encoded.byteLength };
}

function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split("\n")) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Diagnostics on stdout are not model events.
    }
  }
  return events;
}

export function rolloutBudgetConfigArgs(tokenBudget) {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 4) {
    throw new Error("tokenBudget must be an integer of at least 4");
  }
  const reminders = [
    Math.floor(tokenBudget / 3),
    Math.floor(tokenBudget / 6),
    Math.floor(tokenBudget / 15),
  ]
    .filter((value, index, values) =>
      value > 0 && value < tokenBudget && values.indexOf(value) === index
    )
    .sort((left, right) => right - left);
  return [
    "--config",
    "features.rollout_budget.enabled=true",
    "--config",
    `features.rollout_budget.limit_tokens=${tokenBudget}`,
    "--config",
    `features.rollout_budget.reminder_at_remaining_tokens=[${reminders.join(",")}]`,
  ];
}

export function usageFromEvents(events) {
  let raw = {};
  let completedTurns = 0;
  for (const event of events) {
    if (event.type === "turn.completed") {
      completedTurns += 1;
      if (event.usage) raw = event.usage;
    }
  }
  const completed = events
    .filter((event) => event.type === "item.completed")
    .map((event) => event.item)
    .filter((item) => item !== null && typeof item === "object");
  const toolTypes = new Set([
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
    "tool_call",
  ]);
  const toolCalls = completed.filter((item) =>
    toolTypes.has(String(item.type)),
  ).length;
  const reasoningItems = completed.filter(
    (item) => item.type === "reasoning",
  ).length;
  const assistantMessages = completed.filter(
    (item) =>
      item.type === "agent_message" ||
      item.type === "assistant_message" ||
      (item.type === "message" && item.role === "assistant"),
  ).length;
  const modelSamples = Math.max(
    reasoningItems,
    toolCalls + (assistantMessages > 0 ? 1 : 0),
    events.some((event) => event.type === "turn.completed") ? 1 : 0,
  );
  const input = Number(raw.input_tokens ?? 0);
  const cached = Number(raw.cached_input_tokens ?? 0);
  return {
    // Codex reports exact aggregate tokens for the turn, but not the number of
    // provider sampling requests inside an agentic turn.
    model_calls: completedTurns,
    model_samples: modelSamples,
    retries: 0,
    input_tokens: input,
    cached_input_tokens: cached,
    new_input_tokens: Math.max(0, input - cached),
    output_tokens: Number(raw.output_tokens ?? 0),
    reasoning_tokens: Number(raw.reasoning_output_tokens ?? 0),
    model_ms: 0,
    tool_calls: toolCalls,
    tool_response_bytes: 0,
  };
}

function runCodex(args, { cwd, prompt, timeoutMs }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("codex", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timer.unref();
    child.stdin.end(prompt);
    child.once("exit", (code) => {
      clearTimeout(timer);
      const result = { code, stdout, stderr, timedOut };
      if (code === 0 && !timedOut) resolveRun(result);
      else {
        const error = new Error(
          timedOut
            ? `Codex timed out after ${timeoutMs}ms`
            : `Codex exited ${code}: ${(stderr || stdout).slice(-4_000)}`,
        );
        Object.assign(error, result);
        reject(error);
      }
    });
  });
}

export async function runCodexAgent({
  arm,
  model,
  reasoningEffort = "low",
  cwd,
  prompt,
  schema,
  skill,
  mcpServers,
  timeoutMs,
  tokenBudget,
  ledger,
  eventStreamPath,
}) {
  const agentCwd = resolve(cwd);
  assertOutsideAgentWorkspace("codex event stream", eventStreamPath, agentCwd);
  assertOutsideAgentWorkspace("evaluation ledger", ledger?.path, agentCwd);
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), `liveprobe-praxis-${arm}-`),
  );
  const schemaPath = join(temporaryRoot, "diagnosis.schema.json");
  const answerPath = join(temporaryRoot, "answer.json");
  await writeFile(schemaPath, JSON.stringify(schema));
  const args = [
    "exec",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "--sandbox",
    "read-only",
    "--cd",
    agentCwd,
    "--model",
    model,
    "--config",
    `model_reasoning_effort=${tomlString(reasoningEffort)}`,
    "--config",
    'web_search="disabled"',
    "--config",
    "agents.enabled=false",
    ...rolloutBudgetConfigArgs(tokenBudget),
    ...mcpConfigArgs(mcpServers),
    "--output-schema",
    schemaPath,
    "--output-last-message",
    answerPath,
    "-",
  ];
  const started = performance.now();
  let result;
  try {
    result = await runCodex(args, {
      cwd: agentCwd,
      prompt,
      timeoutMs,
    });
    const elapsedMs = Math.round(performance.now() - started);
    const eventStream = await persistEventStream(
      eventStreamPath,
      result.stdout,
    );
    const events = parseEvents(result.stdout);
    const usage = usageFromEvents(events);
    usage.model_ms = elapsedMs;
    const answer = JSON.parse(await readFile(answerPath, "utf8"));
    ledger.recordModel({
      event_stream_sha256: eventStream?.sha256 ?? null,
      phase: "incident_diagnosis",
      prompt_sha256: sha256(prompt),
      system_sha256: null,
      skill_sha256: skill === undefined ? null : sha256(skill),
      tool_schema_sha256: sha256(mcpServers.map((server) => server.name)),
      response_sha256: sha256(answer),
      provider_reported: true,
      usage_scope: "codex_turn_aggregate",
      model_sample_count_source: "event_lower_bound",
      usage,
    });
    return {
      answer,
      usage,
      wall_ms: elapsedMs,
      event_count: events.length,
      event_stream_path: eventStream?.path ?? null,
      event_stream_sha256: eventStream?.sha256 ?? null,
      event_stream_bytes: eventStream?.bytes ?? null,
      stderr_tail: result.stderr.slice(-1_000),
    };
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - started);
    // A truncated or failed run is exactly when the trace is most worth
    // keeping, so persist before deciding how to report the failure.
    const eventStream = await persistEventStream(
      eventStreamPath,
      error.stdout ?? "",
    ).catch(() => null);
    const events = parseEvents(error.stdout ?? "");
    const usage = usageFromEvents(events);
    usage.model_ms = elapsedMs;
    if (error.ledgerRecorded === true) {
      error.usage = usage;
      error.wall_ms = elapsedMs;
      error.event_stream_path = eventStream?.path ?? null;
      throw error;
    }
    ledger.recordModel({
      event_stream_sha256: eventStream?.sha256 ?? null,
      phase: "incident_diagnosis",
      prompt_sha256: sha256(prompt),
      system_sha256: null,
      skill_sha256: skill === undefined ? null : sha256(skill),
      tool_schema_sha256: sha256(mcpServers.map((server) => server.name)),
      response_sha256: null,
      status: error.timedOut ? "timeout" : "failed",
      provider_reported: events.some(
        (event) => event.type === "turn.completed" && event.usage,
      ),
      usage_scope: "codex_turn_aggregate",
      model_sample_count_source: "event_lower_bound",
      usage,
    });
    error.usage = usage;
    error.wall_ms = elapsedMs;
    error.event_stream_path = eventStream?.path ?? null;
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
