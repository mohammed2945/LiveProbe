import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { type Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface ManagedChild {
  label: string;
  process: ChildProcessByStdio<null, Readable, Readable>;
  output(): string;
}

interface StatsResponse {
  counters: {
    requests: number;
    inFlight: number;
  };
  pool: {
    active: number;
    capacity: number;
  };
}

interface CounterEvent {
  type: "counter";
  delta: number;
}

interface LogEvent {
  type: "log";
  message: string;
  level: string;
}

interface MetricEvent {
  type: "metric";
  count: number;
  sum: number;
  min: number;
  max: number;
}

/**
 * Driven back to back over loopback this lands far above the 10 hits/second
 * budget, which is the point: the counter must stay exact anyway.
 */
const COUNTER_BURST = 50;
/**
 * Spaced under the budget so no capture is dropped and every metric field is
 * predictable from the request bodies alone.
 */
const METRIC_AMOUNTS = [1_000, 2_000, 3_000, 4_000, 5_000];
const METRIC_SPACING_MS = 150;

type SanitizedNode =
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "null"; v: null }
  | { t: "obj"; c: Record<string, SanitizedNode> }
  | { t: "arr"; c: SanitizedNode[] }
  | { t: string; v?: unknown };

interface SnapshotEvent {
  type: "snapshot";
  variables: SanitizedNode;
  watches: Record<string, SanitizedNode>;
  stack: Array<{
    fn: string;
    file: string;
    line: number;
    variables?: SanitizedNode;
  }>;
}

interface ProbeDataResponse {
  events: Array<
    SnapshotEvent | { type: string; [key: string]: unknown }
  >;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(packageRoot, "../..");

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const selectedPort = address.port;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolvePromise();
      } else {
        reject(error);
      }
    });
  });
  return selectedPort;
}

function startChild(
  label: string,
  script: string,
  environment: NodeJS.ProcessEnv,
): ManagedChild {
  const child = spawn(
    process.execPath,
    ["--enable-source-maps", script],
    {
      cwd: packageRoot,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const collect = (chunk: Buffer): void => {
    output = `${output}${chunk.toString("utf8")}`.slice(-200_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return {
    label,
    process: child,
    output: () => output,
  };
}

async function stopChild(child: ManagedChild): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) {
    return;
  }
  child.process.kill("SIGTERM");
  await Promise.race([once(child.process, "exit"), delay(3_000)]);
  if (child.process.exitCode === null && child.process.signalCode === null) {
    child.process.kill("SIGKILL");
    await once(child.process, "exit");
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} returned ${String(response.status)}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function waitFor<T>(
  description: string,
  timeoutMs: number,
  operation: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== null) {
        return value;
      }
    } catch (error: unknown) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${description}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}

function objectChild(node: SanitizedNode, key: string): SanitizedNode {
  assert.equal(node.t, "obj", `expected an object while resolving ${key}`);
  assert.ok("c" in node && !Array.isArray(node.c));
  const child = node.c[key];
  assert.ok(child !== undefined, `missing sanitized key ${key}`);
  return child;
}

async function createProbe(
  brokerUrl: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const created = await requestJson<{ probe: { id: string } }>(
    `${brokerUrl}/v1/probes`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return created.probe.id;
}

async function deleteProbe(brokerUrl: string, probeId: string): Promise<void> {
  await fetch(`${brokerUrl}/v1/probes/${probeId}`, { method: "DELETE" }).catch(
    () => undefined,
  );
}

async function probeEvents<T>(
  brokerUrl: string,
  probeId: string,
  type: string,
): Promise<T[]> {
  const data = await requestJson<ProbeDataResponse & {
    status?: { status?: string };
  }>(`${brokerUrl}/v1/probes/${probeId}/data`);
  return data.events.filter((event) => event.type === type) as T[];
}

/**
 * Counters arrive pre-aggregated, one event per flush, so the running total is
 * the sum of every delta rather than the value of the newest event.
 */
async function counterTotal(
  brokerUrl: string,
  probeId: string,
): Promise<number> {
  const events = await probeEvents<CounterEvent>(brokerUrl, probeId, "counter");
  return events.reduce((total, event) => total + event.delta, 0);
}

async function waitArmed(brokerUrl: string, probeId: string): Promise<void> {
  await waitFor(`probe ${probeId} to arm`, 10_000, async () => {
    const data = await requestJson<{ status?: { status?: string } }>(
      `${brokerUrl}/v1/probes/${probeId}/data`,
    );
    return data.status?.status === "armed" ? true : null;
  });
}

/**
 * Waits for in-flight requests to finish so a burst count is unambiguous.
 *
 * The traffic generator is stopped before this runs, but requests it already
 * issued can still be completing, and every later phase compares a probe total
 * against a burst size it drove itself.
 */
async function drain(serviceUrl: string): Promise<number> {
  let previous = -1;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const stats = await requestJson<StatsResponse>(`${serviceUrl}/stats`);
    if (stats.counters.inFlight === 0 && stats.counters.requests === previous) {
      return stats.counters.requests;
    }
    previous = stats.counters.requests;
    await delay(100);
  }
  throw new Error("timed out waiting for in-flight payments to drain");
}

/**
 * Drives payments one at a time so the hit count equals the request count.
 *
 * Each request uses a fresh user id: balances are per user and every payment
 * debits, so reusing one id would eventually fail for insufficient funds and
 * change which branch the probe line sits on.
 */
async function burst(
  serviceUrl: string,
  amounts: number[],
  label: string,
  spacingMs = 0,
): Promise<void> {
  for (const [index, amountCents] of amounts.entries()) {
    const response = await fetch(`${serviceUrl}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user: { id: `${label}-${String(index)}`, tier: "premium" },
        amountCents,
      }),
    });
    assert.equal(
      response.status,
      201,
      `burst payment ${String(index)} returned ${String(response.status)}`,
    );
    await response.arrayBuffer();
    if (spacingMs > 0) await delay(spacingMs);
  }
}

async function findProbeLine(
  sourcePaymentsPath: string,
  marker = "LIVEPROBE_SNAPSHOT_TARGET",
): Promise<number> {
  const lines = (await readFile(sourcePaymentsPath, "utf8")).split(/\r?\n/u);
  const matches = lines
    .map((line, index) => (line.includes(marker) ? index + 1 : null))
    .filter((line): line is number => line !== null);
  assert.deepEqual(matches.length, 1, `${marker} must occur exactly once`);
  return matches[0] as number;
}

interface PhaseContext {
  brokerUrl: string;
  serviceUrl: string;
  serviceId: string;
  service: ManagedChild;
  /** The one line every probe in these phases sits on. */
  line: number;
}

/** Counts the agent's reports of a batch the broker refused. */
function rejectionLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .filter((line) => line.includes("BROKER ERROR") && line.includes("400"));
}

/**
 * Proves the hit budget bounds capture cost rather than counting.
 *
 * A counter and a log probe share one line. The burst runs far above the
 * budget, so the log probe — which has to capture to render its message — must
 * lose hits, while the counter, which reads nothing, must record every one.
 * Asserting the counter alone would pass even with no limiter running, so the
 * dropped captures are what give the exact total its meaning.
 */
async function counterExactnessPhase(
  phase: PhaseContext,
): Promise<{ counterTotal: number; logCaptures: number }> {
  const common = {
    serviceId: phase.serviceId,
    file: "src/payments.ts",
    line: phase.line,
    ttlSeconds: 120,
    createdBy: "e2e:payment-service",
  };
  const counterId = await createProbe(phase.brokerUrl, {
    ...common,
    type: "counter",
    hitLimit: 10_000,
  });
  const logId = await createProbe(phase.brokerUrl, {
    ...common,
    type: "log",
    template: "paying ${amountCents}",
    hitLimit: 10_000,
  });
  try {
    await waitArmed(phase.brokerUrl, counterId);
    await waitArmed(phase.brokerUrl, logId);
    await burst(
      phase.serviceUrl,
      Array.from({ length: COUNTER_BURST }, () => 2_500),
      "counter-burst",
    );

    // Waiting for "at least" and then asserting equality reports an overcount
    // as a failed assertion rather than as a timeout.
    const total = await waitFor("counter total to reach the burst size", 20_000, async () => {
      const observed = await counterTotal(phase.brokerUrl, counterId);
      return observed >= COUNTER_BURST ? observed : null;
    });
    assert.equal(
      total,
      COUNTER_BURST,
      `counter recorded ${String(total)} hits for ${String(COUNTER_BURST)} requests`,
    );

    const logs = await probeEvents<LogEvent>(phase.brokerUrl, logId, "log");
    assert.ok(logs.length > 0, "log probe on the same line captured nothing");
    assert.ok(
      logs.length < COUNTER_BURST,
      "the hit budget dropped no captures, so the exact counter total does " +
        "not demonstrate anything about rate limiting",
    );
    assert.ok(
      logs.some((event) => event.message === "paying 2500"),
      `log template did not render live locals: ${JSON.stringify(logs.slice(0, 3))}`,
    );
    return { counterTotal: total, logCaptures: logs.length };
  } finally {
    await deleteProbe(phase.brokerUrl, logId);
    await deleteProbe(phase.brokerUrl, counterId);
  }
}

/**
 * Checks metric aggregation and log rendering below the hit budget.
 *
 * Spacing the requests under the budget keeps the limiter out of the picture,
 * so every field is predictable from the request bodies alone.
 */
async function metricAndLogPhase(
  phase: PhaseContext,
): Promise<{ samples: number; sum: number; logs: number }> {
  const common = {
    serviceId: phase.serviceId,
    file: "src/payments.ts",
    line: phase.line,
    ttlSeconds: 120,
    createdBy: "e2e:payment-service",
  };
  const metricId = await createProbe(phase.brokerUrl, {
    ...common,
    type: "metric",
    metricPath: "amountCents",
    hitLimit: 10_000,
  });
  const logId = await createProbe(phase.brokerUrl, {
    ...common,
    type: "log",
    template: "payment amount=${amountCents}",
    logLevel: "warn",
    hitLimit: 10_000,
  });
  try {
    await waitArmed(phase.brokerUrl, metricId);
    await waitArmed(phase.brokerUrl, logId);
    await burst(
      phase.serviceUrl,
      METRIC_AMOUNTS,
      "metric-burst",
      METRIC_SPACING_MS,
    );

    const metrics = await waitFor("metric aggregate to cover the burst", 20_000, async () => {
      const events = await probeEvents<MetricEvent>(
        phase.brokerUrl,
        metricId,
        "metric",
      );
      const observed = events.reduce((count, event) => count + event.count, 0);
      return observed >= METRIC_AMOUNTS.length ? events : null;
    });
    const samples = metrics.reduce((count, event) => count + event.count, 0);
    const sum = metrics.reduce((total, event) => total + event.sum, 0);
    assert.equal(samples, METRIC_AMOUNTS.length);
    assert.equal(sum, METRIC_AMOUNTS.reduce((a, b) => a + b, 0));
    assert.equal(Math.min(...metrics.map((event) => event.min)), Math.min(...METRIC_AMOUNTS));
    assert.equal(Math.max(...metrics.map((event) => event.max)), Math.max(...METRIC_AMOUNTS));

    const logs = await waitFor("one log event per request", 20_000, async () => {
      const events = await probeEvents<LogEvent>(phase.brokerUrl, logId, "log");
      return events.length >= METRIC_AMOUNTS.length ? events : null;
    });
    assert.deepEqual(
      logs.map((event) => event.message).sort(),
      METRIC_AMOUNTS.map((amount) => `payment amount=${String(amount)}`).sort(),
    );
    assert.ok(
      logs.every((event) => event.level === "warn"),
      "log level did not survive the round trip",
    );
    return { samples, sum, logs: logs.length };
  } finally {
    await deleteProbe(phase.brokerUrl, logId);
    await deleteProbe(phase.brokerUrl, metricId);
  }
}

/**
 * Runs a fixed over-budget burst against N log probes on one line.
 *
 * Returns the smallest number of captures any single probe managed, which is
 * the quantity the per-capture budget is supposed to leave unchanged as N grows.
 */
async function captureCount(
  phase: PhaseContext,
  probeCount: number,
): Promise<number> {
  const probeIds: string[] = [];
  for (let index = 0; index < probeCount; index += 1) {
    probeIds.push(
      await createProbe(phase.brokerUrl, {
        serviceId: phase.serviceId,
        file: "src/payments.ts",
        line: phase.line,
        ttlSeconds: 120,
        createdBy: "e2e:payment-service",
        type: "log",
        template: `capture ${String(index)} \${amountCents}`,
        hitLimit: 10_000,
      }),
    );
  }
  try {
    for (const probeId of probeIds) await waitArmed(phase.brokerUrl, probeId);
    // Let the bucket refill to capacity so both measurements start level.
    await delay(1_500);
    await burst(
      phase.serviceUrl,
      Array.from({ length: COUNTER_BURST }, () => 2_500),
      `capture-${String(probeCount)}`,
    );
    // The agent flushes every two seconds; this is more than one flush of slack.
    await delay(3_000);
    const counts = await Promise.all(
      probeIds.map(async (probeId) =>
        (await probeEvents<LogEvent>(phase.brokerUrl, probeId, "log")).length,
      ),
    );
    return Math.min(...counts);
  } finally {
    for (const probeId of probeIds) await deleteProbe(phase.brokerUrl, probeId);
  }
}

/**
 * Proves the budget is charged per pause rather than per probe.
 *
 * One paused event reads the frame once and shares it with every probe on the
 * line, so three probes should each capture about as often as one probe does.
 * Charging per probe instead would drain the bucket three times as fast and
 * leave each probe with roughly a third. The threshold sits halfway between
 * those outcomes because this is a timing measurement, not an exact one.
 */
async function perCaptureBudgetPhase(
  phase: PhaseContext,
): Promise<{ alone: number; together: number }> {
  const alone = await captureCount(phase, 1);
  assert.ok(alone > 0, "a single log probe captured nothing");
  const together = await captureCount(phase, 3);
  assert.ok(
    together * 2 > alone,
    `each of three probes on one line captured ${String(together)} hits ` +
      `against ${String(alone)} for a probe on its own, which is the share a ` +
      "per-probe budget would produce",
  );
  return { alone, together };
}

/**
 * Proves one rejected event no longer discards the batch around it.
 *
 * Deleting a probe the agent has already armed is the realistic way a flush
 * turns poisonous: the agent keeps emitting until its next poll, and the broker
 * refuses any event naming a probe it no longer knows. Validation covers the
 * whole request body, so that single stale event returns HTTP 400 for the
 * entire batch without saying which event was at fault. The counter sharing the
 * line has to survive it.
 */
async function ingestIsolationPhase(
  phase: PhaseContext,
): Promise<{ counterTotal: number; rejection: string }> {
  const common = {
    serviceId: phase.serviceId,
    file: "src/payments.ts",
    line: phase.line,
    ttlSeconds: 120,
    createdBy: "e2e:payment-service",
  };
  const counterId = await createProbe(phase.brokerUrl, {
    ...common,
    type: "counter",
    hitLimit: 10_000,
  });
  const poisonId = await createProbe(phase.brokerUrl, {
    ...common,
    type: "log",
    template: "stale ${amountCents}",
    // One hit, so the flush carries a single stale event. Isolation is
    // deliberately bounded at a handful of splits per flush, and a batch that
    // is mostly poison exhausts that budget and takes valid events down with
    // it — the documented trade-off, not the behaviour under test here.
    hitLimit: 1,
  });
  try {
    await waitArmed(phase.brokerUrl, counterId);
    await waitArmed(phase.brokerUrl, poisonId);
    const before = rejectionLines(phase.service.output()).length;
    // Delete, then burst without pausing: the agent polls once a second, so the
    // opening requests still emit for a probe the broker has already forgotten,
    // and those events sit in the same buffer as the counter aggregate.
    await deleteProbe(phase.brokerUrl, poisonId);
    await burst(
      phase.serviceUrl,
      Array.from({ length: COUNTER_BURST }, () => 2_500),
      "isolation-burst",
    );

    const rejection = await waitFor(
      "the broker to refuse the batch carrying the stale event",
      20_000,
      async () => {
        const lines = rejectionLines(phase.service.output());
        return lines.length > before ? (lines.at(-1) ?? null) : null;
      },
    );

    const total = await waitFor(
      "counter total to survive the rejected batch",
      25_000,
      async () => {
        const observed = await counterTotal(phase.brokerUrl, counterId);
        return observed >= COUNTER_BURST ? observed : null;
      },
    );
    assert.equal(
      total,
      COUNTER_BURST,
      `counter recorded ${String(total)} hits for ${String(COUNTER_BURST)} ` +
        "requests flushed alongside a rejected event",
    );
    return { counterTotal: total, rejection: rejection.trim() };
  } finally {
    await deleteProbe(phase.brokerUrl, counterId);
  }
}

test(
  "snapshot probe captures the seeded pool bug without stopping traffic",
  { timeout: 35_000 },
  async (context) => {
    const brokerPort = await unusedPort();
    const servicePort = await unusedPort();
    const brokerUrl = `http://127.0.0.1:${String(brokerPort)}`;
    const serviceUrl = `http://127.0.0.1:${String(servicePort)}`;
    const serviceId = `payment-service-e2e-${String(process.pid)}`;
    const children: ManagedChild[] = [];

    try {
      const broker = startChild(
        "broker",
        resolve(repositoryRoot, "packages/broker/dist/src/index.js"),
        {
          HOST: "127.0.0.1",
          PORT: String(brokerPort),
          LIVEPROBE_STATE_FILE: "",
        },
      );
      children.push(broker);
      await waitFor("broker startup", 5_000, async () => {
        const response = await fetch(`${brokerUrl}/v1/services`);
        return response.ok ? true : null;
      });

      const service = startChild(
        "service",
        resolve(packageRoot, "dist/src/server.js"),
        {
          BUG: "on",
          BROKER_URL: brokerUrl,
          HOST: "127.0.0.1",
          NODE_ENV: "test",
          PORT: String(servicePort),
          SERVICE_ID: serviceId,
          LIVEPROBE_COMMIT_SHA: "abcdef1234567890",
          LIVEPROBE_SOURCE_MAP_DIR: resolve(packageRoot, "dist"),
          LIVEPROBE_DIST_LOCATION: "dist",
        },
      );
      children.push(service);
      await waitFor("payment service startup", 7_000, async () => {
        const response = await fetch(`${serviceUrl}/health`);
        return response.ok ? true : null;
      });
      await waitFor("Node SDK capability heartbeat", 7_000, async () => {
        const response = await requestJson<{
          services: Array<{
            serviceId: string;
            capabilities?: string[];
          }>;
        }>(`${brokerUrl}/v1/services`);
        const registered = response.services.find(
          (candidate) => candidate.serviceId === serviceId,
        );
        return registered?.capabilities?.includes("expression-ast-v1") === true &&
          registered.capabilities.includes("frame-locals-v1")
          ? true
          : null;
      });

      const traffic = startChild(
        "traffic",
        resolve(packageRoot, "dist/src/traffic.js"),
        {
          TARGET_URL: serviceUrl,
          TRAFFIC_INTERVAL_MS: "60",
          TRAFFIC_REQUESTS: "0",
        },
      );
      children.push(traffic);

      await waitFor("mixed-tier traffic", 4_000, async () => {
        const stats = await requestJson<StatsResponse>(`${serviceUrl}/stats`);
        return stats.counters.requests >= 4 ? stats : null;
      });
      const beforeProbe = await requestJson<StatsResponse>(`${serviceUrl}/stats`);
      assert.equal(beforeProbe.pool.capacity, 5);

      const sourcePaymentsPath = resolve(packageRoot, "src/payments.ts");
      const probeLine = await findProbeLine(sourcePaymentsPath);
      const created = await requestJson<{ probe: { id: string } }>(
        `${brokerUrl}/v1/probes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            serviceId,
            type: "snapshot",
            file: "src/payments.ts",
            line: probeLine,
            conditionExpression:
              'user.tier == "free" && pool.active >= 5',
            watchPaths: ["balance", "pool.active"],
            watchExpressions: ["amountCents / 100"],
            includeStackLocals: true,
            stackFrameLimit: 2,
            hitLimit: 1,
            ttlSeconds: 60,
            createdBy: "e2e:payment-service",
          }),
        },
      );

      const snapshot = await waitFor("snapshot evidence within 15 seconds", 15_000, async () => {
        const data = await requestJson<ProbeDataResponse>(
          `${brokerUrl}/v1/probes/${created.probe.id}/data?waitSeconds=1`,
        );
        return (
          data.events.find(
            (event): event is SnapshotEvent => event.type === "snapshot",
          ) ?? null
        );
      });

      assert.deepEqual(snapshot.watches["balance"], { t: "null", v: null });
      assert.deepEqual(snapshot.watches["pool.active"], { t: "num", v: 5 });
      assert.deepEqual(snapshot.watches["amountCents / 100"], {
        t: "num",
        v: 25,
      });
      assert.ok(snapshot.stack.length > 0 && snapshot.stack.length <= 2);
      assert.ok(
        snapshot.stack.every((frame) => frame.variables !== undefined),
        "requested stack frames must include serialized locals",
      );

      const balance = objectChild(snapshot.variables, "balance");
      const pool = objectChild(snapshot.variables, "pool");
      const active = objectChild(pool, "active");
      const user = objectChild(snapshot.variables, "user");
      const tier = objectChild(user, "tier");
      assert.deepEqual(balance, { t: "null", v: null });
      assert.deepEqual(active, { t: "num", v: 5 });
      assert.deepEqual(tier, { t: "str", v: "free" });

      const afterHit = await requestJson<StatsResponse>(`${serviceUrl}/stats`);
      assert.ok(
        afterHit.counters.requests > beforeProbe.counters.requests,
        `request counter did not advance across probe hit: ` +
          `${String(beforeProbe.counters.requests)} -> ${String(afterHit.counters.requests)}`,
      );

      const afterContinuedTraffic = await waitFor(
        "requests continuing after the probe hit",
        3_000,
        async () => {
          const stats = await requestJson<StatsResponse>(`${serviceUrl}/stats`);
          return stats.counters.requests > afterHit.counters.requests ? stats : null;
        },
      );
      assert.ok(afterContinuedTraffic.counters.requests > afterHit.counters.requests);
      assert.equal(service.process.exitCode, null);

      const trafficLines = traffic
        .output()
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("[traffic] request="));
      assert.ok(trafficLines.length >= 4, "traffic generator must log every request");

      await fetch(`${brokerUrl}/v1/probes/${created.probe.id}`, {
        method: "DELETE",
      });
      context.diagnostic(
        `snapshot line=${String(probeLine)} requests=${String(
          beforeProbe.counters.requests,
        )}->${String(afterHit.counters.requests)}->${String(
          afterContinuedTraffic.counters.requests,
        )}`,
      );

      // The remaining phases assert exact totals against bursts they drive
      // themselves, so the background traffic has to stop and its in-flight
      // payments have to land first.
      await stopChild(traffic);
      children.splice(children.indexOf(traffic), 1);
      await drain(serviceUrl);

      const phase: PhaseContext = {
        brokerUrl,
        serviceUrl,
        serviceId,
        service,
        line: probeLine,
      };
      const counters = await counterExactnessPhase(phase);
      context.diagnostic(
        `counter exactness: ${String(counters.counterTotal)} counted, ` +
          `${String(counters.logCaptures)} captured of ${String(COUNTER_BURST)}`,
      );
      const metrics = await metricAndLogPhase(phase);
      context.diagnostic(
        `metric: ${String(metrics.samples)} samples summing ${String(metrics.sum)}`,
      );
      context.diagnostic(`log: ${String(metrics.logs)} rendered messages`);
      const budget = await perCaptureBudgetPhase(phase);
      context.diagnostic(
        `per-capture budget: 1 probe captured ${String(budget.alone)}, ` +
          `3 probes captured at least ${String(budget.together)} each`,
      );
      const isolation = await ingestIsolationPhase(phase);
      context.diagnostic(
        `ingest isolation: ${String(isolation.counterTotal)} counted through ` +
          `"${isolation.rejection}"`,
      );
    } catch (error: unknown) {
      const logs = children
        .map((child) => `\n--- ${child.label} ---\n${child.output()}`)
        .join("");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${logs}`,
        { cause: error },
      );
    } finally {
      for (const child of [...children].reverse()) {
        await stopChild(child);
      }
    }
  },
);
