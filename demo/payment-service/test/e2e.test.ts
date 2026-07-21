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
  };
  pool: {
    active: number;
    capacity: number;
  };
}

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

async function findProbeLine(sourcePaymentsPath: string): Promise<number> {
  const lines = (await readFile(sourcePaymentsPath, "utf8")).split(/\r?\n/u);
  const matches = lines
    .map((line, index) => (line.includes("LIVEPROBE_SNAPSHOT_TARGET") ? index + 1 : null))
    .filter((line): line is number => line !== null);
  assert.deepEqual(matches.length, 1, "source probe marker must occur exactly once");
  return matches[0] as number;
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
            condition: {
              path: "user.tier",
              op: "eq",
              value: "free",
            },
            watchPaths: ["balance", "pool.active"],
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
