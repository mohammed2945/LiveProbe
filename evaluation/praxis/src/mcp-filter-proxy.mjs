#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import process from "node:process";

export const RAW_LIVEPROBE_TOOLS = new Set([
  "set_snapshot_probe",
  "set_log_probe",
  "set_counter_probe",
  "set_metric_probe",
  "list_services",
  "ping_broker",
  "get_safety_overview",
  "list_audit_events",
  "list_probes",
  "get_probe_data",
  "remove_probe",
]);

function sha256(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function resultPayload(response) {
  if (
    response?.result?.structuredContent !== null &&
    typeof response?.result?.structuredContent === "object"
  ) {
    return response.result.structuredContent;
  }
  const text = response?.result?.content?.find(
    (item) => item?.type === "text" && typeof item.text === "string",
  )?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function countWatchPaths(value) {
  if (Array.isArray(value?.watchPaths)) return value.watchPaths.length;
  if (Array.isArray(value?.watch_paths)) return value.watch_paths.length;
  if (value !== null && typeof value === "object") {
    for (const key of ["probe", "config", "spec"]) {
      const count = countWatchPaths(value[key]);
      if (count > 0) return count;
    }
  }
  return 0;
}

export function toolCostCounters(call, response) {
  const payload = resultPayload(response);
  const completed =
    response?.result?.isError !== true && response?.error === undefined;
  if (!completed) return {};
  if (
    [
      "set_snapshot_probe",
      "set_log_probe",
      "set_counter_probe",
      "set_metric_probe",
    ].includes(call?.name)
  ) {
    return {
      deployed_probes: 1,
      deployed_watches:
        call.name === "set_snapshot_probe"
          ? countWatchPaths(call.arguments)
          : 0,
    };
  }
  if (call?.name === "deploy_investigation_probes") {
    const probes = Array.isArray(payload?.probes) ? payload.probes : [];
    return {
      deployed_probes: probes.length,
      deployed_watches: probes.reduce(
        (total, probe) => total + countWatchPaths(probe),
        0,
      ),
      investigation_round:
        Number.isInteger(payload?.round) ? payload.round : null,
    };
  }
  if (call?.name === "collect_investigation_evidence") {
    return {
      collected_occurrences: Array.isArray(payload?.occurrences)
        ? payload.occurrences.length
        : 0,
    };
  }
  return {};
}

export function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1) {
    throw new Error("expected -- before the upstream command");
  }
  const options = argv.slice(0, separator);
  const command = argv[separator + 1];
  const commandArgs = argv.slice(separator + 2);
  const result = {
    profile: "raw",
    ledger: undefined,
    arm: "unknown",
    runId: "standalone-liveprobe",
    incidentId: "unknown",
    seed: 0,
    model: "none",
  };
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === "--profile") result.profile = options[++index];
    else if (options[index] === "--ledger") result.ledger = options[++index];
    else if (options[index] === "--arm") result.arm = options[++index];
    else if (options[index] === "--run-id") result.runId = options[++index];
    else if (options[index] === "--incident-id") {
      result.incidentId = options[++index];
    } else if (options[index] === "--seed") {
      result.seed = Number(options[++index]);
    } else if (options[index] === "--model") result.model = options[++index];
    else throw new Error(`unknown option ${options[index]}`);
  }
  if (!["raw", "graph"].includes(result.profile)) {
    throw new Error(`unsupported profile ${result.profile}`);
  }
  if (!Number.isInteger(result.seed)) throw new Error("--seed must be an integer");
  if (command === undefined) throw new Error("upstream command is required");
  return { ...result, command, commandArgs };
}

function write(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

export async function runProxy(options) {
  const child = spawn(options.command, options.commandArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const pending = new Map();
  async function recordTool(call, response, status = "completed") {
    if (options.ledger === undefined || call?.name === undefined) return;
    const serialized = JSON.stringify(response);
    const record = {
      schema_version: "liveprobe-eval-ledger/v1",
      timestamp: new Date().toISOString(),
      run_id: options.runId,
      arm: options.arm,
      incident_id: options.incidentId,
      seed: options.seed,
      model: options.model,
      kind: "tool_call",
      server: "liveprobe",
      tool: call.name,
      arguments_sha256: sha256(call.arguments ?? {}),
      response_sha256: sha256(serialized),
      response_bytes: Buffer.byteLength(serialized),
      status,
      ...toolCostCounters(call, response),
    };
    await appendFile(options.ledger, `${JSON.stringify(record)}\n`);
  }
  const upstream = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });
  const client = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  const upstreamTask = (async () => {
    for await (const line of upstream) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stderr.write(`mcp-filter-proxy: invalid upstream JSON\n`);
        continue;
      }
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (call?.method === "tools/list" && Array.isArray(message.result?.tools)) {
        if (options.profile === "raw") {
        message.result.tools = message.result.tools.filter((tool) =>
          RAW_LIVEPROBE_TOOLS.has(tool.name),
        );
        }
      }
      if (call?.method === "initialize" && message.result !== undefined) {
        const scope =
          options.profile === "raw"
            ? "Manual raw LiveProbe tools only. This profile exposes no analyzer graph, investigation frontier, or generated probe locations."
            : "Full LiveProbe profile with persistent causal-graph investigations and canonical probe frontiers.";
        message.result.instructions = `${message.result.instructions ?? ""}\n${scope}`.trim();
      }
      if (call?.method === "tools/call") {
        await recordTool(
          call,
          message,
          message.result?.isError === true || message.error !== undefined
            ? "failed"
            : "completed",
        );
      }
      write(process.stdout, message);
    }
  })();

  for await (const line of client) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(process.stdout, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "invalid JSON" },
      });
      continue;
    }
    if (
      message.method === "tools/call" &&
      options.profile === "raw" &&
      !RAW_LIVEPROBE_TOOLS.has(message.params?.name)
    ) {
      const response = {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "capability_denied",
                message: `${message.params?.name} is unavailable in the raw LiveProbe arm`,
                recovery:
                  "Use one of the manual probe, service, safety, audit, data, or cleanup tools returned by tools/list.",
              }),
            },
          ],
          isError: true,
        },
      };
      await recordTool(
        {
          name: message.params?.name,
          arguments: message.params?.arguments ?? {},
        },
        response,
        "capability_denied",
      );
      write(process.stdout, response);
      continue;
    }
    if (message.id !== undefined) {
      pending.set(message.id, {
        method: message.method,
        name:
          message.method === "tools/call" ? message.params?.name : undefined,
        arguments:
          message.method === "tools/call"
            ? message.params?.arguments ?? {}
            : undefined,
      });
    }
    write(child.stdin, message);
  }
  child.stdin.end();
  await upstreamTask;
}

if (process.argv[1]?.endsWith("mcp-filter-proxy.mjs")) {
  try {
    await runProxy(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`mcp-filter-proxy: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
