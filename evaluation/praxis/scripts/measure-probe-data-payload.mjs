// Measure the response payload of `get_probe_data`, the largest remaining
// LiveProbe tool response after the compact investigation view landed.
//
// Tool responses are never prompt-cacheable, so every byte a tool returns is
// charged as fresh input on the turn that reads it and on every later turn that
// keeps it in context. Campaign r12 measured `get_probe_data` at 31 calls,
// 8,628 bytes mean, 267,468 total, with a 26,125-byte worst case.
//
// This script drives the real broker and the real MCP tool handler over probe
// events shaped exactly as the Python SDK emits them
// (`python/sdk/src/liveprobe/runtime.py`, the `probe.kind == "snapshot"`
// branch), then reports bytes per top-level field and per repeated element, so
// that any reduction is chosen from measurements rather than intuition.
//
// The fixture is deliberately generic: a request handler calling a client
// through a retry wrapper. It carries no incident-specific content.
//
// Usage:
//   pnpm --filter @liveprobe/broker run build
//   pnpm --filter @doomslayer2945/liveprobe-mcp run build
//   node evaluation/praxis/scripts/measure-probe-data-payload.mjs

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const { buildBroker } = await import(
  join(repoRoot, "packages/broker/dist/src/index.js")
);
// `BrokerClient.getProbeData` is the unprojected broker payload — the shape the
// tool returned before this change, and the shape the investigation paths still
// consume. `handlers.get_probe_data` is the projected tool response. Measuring
// both against one ingest gives a real before/after rather than two fixtures.
const { BrokerClient, createToolHandlers } = await import(
  join(repoRoot, "packages/mcp-server/dist/index.js")
);

const COMMIT = "a".repeat(40);
const SERVICE = "recommendation";

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * A stack as the Python SDK reports it: up to 8 frames of {fn,file,line} with
 * absolute container paths. The same probe line is reached by the same call
 * path on every hit, so this block is byte-identical across occurrences.
 */
function stack() {
  return [
    { fn: "get_product_list", file: "/usr/src/app/recommendation_server.py", line: 47 },
    { fn: "list_recommendations", file: "/usr/src/app/recommendation_server.py", line: 88 },
    { fn: "_with_retry", file: "/usr/src/app/retry.py", line: 31 },
    { fn: "_unary_response", file: "/usr/local/lib/python3.12/site-packages/grpc/_server.py", line: 542 },
    { fn: "_call_behavior", file: "/usr/local/lib/python3.12/site-packages/grpc/_server.py", line: 611 },
    { fn: "_handle_call", file: "/usr/local/lib/python3.12/site-packages/grpc/_server.py", line: 789 },
    { fn: "_serve", file: "/usr/local/lib/python3.12/site-packages/grpc/_server.py", line: 941 },
    { fn: "run", file: "/usr/local/lib/python3.12/threading.py", line: 975 },
  ];
}

function str(v) {
  return { t: "str", v };
}
function num(v) {
  return { t: "num", v };
}

/**
 * The captured frame of one hit: locals plus the requested watch paths. This is
 * the product — the runtime values the agent reasons from.
 */
function variables(index) {
  return {
    t: "obj",
    c: {
      self: { t: "obj", c: { max_responses: num(5), cache_ttl: num(30) } },
      request_product_ids: {
        t: "arr",
        c: [str("OLJCESPC7Z"), str("66VCHSJNUP"), str("1YMWWN1N4O")],
      },
      products_list: { t: "arr", c: [] },
      max_responses: num(5),
      num_products: num(0),
      num_return: num(0),
      session_id: str(`ab3f9c${String(index).padStart(4, "0")}-4d21-11ef-9c2a`),
      logger: { t: "redacted" },
      catalog_response: {
        t: "obj",
        c: { products: { t: "arr", c: [] }, status_code: num(200) },
      },
    },
  };
}

function watches(index) {
  return {
    "products_list": { t: "arr", c: [] },
    "self.max_responses": num(5),
    "catalog_response.products": { t: "arr", c: [] },
    "request_product_ids": {
      t: "arr",
      c: [str("OLJCESPC7Z"), str("66VCHSJNUP"), str("1YMWWN1N4O")],
    },
    "session_id": str(`ab3f9c${String(index).padStart(4, "0")}-4d21-11ef-9c2a`),
  };
}

function snapshotEvent(probeId, index) {
  return {
    probeId,
    type: "snapshot",
    ts: new Date(Date.UTC(2026, 6, 30, 20, 13, 37, index)).toISOString(),
    correlation: {
      traceId: `4bf92f3577b34da6a3ce929d0e0e${String(index).padStart(4, "0")}`,
      spanId: `00f067aa0ba9${String(index).padStart(4, "0")}`,
      source: "controlled-replay",
      quality: "exact-execution",
      serviceInstance: "recommendation-7d9f8c4b6d-x2ktp",
      localHitSequence: index,
    },
    variables: variables(index),
    watches: watches(index),
    capture: { watchValues: "callback-frozen", status: "complete" },
    stack: stack(),
  };
}

const broker = await buildBroker({ ttlSweepIntervalMs: 1_000 });
await broker.listen({ host: "127.0.0.1", port: 0 });
const address = broker.server.address();
const brokerUrl = `http://127.0.0.1:${address.port}`;

try {
  broker.liveprobeState.ingest({
    serviceId: SERVICE,
    sdk: "python",
    commitSha: COMMIT,
    commitSource: "env",
    agentStatus: { state: "green" },
    events: [],
  });

  const client = new BrokerClient(brokerUrl);
  const handlers = createToolHandlers(client);
  const probe = await handlers.set_snapshot_probe({
    service_id: SERVICE,
    commit_hash: COMMIT,
    file: "recommendation_server.py",
    line: 47,
    watch_paths: [
      "products_list",
      "self.max_responses",
      "catalog_response.products",
      "request_product_ids",
      "session_id",
    ],
    hit_limit: 25,
  });

  const HITS = Number(process.env["HITS"] ?? 25);
  broker.liveprobeState.ingest({
    serviceId: SERVICE,
    sdk: "python",
    commitSha: COMMIT,
    commitSource: "env",
    agentStatus: { state: "green" },
    events: Array.from({ length: HITS }, (_, index) =>
      snapshotEvent(probe.id, index),
    ),
  });

  const before = await client.getProbeData(probe.id, 0);
  const data = await handlers.get_probe_data({ probe_id: probe.id });
  const total = bytes(data);
  const baseline = bytes(before);

  console.log(
    `ingested ${HITS} captured occurrences of one snapshot probe\n` +
      `  before (unprojected broker payload): ${baseline} B, ` +
      `${before.events.length} events\n` +
      `  after  (projected tool response)   : ${total} B, ` +
      `${data.events.length} events\n` +
      `  reduction: ${baseline - total} B ` +
      `(${(((baseline - total) / baseline) * 100).toFixed(1)}%)`,
  );
  if (data.eventsOmitted !== undefined) {
    console.log(`  eventsOmitted: ${JSON.stringify(data.eventsOmitted)}`);
  }
  console.log(
    `r12 measured: 31 calls, mean 8,628 B, max 26,125 B, total 267,468 B\n`,
  );

  console.log("bytes per top-level field (after)");
  for (const [key, value] of Object.entries(data)) {
    const size = bytes(value);
    console.log(
      `  ${key.padEnd(8)} ${String(size).padStart(7)}B ` +
        `${String(Math.round((size / total) * 100)).padStart(3)}%`,
    );
  }

  const dataEvents = data.events.filter((event) => event.type !== "status");
  const beforeEvents = before.events.filter((event) => event.type !== "status");
  console.log(
    `\nbytes per snapshot event: ` +
      `${Math.round(bytes(beforeEvents) / beforeEvents.length)}B before, ` +
      `${Math.round(bytes(dataEvents) / dataEvents.length)}B after`,
  );

  console.log("\nbytes per field within one snapshot event (before), times n");
  const sample = beforeEvents[0];
  const rows = [];
  for (const [key, value] of Object.entries(sample)) {
    // Cost of the key plus its value plus the separators, as serialised.
    const size = Buffer.byteLength(JSON.stringify({ [key]: value })) - 2;
    rows.push([key, size, size * beforeEvents.length]);
  }
  rows.sort((a, b) => b[2] - a[2]);
  for (const [key, size, totalSize] of rows) {
    console.log(
      `  ${key.padEnd(12)} ${String(size).padStart(5)}B x${String(
        beforeEvents.length,
      ).padStart(3)} = ${String(totalSize).padStart(7)}B ` +
        `${String(Math.round((totalSize / baseline) * 100)).padStart(3)}% of before`,
    );
  }

  console.log("\nredundancy: fields identical across every captured event");
  const identical = [];
  for (const key of Object.keys(sample)) {
    const first = JSON.stringify(sample[key]);
    if (beforeEvents.every((event) => JSON.stringify(event[key]) === first)) {
      const size =
        Buffer.byteLength(JSON.stringify({ [key]: sample[key] })) - 2;
      identical.push([key, size, size * (beforeEvents.length - 1)]);
    }
  }
  identical.sort((a, b) => b[2] - a[2]);
  for (const [key, size, wasted] of identical) {
    console.log(
      `  ${key.padEnd(12)} ${String(size).padStart(5)}B, repeated ` +
        `${beforeEvents.length - 1} extra times = ${String(wasted).padStart(7)}B recoverable`,
    );
  }

  console.log("\nevidence retained verbatim on every returned occurrence");
  const keptSample = dataEvents[0];
  for (const key of ["correlation", "variables", "watches", "ts", "type"]) {
    console.log(
      `  ${key.padEnd(12)} ${
        keptSample[key] === undefined ? "MISSING" : "present"
      }`,
    );
  }
  const traces = new Set(
    dataEvents.map((event) => event.correlation?.traceId).filter(Boolean),
  );
  console.log(
    `  distinct correlation.traceId across returned occurrences: ${traces.size}`,
  );
} finally {
  await broker.close();
}
