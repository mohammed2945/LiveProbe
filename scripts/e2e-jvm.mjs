import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const brokerEntry = resolve(root, "packages/broker/dist/src/index.js");
const bridgeJar = resolve(root, "java/bridge/build/liveprobe-bridge.jar");
const inventoryJar = resolve(
  root,
  "demo/inventory-service/target/inventory-service.jar",
);
const inventorySource = resolve(
  root,
  "demo/inventory-service/src/main/java/io/liveprobe/demo/inventory/InventoryService.java",
);
const serviceId = "inventory-service-e2e";
const INVENTORY_PROBE_FILE =
  "demo/inventory-service/src/main/java/io/liveprobe/demo/inventory/InventoryService.java";
/**
 * Driven back to back this lands far above the 10 hits/second budget, which is
 * the point: on the JVM the counter is expected to fall short.
 */
const COUNTER_BURST = 50;
/** Spaced under the budget so no hit is lost and the aggregate is exact. */
const METRIC_QUANTITIES = [1, 2, 3, 4, 5];
const METRIC_SPACING_MS = 150;

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
  );
  return address.port;
}

function startChild(label, command, args, environment = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-100_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return { label, process: child, output: () => output };
}

async function stopChild(child) {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  child.process.kill("SIGTERM");
  await Promise.race([once(child.process, "exit"), delay(3_000)]);
  if (child.process.exitCode === null && child.process.signalCode === null) {
    child.process.kill("SIGKILL");
    await once(child.process, "exit");
  }
}

async function waitFor(description, timeoutMilliseconds, operation) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${description}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${url} returned ${String(response.status)}: ${text}`,
    );
  }
  return JSON.parse(text);
}

function evidenceValue(snapshot, path) {
  const variableNode = snapshot.variables?.c?.[path];
  const watchNode = snapshot.watches?.[path];
  assert.ok(
    variableNode !== null && typeof variableNode === "object",
    `variables must include ${path}`,
  );
  assert.ok(
    watchNode !== null && typeof watchNode === "object",
    `watches must include ${path}`,
  );
  assert.deepEqual(watchNode, variableNode, `${path} watch must match captured variable`);
  assert.ok("v" in variableNode, `${path} must have a scalar value`);
  return variableNode.v;
}

function watchValue(snapshot, expression) {
  const watchNode = snapshot.watches?.[expression];
  assert.ok(
    watchNode !== null && typeof watchNode === "object",
    `watches must include ${expression}`,
  );
  assert.ok("v" in watchNode, `${expression} must have a scalar value`);
  return watchNode.v;
}

/**
 * Reservations come in pairs by construction: the engine makes both requests in
 * a wave read the cache before either commits, so a lone request would block on
 * the latch. Each pair uses a fresh sku and wave so stock never runs across
 * measurements.
 */
async function reservePair(inventoryUrl, index, quantity) {
  const responses = await Promise.all(
    ["leader", "follower"].map((role) =>
      fetch(
        `${inventoryUrl}/reserve?sku=sku-${String(index)}&quantity=${String(quantity)}` +
          `&wave=wave-${String(index)}&role=${role}`,
        { method: "POST" },
      ),
    ),
  );
  for (const response of responses) {
    // Stock is one unit per wave, so anything above a single unit is refused —
    // the probe line runs either way, which is all these phases depend on.
    assert.ok(
      response.status === 201 || response.status === 409,
      `reservation ${String(index)} returned ${String(response.status)}`,
    );
    await response.arrayBuffer();
  }
}

async function createProbe(brokerUrl, payload) {
  const created = await requestJson(`${brokerUrl}/v1/probes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return created.probe.id;
}

async function deleteProbe(brokerUrl, probeId) {
  await fetch(`${brokerUrl}/v1/probes/${probeId}`, { method: "DELETE" }).catch(
    () => {},
  );
}

async function probeEvents(brokerUrl, probeId, type) {
  const data = await requestJson(`${brokerUrl}/v1/probes/${probeId}/data`);
  return (data.events ?? []).filter((event) => event.type === type);
}

async function waitArmed(brokerUrl, probeId) {
  await waitFor(`probe ${probeId} to arm`, 15_000, async () => {
    const data = await requestJson(`${brokerUrl}/v1/probes/${probeId}/data`);
    return data.status?.status === "armed" ? true : null;
  });
}

/** Waits for in-flight reservations to land so a burst count is unambiguous. */
async function drain(inventoryUrl) {
  let previous = -1;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const stats = await requestJson(`${inventoryUrl}/stats`);
    if (stats.inFlightRequests === 0 && stats.completedRequests === previous) {
      return stats.completedRequests;
    }
    previous = stats.completedRequests;
    await delay(100);
  }
  throw new Error("timed out waiting for in-flight reservations to drain");
}

async function markerLine() {
  const lines = (await readFile(inventorySource, "utf8")).split(/\r?\n/u);
  const matches = lines
    .map((line, index) => (line.includes("LIVEPROBE_BUG_LINE") ? index + 1 : null))
    .filter((line) => line !== null);
  assert.equal(matches.length, 1, "inventory probe marker must be unique");
  return matches[0];
}

/**
 * Checks that a JVM counter under sustained rate limiting is a floor.
 *
 * The bridge cannot count what it never receives: rather than resume from a
 * suspend it cannot afford, it disables the breakpoint request until the budget
 * window resets, so hits inside that window are never delivered. The strict
 * upper bound is the discriminating half of this — it is what proves the
 * limiter fired at all, and it is the assertion the Node and Python agents
 * deliberately fail, because there a plain counter stays exact.
 */
async function counterFloorPhase(brokerUrl, inventoryUrl, serviceId, line) {
  const counterId = await createProbe(brokerUrl, {
    serviceId,
    type: "counter",
    file: INVENTORY_PROBE_FILE,
    line,
    hitLimit: 10_000,
    ttlSeconds: 120,
    createdBy: "e2e:jvm",
  });
  try {
    await waitArmed(brokerUrl, counterId);
    for (let index = 0; index < COUNTER_BURST; index += 1) {
      await reservePair(inventoryUrl, `floor-${String(index)}`, 1);
    }
    const total = await waitFor("a JVM counter total", 25_000, async () => {
      const events = await probeEvents(brokerUrl, counterId, "counter");
      const observed = events.reduce((sum, event) => sum + event.delta, 0);
      return observed > 0 ? observed : null;
    });
    assert.ok(
      total < COUNTER_BURST,
      `JVM counter recorded ${String(total)} of ${String(COUNTER_BURST)} hits; ` +
        "the limiter never fired, so this run says nothing about the floor",
    );
    return total;
  } finally {
    await deleteProbe(brokerUrl, counterId);
  }
}

/**
 * Checks JVM metric aggregation and log rendering below the hit budget.
 *
 * Spaced under the budget the breakpoint request is never disabled, so every
 * field is predictable from the request queries alone.
 */
async function metricAndLogPhase(brokerUrl, inventoryUrl, serviceId, line) {
  const common = {
    serviceId,
    file: INVENTORY_PROBE_FILE,
    line,
    hitLimit: 10_000,
    ttlSeconds: 120,
    createdBy: "e2e:jvm",
  };
  const metricId = await createProbe(brokerUrl, {
    ...common,
    type: "metric",
    metricPath: "requested",
  });
  const logId = await createProbe(brokerUrl, {
    ...common,
    type: "log",
    template: "reserve requested=${requested} role=${requestRole}",
    logLevel: "warn",
  });
  try {
    await waitArmed(brokerUrl, metricId);
    await waitArmed(brokerUrl, logId);
    for (const [index, quantity] of METRIC_QUANTITIES.entries()) {
      await reservePair(inventoryUrl, `metric-${String(index)}`, quantity);
      await delay(METRIC_SPACING_MS);
    }

    const metrics = await waitFor("JVM metric aggregate", 25_000, async () => {
      const events = await probeEvents(brokerUrl, metricId, "metric");
      const observed = events.reduce((count, event) => count + event.count, 0);
      return observed >= METRIC_QUANTITIES.length ? events : null;
    });
    const samples = metrics.reduce((count, event) => count + event.count, 0);
    const sum = metrics.reduce((total, event) => total + event.sum, 0);
    assert.equal(samples, METRIC_QUANTITIES.length);
    assert.equal(sum, METRIC_QUANTITIES.reduce((a, b) => a + b, 0));
    assert.equal(
      Math.min(...metrics.map((event) => event.min)),
      Math.min(...METRIC_QUANTITIES),
    );
    assert.equal(
      Math.max(...metrics.map((event) => event.max)),
      Math.max(...METRIC_QUANTITIES),
    );

    const logs = await waitFor("one JVM log event per reservation", 25_000, async () => {
      const events = await probeEvents(brokerUrl, logId, "log");
      return events.length >= METRIC_QUANTITIES.length ? events : null;
    });
    assert.deepEqual(
      logs.map((event) => event.message).sort(),
      METRIC_QUANTITIES.map(
        (quantity) => `reserve requested=${String(quantity)} role=follower`,
      ).sort(),
    );
    assert.ok(
      logs.every((event) => event.level === "warn"),
      "JVM log level did not survive the round trip",
    );
    return { samples, sum, logs: logs.length };
  } finally {
    await deleteProbe(brokerUrl, logId);
    await deleteProbe(brokerUrl, metricId);
  }
}

async function waitForExit(child) {
  const [code, signal] = await once(child.process, "exit");
  if (code !== 0) {
    throw new Error(
      `${child.label} exited with ${String(code ?? signal)}\n${child.output()}`,
    );
  }
}

const children = [];
let probeId;
let brokerUrl;

try {
  const [brokerPort, inventoryPort, jdwpPort] = await Promise.all([
    unusedPort(),
    unusedPort(),
    unusedPort(),
  ]);
  brokerUrl = `http://127.0.0.1:${String(brokerPort)}`;
  const inventoryUrl = `http://127.0.0.1:${String(inventoryPort)}`;

  children.push(
    startChild("broker", process.execPath, [brokerEntry], {
      HOST: "127.0.0.1",
      PORT: String(brokerPort),
      LIVEPROBE_STATE_FILE: "",
    }),
  );
  await waitFor("broker startup", 5_000, async () => {
    const response = await fetch(`${brokerUrl}/v1/services`);
    return response.ok ? true : null;
  });

  children.push(
    startChild(
      "inventory",
      "java",
      [
        `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${String(jdwpPort)}`,
        "-jar",
        inventoryJar,
      ],
      { BUG: "on", PORT: String(inventoryPort) },
    ),
  );
  await waitFor("inventory startup", 10_000, async () => {
    const response = await fetch(`${inventoryUrl}/health`);
    return response.ok ? true : null;
  });

  children.push(
    startChild(
      "bridge",
      "java",
      [
        "--add-modules",
        "jdk.jdi",
        "-jar",
        bridgeJar,
        "--service",
        serviceId,
        "--attach",
        `127.0.0.1:${String(jdwpPort)}`,
        "--broker",
        brokerUrl,
        "--commit",
        "abcdef1234567890",
      ],
    ),
  );
  await waitFor("JVM bridge registration", 10_000, async () => {
    const response = await requestJson(`${brokerUrl}/v1/services`);
    return response.services?.some(
      (service) =>
        service.serviceId === serviceId
        && service.sdk === "jvm"
        && service.capabilities?.includes("expression-ast-v1")
        && service.capabilities?.includes("frame-locals-v1"),
    )
      ? true
      : null;
  });

  const line = await markerLine();
  const created = await requestJson(`${brokerUrl}/v1/probes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      serviceId,
      type: "snapshot",
      file: "demo/inventory-service/src/main/java/io/liveprobe/demo/inventory/InventoryService.java",
      line,
      conditionExpression:
        'requestRole == "follower" && cachedStock > authoritativeStock',
      watchPaths: ["cachedStock", "authoritativeStock", "requested", "requestRole"],
      watchExpressions: ["cachedStock - authoritativeStock"],
      includeStackLocals: true,
      stackFrameLimit: 2,
      hitLimit: 1,
      ttlSeconds: 60,
      createdBy: "e2e:jvm",
    }),
  });
  probeId = created.probe.id;

  await waitFor("JVM probe arming", 10_000, async () => {
    const data = await requestJson(`${brokerUrl}/v1/probes/${probeId}/data`);
    return data.status?.status === "armed" ? true : null;
  });

  const statsBefore = await requestJson(`${inventoryUrl}/stats`);
  const traffic = startChild(
    "inventory traffic",
    "java",
    ["-cp", inventoryJar, "io.liveprobe.demo.inventory.TrafficGenerator"],
    {
      TARGET_URL: inventoryUrl,
      WAVES: "4",
      INTERVAL_MS: "10",
    },
  );
  children.push(traffic);
  await waitForExit(traffic);
  const statsAfter = await requestJson(`${inventoryUrl}/stats`);
  assert.ok(
    statsAfter.completedRequests > statsBefore.completedRequests,
    "reservation traffic must advance while the probe is armed",
  );
  assert.ok(
    statsAfter.workerThreadCount >= 2,
    "inventory service must use multiple request worker threads",
  );

  const snapshot = await waitFor("JVM snapshot evidence", 12_000, async () => {
    const data = await requestJson(
      `${brokerUrl}/v1/probes/${probeId}/data?waitSeconds=1`,
    );
    return data.events?.find((event) => event.type === "snapshot") ?? null;
  });
  assert.equal(snapshot.variables.t, "obj");
  const cachedStock = evidenceValue(snapshot, "cachedStock");
  const authoritativeStock = evidenceValue(snapshot, "authoritativeStock");
  const requested = evidenceValue(snapshot, "requested");
  const requestRole = evidenceValue(snapshot, "requestRole");
  assert.equal(typeof cachedStock, "number");
  assert.equal(typeof authoritativeStock, "number");
  assert.equal(typeof requested, "number");
  assert.equal(requestRole, "follower");
  assert.ok(
    cachedStock > authoritativeStock,
    "snapshot must prove cached stock is stale",
  );
  assert.ok(
    requested > authoritativeStock && requested <= cachedStock,
    "snapshot must prove the stale cache permits an invalid reservation",
  );
  assert.ok(
    watchValue(snapshot, "cachedStock - authoritativeStock") > 0,
    "expression watch must quantify the stale-cache gap",
  );
  assert.ok(
    snapshot.stack.some((frame) => frame.file.endsWith("InventoryService.java")),
    "snapshot stack should identify InventoryService.java",
  );
  assert.ok(
    snapshot.stack.every((frame) => frame.line > 0),
    "snapshot stack must contain only positive source lines",
  );
  assert.ok(
    snapshot.stack.length > 0
      && snapshot.stack.length <= 2
      && snapshot.stack.every((frame) => frame.variables),
    "requested JVM stack frames must include bounded serialized locals",
  );

  await fetch(`${brokerUrl}/v1/probes/${probeId}`, { method: "DELETE" });
  probeId = undefined;

  // The remaining phases assert totals against bursts they drive themselves, so
  // the wave traffic has to be finished and drained first.
  await drain(inventoryUrl);
  const counterFloor = await counterFloorPhase(
    brokerUrl,
    inventoryUrl,
    serviceId,
    line,
  );
  const aggregates = await metricAndLogPhase(
    brokerUrl,
    inventoryUrl,
    serviceId,
    line,
  );

  console.log(
    `JVM e2e passed: bridge attached on loopback, probe line ${String(line)}, ` +
      `stale stock ${String(cachedStock)}>${String(authoritativeStock)}, ` +
      `${String(snapshot.stack.length)} stack frame(s), traffic advanced by ` +
      `${String(statsAfter.completedRequests - statsBefore.completedRequests)}, ` +
      `counter floor ${String(counterFloor)}/${String(COUNTER_BURST)} under the ` +
      `hit budget, ${String(aggregates.samples)} metric samples summing ` +
      `${String(aggregates.sum)} and ${String(aggregates.logs)} log messages.`,
  );
} catch (error) {
  const logs = children
    .map((child) => `\n--- ${child.label} ---\n${child.output()}`)
    .join("");
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}${logs}`,
    { cause: error },
  );
} finally {
  if (probeId !== undefined && brokerUrl !== undefined) {
    await fetch(`${brokerUrl}/v1/probes/${probeId}`, { method: "DELETE" }).catch(
      () => {},
    );
  }
  for (const child of [...children].reverse()) await stopChild(child);
}
