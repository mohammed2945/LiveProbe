#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const language = process.argv[2];
if (!new Set(["rust", "cpp"]).has(language)) {
  throw new Error("usage: node scripts/native-e2e.mjs rust|cpp");
}
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("native E2E is mandatory only on supported Linux x86-64");
}

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(`${tmpdir()}/liveprobe-native-e2e-`);
const apiKey = `lp_native_${randomBytes(32).toString("base64url")}`;
const port = language === "rust" ? 17070 : 17071;
const demoPort = language === "rust" ? 8083 : 8084;
const brokerUrl = `http://127.0.0.1:${port}`;
const agentId = `native-e2e-${language}`;
const serviceId = `native-e2e-${language}`;
const executable = resolve(root, language === "rust"
  ? "demo/rust-service/target/release/liveprobe-rust-demo"
  : "demo/cpp-service/liveprobe-cpp-demo");
const sourcePath = resolve(root, language === "rust"
  ? "demo/rust-service/src/main.rs"
  : "demo/cpp-service/main.cpp");
const sourceSuffix = language === "rust"
  ? "demo/rust-service/src/main.rs"
  : "demo/cpp-service/main.cpp";
const marker = language === "rust" ? "let discount =" : "const long discount =";
const coldMarker = language === "rust" ? "fn cold_marker(" : "long cold_marker(";
const source = await readFile(sourcePath, "utf8");
const sourceLine = source.split("\n").findIndex((line) => line.includes(marker)) + 1;
const coldLine = source.split("\n").findIndex((line) => line.includes(coldMarker)) + 1;
if (sourceLine <= 0 || coldLine <= 0) throw new Error(`stable source marker not found in ${sourceSuffix}`);
const buildId = execFileSync("readelf", ["--notes", executable], { encoding: "utf8" })
  .match(/Build ID:\s*([0-9a-f]+)/i)?.[1]?.toLowerCase();
if (!buildId) throw new Error(`GNU build ID missing from ${executable}`);

const children = [];
function start(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { log = `${log}${chunk}`.slice(-32_768); });
  }
  child.liveprobeName = name;
  child.liveprobeLog = () => log;
  children.push(child);
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((done) => child.once("exit", done)),
    new Promise((done) => setTimeout(done, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
async function waitFor(description, operation, timeout = 60_000) {
  const deadline = performance.now() + timeout;
  let lastError;
  while (performance.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError}` : ""}`);
}
async function broker(path, { method = "GET", body } = {}) {
  const response = await fetch(`${brokerUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}
function startBroker() {
  return start("broker", "node", ["packages/broker/dist/src/index.js"], {
    HOST: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "production",
    LIVEPROBE_API_KEY: apiKey,
    LIVEPROBE_STATE_FILE: `${temporary}/broker-state.json`,
    LIVEPROBE_SNAPSHOT_INTERVAL_MS: "50",
  });
}

let brokerProcess;
try {
  brokerProcess = startBroker();
  await waitFor("broker readiness", async () => (await fetch(`${brokerUrl}/readyz`)).ok);
  const demo = start("demo", executable, [], { LIVEPROBE_DISABLE_BACKGROUND: "1" });
  const installedLoader = `${temporary}/liveprobe-bpf-loader`;
  await copyFile(resolve(root, "native/target/release/liveprobe-bpf-loader"), installedLoader);
  await chmod(installedLoader, 0o755);
  const loader = start("loader", "sudo", [
    "-n", installedLoader,
    `${temporary}/loader.sock`, String(process.getuid()), String(process.getgid()), executable,
  ]);
  await waitFor("loader socket", async () => {
    if (loader.exitCode !== null) throw new Error(loader.liveprobeLog());
    try { return (await import("node:fs/promises")).stat(`${temporary}/loader.sock`); } catch { return false; }
  });
  const configPath = `${temporary}/agent.json`;
  await writeFile(configPath, JSON.stringify({
    agentId,
    brokerUrl,
    loaderSocket: `${temporary}/loader.sock`,
    redactKeys: ["tenant_secret"],
    redactValues: ["31337"],
    services: [{ serviceId, language, executablePath: executable }],
    symbolDirectories: [],
    debuginfodUrl: null,
    symbolCacheDirectory: null,
    safety: {
      preflightSeconds: 0,
      maxAttachments: 64,
      maxRawHitsPerSecond: 100000,
      perProbeRawHitsPerSecond: 1000,
      maxEventBytes: 65536,
      maxSerializerMillisPerSecond: 500,
      maxOutboundBytesPerSecond: 8388608,
      pollIntervalMillis: 50,
    },
  }));
  const agent = start("agent", resolve(root, "native/target/release/liveprobe-native-agent"), [configPath], {
    LIVEPROBE_NATIVE_CREDENTIAL: apiKey,
  });

  const service = await waitFor("native instance registration", async () => {
    if (agent.exitCode !== null) throw new Error(agent.liveprobeLog());
    const services = (await broker("/v1/services")).services;
    return services.find((entry) => entry.serviceId === serviceId && entry.instanceCount === 1);
  });
  if (service.language !== language || !service.buildIds.includes(buildId)) {
    throw new Error(`service build/language mismatch: ${JSON.stringify(service)}`);
  }
  const { BrokerClient, createToolHandlers } = await import(
    "../packages/mcp-server/dist/index.js"
  );
  const mcp = createToolHandlers(new BrokerClient(brokerUrl, { apiKey }));
  const mcpServices = await mcp.list_services();
  if (!mcpServices.services.some((entry) =>
    entry.serviceId === serviceId &&
    entry.backend === "native-ebpf" &&
    entry.buildIds?.includes(buildId)
  )) {
    throw new Error(`MCP did not expose the native service: ${JSON.stringify(mcpServices)}`);
  }

  const common = {
    serviceId,
    sourceCommit: "abcdef1234567890",
    file: sourceSuffix,
    line: sourceLine,
    ttlSeconds: 600,
    createdBy: "test:broker-http-native-e2e",
  };
  const coreDefinitions = [
    ["true", { ...common, type: "snapshot", watchPaths: ["subtotal"], condition: { path: "subtotal", op: "eq", value: 4242 }, hitLimit: 1 }],
    ["redacted", { ...common, type: "snapshot", watchPaths: ["tenant_secret"], hitLimit: 1 }],
    ["counter", { ...common, type: "counter", hitLimit: 20 }],
  ];
  const extendedDefinitions = [
    ["false", { ...common, type: "snapshot", watchPaths: ["subtotal"], condition: { path: "subtotal", op: "eq", value: 999 }, hitLimit: 20 }],
    ["literal", { ...common, type: "log", template: "literal-zero-interpolation", hitLimit: 1 }],
    ["unavailable", { ...common, type: "snapshot", watchPaths: ["missing_scalar"], hitLimit: 1 }],
    ["redactedLog", { ...common, type: "log", template: "secret=${tenant_secret}", hitLimit: 1 }],
    ["redactedMetric", { ...common, type: "metric", metricPath: "tenant_secret", hitLimit: 20 }],
    ["conditionOnly", { ...common, type: "snapshot", watchPaths: ["discount"], condition: { path: "subtotal", op: "eq", value: 4242 }, hitLimit: 1 }],
  ];
  const definitions = process.env.LIVEPROBE_NATIVE_EXTENDED_E2E === "1"
    ? [...coreDefinitions, ...extendedDefinitions]
    : coreDefinitions;
  const probes = new Map();
  for (const [name, body] of definitions) {
    if (name === "true") {
      const result = await mcp.set_snapshot_probe({
        service_id: body.serviceId,
        commit_hash: body.sourceCommit,
        file: body.file,
        line: body.line,
        condition: body.condition,
        watch_paths: body.watchPaths,
        hit_limit: body.hitLimit,
        ttl_seconds: body.ttlSeconds,
        created_by: body.createdBy,
      });
      probes.set(name, result.probe);
    } else {
      probes.set(name, (await broker("/v1/probes", { method: "POST", body })).probe);
    }
  }
  const armed = await waitFor("all probes armed", async () => {
    const values = await Promise.all([...probes.values()].map((probe) =>
      broker(`/v1/probes/${probe.id}/data?waitSeconds=0`)));
    const terminal = values.filter((value) =>
      value.status?.agentId === agentId && value.status.status !== "armed");
    if (terminal.length > 0) {
      throw new Error(`native probe arming failed: ${JSON.stringify(
        terminal.map((value) => ({ probe: value.probe, status: value.status })),
      )}`);
    }
    return values.every((value) =>
      value.status?.status === "armed" &&
      value.status.agentId === agentId &&
      value.status.instanceId &&
      value.status.buildId === buildId &&
      value.status.probeVersion === value.probe.version
    ) ? values : false;
  }, 300_000);
  for (const value of armed) {
    if (value.status.buildId !== buildId || value.status.agentId !== agentId ||
        !value.status.instanceId || value.status.probeVersion !== value.probe.version ||
        value.status.resolution?.sourceFile !== sourceSuffix ||
        value.status.resolution?.line !== sourceLine) {
      throw new Error(`identity/source resolution mismatch: ${JSON.stringify(value.status)}`);
    }
  }
  await waitFor("raw-hit safety supervisor readiness", async () => {
    const values = await Promise.all([...probes.values()].map((probe) =>
      broker(`/v1/probes/${probe.id}/data?waitSeconds=0`)));
    return values.every((value) => typeof value.status?.rawHitRate === "number");
  });

  for (let index = 0; index < 20; index += 1) {
    const response = await fetch(`http://127.0.0.1:${demoPort}/`);
    if (!response.ok) throw new Error(`demo traffic failed at request ${index}`);
    // Keep ordinary evidence traffic below the deliberately low test-only
    // raw-hit ceiling. The /burst path below remains unpaced.
    await new Promise((done) => setTimeout(done, 5));
  }
  const evidence = new Map();
  for (const [name, probe] of probes) {
    evidence.set(name, await waitFor(`${name} evidence`, async () => {
      const value = await broker(`/v1/probes/${probe.id}/data?waitSeconds=0`);
      if (name === "false") return value;
      if (name === "redactedMetric") return value;
      if (name === "counter") {
        const total = value.events
          .filter((event) => event.type === "counter")
          .reduce((sum, event) => sum + event.delta, 0);
        return total === 20 ? value : false;
      }
      const eventType = name === "literal" || name === "redactedLog" ? "log" : "snapshot";
      return value.events.some((event) => event.type === eventType) ? value : false;
    }));
  }
  const snapshots = evidence.get("true").events.filter((event) => event.type === "snapshot");
  if (!snapshots.some((event) => event.watches?.subtotal?.t === "num" && event.watches.subtotal.v === 4242)) {
    throw new Error("known scalar 4242 was not captured from a register or stack location");
  }
  if (evidence.get("false")?.events.some((event) => event.type === "snapshot")) {
    throw new Error("condition-false capture was emitted");
  }
  if (evidence.has("literal") && !evidence.get("literal").events.some((event) => event.type === "log" && event.message === "literal-zero-interpolation")) {
    throw new Error("literal zero-interpolation log missing");
  }
  if (evidence.has("unavailable") && !evidence.get("unavailable").events.some((event) =>
    event.type === "snapshot" && event.watches?.missing_scalar?.t === "unavailable")) {
    throw new Error("all-unavailable snapshot missing");
  }
  if (!evidence.get("redacted").events.some((event) =>
    event.type === "snapshot" && event.watches?.tenant_secret?.t === "redacted")) {
    throw new Error("redacted scalar missing");
  }
  if (evidence.has("redactedLog") && !evidence.get("redactedLog").events.some((event) =>
    event.type === "log" && !event.message.includes("31337"))) {
    throw new Error("redacted log evidence missing");
  }
  if (evidence.get("redactedMetric")?.events.some((event) => event.type === "metric")) {
    throw new Error("redacted metric path was emitted");
  }
  const conditionOnlySnapshots = (evidence.get("conditionOnly")?.events ?? [])
    .filter((event) => event.type === "snapshot");
  if (evidence.has("conditionOnly") && (conditionOnlySnapshots.length === 0 ||
      conditionOnlySnapshots.some((event) =>
        Object.hasOwn(event.watches ?? {}, "subtotal")))) {
    throw new Error("condition-only path leaked into emitted watches");
  }
  const counter = evidence.get("counter").events
    .filter((event) => event.type === "counter")
    .reduce((sum, event) => sum + event.delta, 0);
  if (counter !== 20) throw new Error(`counter aggregation was ${counter}, expected exactly 20`);
  const outboundPayloads = [...evidence.values()].flatMap((value) =>
    value.events.flatMap((event) => {
      if (event.type === "snapshot") {
        return [{ variables: event.variables, watches: event.watches, stack: event.stack }];
      }
      if (event.type === "log") return [event.message];
      if (event.type === "metric") {
        return [{ sum: event.sum, min: event.min, max: event.max, last: event.last }];
      }
      return [];
    }));
  if (JSON.stringify(outboundPayloads).includes("31337")) {
    throw new Error("redacted scalar leaked through emitted evidence payloads");
  }

  await new Promise((done) => setTimeout(done, 150));
  await stop(brokerProcess);
  brokerProcess = startBroker();
  await waitFor("broker restart", async () => (await fetch(`${brokerUrl}/readyz`)).ok);
  const persisted = await mcp.get_probe_data({ probe_id: probes.get("true").id });
  if (!persisted.events.some((event) => event.type === "snapshot")) {
    throw new Error("broker restart lost persisted native evidence");
  }

  for (const [name, probe] of probes) {
    if (name === "true") {
      await mcp.remove_probe({ probe_id: probe.id });
    } else {
      await broker(`/v1/probes/${probe.id}`, { method: "DELETE" });
    }
  }
  await waitFor("probe removal reconciliation", async () => {
    const desired = await broker(`/v1/native/agents/${agentId}/assignments?since=0`);
    return desired.assignments.every((assignment) => assignment.probes.length === 0);
  });

  const hot = (await broker("/v1/probes", { method: "POST", body: {
    ...common, type: "counter", hitLimit: 100000, createdBy: "test:automatic-hot-burst",
  } })).probe;
  const cold = (await broker("/v1/probes", { method: "POST", body: {
    ...common, type: "counter", line: coldLine, hitLimit: 100000,
    createdBy: "test:automatic-hot-burst-unrelated",
  } })).probe;
  await waitFor("hot and unrelated probes armed", async () => {
    const [hotData, coldData] = await Promise.all([
      broker(`/v1/probes/${hot.id}/data?waitSeconds=0`),
      broker(`/v1/probes/${cold.id}/data?waitSeconds=0`),
    ]);
    return hotData.status?.status === "armed" &&
      coldData.status?.status === "armed" &&
      typeof hotData.status?.rawHitRate === "number" &&
      typeof coldData.status?.rawHitRate === "number";
  });
  const liveLinkCount = () => {
    const programs = JSON.parse(execFileSync("sudo", ["-n", "bpftool", "-j", "prog", "show"], { encoding: "utf8" }));
    const ids = new Set(programs.filter((program) => /^liveprobe_/.test(program.name)).map((program) => program.id));
    const links = JSON.parse(execFileSync("sudo", ["-n", "bpftool", "-j", "link", "show"], { encoding: "utf8" }));
    return links.filter((link) => ids.has(link.prog_id)).length;
  };
  const linksBeforeBurst = liveLinkCount();
  if (linksBeforeBurst < 2) throw new Error(`expected two LiveProbe links before burst, saw ${linksBeforeBurst}`);
  const burst = await fetch(`http://127.0.0.1:${demoPort}/burst`);
  if (!burst.ok) throw new Error("hot burst traffic failed");
  const hotStatus = await waitFor("automatic raw-hit detachment", async () => {
    const value = await broker(`/v1/probes/${hot.id}/data?waitSeconds=0`);
    return value.status?.status === "suspended" &&
      value.status?.reasonCode === "raw-hit-budget-exceeded" ? value.status : false;
  });
  const coldData = await broker(`/v1/probes/${cold.id}/data?waitSeconds=0`);
  if (coldData.status?.status !== "armed") {
    throw new Error(`unrelated probe did not remain active: ${JSON.stringify(coldData.status)}`);
  }
  const coldPhysicalSites = coldData.status?.physicalSiteCount;
  if (!Number.isInteger(coldPhysicalSites) || coldPhysicalSites < 1) {
    throw new Error(`unrelated physical site count missing: ${JSON.stringify(coldData.status)}`);
  }
  await waitFor("all hot BPF links removed", async () => liveLinkCount() === coldPhysicalSites);
  const desiredAfterBurst = await broker(`/v1/native/agents/${agentId}/assignments?since=0`);
  const desiredIds = desiredAfterBurst.assignments.flatMap((assignment) => assignment.probes.map((probe) => probe.id));
  if (desiredIds.includes(hot.id) || !desiredIds.includes(cold.id)) {
    throw new Error(`version-protected desired state wrong after hot detachment: ${JSON.stringify(desiredIds)}`);
  }
  await broker(`/v1/probes/${cold.id}`, { method: "DELETE" });
  await broker(`/v1/probes/${hot.id}`, { method: "DELETE" });
  await waitFor("automatic burst cleanup", async () => liveLinkCount() === 0);
  await stop(agent);
  await stop(loader);
  await stop(demo);
  for (const kind of ["link", "prog", "map"]) {
    const output = execFileSync("sudo", ["-n", "bpftool", kind, "show"], { encoding: "utf8" });
    if (/liveprobe_|probe_plans|raw_hit_counters|capture_counters/.test(output)) {
      throw new Error(`LiveProbe BPF ${kind} resources remain:\n${output}`);
    }
  }
  console.log(`NATIVE_E2E_${language.toUpperCase()}_OK buildId=${buildId} source=${sourceSuffix}:${sourceLine} counter=${counter} hot=${hotStatus.reasonCode}`);
} catch (error) {
  const logs = children.map((child) => `\n--- ${child.liveprobeName} ---\n${child.liveprobeLog()}`).join("");
  console.error(`${error.stack ?? error}${logs}`);
  process.exitCode = 1;
} finally {
  for (const child of [...children].reverse()) await stop(child);
  await rm(temporary, { recursive: true, force: true });
}
