import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

export function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const { timeoutMs, ...spawnOptions } = options;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const started = performance.now();
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
          }, timeoutMs);
    timeout?.unref();
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (timedOut) {
        reject(new ProcessRunError(
          `${command} timed out after ${timeoutMs}ms: ${stderr.slice(-2_000)}`,
          {
            command,
            code,
            stdout,
            stderr,
            timedOut: true,
            elapsedMs: Math.round(performance.now() - started),
          },
        ));
      } else if (code === 0) resolveRun(stdout.trim());
      else {
        reject(new ProcessRunError(
          `${command} exited ${code}: ${(stderr || stdout).slice(-8_000)}`,
          {
            command,
            code,
            stdout,
            stderr,
            timedOut: false,
            elapsedMs: Math.round(performance.now() - started),
          },
        ));
      }
    });
  });
}

export class ProcessRunError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ProcessRunError";
    Object.assign(this, details);
  }
}

export async function freePort() {
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

export async function waitFor(check, label, timeoutMs = 20_000) {
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

function startTarget({
  root,
  rideRoot,
  scenario,
  port,
  brokerUrl,
  commit,
  pricingUrl,
}) {
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
  if (pricingUrl !== undefined) args.push("--pricing-url", pricingUrl);
  const child = spawn(python, args, {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: [sdkPath, rideRoot, process.env["PYTHONPATH"]]
        .filter(Boolean)
        .join(":"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

export async function startRideTargets({
  root,
  rideRoot,
  brokerUrl,
  commit,
  handlers,
}) {
  const pricingPort = await freePort();
  const gatewayPort = await freePort();
  const pricing = startTarget({
    root,
    rideRoot,
    scenario: "pricing",
    port: pricingPort,
    brokerUrl,
    commit,
  });
  const gateway = startTarget({
    root,
    rideRoot,
    scenario: "gateway",
    port: gatewayPort,
    brokerUrl,
    commit,
    pricingUrl: `http://127.0.0.1:${pricingPort}`,
  });
  try {
    await waitFor(async () => {
      const response = await fetch(
        `http://127.0.0.1:${pricingPort}/healthz`,
      );
      return response.ok;
    }, "pricing HTTP");
    await waitFor(async () => {
      const response = await fetch(
        `http://127.0.0.1:${gatewayPort}/healthz`,
      );
      return response.ok;
    }, "gateway HTTP");
    for (const serviceId of ["pricing-e2e", "gateway-e2e"]) {
      await waitFor(async () => {
        const response = await handlers.list_services({});
        return response.services.some(
          (service) => service.serviceId === serviceId && service.online,
        );
      }, `${serviceId} heartbeat`);
    }
  } catch (error) {
    await Promise.all([stopTarget(gateway), stopTarget(pricing)]);
    throw error;
  }
  return {
    gatewayPort,
    pricingPort,
    logs: () => ({ gateway: gateway.logs(), pricing: pricing.logs() }),
    async close() {
      await Promise.all([stopTarget(gateway), stopTarget(pricing)]);
    },
  };
}

export async function replayFailingRequest(gatewayPort, replayId) {
  const started = performance.now();
  const response = await fetch(
    `http://127.0.0.1:${gatewayPort}/request_ride`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-liveprobe-replay-id": replayId,
        "x-trace-id": "four-method-business-trace",
      },
      body: JSON.stringify({
        rider_id: "rider-benchmark",
        x: 16,
        y: 16,
        dest_x: 22,
        dest_y: 24,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `failing replay returned ${response.status}: ${await response.text()}`,
    );
  }
  const body = await response.json();
  if (Number(body.quote) < 1_000) {
    throw new Error("benchmark fault did not produce an inflated quote");
  }
  return {
    body,
    elapsedMs: Math.round(performance.now() - started),
    traceId: replayId,
  };
}

export async function waitForArmed(handlers, probes) {
  await waitFor(async () => {
    const states = await Promise.all(
      probes.map(({ probe }) =>
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
  }, "benchmark probes");
}

export async function waitForSnapshots(
  handlers,
  probes,
  traceId,
  { requireAll = false } = {},
) {
  return waitFor(async () => {
    const states = await Promise.all(
      probes.map(async ({ probe, ...metadata }) => ({
        ...metadata,
        probe,
        data: await handlers.get_probe_data({
          probe_id: probe.id,
          wait_seconds: 0,
        }),
      })),
    );
    const matching = states.flatMap((state) =>
      state.data.events
        .filter(
          (event) =>
            event.type === "snapshot" &&
            event.correlation?.traceId === traceId,
        )
        .map((event) => ({ ...state, event })),
    );
    if (!requireAll) return matching.length > 0 ? matching : undefined;
    const matchedProbeIds = new Set(
      matching.map(({ probe }) => probe.id),
    );
    return probes.every(({ probe }) => matchedProbeIds.has(probe.id))
      ? matching
      : undefined;
  }, `snapshots for ${traceId}`);
}

export async function removeProbes(handlers, probes) {
  await Promise.all(
    probes.map(({ probe }) =>
      handlers
        .remove_probe({ probe_id: probe.id })
        .catch(() => undefined),
    ),
  );
}

function parseCodexEvents(stdout) {
  const events = [];
  for (const line of stdout.split("\n")) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Codex JSONL can contain non-event diagnostics.
    }
  }
  return events;
}

function countCodexWork(events) {
  const completedItems = events
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
  const toolCalls = completedItems.filter((item) =>
    toolTypes.has(String(item.type)),
  ).length;
  const reasoningItems = completedItems.filter(
    (item) => item.type === "reasoning",
  ).length;
  const assistantMessages = completedItems.filter(
    (item) =>
      item.type === "agent_message" ||
      item.type === "assistant_message" ||
      (item.type === "message" && item.role === "assistant"),
  ).length;
  return {
    toolCalls,
    // Current Codex JSONL emits one reasoning item for each model sampling
    // cycle. Older clients omit it, in which case tool_calls + final answer
    // is the conservative observable lower bound.
    modelSamples: Math.max(
      reasoningItems,
      toolCalls + (assistantMessages > 0 ? 1 : 0),
      events.some((event) => event.type === "turn.completed") ? 1 : 0,
    ),
  };
}

function cumulativeUsageFromEvents(events) {
  let raw = {};
  for (const event of events) {
    if (event.type === "turn.completed" && event.usage) raw = event.usage;
  }
  return {
    inputTokens: Number(raw.input_tokens ?? 0),
    cachedInputTokens: Number(raw.cached_input_tokens ?? 0),
    outputTokens: Number(raw.output_tokens ?? 0),
    reasoningTokens: Number(raw.reasoning_output_tokens ?? 0),
  };
}

function usageDelta(current, previous, work, elapsedMs) {
  const inputTokens = Math.max(
    0,
    current.inputTokens - previous.inputTokens,
  );
  const cachedInputTokens = Math.max(
    0,
    current.cachedInputTokens - previous.cachedInputTokens,
  );
  return {
    calls: work.modelSamples,
    modelSamples: work.modelSamples,
    outerTurns: 1,
    toolCalls: work.toolCalls,
    inputTokens,
    cachedInputTokens,
    newInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens: Math.max(
      0,
      current.outputTokens - previous.outputTokens,
    ),
    reasoningTokens: Math.max(
      0,
      current.reasoningTokens - previous.reasoningTokens,
    ),
    elapsedMs,
  };
}

export const zeroUsage = () => ({
  calls: 0,
  modelSamples: 0,
  outerTurns: 0,
  toolCalls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  newInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  elapsedMs: 0,
});

export function addUsage(left, right) {
  return {
    calls: left.calls + right.calls,
    modelSamples:
      Number(left.modelSamples ?? left.calls) +
      Number(right.modelSamples ?? right.calls),
    outerTurns:
      Number(left.outerTurns ?? 0) + Number(right.outerTurns ?? 0),
    toolCalls:
      Number(left.toolCalls ?? 0) + Number(right.toolCalls ?? 0),
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    newInputTokens: left.newInputTokens + right.newInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    elapsedMs: left.elapsedMs + right.elapsedMs,
  };
}

export class CodexSession {
  constructor({
    model,
    cwd,
    allowRepositoryTools,
    persistent = true,
    turnTimeoutMs = 120_000,
  }) {
    this.model = model;
    this.cwd = cwd;
    this.allowRepositoryTools = allowRepositoryTools;
    this.persistent = persistent;
    this.turnTimeoutMs = turnTimeoutMs;
    this.temporaryRoot = undefined;
    this.sessionId = undefined;
    this.turn = 0;
    this.previousCumulativeUsage = cumulativeUsageFromEvents([]);
    this.totalUsage = zeroUsage();
    this.completedTurns = [];
  }

  async initialize() {
    this.temporaryRoot = await mkdtemp(join(tmpdir(), "liveprobe-4arm-"));
  }

  async decide({ prompt, schema }) {
    if (this.temporaryRoot === undefined) await this.initialize();
    this.turn += 1;
    const schemaPath = join(
      this.temporaryRoot,
      `schema-${this.turn}.json`,
    );
    const answerPath = join(
      this.temporaryRoot,
      `answer-${this.turn}.json`,
    );
    const encodedSchema = JSON.stringify(schema);
    const promptBytes = Buffer.byteLength(prompt);
    const schemaBytes = Buffer.byteLength(encodedSchema);
    await writeFile(schemaPath, encodedSchema);
    const common = [
      "--skip-git-repo-check",
      "--config",
      'web_search="disabled"',
      "--config",
      "agents.enabled=false",
      "--config",
      "mcp_servers={}",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      answerPath,
    ];
    if (this.model !== undefined) common.push("--model", this.model);
    const firstCwd = this.allowRepositoryTools
      ? this.cwd
      : this.temporaryRoot;
    const args =
      !this.persistent || this.sessionId === undefined
        ? [
            "exec",
            "--ignore-user-config",
            "--ignore-rules",
            "--json",
            "--sandbox",
            "read-only",
            "--cd",
            firstCwd,
            ...common,
            prompt,
          ]
        : [
            "exec",
            "resume",
            "--ignore-user-config",
            "--ignore-rules",
            "--json",
            ...common,
            this.sessionId,
            prompt,
          ];
    const started = performance.now();
    let stdout;
    let elapsedMs;
    try {
      stdout = await run("codex", args, {
        cwd: firstCwd,
        timeoutMs: this.turnTimeoutMs,
      });
      elapsedMs = Math.round(performance.now() - started);
    } catch (error) {
      elapsedMs = Number(error?.elapsedMs) ||
        Math.round(performance.now() - started);
      const events = parseCodexEvents(String(error?.stdout ?? ""));
      const cumulative = cumulativeUsageFromEvents(events);
      const usage = usageDelta(
        cumulative,
        this.persistent
          ? this.previousCumulativeUsage
          : cumulativeUsageFromEvents([]),
        countCodexWork(events),
        elapsedMs,
      );
      this.totalUsage = addUsage(this.totalUsage, usage);
      const partialTurn = {
        answer: undefined,
        usage,
        cumulativeUsage: cumulative,
        packetBytes: promptBytes + schemaBytes,
        promptBytes,
        schemaBytes,
        turn: this.turn,
        incomplete: true,
      };
      this.completedTurns.push(partialTurn);
      if (error !== null && typeof error === "object") {
        error.partialTurn = partialTurn;
        error.usage = this.totalUsage;
        error.turns = [...this.completedTurns];
      }
      throw error;
    }
    const events = parseCodexEvents(stdout);
    if (this.persistent && this.sessionId === undefined) {
      const startedEvent = events.find(
        (event) => event.type === "thread.started",
      );
      this.sessionId =
        startedEvent?.thread_id ??
        startedEvent?.session_id ??
        startedEvent?.thread?.id;
      if (typeof this.sessionId !== "string") {
        throw new Error("Codex did not report a persistent session id");
      }
    }
    const cumulativeUsage = cumulativeUsageFromEvents(events);
    const usage = usageDelta(
      cumulativeUsage,
      this.persistent
        ? this.previousCumulativeUsage
        : cumulativeUsageFromEvents([]),
      countCodexWork(events),
      elapsedMs,
    );
    if (this.persistent) {
      this.previousCumulativeUsage = cumulativeUsage;
    }
    this.totalUsage = addUsage(this.totalUsage, usage);
    const completed = {
      answer: JSON.parse(await readFile(answerPath, "utf8")),
      usage,
      cumulativeUsage,
      packetBytes: promptBytes + schemaBytes,
      promptBytes,
      schemaBytes,
      turn: this.turn,
    };
    this.completedTurns.push(completed);
    return completed;
  }

  async close() {
    if (this.temporaryRoot !== undefined) {
      await rm(this.temporaryRoot, { recursive: true, force: true });
      this.temporaryRoot = undefined;
    }
  }
}

export function compactCapturedValue(value, depth = 0) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value === "string" && value.length > 200
      ? `${value.slice(0, 200)}…`
      : value;
  }
  if (depth >= 3) return { summary: typeof value };
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) =>
      compactCapturedValue(item, depth + 1),
    );
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 16)
        .map(([key, item]) => [
          key,
          compactCapturedValue(item, depth + 1),
        ]),
    );
  }
  return String(value);
}

async function pythonFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "__pycache__" ||
        entry.name === "node_modules"
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".py")) result.push(path);
    }
  }
  await visit(root);
  return result.sort();
}

function sourceFunctions(file, source) {
  const lines = source.split("\n");
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(
      /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    );
    if (match) starts.push({ name: match[1], index });
  }
  return starts.map((current, position) => {
    const next = starts[position + 1]?.index ?? lines.length;
    let end = next;
    while (end > current.index + 1 && lines[end - 1].trim() === "") end -= 1;
    return {
      id: `${file}:${current.name}:${current.index + 1}`,
      name: current.name,
      file,
      startLine: current.index + 1,
      endLine: end,
      signature: lines[current.index].trim(),
      source: lines
        .slice(current.index, end)
        .map(
          (line, offset) =>
            `${String(current.index + offset + 1).padStart(4)} ${line}`,
        )
        .join("\n"),
    };
  });
}

export async function buildSourceHierarchy(rideRoot) {
  const files = [];
  for (const path of await pythonFiles(rideRoot)) {
    const relativePath = relative(rideRoot, path).split(sep).join("/");
    const source = await readFile(path, "utf8");
    const functions = sourceFunctions(relativePath, source);
    if (functions.length === 0) continue;
    files.push({ path: relativePath, functions });
  }
  const communities = new Map();
  for (const file of files) {
    const parts = file.path.split("/");
    const community =
      parts[0] === "services" && parts.length > 1
        ? `services/${parts[1]}`
        : parts[0];
    const existing = communities.get(community) ?? {
      id: community,
      files: [],
      functions: [],
    };
    existing.files.push(file.path);
    existing.functions.push(...file.functions);
    communities.set(community, existing);
  }
  return {
    communities: [...communities.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    functions: files.flatMap((file) => file.functions),
  };
}

export function exactRootCause(answer) {
  const file = String(answer?.root_cause_file ?? "").replaceAll("\\", "/");
  const line = Number(answer?.root_cause_line);
  return (
    file.endsWith("services/pricing/app.py") &&
    Number.isInteger(line) &&
    line === 74
  );
}

export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function mean(values) {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

export async function fileSize(path) {
  return (await stat(path)).size;
}
