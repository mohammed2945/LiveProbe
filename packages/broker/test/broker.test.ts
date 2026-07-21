import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  BrokerState,
  CreateProbeSchema,
  PostgresStore,
  buildBroker,
  type ProbeDefinition,
} from "../src/index.js";

const openBrokers: Awaited<ReturnType<typeof buildBroker>>[] = [];

afterEach(async () => {
  await Promise.all(openBrokers.splice(0).map((broker) => broker.close()));
});

function createCounter(state: BrokerState, ttlSeconds = 1_800): ProbeDefinition {
  return state.createProbe(
    CreateProbeSchema.parse({
      serviceId: "orders",
      type: "counter",
      file: "src/orders.ts",
      line: 19,
      hitLimit: 10_000,
      ttlSeconds,
      createdBy: "test",
    }),
  );
}

class EventBeforeRegistrationState extends BrokerState {
  public injected = false;

  public override waitForEvents(
    probeId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    if (!this.injected) {
      this.injected = true;
      this.ingest({
        serviceId: "orders",
        sdk: "node",
        commitSha: "abcdef1234567890",
        commitSource: "config",
        agentStatus: { state: "green" },
        events: [
          {
            probeId,
            type: "counter",
            ts: new Date().toISOString(),
            delta: 1,
          },
        ],
      });
    }
    return super.waitForEvents(probeId, timeoutMs, signal);
  }
}

describe("broker validation and storage", () => {
  it("rolls back a probe mutation when durable persistence fails", async () => {
    const broker = await buildBroker({
      store: {
        async restore() {},
        async persist() {},
        async persistProbe() {
          throw new Error("database unavailable");
        },
      },
    });
    openBrokers.push(broker);

    const created = await broker.inject({
      method: "POST",
      url: "/v1/probes",
      payload: {
        serviceId: "orders",
        type: "counter",
        file: "src/orders.ts",
        line: 12,
        createdBy: "test",
      },
    });
    expect(created.statusCode).toBe(500);
    expect(broker.liveprobeState.listProbes()).toEqual([]);
  });

  it("requires bearer auth on v1 routes when configured and leaves healthz open", async () => {
    const broker = await buildBroker({ apiKey: "fixture-key" });
    openBrokers.push(broker);

    const health = await broker.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });

    const unauthorized = await broker.inject({
      method: "GET",
      url: "/v1/ping",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toMatchObject({
      error: { code: "unauthorized" },
    });

    const authorized = await broker.inject({
      method: "GET",
      url: "/v1/ping",
      headers: { authorization: "Bearer fixture-key" },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ ok: true });
  });

  it("strictly rejects malformed requests and mismatched events", async () => {
    const broker = await buildBroker();
    openBrokers.push(broker);

    const invalidCreate = await broker.inject({
      method: "POST",
      url: "/v1/probes",
      payload: {
        serviceId: "orders",
        type: "log",
        file: "src/orders.ts",
        line: 0,
        template: "order=${order.id}",
        createdBy: "test",
        unexpected: true,
      },
    });
    expect(invalidCreate.statusCode).toBe(400);
    expect(invalidCreate.json()).toMatchObject({
      error: { code: "invalid_request" },
    });

    const malformedJson = await broker.inject({
      method: "POST",
      url: "/v1/probes",
      headers: { "content-type": "application/json" },
      payload: '{"serviceId":',
    });
    expect(malformedJson.statusCode).toBe(400);
    expect(malformedJson.json()).toMatchObject({
      error: { code: "invalid_request" },
    });

    const unknownQuery = await broker.inject({
      method: "GET",
      url: "/v1/services?unexpected=true",
    });
    expect(unknownQuery.statusCode).toBe(400);

    const created = await broker.inject({
      method: "POST",
      url: "/v1/probes",
      payload: {
        serviceId: "orders",
        type: "counter",
        file: "src/orders.ts",
        line: 19,
        createdBy: "test",
      },
    });
    const probe = created.json<{ probe: ProbeDefinition }>().probe;

    const mismatched = await broker.inject({
      method: "POST",
      url: "/v1/ingest",
      payload: {
        serviceId: "orders",
        sdk: "node",
        commitSha: "abcdef1234567890",
        commitSource: "config",
        agentStatus: { state: "green" },
        events: [
          {
            probeId: probe.id,
            type: "log",
            ts: new Date().toISOString(),
            message: "wrong event for a counter",
            level: "info",
          },
        ],
      },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({
      error: {
        code: "invalid_request",
        message: expect.stringContaining("does not match"),
      },
    });
  });

  it("normalizes and round-trips optional source commit metadata", async () => {
    const broker = await buildBroker();
    openBrokers.push(broker);
    const sourceCommit = "ABCDEF1234567890";

    const created = await broker.inject({
      method: "POST",
      url: "/v1/probes",
      payload: {
        serviceId: "orders",
        sourceCommit,
        type: "counter",
        file: "src/orders.ts",
        line: 19,
        createdBy: "test",
      },
    });
    expect(created.statusCode).toBe(201);
    const probe = created.json<{ probe: ProbeDefinition }>().probe;
    expect(probe.sourceCommit).toBe(sourceCommit.toLowerCase());

    const listed = await broker.inject({
      method: "GET",
      url: "/v1/probes?serviceId=orders",
    });
    expect(listed.json()).toMatchObject({
      probes: [
        {
          probe: {
            id: probe.id,
            sourceCommit: sourceCommit.toLowerCase(),
          },
        },
      ],
    });

    const data = await broker.inject({
      method: "GET",
      url: `/v1/probes/${probe.id}/data`,
    });
    expect(data.json()).toMatchObject({
      probe: { id: probe.id, sourceCommit: sourceCommit.toLowerCase() },
    });

    const polled = await broker.inject({
      method: "GET",
      url: "/v1/services/orders/probes?since=0",
    });
    expect(polled.json()).toMatchObject({
      probes: [{ id: probe.id, sourceCommit: sourceCommit.toLowerCase() }],
    });

    const invalid = await broker.inject({
      method: "POST",
      url: "/v1/probes",
      payload: {
        serviceId: "orders",
        sourceCommit: "not-a-git-object",
        type: "counter",
        file: "src/orders.ts",
        line: 19,
        createdBy: "test",
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("stores service commit metadata from ingest and reports honest safety", async () => {
    const broker = await buildBroker();
    openBrokers.push(broker);

    const response = await broker.inject({
      method: "POST",
      url: "/v1/ingest",
      payload: {
        serviceId: "orders",
        sdk: "node",
        commitSha: "ABCDEF1234567890",
        commitSource: "env",
        agentStatus: { state: "green", detail: "0 probes armed" },
        events: [],
      },
    });
    expect(response.statusCode).toBe(202);

    const services = await broker.inject({
      method: "GET",
      url: "/v1/services",
    });
    expect(services.json()).toMatchObject({
      services: [
        {
          serviceId: "orders",
          sdk: "node",
          commitSha: "abcdef1234567890",
          commitSource: "env",
          agentStatus: { state: "green", detail: "0 probes armed" },
        },
      ],
    });

    const safety = await broker.inject({
      method: "GET",
      url: "/v1/safety",
    });
    expect(safety.statusCode).toBe(200);
    expect(safety.json()).toMatchObject({
      services: [
        {
          serviceId: "orders",
          online: true,
          agent: { state: "green", detail: "0 probes armed" },
          probesSummary: { armed: 0, unknown: 0 },
          caveats: expect.arrayContaining([
            expect.stringContaining("agent-reported"),
          ]),
        },
      ],
    });
  });

  it("coordinates source-map upload and returns broker-resolved runtime coordinates", async () => {
    const broker = await buildBroker();
    openBrokers.push(broker);
    const created = await broker.inject({
      method: "POST",
      url: "/v1/probes",
      payload: {
        serviceId: "orders",
        type: "counter",
        file: "src/orders.ts",
        line: 2,
        createdBy: "test",
      },
    });
    const probe = created.json<{ probe: ProbeDefinition }>().probe;
    const identity = {
      serviceId: "orders",
      commitSha: "abcdef1234567890",
      uploaderId: "agent-a",
    };

    const status = await broker.inject({
      method: "POST",
      url: "/v1/source-maps/status",
      payload: identity,
    });
    expect(status.json()).toEqual({ isUploader: true, isComplete: false });
    const competing = await broker.inject({
      method: "POST",
      url: "/v1/source-maps/status",
      payload: { ...identity, uploaderId: "agent-b" },
    });
    expect(competing.json()).toEqual({ isUploader: false, isComplete: false });

    const rejectedUpload = await broker.inject({
      method: "POST",
      url: "/v1/source-maps/upload",
      payload: {
        ...identity,
        uploaderId: "agent-b",
        mapPath: "dist/orders.js.map",
        map: { version: 3, sources: ["../src/orders.ts"], names: [], mappings: ";;;AACA" },
      },
    });
    expect(rejectedUpload.statusCode).toBe(409);

    const upload = await broker.inject({
      method: "POST",
      url: "/v1/source-maps/upload",
      payload: {
        ...identity,
        mapPath: "dist/orders.js.map",
        map: {
          version: 3,
          file: "orders.js",
          sources: ["../src/orders.ts"],
          sourcesContent: ["const hidden = true;"],
          names: [],
          mappings: ";;;AACA",
        },
      },
    });
    expect(upload.statusCode).toBe(202);
    await broker.inject({
      method: "POST",
      url: "/v1/source-maps/complete",
      payload: identity,
    });

    expect(
      broker.liveprobeState.getSourceMapSet("orders", identity.commitSha)
        ?.maps[0]?.map,
    ).not.toHaveProperty("sourcesContent");
    const polled = await broker.inject({
      method: "GET",
      url:
        `/v1/services/orders/probes?since=0&commitSha=${identity.commitSha}`,
    });
    expect(polled.json()).toMatchObject({
      probes: [
        {
          id: probe.id,
          file: "src/orders.ts",
          line: 2,
          runtimeLocation: "dist/orders.js",
          runtimeLine: 4,
          runtimeColumn: 0,
        },
      ],
    });
  });

  it("resets incomplete uploads on takeover and retains five commits", () => {
    let now = Date.parse("2026-07-20T00:00:00.000Z");
    const state = new BrokerState({ clock: () => now });
    const map = {
      version: 3,
      file: "orders.js",
      sources: ["../src/orders.ts"],
      names: [],
      mappings: ";;;AACA",
    };
    state.sourceMapStatus("orders", "0000001", "agent-a");
    state.uploadSourceMap({
      serviceId: "orders",
      commitSha: "0000001",
      uploaderId: "agent-a",
      mapPath: "dist/orders.js.map",
      map,
    });
    now += 120_001;
    expect(state.sourceMapStatus("orders", "0000001", "agent-b")).toEqual({
      isUploader: true,
      isComplete: false,
    });
    expect(state.getSourceMapSet("orders", "0000001")?.maps).toEqual([]);

    for (let index = 2; index <= 7; index += 1) {
      const commitSha = index.toString(16).padStart(7, "0");
      const uploaderId = `agent-${String(index)}`;
      now += 1;
      state.sourceMapStatus("orders", commitSha, uploaderId);
      state.completeSourceMaps("orders", commitSha, uploaderId);
    }
    expect(state.getSourceMapSet("orders", "0000001")).toBeUndefined();
    expect(state.getSourceMapSet("orders", "0000007")).toMatchObject({
      complete: true,
    });
  });

  it("caps each event ring at 500 oldest-first", async () => {
    const broker = await buildBroker();
    openBrokers.push(broker);
    const probe = createCounter(broker.liveprobeState);
    const timestamp = new Date().toISOString();

    const response = await broker.inject({
      method: "POST",
      url: "/v1/ingest",
      payload: {
        serviceId: "orders",
        sdk: "node",
        commitSha: "abcdef1234567890",
        commitSource: "config",
        agentStatus: { state: "green" },
        events: Array.from({ length: 501 }, (_, index) => ({
          probeId: probe.id,
          type: "counter",
          ts: timestamp,
          delta: index + 1,
        })),
      },
    });

    expect(response.statusCode).toBe(202);
    const events = broker.liveprobeState.getEvents(probe.id);
    expect(events).toHaveLength(500);
    expect(events[0]).toMatchObject({ delta: 2 });
    expect(events[499]).toMatchObject({ delta: 501 });
  });

  it("cleans long-poll listeners on activity, timeout, abort, and disposal", async () => {
    const state = new BrokerState();
    const probe = createCounter(state);

    const activity = state.waitForEvents(probe.id, 1_000);
    expect(state.pendingLongPollCount(probe.id)).toBe(1);
    state.ingest({
      serviceId: "orders",
      sdk: "node",
      commitSha: "abcdef1234567890",
      commitSource: "config",
      agentStatus: { state: "green" },
      events: [
        {
          probeId: probe.id,
          type: "counter",
          ts: new Date().toISOString(),
          delta: 1,
        },
      ],
    });
    await expect(activity).resolves.toBe("activity");
    expect(state.pendingLongPollCount()).toBe(0);

    await expect(state.waitForEvents(probe.id, 1_000)).resolves.toBe(
      "activity",
    );
    expect(state.pendingLongPollCount()).toBe(0);

    const emptyProbe = createCounter(state);
    await expect(state.waitForEvents(emptyProbe.id, 5)).resolves.toBe("timeout");
    expect(state.pendingLongPollCount()).toBe(0);

    const abortController = new AbortController();
    const aborted = state.waitForEvents(
      emptyProbe.id,
      1_000,
      abortController.signal,
    );
    abortController.abort();
    await expect(aborted).resolves.toBe("aborted");
    expect(state.pendingLongPollCount()).toBe(0);

    const disposed = state.waitForEvents(emptyProbe.id, 1_000);
    state.dispose();
    await expect(disposed).resolves.toBe("aborted");
    expect(state.pendingLongPollCount()).toBe(0);
  });
});

describe("poll and long-poll edge cases", () => {
  it("returns the active set when an HTTP poll cursor is ahead", async () => {
    const state = new BrokerState();
    const probe = createCounter(state);
    const broker = await buildBroker({ state });
    openBrokers.push(broker);

    const current = await broker.inject({
      method: "GET",
      url: `/v1/services/orders/probes?since=${probe.version}`,
    });
    expect(current.json()).toEqual({
      version: probe.version,
      unchanged: true,
    });

    const ahead = await broker.inject({
      method: "GET",
      url: `/v1/services/orders/probes?since=${probe.version + 100}`,
    });
    expect(ahead.statusCode).toBe(200);
    expect(ahead.json()).toMatchObject({
      version: probe.version,
      probes: [{ id: probe.id }],
    });
  });

  it("does not miss an event arriving before listener registration", async () => {
    const state = new EventBeforeRegistrationState();
    const probe = createCounter(state);
    const broker = await buildBroker({ state });
    openBrokers.push(broker);

    const startedAt = Date.now();
    const response = await broker.inject({
      method: "GET",
      url: `/v1/probes/${probe.id}/data?waitSeconds=2`,
    });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(state.injected).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      events: [{ probeId: probe.id, type: "counter", delta: 1 }],
    });
    expect(state.pendingLongPollCount()).toBe(0);
  });
});

describe("TTL and configurable persistence", () => {
  it("expires probes once, advances version, and appends one status event", async () => {
    let now = Date.parse("2026-07-19T18:30:00.000Z");
    const state = new BrokerState({ clock: () => now });
    const probe = createCounter(state, 1);

    expect(state.pollProbes("orders", 0)).toMatchObject({
      version: 1,
      probes: [{ id: probe.id }],
    });
    const expiryWait = state.waitForEvents(probe.id, 1_000);
    expect(state.pendingLongPollCount(probe.id)).toBe(1);
    now += 1_001;
    expect(state.expireDueProbes()).toBe(1);
    await expect(expiryWait).resolves.toBe("activity");
    expect(state.expireDueProbes()).toBe(0);
    expect(state.pollProbes("orders", 1)).toEqual({
      version: 2,
      probes: [],
    });
    expect(state.getStatus(probe.id)).toMatchObject({ status: "expired" });
    expect(state.getEvents(probe.id)).toEqual([
      {
        probeId: probe.id,
        type: "status",
        ts: "2026-07-19T18:30:01.001Z",
        status: "expired",
      },
    ]);
    expect(state.pendingLongPollCount()).toBe(0);
  });

  it("writes and restores an explicitly configured snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liveprobe-broker-"));
    const path = join(directory, "state.json");
    try {
      const first = await buildBroker({
        persistence: { path, intervalMs: 60_000 },
      });
      openBrokers.push(first);
      const created = await first.inject({
        method: "POST",
        url: "/v1/probes",
        payload: {
          serviceId: "orders",
          sourceCommit: "ABCDEF1234567890",
          type: "metric",
          file: "src/orders.ts",
          line: 20,
          metricPath: "order.total",
          createdBy: "test",
        },
      });
      expect(created.statusCode).toBe(201);
      const sourceMapIdentity = {
        serviceId: "orders",
        commitSha: "abcdef1234567890",
        uploaderId: "json-agent",
      };
      await first.inject({
        method: "POST",
        url: "/v1/source-maps/status",
        payload: sourceMapIdentity,
      });
      await first.inject({
        method: "POST",
        url: "/v1/source-maps/upload",
        payload: {
          ...sourceMapIdentity,
          mapPath: "dist/orders.js.map",
          map: {
            version: 3,
            file: "orders.js",
            sources: ["../src/orders.ts"],
            names: [],
            mappings: ";;;AACA",
          },
        },
      });
      await first.inject({
        method: "POST",
        url: "/v1/source-maps/complete",
        payload: sourceMapIdentity,
      });
      await first.close();
      openBrokers.splice(openBrokers.indexOf(first), 1);

      const restored = await buildBroker({
        persistence: { path, intervalMs: 60_000 },
      });
      openBrokers.push(restored);
      const listed = await restored.inject({
        method: "GET",
        url: "/v1/probes?serviceId=orders",
      });
      expect(listed.json()).toMatchObject({
        probes: [
          {
            probe: {
              sourceCommit: "abcdef1234567890",
            },
          },
        ],
      });
      expect(
        restored.liveprobeState.getSourceMapSet(
          sourceMapIdentity.serviceId,
          sourceMapIdentity.commitSha,
        ),
      ).toMatchObject({
        complete: true,
        maps: [{ mapPath: "dist/orders.js.map" }],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const postgresIt =
  process.env["TEST_DATABASE_URL"] === undefined ? it.skip : it;

describe("Postgres persistence", () => {
  postgresIt("restores normalized broker state after restart", async () => {
    const databaseUrl = process.env["TEST_DATABASE_URL"] as string;
    const cleanup = new Client({ connectionString: databaseUrl });
    await cleanup.connect();
    await cleanup.query(`
      drop table if exists source_maps, source_map_sets, probe_events,
        probe_statuses, probes, services,
        service_versions, liveprobe_schema_migrations, broker_snapshots cascade
    `);
    await cleanup.end();

    const first = await buildBroker({
      store: new PostgresStore(databaseUrl),
      persistence: false,
    });
    openBrokers.push(first);
    const created = await first.inject({
      method: "POST",
      url: "/v1/probes",
      payload: {
        serviceId: "orders",
        sourceCommit: "abcdef1234567890",
        type: "counter",
        file: "src/orders.ts",
        line: 19,
        createdBy: "postgres-test",
      },
    });
    const probe = created.json<{ probe: ProbeDefinition }>().probe;
    const eventTimestamp = new Date().toISOString();
    const ingested = await first.inject({
      method: "POST",
      url: "/v1/ingest",
      payload: {
        serviceId: "orders",
        sdk: "node",
        commitSha: "abcdef1234567890",
        commitSource: "config",
        agentStatus: { state: "green", detail: "1 probe armed" },
        events: [
          {
            probeId: probe.id,
            type: "status",
            ts: eventTimestamp,
            status: "armed",
          },
        ],
      },
    });
    expect(ingested.statusCode).toBe(202);
    const sourceMapIdentity = {
      serviceId: "orders",
      commitSha: "abcdef1234567890",
      uploaderId: "postgres-agent",
    };
    await first.inject({
      method: "POST",
      url: "/v1/source-maps/status",
      payload: sourceMapIdentity,
    });
    await first.inject({
      method: "POST",
      url: "/v1/source-maps/upload",
      payload: {
        ...sourceMapIdentity,
        mapPath: "dist/orders.js.map",
        map: {
          version: 3,
          file: "orders.js",
          sources: ["../src/orders.ts"],
          names: [],
          mappings: ";;;AACA",
        },
      },
    });
    await first.inject({
      method: "POST",
      url: "/v1/source-maps/complete",
      payload: sourceMapIdentity,
    });
    await first.close();
    openBrokers.splice(openBrokers.indexOf(first), 1);

    const restored = await buildBroker({
      store: new PostgresStore(databaseUrl),
      persistence: false,
    });
    openBrokers.push(restored);
    expect(restored.liveprobeState.listServices()).toMatchObject([
      {
        serviceId: "orders",
        sdk: "node",
        commitSha: "abcdef1234567890",
        agentStatus: { state: "green", detail: "1 probe armed" },
      },
    ]);
    expect(restored.liveprobeState.getProbe(probe.id)).toMatchObject({
      id: probe.id,
      sourceCommit: "abcdef1234567890",
    });
    expect(restored.liveprobeState.getStatus(probe.id)).toMatchObject({
      status: "armed",
    });
    expect(restored.liveprobeState.getEvents(probe.id)).toEqual([
      {
        probeId: probe.id,
        type: "status",
        ts: eventTimestamp,
        status: "armed",
      },
    ]);
    expect(
      restored.liveprobeState.getSourceMapSet("orders", "abcdef1234567890"),
    ).toMatchObject({
      complete: true,
      maps: [{ mapPath: "dist/orders.js.map" }],
    });

    const inspection = new Client({ connectionString: databaseUrl });
    await inspection.connect();
    const tables = await inspection.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[])
       order by table_name`,
      [[
        "probe_events",
        "probe_statuses",
        "probes",
        "service_versions",
        "services",
        "source_map_sets",
        "source_maps",
      ]],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "probe_events",
      "probe_statuses",
      "probes",
      "service_versions",
      "services",
      "source_map_sets",
      "source_maps",
    ]);
    const eventCount = await inspection.query<{ count: string }>(
      "select count(*) from probe_events where probe_id = $1",
      [probe.id],
    );
    expect(eventCount.rows[0]?.count).toBe("1");
    await inspection.end();
  });
});
