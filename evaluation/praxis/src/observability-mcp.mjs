#!/usr/bin/env node

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import process from "node:process";

import {
  EvidenceStore,
  EvaluationLedger,
  readJson,
  sha256,
} from "./core.mjs";

const windowSchema = {
  type: "object",
  additionalProperties: false,
  required: ["start", "end"],
  properties: {
    start: {
      type: "string",
      description: "Inclusive ISO-8601 start inside the snapshot window, for example 2026-07-28T18:00:00.000Z.",
    },
    end: {
      type: "string",
      description: "Inclusive ISO-8601 end inside the snapshot window, for example 2026-07-28T18:10:00.000Z.",
    },
  },
};

const paging = {
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 200,
    description: "Maximum items in this page, for example 50.",
  },
  cursor: {
    type: "string",
    description: "Opaque next_cursor returned by the same tool and snapshot revision.",
  },
};

const OBSERVABILITY_TOOL_DEFINITIONS = [
  {
    name: "get_incident_bootstrap",
    description:
      "Returns the immutable incident detection envelope: alerts, fixed time window, and up to three failing trace summaries. incident_id must match the loaded snapshot. Returns evidence IDs and the snapshot revision.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        incident_id: {
          type: "string",
          description: "Incident ID supplied by the evaluation task, for example 401.",
        },
      },
    },
  },
  {
    name: "search_logs",
    description:
      "Searches log records in the immutable snapshot for one exact service. Optional trace, severity, text, and time filters are combined. Returns a paginated list with evidence IDs; an invalid or stale cursor is rejected.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["service"],
      properties: {
        service: {
          type: "string",
          description: "Exact service name from traces or topology, for example recommendation.",
        },
        window: windowSchema,
        trace_id: {
          type: "string",
          description: "Exact trace_id from bootstrap, search_traces, or get_trace.",
        },
        severity: {
          type: "string",
          description: "Exact case-insensitive severity, for example ERROR.",
        },
        query: {
          type: "string",
          description: "Case-insensitive substring matched against message and attributes.",
        },
        ...paging,
      },
    },
  },
  {
    name: "search_traces",
    description:
      "Searches complete distributed traces in the immutable snapshot by optional service, operation, status, and time window. Returns paginated trace records and evidence IDs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        service: {
          type: "string",
          description: "Exact service name, for example recommendation.",
        },
        operation: {
          type: "string",
          description: "Exact span operation, for example ListRecommendations.",
        },
        status: {
          type: "string",
          description: "Exact case-insensitive trace status, for example ERROR.",
        },
        window: windowSchema,
        ...paging,
      },
    },
  },
  {
    name: "get_trace",
    description:
      "Returns one complete distributed trace and its spans from the immutable snapshot. trace_id must come from bootstrap or search_traces; an unknown ID is rejected.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["trace_id"],
      properties: {
        trace_id: {
          type: "string",
          description: "Exact trace identity, for example 4c010000000000000000000000000001.",
        },
      },
    },
  },
  {
    name: "query_metrics",
    description:
      "Returns recorded points for one exact service and metric name within the immutable time window. Results preserve units, timestamps, evidence IDs, and pagination metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["service", "metric_or_preset"],
      properties: {
        service: {
          type: "string",
          description: "Exact service name, for example recommendation.",
        },
        metric_or_preset: {
          type: "string",
          description: "Exact metric name exposed by the snapshot, for example request_error_rate.",
        },
        window: windowSchema,
        step: {
          type: "string",
          description: "Requested display step such as 30s; stored fixture points are not interpolated.",
        },
        ...paging,
      },
    },
  },
  {
    name: "get_kubernetes_events",
    description:
      "Returns Kubernetes events for an exact namespace, optionally filtered by kind, name, and snapshot time window. Results include evidence IDs and pagination metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["namespace"],
      properties: {
        namespace: {
          type: "string",
          description: "Exact Kubernetes namespace, for example otel-demo.",
        },
        kind: {
          type: "string",
          description: "Exact resource kind, for example ConfigMap.",
        },
        name: {
          type: "string",
          description: "Exact resource name, for example flagd-config.",
        },
        window: windowSchema,
        ...paging,
      },
    },
  },
  {
    name: "get_resource_state",
    description:
      "Returns the captured state of one Kubernetes resource. namespace, kind, and name must exactly identify a resource in the snapshot; unknown resources are rejected.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["namespace", "kind", "name"],
      properties: {
        namespace: { type: "string", description: "For example otel-demo." },
        kind: { type: "string", description: "For example Deployment." },
        name: { type: "string", description: "For example recommendation." },
      },
    },
  },
  {
    name: "get_deployment_history",
    description:
      "Returns deployment revisions recorded for one exact service in the immutable time window. Each change includes its evidence ID, time, revision, and bounded summary.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["service"],
      properties: {
        service: {
          type: "string",
          description: "Exact service name, for example recommendation.",
        },
        window: windowSchema,
        ...paging,
      },
    },
  },
  {
    name: "get_service_topology",
    description:
      "Returns the captured service/resource topology, or a bounded neighborhood around one exact node. depth is 0 through 5. Topology edges are structural evidence and carry no runtime execution claim.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        service: {
          type: "string",
          description: "Optional exact topology node ID, for example recommendation.",
        },
        depth: {
          type: "integer",
          minimum: 0,
          maximum: 5,
          description: "Neighborhood expansion depth, for example 1.",
        },
      },
    },
  },
  {
    name: "replay_incident",
    description:
      "Prepares or executes a pre-registered incident replay and returns its replay and trace correlation identities. For runtime probing, first set prepare_only=true, arm probes with the returned trace_id, then call again with that exact prepared_replay_id. With neither optional field, the replay executes immediately. incident_id and recipe_id must come from the task or loaded snapshot; arbitrary commands are never accepted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["incident_id", "recipe_id"],
      properties: {
        incident_id: {
          type: "string",
          description: "Exact loaded incident ID, for example 401.",
        },
        recipe_id: {
          type: "string",
          description:
            "Pre-registered recipe ID, for example astronomy-recommendations.",
        },
        prepare_only: {
          type: "boolean",
          description:
            "Set true to reserve a fresh replay_id and trace_id without executing the request, so probes can be armed first.",
        },
        prepared_replay_id: {
          type: "string",
          description:
            "Exact replay_id returned by an earlier prepare_only=true call. Executes that one-shot prepared replay with its reserved trace_id.",
        },
      },
    },
  },
];

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const OBSERVABILITY_TOOLS = OBSERVABILITY_TOOL_DEFINITIONS.map(
  (tool) => ({
    ...tool,
    annotations:
      tool.name === "replay_incident"
        ? {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
          }
        : readOnlyAnnotations,
  }),
);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--snapshot") result.snapshot = argv[++index];
    else if (argument === "--ledger") result.ledger = argv[++index];
    else if (argument === "--arm") result.arm = argv[++index];
    else if (argument === "--run-id") result.runId = argv[++index];
    else if (argument === "--seed") result.seed = Number(argv[++index]);
    else if (argument === "--model") result.model = argv[++index];
    else if (argument === "--enable-live-replay") {
      result.enableLiveReplay = true;
    }
    else if (argument === "--help" || argument === "-h") result.help = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  return result;
}

function formatHelp() {
  return `Usage: node observability-mcp.mjs --snapshot FILE [options]

Options:
  --ledger FILE   Append evaluation tool-call records as JSONL
  --arm NAME      Arm name recorded in the ledger
  --run-id ID     Evaluation run identity
  --seed NUMBER   Evaluation seed
  --model NAME    Decision model identity
  --enable-live-replay
                   Execute only the pre-registered replay recipe
  -h, --help      Show this help`;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function createObservabilityServer(options) {
  const snapshot = await readJson(resolve(options.snapshot));
  const ledger = new EvaluationLedger({
    run_id: options.runId ?? "standalone-observability",
    arm: options.arm ?? "unknown",
    incident_id: snapshot.incident_id,
    seed: Number.isFinite(options.seed) ? options.seed : 0,
    model: options.model ?? "none",
    path: options.ledger === undefined ? undefined : resolve(options.ledger),
  });
  return {
    store: new EvidenceStore(snapshot, {
      ledger,
      replayExecutor: options.enableLiveReplay
        ? async ({ recipe, replayId, traceId }) => {
            if (
              typeof recipe.base_url !== "string" ||
              typeof recipe.path !== "string" ||
              !["GET", "POST"].includes(recipe.method)
            ) {
              throw new Error(
                "live replay recipe must contain base_url, path, and GET or POST method",
              );
            }
            const base = new URL(recipe.base_url);
            if (!["http:", "https:"].includes(base.protocol)) {
              throw new Error("live replay base_url must use HTTP or HTTPS");
            }
            const url = new URL(recipe.path, base);
            const spanId = sha256(`${replayId}:span`).slice(0, 16);
            const response = await fetch(url, {
              method: recipe.method,
              headers: {
                "content-type": "application/json",
                "x-liveprobe-replay-id": replayId,
                "x-trace-id": traceId,
                traceparent: `00-${traceId}-${spanId}-01`,
              },
              body:
                recipe.method === "POST"
                  ? JSON.stringify(recipe.body ?? {})
                  : undefined,
              signal: AbortSignal.timeout(30_000),
            });
            const body = await response.text();
            return {
              synthetic: false,
              status: response.ok ? "completed" : "http_error",
              http_status: response.status,
              response_body: body.slice(0, 2_000),
            };
          }
        : undefined,
    }),
    ledger,
  };
}

export async function runProtocol(options) {
  const { store } = await createObservabilityServer(options);
  const toolsByName = new Map(OBSERVABILITY_TOOLS.map((tool) => [tool.name, tool]));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (line.trim() === "") continue;
    let request;
    try {
      request = JSON.parse(line);
      if (request.method === "notifications/initialized") continue;
      if (request.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: "liveprobe-praxis-observability",
              version: "1.0.0",
            },
            instructions:
              "Read-only access to one immutable incident snapshot. Tool results identify their snapshot revision and evidence IDs.",
          },
        });
      } else if (request.method === "ping") {
        send({ jsonrpc: "2.0", id: request.id, result: {} });
      } else if (request.method === "tools/list") {
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: OBSERVABILITY_TOOLS },
        });
      } else if (request.method === "tools/call") {
        const name = request.params?.name;
        if (!toolsByName.has(name)) throw new Error(`unknown tool ${name}`);
        const result = await store.call(name, request.params?.arguments ?? {});
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result),
              },
            ],
            structuredContent: result,
            isError: false,
          },
        });
      } else {
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `method not found: ${request.method}` },
        });
      }
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: request?.id ?? null,
        result:
          request?.method === "tools/call"
            ? {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      code: "invalid_request",
                      message: error.message,
                      recovery:
                        "Correct the rejected field using values from the loaded snapshot or repeat without a stale cursor.",
                    }),
                  },
                ],
                isError: true,
              }
            : undefined,
        error:
          request?.method === "tools/call"
            ? undefined
            : { code: -32602, message: error.message },
      });
    }
  }
}

const executed = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (executed) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${formatHelp()}\n`);
  } else if (options.snapshot === undefined) {
    process.stderr.write("observability-mcp: --snapshot is required\n");
    process.exitCode = 2;
  } else {
    runProtocol(options).catch((error) => {
      process.stderr.write(`observability-mcp: ${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
  }
}

export const OBSERVABILITY_TOOL_SCHEMA_SHA256 = sha256(OBSERVABILITY_TOOLS);
