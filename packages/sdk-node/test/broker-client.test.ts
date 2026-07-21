import { describe, expect, it } from "vitest";

import { BrokerClient, BrokerIngestError } from "../src/broker-client.js";
import type { AgentEvent, ProbeDefinition } from "../src/types.js";

const probe: ProbeDefinition = {
  id: "prb_1",
  serviceId: "payments/api",
  sourceCommit: "abcdef1234567890",
  type: "snapshot",
  file: "src/payments.js",
  line: 34,
  watchPaths: ["user.tier"],
  hitLimit: 1,
  ttlSeconds: 1800,
  version: 2,
  createdBy: "mcp:test",
};

describe("BrokerClient", () => {
  it("uses the documented poll URL and parses complete snapshots", async () => {
    let requested = "";
    const client = new BrokerClient("http://broker:7070", {
      fetch: (async (input: URL) => {
        requested = input.toString();
        return new Response(JSON.stringify({ version: 2, probes: [probe] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as never,
    });

    await expect(client.poll("payments/api", 1)).resolves.toEqual({
      version: 2,
      probes: [probe],
    });
    expect(requested).toBe("http://broker:7070/v1/services/payments%2Fapi/probes?since=1");
  });

  it("requests commit-specific runtime coordinates and validates them", async () => {
    let requested = "";
    const runtimeProbe = {
      ...probe,
      runtimeLocation: "dist/payments.js",
      runtimeLine: 71,
      runtimeColumn: 4,
    };
    const client = new BrokerClient("http://broker:7070", {
      fetch: (async (input: URL) => {
        requested = input.toString();
        return new Response(JSON.stringify({ version: 2, probes: [runtimeProbe] }));
      }) as never,
    });

    await expect(
      client.poll("payments/api", 1, "abcdef1234567890"),
    ).resolves.toEqual({ version: 2, probes: [runtimeProbe] });
    expect(requested).toBe(
      "http://broker:7070/v1/services/payments%2Fapi/probes?since=1&commitSha=abcdef1234567890",
    );
  });

  it("performs the source-map upload handshake", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = new BrokerClient("http://broker:7070", {
      fetch: (async (input: URL, init: { body: string }) => {
        requests.push({ url: input.toString(), body: JSON.parse(init.body) });
        if (input.pathname.endsWith("/status")) {
          return new Response(
            JSON.stringify({ isUploader: true, isComplete: false }),
          );
        }
        return new Response(null, { status: 202 });
      }) as never,
    });
    const identity = {
      serviceId: "payments",
      commitSha: "abcdef1234567890",
      uploaderId: "agent-a",
    };

    await expect(client.sourceMapStatus(identity)).resolves.toEqual({
      isUploader: true,
      isComplete: false,
    });
    await client.uploadSourceMap({
      ...identity,
      mapPath: "dist/payments.js.map",
      map: { version: 3, sources: [], names: [], mappings: "" },
    });
    await client.completeSourceMaps(identity);

    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/v1/source-maps/status",
      "/v1/source-maps/upload",
      "/v1/source-maps/complete",
    ]);
    expect(requests[1]?.body).toMatchObject({
      mapPath: "dist/payments.js.map",
      commitSha: identity.commitSha,
    });
  });

  it("sends the exact ingest envelope", async () => {
    let body: unknown;
    let method = "";
    const client = new BrokerClient("https://broker.example/base", {
      fetch: (async (_input: URL, init: { body: string; method: string }) => {
        method = init.method;
        body = JSON.parse(init.body);
        return new Response(null, { status: 202 });
      }) as never,
    });
    const events: AgentEvent[] = [
      {
        probeId: "prb_1",
        type: "counter",
        ts: "2026-07-19T18:30:02.000Z",
        delta: 4,
      },
    ];

    await client.ingest(
      "payments",
      "abcdef1234567890",
      "config",
      { state: "green", detail: "1 probe armed" },
      events,
    );

    expect(method).toBe("POST");
    expect(body).toEqual({
      serviceId: "payments",
      sdk: "node",
      commitSha: "abcdef1234567890",
      commitSource: "config",
      agentStatus: { state: "green", detail: "1 probe armed" },
      events,
    });
  });

  it("exposes rejected ingest status for retry classification", async () => {
    const client = new BrokerClient("http://broker:7070", {
      fetch: (async () => new Response(null, { status: 400 })) as never,
    });

    await expect(
      client.ingest(
        "payments",
        "abcdef1234567890",
        "config",
        { state: "green", detail: "0 probes armed" },
        [],
      ),
    ).rejects.toMatchObject<BrokerIngestError>({
      name: "BrokerIngestError",
      statusCode: 400,
    });
  });

  it("sends bearer authorization when configured", async () => {
    let authorization = "";
    const client = new BrokerClient("http://broker:7070", {
      apiKey: "test-key",
      fetch: (async (_input: URL, init: { headers: Record<string, string> }) => {
        authorization = init.headers.authorization;
        return new Response(JSON.stringify({ version: 0, unchanged: true }), {
          status: 200,
        });
      }) as never,
    });

    await client.poll("payments", 0);

    expect(authorization).toBe("Bearer test-key");
  });

  it("rejects malformed definitions instead of installing them", async () => {
    const client = new BrokerClient("http://broker", {
      fetch: (async () =>
        new Response(JSON.stringify({ version: 1, probes: [{ id: "bad" }] }), {
          status: 200,
        })) as never,
    });

    await expect(client.poll("payments", 0)).rejects.toThrow("invalid probe definition");
  });

  it("rejects non-http broker URLs", () => {
    expect(() => new BrokerClient("file:///tmp/broker")).toThrow("http or https");
  });
});
