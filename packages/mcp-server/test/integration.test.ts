import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildBroker,
  type ProbeEvent,
} from "../../broker/src/index.js";
import { FakeAgent } from "../../broker/src/fake-agent.js";
import {
  type AnalyzerClient,
  AnalyzerClientError,
  type AnalyzerPlan,
  BrokerClient,
  createMcpServer,
  createToolHandlers,
  GetProbeDataInputSchema,
} from "../src/index.js";

const openBrokers: Awaited<ReturnType<typeof buildBroker>>[] = [];
const DEPLOYED_COMMIT = "ABCDEF1234567890";
const NORMALIZED_COMMIT = DEPLOYED_COMMIT.toLowerCase();

afterEach(async () => {
  await Promise.all(openBrokers.splice(0).map((broker) => broker.close()));
});

async function startBroker(apiKey?: string): Promise<{
  broker: Awaited<ReturnType<typeof buildBroker>>;
  brokerUrl: string;
}> {
  const broker = await buildBroker({
    ttlSweepIntervalMs: 25,
    ...(apiKey === undefined ? {} : { apiKey }),
  });
  openBrokers.push(broker);
  await broker.listen({ host: "127.0.0.1", port: 0 });
  const address = broker.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected broker to listen on a TCP port");
  }
  return {
    broker,
    brokerUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before timeout");
    }
    await delay(5);
  }
}

function dataEvents(events: Record<string, unknown>[]): ProbeEvent[] {
  return events.filter(
    (event) => event["type"] !== "status",
  ) as ProbeEvent[];
}

/**
 * The captured occurrences of a projected `get_probe_data` response. Unlike
 * `dataEvents` this keeps the open record type, because a projected event drops
 * `probeId` and carries `stackId` and so is deliberately not a broker
 * `ProbeEvent`.
 */
function capturedEvents(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return events.filter((event) => event["type"] !== "status");
}

const ANALYSIS_PLAN_ID = `inv_${"1".repeat(24)}`;
const CANDIDATE_A = `cand_${"a".repeat(24)}`;
const CANDIDATE_B = `cand_${"b".repeat(24)}`;
const INVESTIGATION_ID = `inv_${"2".repeat(24)}`;
const INVESTIGATION_SITE = `cand_${"c".repeat(24)}`;

function analysisPlan(): AnalyzerPlan {
  return {
    plan_id: ANALYSIS_PLAN_ID,
    criterion: {
      repository_root: "/repo",
      commit: NORMALIZED_COMMIT,
      service_id: "payments",
      file: "services/payments/app.py",
      line: 64,
      watch_path: "fare_inputs.per_mile_rate",
      probe_budget: 5,
      source_roots: [],
    },
    slice_node_ids: ["pricing", "payments"],
    slice_edges: [],
    hammocks: [],
    frontier: [
      {
        candidate_id: CANDIDATE_A,
        function_id: "pricing.refresh",
        hammock_id: "hmk_pricing",
        file: "services/pricing/app.py",
        line: 97,
        watch_paths: ["per_mile_rate"],
        distance_from_sink: 4,
        upstream_weight: 2,
        reason: "durable dependency cut",
        certainty: "MAY",
      },
      {
        candidate_id: CANDIDATE_B,
        function_id: "payments.capture",
        hammock_id: "hmk_payments",
        file: "services/payments/app.py",
        line: 64,
        watch_paths: ["fare_inputs.per_mile_rate"],
        distance_from_sink: 1,
        upstream_weight: 1,
        reason: "balanced upstream cut",
        certainty: "MUST",
      },
    ],
    coverage_notes: [],
    round: 1,
    status: "ACTIVE",
    stats: { sliceNodes: 2, elapsedMs: 1 },
  };
}

function investigationView() {
  return {
    investigation_id: INVESTIGATION_ID,
    revision: 1,
    criterion: {
      repository_root: "/repo",
      commit: NORMALIZED_COMMIT,
      service_id: "payments",
      file: "services/payments/app.py",
      line: 64,
      symptom: "fare is non-numeric",
      watch_path: "amount",
      expression: null,
      failure_class: "type_shape",
      expected_type: "numeric",
      probe_budget: 5,
      source_roots: [],
    },
    phase: "AWAITING_EVIDENCE",
    status: "ACTIVE",
    round: 1,
    graph: { nodes: [], edges: [], unresolvedBranches: 1 },
    probe_bundle: {
      bundle_id: `bnd_${"d".repeat(24)}`,
      round: 1,
      sites: [
        {
          site_id: INVESTIGATION_SITE,
          node_id: "payments:amount",
          function_id: "payments.capture",
          file: "services/payments/app.py",
          line: 64,
          watch_paths: ["amount"],
          reason: "manifestation operand",
          certainty: "MUST",
          service_id: "payments",
          traversal_ids: [`trv_${"a".repeat(24)}`],
        },
      ],
      reason: "initial cut",
    },
    value_dossiers: [],
    judgments: [],
    actions: [],
    mechanism_context: null,
    candidate_mechanism: null,
    decision_context: {},
    decision_aliases: {
      actions: {},
      statements: {},
      traversals: {},
      probes: {},
    },
    coverage_notes: [],
    decision_log: [],
    stats: { packetBytes: 1000 },
  };
}

/**
 * Byte ceilings for the compact investigation view.
 *
 * A tool response is never prompt-cacheable, so its bytes are charged as fresh
 * input on the turn that reads it and on every later turn that keeps it in
 * context. Campaign r12 measured `start_probe_investigation` at 30,989 bytes
 * per call and `collect_investigation_evidence` at 43,917 — together 86% of the
 * graph arm's LiveProbe payload. Driving the real Python analyzer over an
 * ordinary three-module service
 * (`evaluation/praxis/scripts/measure-investigation-payload.mjs`) reproduced
 * that scale and attributed it: `graph` was 89.6% of a 41,426-byte start view
 * and 79.9% of a 46,432-byte post-evidence view, with `graph.projections` alone
 * roughly two thirds of the whole response. Dropping `graph` took those views
 * to 4,699 and 9,705 bytes.
 *
 * The ceilings are measured on the wire, the same basis as the campaign
 * ledger's `response_bytes`. The fixture below is built to that measured scale:
 * its full view is over 30 KB and its compact decision surface, at 11.8 KB, is
 * slightly larger than the largest compact view the real analyzer produced
 * (9.7 KB), so the ceilings already absorb an investigation with more dossiers,
 * more legal actions and a longer decision log than either measurement showed.
 * The fixture's compact responses land at 13.4 KB on the wire, leaving roughly
 * 20% headroom, while any regression that puts the graph — or anything else
 * that scales with analysis depth rather than with decision complexity — back
 * into a default response is several times over the limit.
 */
const COMPACT_START_CEILING_BYTES = 16_000;
const COMPACT_COLLECT_CEILING_BYTES = 18_000;

/**
 * Byte ceiling for `get_probe_data`, the largest remaining LiveProbe payload
 * once the compact investigation view landed: campaign r12 measured 31 calls at
 * 8,628 bytes mean, 26,125 bytes worst case, 267,468 bytes total.
 *
 * Driving the real broker and the real handler over Python-SDK-shaped snapshot
 * events (`evaluation/praxis/scripts/measure-probe-data-payload.mjs`) attributed
 * that cost: at 25 captured occurrences the unprojected payload is 49,525 bytes,
 * of which `stack` is 36%, `capture` 3% and the per-event `probeId` echo 2% —
 * all three byte-identical on every occurrence. Deduplicating stacks, dropping
 * the probeId echo and dropping a `capture` block that reports no truncation
 * takes the same 25 occurrences to 30,233 bytes, a 39.0% reduction with every
 * captured value and every correlation identity returned verbatim.
 *
 * The fixture below is built to that measured scale. The ceiling is measured on
 * the wire, the same basis as the campaign ledger's `response_bytes`.
 */
const PROBE_DATA_CEILING_BYTES = 34_000;

/**
 * One captured occurrence shaped exactly as the Python SDK emits it — see the
 * `probe.kind == "snapshot"` branch of `python/sdk/src/liveprobe/runtime.py`.
 * `stackDepth` varies the call path so a test can prove that genuinely
 * different stacks are preserved rather than collapsed.
 */
function snapshotFixture(
  probeId: string,
  index: number,
  options: { traceId?: string; stackDepth?: number } = {},
): Record<string, unknown> {
  const frames = [
    { fn: "get_product_list", file: "/usr/src/app/recommendation_server.py", line: 47 },
    { fn: "list_recommendations", file: "/usr/src/app/recommendation_server.py", line: 88 },
    { fn: "_with_retry", file: "/usr/src/app/retry.py", line: 31 },
    { fn: "_unary_response", file: "/usr/local/lib/python3.12/site-packages/grpc/_server.py", line: 542 },
    { fn: "_call_behavior", file: "/usr/local/lib/python3.12/site-packages/grpc/_server.py", line: 611 },
    { fn: "_handle_call", file: "/usr/local/lib/python3.12/site-packages/grpc/_server.py", line: 789 },
    { fn: "_serve", file: "/usr/local/lib/python3.12/site-packages/grpc/_server.py", line: 941 },
    { fn: "run", file: "/usr/local/lib/python3.12/threading.py", line: 975 },
  ];
  const productIds = {
    t: "arr" as const,
    c: [
      { t: "str" as const, v: "OLJCESPC7Z" },
      { t: "str" as const, v: "66VCHSJNUP" },
      { t: "str" as const, v: "1YMWWN1N4O" },
    ],
  };
  const sessionId = `ab3f9c${String(index).padStart(4, "0")}-4d21-11ef-9c2a`;
  return {
    probeId,
    type: "snapshot",
    ts: new Date(Date.UTC(2026, 6, 30, 20, 13, 37, index)).toISOString(),
    correlation: {
      traceId:
        options.traceId ??
        `4bf92f3577b34da6a3ce929d0e0e${String(index).padStart(4, "0")}`,
      spanId: `00f067aa0ba9${String(index).padStart(4, "0")}`,
      source: "controlled-replay",
      quality: "exact-execution",
      serviceInstance: "recommendation-7d9f8c4b6d-x2ktp",
      localHitSequence: index,
    },
    variables: {
      t: "obj",
      c: {
        self: {
          t: "obj",
          c: {
            max_responses: { t: "num", v: 5 },
            cache_ttl: { t: "num", v: 30 },
          },
        },
        request_product_ids: productIds,
        products_list: { t: "arr", c: [] },
        max_responses: { t: "num", v: 5 },
        num_products: { t: "num", v: 0 },
        num_return: { t: "num", v: 0 },
        session_id: { t: "str", v: sessionId },
        logger: { t: "redacted" },
        catalog_response: {
          t: "obj",
          c: {
            products: { t: "arr", c: [] },
            status_code: { t: "num", v: 200 },
          },
        },
      },
    },
    watches: {
      products_list: { t: "arr", c: [] },
      "self.max_responses": { t: "num", v: 5 },
      "catalog_response.products": { t: "arr", c: [] },
      request_product_ids: productIds,
      session_id: { t: "str", v: sessionId },
    },
    capture: { watchValues: "callback-frozen", status: "complete" },
    stack: frames.slice(0, options.stackDepth ?? frames.length),
  };
}

function repeatId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(24, "0")}`;
}

/**
 * The bytes an MCP client actually receives for one tool call — the same basis
 * as the campaign ledger's `response_bytes`
 * (`evaluation/praxis/src/mcp-filter-proxy.mjs`), so a ceiling here is directly
 * comparable to the numbers the campaign reports.
 */
function wireBytes(result: unknown): number {
  return Buffer.byteLength(JSON.stringify(result));
}

function toolPayload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: unknown }).content as
    | Array<{ type: string; text?: string }>
    | undefined;
  const text = content?.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error("tool result carried no text");
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * An investigation view at the scale the real analyzer produces: a focused
 * graph of 60 nodes with edges and three region projections, beside a decision
 * surface of legal actions, probe sites, typed dossiers, judgments, mechanism
 * anchors and a bounded decision packet.
 */
function largeInvestigationView(): Record<string, unknown> {
  const nodes = Array.from({ length: 60 }, (_, index) => ({
    node_id: `svc:services/recommend/app.py:${100 + index}`,
    file: "services/recommend/app.py",
    line: 100 + index,
    end_line: 100 + index,
    kind: index % 3 === 0 ? "assign" : index % 3 === 1 ? "call" : "branch",
    function_id: `services/recommend/app.py:handler_${index % 9}`,
    defs: [`local_${index}`, `local_${index}.value`],
    uses: [`local_${index - 1}`, `config.threshold_${index % 5}`],
    synthetic: false,
    distance: index % 11,
  }));
  const edges = Array.from({ length: 120 }, (_, index) => ({
    source: nodes[index % nodes.length]?.node_id,
    target: nodes[(index + 7) % nodes.length]?.node_id,
    kind: index % 2 === 0 ? "reaching-definition" : "control",
    variable_paths: [`local_${index % 17}`, `config.threshold_${index % 5}`],
  }));
  const regions = (kind: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      region_id: `${kind}_region_${index}`,
      kind,
      label: `${kind} region ${index} over services/recommend/app.py`,
      member_node_ids: nodes
        .slice(index * 3, index * 3 + 6)
        .map((node) => node.node_id),
      member_function_ids: [`services/recommend/app.py:handler_${index % 9}`],
      input_paths: [`config.threshold_${index % 5}`, `local_${index}`],
      output_paths: [`local_${index + 1}`, `result_${index}`],
      control_paths: [`flag_${index % 4}`],
    }));
  const projection = (kind: string, count: number) => ({
    regions: regions(kind, count),
    edges: Array.from({ length: count }, (_, index) => ({
      source_region_id: `${kind}_region_${index}`,
      target_region_id: `${kind}_region_${(index + 1) % count}`,
      edge_kinds: ["value"],
      variable_paths: [`local_${index}`, `config.threshold_${index % 5}`],
    })),
  });
  return {
    investigation_id: INVESTIGATION_ID,
    revision: 4,
    criterion: {
      repository_root: "/repo",
      commit: NORMALIZED_COMMIT,
      service_id: "recommend",
      file: "services/recommend/app.py",
      line: 24,
      symptom: "response_ids is empty for a session that should return results",
      watch_path: "response_ids",
      expression: null,
      failure_class: "semantic",
      expected_type: null,
      probe_budget: 5,
      source_roots: ["services"],
    },
    phase: "DECIDING",
    status: "ACTIVE",
    round: 2,
    graph: {
      nodes,
      edges,
      collapsedFunctions: Array.from({ length: 12 }, (_, index) => ({
        function_id: `services/recommend/app.py:handler_${index}`,
        qualifiedName: `RecommendationHandler.handler_${index}`,
        file: "services/recommend/app.py",
        line: 100 + index * 4,
        dependencies: [
          {
            output_path: `result_${index}`,
            input_paths: [`local_${index}`, `config.threshold_${index % 5}`],
          },
        ],
      })),
      projections: {
        boundary: projection("boundary", 6),
        function: projection("function", 12),
        segment: projection("segment", 18),
      },
      runtimeTraversalVersion: 1,
      runtimeTraversals: Array.from({ length: 8 }, (_, index) => ({
        traversal_id: repeatId("trv", index),
        function_id: `services/recommend/app.py:handler_${index}`,
        service_id: "recommend",
        depth: index,
        tracked_paths: [`local_${index}`, `result_${index}`],
        parent_traversal_ids: index === 0 ? [] : [repeatId("trv", index - 1)],
        anchors: [nodes[index]?.node_id],
      })),
      runtimeTraversalSummary: { total: 14, returned: 8 },
      manifestationTraversalId: repeatId("trv", 0),
      unresolvedBranches: 5,
    },
    probe_bundle: {
      bundle_id: `bnd_${"d".repeat(24)}`,
      round: 2,
      sites: Array.from({ length: 3 }, (_, index) => ({
        site_id: repeatId("cand", index),
        node_id: nodes[index]?.node_id,
        function_id: `services/recommend/app.py:handler_${index}`,
        file: "services/recommend/app.py",
        line: 100 + index,
        watch_paths: [`local_${index}`, `result_${index}`],
        reason: "region output port on the selected causal path",
        certainty: "MUST",
        service_id: "recommend",
        traversal_ids: [repeatId("trv", index)],
        path_node_ids: [],
      })),
      reason: "frontier cut for round 2",
    },
    value_dossiers: Array.from({ length: 4 }, (_, index) => ({
      dossier_id: repeatId("dos", index),
      evidence_ref: repeatId("obs", index),
      occurrence_id: "trace:replay-42",
      site_id: repeatId("cand", index % 3),
      service_id: "recommend",
      location: `services/recommend/app.py:${100 + index}`,
      watch_path: `local_${index}`,
      value: { t: "seq", v: [] },
      interpretation: index % 2 === 0 ? "VIOLATES" : "UNKNOWN",
      static_certainty: "MUST",
    })),
    judgments: Array.from({ length: 3 }, (_, index) => ({
      judgment_id: repeatId("jdg", index),
      dossier_id: repeatId("dos", index),
      classification: "VIOLATES",
      rule: "domain_range",
      detail: "observed empty sequence where a non-empty sequence is required",
    })),
    actions: Array.from({ length: 4 }, (_, index) => ({
      action_id: repeatId("act", index),
      kind: index === 0 ? "PROBE_REGION" : "FOLLOW_PATH",
      label: `follow value into handler_${index}`,
      reason: "unique reaching definition for the tracked path",
      function_id: `services/recommend/app.py:handler_${index}`,
      anchor_node_id: nodes[index]?.node_id,
      tracked_paths: [`local_${index}`, `result_${index}`],
      boundary_kind: null,
      estimated_nodes: 6 + index,
      source_traversal_id: repeatId("trv", index % 8),
      target_service_id: "recommend",
      region_id: `segment_region_${index}`,
      dependency_role: "VALUE_PRODUCER",
    })),
    mechanism_context: {
      statements: Array.from({ length: 3 }, (_, index) => ({
        node_id: nodes[index]?.node_id,
        file: "services/recommend/app.py",
        line: 100 + index,
        kind: "assign",
        source: `local_${index} = compute(config.threshold_${index})`,
        defs: [`local_${index}`],
        uses: [`config.threshold_${index}`],
      })),
      traversalIds: [repeatId("trv", 0), repeatId("trv", 1)],
      probeCandidates: Array.from({ length: 3 }, (_, index) => ({
        site_id: repeatId("cand", index),
        file: "services/recommend/app.py",
        line: 100 + index,
        watch_paths: [`local_${index}`],
      })),
      evidenceRefs: [repeatId("obs", 0)],
    },
    candidate_mechanism: null,
    decision_context: {
      protocol: "liveprobe-adaptive-v2",
      rev: 4,
      incident: {
        symptom:
          "response_ids is empty for a session that should return results",
        class: "semantic",
      },
      phase: "DECIDING",
      focus: {
        regions: Array.from({ length: 4 }, (_, index) => ({
          id: `r${index + 1}`,
          kind: "segment",
          label: `segment region ${index}`,
          in: [`config.threshold_${index % 5}`],
          out: [`local_${index}`],
          control: [`flag_${index % 4}`],
        })),
        edges: Array.from({ length: 4 }, (_, index) => ({
          from: `r${(index % 4) + 1}`,
          to: `r${((index + 1) % 4) + 1}`,
          kind: ["value"],
          path: [`local_${index}`],
        })),
      },
      traversals: Array.from({ length: 3 }, (_, index) => ({
        id: `t${index + 1}`,
        function: `RecommendationHandler.handler_${index}`,
        service: "recommend",
        depth: index,
        paths: [`local_${index}`],
      })),
      evidence: Array.from({ length: 4 }, (_, index) => ({
        at: `services/recommend/app.py:${100 + index}`,
        svc: "recommend",
        path: `local_${index}`,
        value: { t: "seq", v: [] },
        state: index % 2 === 0 ? "VIOLATES" : "UNKNOWN",
        certainty: "MUST",
      })),
      actions: Array.from({ length: 4 }, (_, index) => ({
        id: `a${index + 1}`,
        kind: index === 0 ? "PROBE_REGION" : "FOLLOW_PATH",
        label: `follow value into handler_${index}`,
        role: "VALUE_PRODUCER",
        service: "recommend",
        paths: [`local_${index}`],
      })),
      deferred: { count: 5, byKind: { FOLLOW_PATH: 5 } },
    },
    decision_aliases: {
      actions: Object.fromEntries(
        Array.from({ length: 4 }, (_, index) => [
          `a${index + 1}`,
          repeatId("act", index),
        ]),
      ),
      statements: Object.fromEntries(
        Array.from({ length: 3 }, (_, index) => [
          `s${index + 1}`,
          nodes[index]?.node_id,
        ]),
      ),
      traversals: Object.fromEntries(
        Array.from({ length: 3 }, (_, index) => [
          `t${index + 1}`,
          repeatId("trv", index),
        ]),
      ),
      probes: Object.fromEntries(
        Array.from({ length: 3 }, (_, index) => [
          `p${index + 1}`,
          repeatId("cand", index),
        ]),
      ),
    },
    coverage_notes: [
      "dynamic dispatch through getattr was not resolved",
      "third-party package boundary was summarised, not expanded",
    ],
    decision_log: Array.from({ length: 5 }, (_, index) => ({
      kind: index % 3 === 0 ? "EVIDENCE_RECORDED" : "AI_SRE_DECISION",
      round: 1 + Math.floor(index / 6),
      revision: index + 1,
      occurrenceId: "trace:replay-42",
      observationIds: [repeatId("obs", index % 10)],
      actionIds: [repeatId("act", index % 8)],
      explorationQuestion: null,
    })),
    stats: {
      summariesLoaded: 21,
      fragmentsLoaded: 9,
      expandedFunctions: 12,
      graphNodes: 214,
      graphEdges: 486,
      boundaryRegions: 6,
      functionRegions: 12,
      segmentRegions: 18,
      runtimeTraversals: 14,
      decisionPacketBytes: 2_591,
      viewBytes: 41_426,
    },
  };
}

class LargeViewAnalyzer implements AnalyzerClient {
  public async run(
    _repositoryRoot: string,
    _command: Record<string, unknown>,
  ): Promise<unknown> {
    return largeInvestigationView();
  }

  public async getPlan(): Promise<AnalyzerPlan> {
    return analysisPlan();
  }
}

class FakeAnalyzer implements AnalyzerClient {
  public readonly commands: Record<string, unknown>[] = [];

  public async run(
    _repositoryRoot: string,
    command: Record<string, unknown>,
  ): Promise<unknown> {
    this.commands.push(command);
    if (command["command"] === "prepare") {
      return { indexedFiles: 2, reusedFiles: 0 };
    }
    if (command["command"] === "refine") {
      return {
        ...analysisPlan(),
        frontier: [],
        round: 2,
        status: "LOCALIZED",
        likely_hammock_id: "hmk_pricing",
      };
    }
    if (
      command["command"] === "start_investigation" ||
      command["command"] === "get_investigation" ||
      command["command"] === "record_evidence" ||
      command["command"] === "decide_investigation"
    ) {
      return investigationView();
    }
    if (command["command"] === "get_investigation_result") {
      return { status: "ACTIVE", judgments: [] };
    }
    return analysisPlan();
  }

  public async getPlan(
    _repositoryRoot: string,
    _planId: string,
  ): Promise<AnalyzerPlan> {
    return analysisPlan();
  }
}

describe("Phase 1 MCP and fake-agent integration", () => {
  it("deploys an analysis frontier and groups only explicit occurrences", async () => {
    const { broker, brokerUrl } = await startBroker();
    const analyzer = new FakeAnalyzer();
    const handlers = createToolHandlers(
      new BrokerClient(brokerUrl),
      analyzer,
    );
    for (const serviceId of ["pricing", "payments"]) {
      broker.liveprobeState.ingest({
        serviceId,
        sdk: "python",
        commitSha: NORMALIZED_COMMIT,
        commitSource: "config",
        agentStatus: { state: "green" },
        events: [],
      });
    }

    await expect(
      handlers.prepare_repository_analysis({
        repository_root: "/repo",
        commit_hash: NORMALIZED_COMMIT,
      }),
    ).resolves.toMatchObject({ indexedFiles: 2 });
    const analyzed = await handlers.analyze_probe_candidates({
      repository_root: "/repo",
      commit_hash: NORMALIZED_COMMIT,
      service_id: "payments",
      file: "services/payments/app.py",
      line: 64,
      watch_path: "fare_inputs.per_mile_rate",
    });
    expect(analyzed.plan_id).toBe(ANALYSIS_PLAN_ID);

    const deployed = await handlers.deploy_probe_frontier({
      repository_root: "/repo",
      plan_id: ANALYSIS_PLAN_ID,
    });
    expect(deployed.probes).toHaveLength(2);
    expect(deployed.probes.map(({ probe }) => probe.serviceId)).toEqual([
      "pricing",
      "payments",
    ]);
    expect(deployed.probes.map(({ probe }) => probe.investigationId)).toEqual([
      ANALYSIS_PLAN_ID,
      ANALYSIS_PLAN_ID,
    ]);

    const timestamp = new Date().toISOString();
    for (const [index, deployedProbe] of deployed.probes.entries()) {
      const probe = deployedProbe.probe;
      const correlated = {
        probeId: probe.id,
        type: "snapshot" as const,
        ts: timestamp,
        correlation: {
          traceId: "trace-one",
          source: "legacy-x-trace-id" as const,
          quality: "exact-execution" as const,
          localHitSequence: index + 1,
        },
        variables: { t: "obj" as const, c: {} },
        watches: {},
        stack: [],
      };
      const uncorrelated = {
        ...correlated,
        correlation: {
          source: "none" as const,
          quality: "absent" as const,
          localHitSequence: index + 10,
        },
      };
      broker.liveprobeState.ingest({
        serviceId: probe.serviceId,
        sdk: "python",
        commitSha: NORMALIZED_COMMIT,
        commitSource: "config",
        agentStatus: { state: "green" },
        events: [correlated, uncorrelated],
      });
    }

    const observed = await handlers.refine_probe_candidates({
      repository_root: "/repo",
      plan_id: ANALYSIS_PLAN_ID,
    });
    const correlatedGroup = observed.occurrences.find(
      ({ occurrenceId }) => occurrenceId === "trace:trace-one",
    );
    expect(correlatedGroup?.correlated).toBe(true);
    expect(
      correlatedGroup?.events.map(({ candidateId }) => candidateId).sort(),
    ).toEqual([CANDIDATE_A, CANDIDATE_B]);
    expect(
      observed.occurrences.filter(({ correlated }) => !correlated),
    ).toHaveLength(2);

    const refined = await handlers.refine_probe_candidates({
      repository_root: "/repo",
      plan_id: ANALYSIS_PLAN_ID,
      assessments: [
        {
          candidate_id: CANDIDATE_A,
          classification: "bad",
          occurrence_id: "trace:trace-one",
        },
      ],
    });
    expect(refined.plan).toMatchObject({
      round: 2,
      status: "LOCALIZED",
      likely_hammock_id: "hmk_pricing",
    });
  });

  it("runs the reversible investigation surface with judgment provenance", async () => {
    const { broker, brokerUrl } = await startBroker();
    const analyzer = new FakeAnalyzer();
    const handlers = createToolHandlers(
      new BrokerClient(brokerUrl),
      analyzer,
    );
    for (const serviceId of ["payments", "pricing"]) {
      broker.liveprobeState.ingest({
        serviceId,
        sdk: "python",
        commitSha: NORMALIZED_COMMIT,
        commitSource: "config",
        agentStatus: { state: "green" },
        events: [],
      });
    }

    const started = await handlers.start_probe_investigation({
      repository_root: "/repo",
      commit_hash: NORMALIZED_COMMIT,
      service_id: "payments",
      file: "services/payments/app.py",
      line: 64,
      symptom: "fare is non-numeric",
      watch_path: "amount",
      failure_class: "type_shape",
      expected_type: "numeric",
    });
    expect(started.investigation_id).toBe(INVESTIGATION_ID);

    const deployed = await handlers.deploy_investigation_probes({
      repository_root: "/repo",
      investigation_id: INVESTIGATION_ID,
      correlation_trace_id: "investigation-trace",
      service_map: [
        {
          source_root: "services/payments",
          service_id: "pricing",
        },
      ],
    });
    expect(deployed.probes).toHaveLength(1);
    const probe = deployed.probes[0]?.probe;
    if (probe === undefined) throw new Error("expected investigation probe");
    expect(probe.serviceId).toBe("payments");
    expect(probe.correlationTraceId).toBe("investigation-trace");
    const rawProbe = await handlers.set_snapshot_probe({
      service_id: "payments",
      commit_hash: NORMALIZED_COMMIT,
      file: "services/payments/app.py",
      line: 64,
      watch_paths: ["amount"],
      correlation_trace_id: "investigation-trace",
    });
    expect(rawProbe.probe.correlationTraceId).toBe("investigation-trace");
    const timestamp = new Date().toISOString();
    broker.liveprobeState.ingest({
      serviceId: "payments",
      sdk: "python",
      commitSha: NORMALIZED_COMMIT,
      commitSource: "config",
      agentStatus: { state: "green" },
      events: [
        {
          probeId: probe.id,
          type: "snapshot",
          ts: timestamp,
          correlation: {
            traceId: "investigation-trace",
            source: "controlled-replay",
            quality: "exact-execution",
            localHitSequence: 3,
          },
          variables: { t: "obj", c: {} },
          watches: { amount: { t: "str", v: "2,45" } },
          capture: {
            watchValues: "callback-frozen",
            status: "complete",
          },
          stack: [],
        },
      ],
    });

    const collected = await handlers.collect_investigation_evidence({
      repository_root: "/repo",
      investigation_id: INVESTIGATION_ID,
      occurrences: [
        {
          occurrence_id: "trace:investigation-trace",
        },
      ],
    });
    expect(
      collected.occurrences.find(
        ({ occurrenceId }) =>
          occurrenceId === "trace:investigation-trace",
      )?.correlated,
    ).toBe(true);
    expect(analyzer.commands.at(-1)).toMatchObject({
      command: "record_evidence",
      investigationId: INVESTIGATION_ID,
      observations: [
        {
          siteId: INVESTIGATION_SITE,
          occurrenceId: "trace:investigation-trace",
          hitIndex: 1,
          sequenceIndex: 3,
          captureStatus: "complete",
        },
      ],
    });

    await handlers.apply_investigation_decision({
      repository_root: "/repo",
      investigation_id: INVESTIGATION_ID,
      based_on_revision: 1,
      action_ids: [],
    });
    expect(analyzer.commands.at(-1)).toMatchObject({
      command: "decide_investigation",
      investigationId: INVESTIGATION_ID,
    });
  });

  it("keeps the default investigation responses under their byte ceilings", async () => {
    const { brokerUrl } = await startBroker();
    const server = createMcpServer(
      new BrokerClient(brokerUrl),
      new LargeViewAnalyzer(),
    );
    const client = new Client(
      { name: "liveprobe-payload-budget-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // The fixture must be at the scale campaign r12 measured, otherwise the
      // ceilings below would pass on a payload nobody actually pays for.
      const fullFixtureBytes = Buffer.byteLength(
        JSON.stringify(largeInvestigationView()),
      );
      expect(fullFixtureBytes).toBeGreaterThan(30_000);

      const started = await client.callTool({
        name: "start_probe_investigation",
        arguments: {
          repository_root: "/repo",
          commit_hash: NORMALIZED_COMMIT,
          service_id: "recommend",
          file: "services/recommend/app.py",
          line: 24,
          symptom: "response_ids is empty",
          watch_path: "response_ids",
        },
      });
      expect(started.isError).toBeFalsy();
      expect(wireBytes(started)).toBeLessThan(COMPACT_START_CEILING_BYTES);
      const startedView = toolPayload(started) as {
        graph?: unknown;
        graph_summary?: Record<string, unknown>;
      };
      expect(startedView).not.toHaveProperty("graph");
      expect(startedView.graph_summary).toMatchObject({
        detail: "compact",
        focus_nodes: 60,
        focus_edges: 120,
        unresolved_branches: 5,
        runtime_traversals: { total: 14, returned: 8 },
      });

      const collected = await client.callTool({
        name: "collect_investigation_evidence",
        arguments: {
          repository_root: "/repo",
          investigation_id: INVESTIGATION_ID,
        },
      });
      expect(collected.isError).toBeFalsy();
      expect(wireBytes(collected)).toBeLessThan(COMPACT_COLLECT_CEILING_BYTES);
      const collectedPayload = toolPayload(collected) as {
        investigation: { graph?: unknown; graph_summary?: { detail: string } };
      };
      expect(collectedPayload.investigation).not.toHaveProperty("graph");
      expect(collectedPayload.investigation.graph_summary?.detail).toBe(
        "compact",
      );

      const decided = await client.callTool({
        name: "apply_investigation_decision",
        arguments: {
          repository_root: "/repo",
          investigation_id: INVESTIGATION_ID,
          based_on_revision: 4,
          action_ids: [],
        },
      });
      expect(decided.isError).toBeFalsy();
      expect(wireBytes(decided)).toBeLessThan(COMPACT_START_CEILING_BYTES);

      const context = await client.callTool({
        name: "get_investigation_context",
        arguments: {
          repository_root: "/repo",
          investigation_id: INVESTIGATION_ID,
        },
      });
      expect(context.isError).toBeFalsy();
      expect(wireBytes(context)).toBeLessThan(COMPACT_START_CEILING_BYTES);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps get_probe_data under its byte ceiling without losing evidence", async () => {
    const { broker, brokerUrl } = await startBroker();
    const handlers = createToolHandlers(new BrokerClient(brokerUrl));
    broker.liveprobeState.ingest({
      serviceId: "recommendation",
      sdk: "python",
      commitSha: NORMALIZED_COMMIT,
      commitSource: "env",
      agentStatus: { state: "green" },
      events: [],
    });

    const probe = await handlers.set_snapshot_probe({
      service_id: "recommendation",
      commit_hash: DEPLOYED_COMMIT,
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

    const captured = Array.from({ length: 25 }, (_, index) =>
      snapshotFixture(probe.id, index),
    );
    broker.liveprobeState.ingest({
      serviceId: "recommendation",
      sdk: "python",
      commitSha: NORMALIZED_COMMIT,
      commitSource: "env",
      agentStatus: { state: "green" },
      events: captured as ProbeEvent[],
    });

    // The fixture must be at the scale campaign r12 measured, otherwise the
    // ceiling below would pass on a payload nobody actually pays for.
    const unprojected = await new BrokerClient(brokerUrl).getProbeData(
      probe.id,
      0,
    );
    expect(wireBytes(unprojected)).toBeGreaterThan(45_000);

    const data = await handlers.get_probe_data({
      probe_id: probe.id,
      wait_seconds: 0,
    });
    expect(wireBytes(data)).toBeLessThan(PROBE_DATA_CEILING_BYTES);
    expect(wireBytes(data)).toBeLessThan(wireBytes(unprojected) * 0.7);

    // Every captured occurrence is still returned, and nothing was capped.
    const events = capturedEvents(data.events);
    expect(events).toHaveLength(25);
    expect(data).not.toHaveProperty("eventsOmitted");

    // The correlation identity survives on every occurrence: the skills and
    // `evaluation/praxis/scripts/remote-liveprobe-tripwire.mjs` select
    // snapshots by exact traceId and exact-execution quality.
    for (const [index, event] of events.entries()) {
      expect(event["correlation"]).toEqual(captured[index]!["correlation"]);
    }
    expect(
      new Set(
        events.map(
          (event) =>
            (event["correlation"] as { traceId: string } | undefined)?.traceId,
        ),
      ).size,
    ).toBe(25);
    expect(
      events.filter(
        (event) =>
          (event["correlation"] as { quality?: string } | undefined)
            ?.quality === "exact-execution",
      ),
    ).toHaveLength(25);

    // The captured runtime values and their types survive verbatim. They are
    // the reason the tool exists.
    for (const [index, event] of events.entries()) {
      expect(event["variables"]).toEqual(captured[index]!["variables"]);
      expect(event["watches"]).toEqual(captured[index]!["watches"]);
      expect(event["ts"]).toEqual(captured[index]!["ts"]);
      expect(event["type"]).toBe("snapshot");
    }

    // The stack is deduplicated, not dropped: one entry, resolvable per event.
    expect(data.stacks).toHaveLength(1);
    expect(data.stacks?.[0]).toEqual(captured[0]!["stack"]);
    for (const event of events) {
      expect(data.stacks?.[event["stackId"] as number]).toEqual(
        captured[0]!["stack"],
      );
    }

    // What was removed carries no evidence.
    for (const event of events) {
      expect(event).not.toHaveProperty("probeId");
      expect(event).not.toHaveProperty("capture");
      expect(event).not.toHaveProperty("stack");
    }
    expect(data.probe.id).toBe(probe.id);
  });

  it("preserves a truncated capture and a genuinely different call path", async () => {
    const { broker, brokerUrl } = await startBroker();
    const handlers = createToolHandlers(new BrokerClient(brokerUrl));
    broker.liveprobeState.ingest({
      serviceId: "recommendation",
      sdk: "python",
      commitSha: NORMALIZED_COMMIT,
      commitSource: "env",
      agentStatus: { state: "green" },
      events: [],
    });
    const probe = await handlers.set_snapshot_probe({
      service_id: "recommendation",
      commit_hash: DEPLOYED_COMMIT,
      file: "recommendation_server.py",
      line: 47,
      hit_limit: 5,
    });

    const shallow = snapshotFixture(probe.id, 1, { stackDepth: 3 });
    const truncated = {
      ...snapshotFixture(probe.id, 2),
      capture: { watchValues: "callback-frozen", status: "truncated" },
    };
    broker.liveprobeState.ingest({
      serviceId: "recommendation",
      sdk: "python",
      commitSha: NORMALIZED_COMMIT,
      commitSource: "env",
      agentStatus: { state: "green" },
      events: [
        snapshotFixture(probe.id, 0),
        shallow,
        truncated,
      ] as ProbeEvent[],
    });

    const data = await handlers.get_probe_data({
      probe_id: probe.id,
      wait_seconds: 0,
    });
    const events = capturedEvents(data.events);

    // Two distinct call paths stay distinct; the third reuses the first.
    expect(data.stacks).toHaveLength(2);
    expect(events[0]!["stackId"]).toBe(0);
    expect(events[1]!["stackId"]).toBe(1);
    expect(events[2]!["stackId"]).toBe(0);
    expect(data.stacks?.[1]).toHaveLength(3);

    // Truncation is weaker evidence and the agent must still be told.
    expect(events[0]).not.toHaveProperty("capture");
    expect(events[2]!["capture"]).toEqual({
      watchValues: "callback-frozen",
      status: "truncated",
    });
  });

  it("bounds captured occurrences to the newest and never caps status events", async () => {
    const { broker, brokerUrl } = await startBroker();
    const handlers = createToolHandlers(new BrokerClient(brokerUrl));
    broker.liveprobeState.ingest({
      serviceId: "recommendation",
      sdk: "python",
      commitSha: NORMALIZED_COMMIT,
      commitSource: "env",
      agentStatus: { state: "green" },
      events: [],
    });
    const probe = await handlers.set_snapshot_probe({
      service_id: "recommendation",
      commit_hash: DEPLOYED_COMMIT,
      file: "recommendation_server.py",
      line: 47,
      hit_limit: 200,
    });

    // A hot-path probe: an armed status, then 60 captures. The broker retains
    // events chronologically, and a replay is driven after arming, so the
    // correlated occurrence is always among the newest.
    broker.liveprobeState.ingest({
      serviceId: "recommendation",
      sdk: "python",
      commitSha: NORMALIZED_COMMIT,
      commitSource: "env",
      agentStatus: { state: "green" },
      events: [
        {
          probeId: probe.id,
          type: "status",
          ts: new Date(Date.UTC(2026, 6, 30, 20, 13, 0)).toISOString(),
          status: "armed",
        },
        ...Array.from({ length: 60 }, (_, index) =>
          snapshotFixture(probe.id, index),
        ),
      ] as ProbeEvent[],
    });

    const data = await handlers.get_probe_data({
      probe_id: probe.id,
      wait_seconds: 0,
    });
    const events = capturedEvents(data.events);
    expect(events).toHaveLength(25);
    expect(data.eventsOmitted).toMatchObject({
      returned: 25,
      total: 60,
      olderCapturesDropped: 35,
    });

    // The newest captures are the ones kept.
    expect(
      (events[24]!["correlation"] as { localHitSequence: number }).localHitSequence,
    ).toBe(59);
    expect(
      (events[0]!["correlation"] as { localHitSequence: number }).localHitSequence,
    ).toBe(35);

    // Arm state is how a caller learns a probe is live, so it is never capped.
    expect(
      data.events.filter((event) => event["type"] === "status"),
    ).toHaveLength(1);

    // The omission is recoverable by an explicit request, as the hint says.
    const full = await handlers.get_probe_data({
      probe_id: probe.id,
      wait_seconds: 0,
      max_events: 100,
    });
    expect(capturedEvents(full.events)).toHaveLength(60);
    expect(full).not.toHaveProperty("eventsOmitted");
  });

  it("keeps every field a legal next action needs in the compact view", async () => {
    const { brokerUrl } = await startBroker();
    const handlers = createToolHandlers(
      new BrokerClient(brokerUrl),
      new LargeViewAnalyzer(),
    );
    const view = await handlers.start_probe_investigation({
      repository_root: "/repo",
      commit_hash: NORMALIZED_COMMIT,
      service_id: "recommend",
      file: "services/recommend/app.py",
      line: 24,
      symptom: "response_ids is empty",
      watch_path: "response_ids",
    });
    const reference = largeInvestigationView();

    // Everything a tool input accepts must survive the projection: revision and
    // action_id for apply_investigation_decision, probe_bundle sites for
    // deploy_investigation_probes, mechanism anchors, traversal and probe
    // candidate IDs for candidate_mechanism, dossier and decision-log
    // observation IDs for completion evidence_refs.
    for (const field of [
      "investigation_id",
      "revision",
      "phase",
      "status",
      "round",
      "criterion",
      "probe_bundle",
      "actions",
      "value_dossiers",
      "judgments",
      "mechanism_context",
      "candidate_mechanism",
      "decision_context",
      "decision_aliases",
      "coverage_notes",
      "decision_log",
      "stats",
    ] as const) {
      expect(view[field]).toEqual(reference[field]);
    }
    expect(view.actions.map((action) => action.action_id)).toEqual(
      (reference["actions"] as Array<{ action_id: string }>).map(
        (action) => action.action_id,
      ),
    );
    expect(view.probe_bundle?.sites.length).toBe(3);
  });

  it("restores the graph only when detail=full is requested", async () => {
    const { brokerUrl } = await startBroker();
    const server = createMcpServer(
      new BrokerClient(brokerUrl),
      new LargeViewAnalyzer(),
    );
    const client = new Client(
      { name: "liveprobe-payload-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const call = async (detail?: "compact" | "full") =>
        client.callTool({
          name: "start_probe_investigation",
          arguments: {
            repository_root: "/repo",
            commit_hash: NORMALIZED_COMMIT,
            service_id: "recommend",
            file: "services/recommend/app.py",
            line: 24,
            symptom: "response_ids is empty",
            watch_path: "response_ids",
            ...(detail === undefined ? {} : { detail }),
          },
        });

      const compact = await call();
      const full = await call("full");

      expect(compact.isError).toBeFalsy();
      expect(full.isError).toBeFalsy();
      expect(wireBytes(compact)).toBeLessThan(COMPACT_START_CEILING_BYTES);
      expect(wireBytes(full)).toBeGreaterThan(wireBytes(compact) * 4);

      expect(toolPayload(compact)).not.toHaveProperty("graph");
      expect(toolPayload(full)).toHaveProperty("graph");
      expect(toolPayload(full)).not.toHaveProperty("graph_summary");

      const tools = await client.listTools();
      const detailProperty = (
        tools.tools.find(({ name }) => name === "start_probe_investigation")
          ?.inputSchema as {
          properties?: Record<string, { enum?: string[] }>;
        }
      ).properties?.["detail"];
      expect(detailProperty?.enum).toEqual(["compact", "full"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serves the complete tool set over authenticated Streamable HTTP", async () => {
    const principal = {
      type: "user" as const,
      role: "operator" as const,
      principalId: "user-remote",
      tenantId: "org-remote",
      projectId: "default",
      environmentId: "default",
      organizationId: "org-remote",
    };
    const authenticate = async (token: string) =>
      token === "oauth-token" ? principal : undefined;
    const backend = await buildBroker({ authenticateBearer: authenticate });
    openBrokers.push(backend);
    await backend.listen({ host: "127.0.0.1", port: 0 });
    const backendAddress = backend.server.address();
    if (backendAddress === null || typeof backendAddress === "string") {
      throw new Error("expected backend broker TCP address");
    }

    const frontend = await buildBroker({
      authenticateBearer: authenticate,
      remoteMcp: {
        publicUrl: "https://probe.example.com",
        brokerUrl: `http://127.0.0.1:${backendAddress.port}`,
        authorizationServerUrl: "https://clerk.probe.example.com",
        authenticateBearer: authenticate,
      },
    });
    openBrokers.push(frontend);
    await frontend.listen({ host: "127.0.0.1", port: 0 });
    const frontendAddress = frontend.server.address();
    if (frontendAddress === null || typeof frontendAddress === "string") {
      throw new Error("expected frontend broker TCP address");
    }

    const client = new Client({ name: "remote-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${frontendAddress.port}/mcp`),
      {
        requestInit: {
          headers: { authorization: "Bearer oauth-token" },
        },
      },
    );
    await client.connect(
      transport as Parameters<Client["connect"]>[0],
    );
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "apply_investigation_decision",
        "collect_investigation_evidence",
        "deploy_investigation_probes",
        "get_investigation_context",
        "get_investigation_result",
        "get_probe_data",
        "get_safety_overview",
        "list_audit_events",
        "list_probes",
        "list_services",
        "ping_broker",
        "prepare_repository_analysis",
        "remove_probe",
        "set_counter_probe",
        "set_log_probe",
        "set_metric_probe",
        "set_snapshot_probe",
        "start_probe_investigation",
      ]);
      const ping = await client.callTool({ name: "ping_broker", arguments: {} });
      expect(ping.isError).not.toBe(true);
      // Successful results carry no indentation: it is information-free and is
      // charged as fresh, uncacheable input on every turn that reads them.
      expect(ping.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
    } finally {
      await client.close();
    }
  });

  it("creates every probe type and exposes status transitions and data", async () => {
    const { broker, brokerUrl } = await startBroker();
    const handlers = createToolHandlers(new BrokerClient(brokerUrl));
    const fakeAgent = new FakeAgent({
      brokerUrl,
      serviceId: "checkout",
      pollIntervalMs: 10,
    });
    await fakeAgent.tick();

    const snapshot = await handlers.set_snapshot_probe({
      service_id: "checkout",
      commit_hash: DEPLOYED_COMMIT,
      file: "src/checkout.ts",
      line: 20,
      watch_paths: ["cart.total"],
      hit_limit: 1,
    });
    const log = await handlers.set_log_probe({
      service_id: "checkout",
      commit_hash: DEPLOYED_COMMIT,
      file: "src/checkout.ts",
      line: 21,
      template: "total=${cart.total}",
      hit_limit: 1,
    });
    const counter = await handlers.set_counter_probe({
      service_id: "checkout",
      commit_hash: DEPLOYED_COMMIT,
      file: "src/checkout.ts",
      line: 22,
      hit_limit: 1,
    });
    const metric = await handlers.set_metric_probe({
      service_id: "checkout",
      commit_hash: DEPLOYED_COMMIT,
      file: "src/checkout.ts",
      line: 23,
      metric_path: "cart.total",
      hit_limit: 1,
    });

    expect([snapshot.type, log.type, counter.type, metric.type]).toEqual([
      "snapshot",
      "log",
      "counter",
      "metric",
    ]);
    expect(
      [snapshot, log, counter, metric].map((probe) => probe.sourceCommit),
    ).toEqual(Array.from({ length: 4 }, () => NORMALIZED_COMMIT));

    const longPollStartedAt = Date.now();
    const pendingData = handlers.get_probe_data({
      probe_id: snapshot.id,
      wait_seconds: 2,
    });
    await waitUntil(
      () => broker.liveprobeState.pendingLongPollCount(snapshot.id) === 1,
    );

    const armedTick = await fakeAgent.tick();
    expect(armedTick.armed).toHaveLength(4);
    const firstLongPoll = await pendingData;
    expect(Date.now() - longPollStartedAt).toBeLessThan(3_000);
    expect(firstLongPoll.events).toContainEqual(
      expect.objectContaining({ type: "status", status: "armed" }),
    );
    expect(broker.liveprobeState.pendingLongPollCount()).toBe(0);

    const armedList = await handlers.list_probes({
      service_id: "checkout",
    });
    expect(
      armedList.probes.map((entry) => entry.status?.status),
    ).toEqual(["armed", "armed", "armed", "armed"]);
    expect(
      armedList.probes.map((entry) => entry.probe.sourceCommit),
    ).toEqual(Array.from({ length: 4 }, () => NORMALIZED_COMMIT));

    const emittedTick = await fakeAgent.tick();
    expect(emittedTick.emitted).toHaveLength(4);

    const probes = [snapshot, log, counter, metric];
    for (const probe of probes) {
      const result = await handlers.get_probe_data({
        probe_id: probe.id,
      });
      expect(result.probe.sourceCommit).toBe(NORMALIZED_COMMIT);
      expect(dataEvents(result.events)).toContainEqual(
        expect.objectContaining({ type: probe.type }),
      );
    }

    const completedList = await handlers.list_probes({
      service_id: "checkout",
    });
    expect(
      completedList.probes.map((entry) => entry.status?.status),
    ).toEqual([
      "hit-limit-reached",
      "hit-limit-reached",
      "hit-limit-reached",
      "hit-limit-reached",
    ]);

    const services = await handlers.list_services();
    expect(services.services).toEqual([
      expect.objectContaining({
        serviceId: "checkout",
        sdk: "node",
        agentStatus: expect.objectContaining({ state: "green" }),
      }),
    ]);

    await expect(
      handlers.remove_probe({ probe_id: log.id }),
    ).resolves.toEqual({ removed: true, probeId: log.id });
    const afterRemoval = await handlers.list_probes({
      service_id: "checkout",
    });
    expect(afterRemoval.probes).toHaveLength(3);
  });

  it("validates tool inputs and cleans timeout listeners", async () => {
    const { broker, brokerUrl } = await startBroker();
    const handlers = createToolHandlers(new BrokerClient(brokerUrl));

    await expect(
      handlers.set_counter_probe({
        service_id: "checkout",
        commit_hash: DEPLOYED_COMMIT,
        file: "src/checkout.ts",
        line: 0,
      }),
    ).rejects.toThrow();
    await expect(
      handlers.set_counter_probe({
        service_id: "checkout",
        commit_hash: DEPLOYED_COMMIT,
        file: "src/checkout.ts",
        line: 20,
        unexpected: true,
      } as never),
    ).rejects.toThrow();

    broker.liveprobeState.ingest({
      serviceId: "checkout",
      sdk: "node",
      commitSha: NORMALIZED_COMMIT,
      commitSource: "config",
      agentStatus: { state: "green" },
      events: [],
    });

    const probe = await handlers.set_counter_probe({
      service_id: "checkout",
      commit_hash: DEPLOYED_COMMIT,
      file: "src/checkout.ts",
      line: 20,
    });
    const pending = handlers.get_probe_data({
      probe_id: probe.id,
      wait_seconds: 0.02,
    });
    await waitUntil(
      () => broker.liveprobeState.pendingLongPollCount(probe.id) === 1,
    );
    await expect(pending).resolves.toMatchObject({ events: [] });
    expect(broker.liveprobeState.pendingLongPollCount()).toBe(0);
  });

  it("requires and validates a deployed commit hash for every set tool", async () => {
    const { brokerUrl } = await startBroker();
    const handlers = createToolHandlers(new BrokerClient(brokerUrl));
    const tools: Array<{
      call: (input: Record<string, unknown>) => Promise<unknown>;
      input: Record<string, unknown>;
    }> = [
      {
        call: (input) => handlers.set_snapshot_probe(input as never),
        input: {
          service_id: "checkout",
          commit_hash: DEPLOYED_COMMIT,
          file: "src/checkout.ts",
          line: 20,
        },
      },
      {
        call: (input) => handlers.set_log_probe(input as never),
        input: {
          service_id: "checkout",
          commit_hash: DEPLOYED_COMMIT,
          file: "src/checkout.ts",
          line: 21,
          template: "checkout",
        },
      },
      {
        call: (input) => handlers.set_counter_probe(input as never),
        input: {
          service_id: "checkout",
          commit_hash: DEPLOYED_COMMIT,
          file: "src/checkout.ts",
          line: 22,
        },
      },
      {
        call: (input) => handlers.set_metric_probe(input as never),
        input: {
          service_id: "checkout",
          commit_hash: DEPLOYED_COMMIT,
          file: "src/checkout.ts",
          line: 23,
          metric_path: "cart.total",
        },
      },
    ];

    for (const tool of tools) {
      const missing = { ...tool.input };
      delete missing["commit_hash"];
      await expect(tool.call(missing)).rejects.toThrow();
      for (const invalid of [
        "abc123",
        "not-a-git-object",
        "a".repeat(65),
      ]) {
        await expect(
          tool.call({ ...tool.input, commit_hash: invalid }),
        ).rejects.toThrow();
      }
    }
  });

  it("exposes connectivity, safety, and commit mismatch guidance", async () => {
    const { broker, brokerUrl } = await startBroker();
    const handlers = createToolHandlers(new BrokerClient(brokerUrl));
    broker.liveprobeState.ingest({
      serviceId: "checkout",
      sdk: "node",
      commitSha: NORMALIZED_COMMIT,
      commitSource: "env",
      agentStatus: { state: "green", detail: "0 probes armed" },
      events: [],
    });

    await expect(handlers.ping_broker()).resolves.toEqual({ ok: true });
    await expect(handlers.get_safety_overview()).resolves.toMatchObject({
      services: [
        {
          serviceId: "checkout",
          online: true,
          agent: { state: "green" },
        },
      ],
    });

    const mismatched = await handlers.set_counter_probe({
      service_id: "checkout",
      commit_hash: "1234567890abcdef",
      file: "src/checkout.ts",
      line: 22,
    });
    expect(mismatched.commitMismatch).toMatchObject({
      requested: "1234567890abcdef",
      reported: NORMALIZED_COMMIT,
      warning: expect.stringContaining("does not match"),
    });
  });

  it("lists bounded audit events and preserves admin authorization errors", async () => {
    const occurredAt = "2026-07-22T20:00:00.000Z";
    let requestedUrl = "";
    let authorization = "";
    const handlers = createToolHandlers(
      new BrokerClient("https://probe.example.com", {
        apiKey: "admin-token",
        fetchImplementation: async (input, init) => {
          requestedUrl = String(input);
          authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(
            JSON.stringify({
              events: [
                {
                  auditId: "aud_123",
                  tenantId: "org_123",
                  projectId: "default",
                  environmentId: "default",
                  occurredAt,
                  requestId: "req-1",
                  actorType: "user",
                  actorId: "user_admin",
                  actorRole: "admin",
                  action: "probe.create",
                  resourceType: "probe",
                  resourceId: "prb_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                  outcome: "success",
                  statusCode: 201,
                  metadata: { serviceId: "checkout", probeType: "counter" },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      }),
    );

    await expect(
      handlers.list_audit_events({ limit: 10, before: occurredAt }),
    ).resolves.toMatchObject({
      events: [
        {
          actorRole: "admin",
          action: "probe.create",
          outcome: "success",
        },
      ],
    });
    expect(requestedUrl).toBe(
      `https://probe.example.com/v1/audit-events?limit=10&before=${encodeURIComponent(occurredAt)}`,
    );
    expect(authorization).toBe("Bearer admin-token");

    const server = createMcpServer(
      new BrokerClient("https://probe.example.com", {
        fetchImplementation: async () =>
          new Response(
            JSON.stringify({
              error: { code: "forbidden", message: "admin access is required" },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
      }),
    );
    const client = new Client(
      { name: "liveprobe-audit-error-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const denied = await client.callTool({
        name: "list_audit_events",
        arguments: {},
      });
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining('"code": "forbidden"'),
        }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("publishes exactly the twenty-one official MCP tools", async () => {
    const { brokerUrl } = await startBroker();
    const server = createMcpServer(new BrokerClient(brokerUrl));
    const client = new Client(
      { name: "liveprobe-integration-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "apply_investigation_decision",
        "collect_investigation_evidence",
        "deploy_investigation_probes",
        "get_investigation_context",
        "get_investigation_result",
        "get_probe_data",
        "get_safety_overview",
        "list_audit_events",
        "list_probes",
        "list_services",
        "ping_broker",
        "prepare_repository_analysis",
        "remove_probe",
        "set_counter_probe",
        "set_log_probe",
        "set_metric_probe",
        "set_snapshot_probe",
        "start_probe_investigation",
      ]);
      for (const tool of tools.tools.filter(({ name }) =>
        name.startsWith("set_"),
      )) {
        expect(
          (tool.inputSchema as { required?: string[] }).required,
        ).toContain("commit_hash");
        expect(tool.description).toContain("manual diagnostic probe");
        expect(tool.description).toContain(
          "use deploy_investigation_probes",
        );
        expect(tool.description).toContain("Returns {probe}");
        const properties = (
          tool.inputSchema as {
            properties?: Record<string, { description?: string }>;
          }
        ).properties;
        expect(properties?.["service_id"]?.description).toContain(
          "returned by list_services",
        );
        expect(properties?.["commit_hash"]?.description).toContain(
          "for example",
        );
      }

      const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
      const startDescription =
        byName.get("start_probe_investigation")?.description ?? "";
      expect(startDescription).toContain("observability-derived");
      expect(startDescription).toContain("legal menus, not templates");
      expect(startDescription).toContain("must not be used for cold");
      expect(startDescription).toContain("liveprobe-investigation/v1");
      expect(startDescription).toContain("liveprobe-adaptive-v2");

      const decisionDescription =
        byName.get("apply_investigation_decision")?.description ?? "";
      expect(decisionDescription).toContain("based_on_revision");
      expect(decisionDescription).toContain("stale_revision");
      expect(decisionDescription).toContain("illegal_action");
      expect(decisionDescription).toContain("budget_exceeded");

      const actionProperties = (
        byName.get("apply_investigation_decision")?.inputSchema as {
          properties?: Record<string, { description?: string }>;
        }
      ).properties;
      expect(actionProperties?.["based_on_revision"]?.description).toContain(
        "current investigation response",
      );
      expect(actionProperties?.["action_ids"]?.description).toContain(
        "never construct IDs",
      );

      for (const tool of tools.tools) {
        expect(tool.description?.length ?? 0).toBeGreaterThan(80);
        expect(tool.description?.length ?? 0).toBeLessThan(1_000);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns MCP-friendly auth, unknown-service, and connectivity errors", async () => {
    const { brokerUrl } = await startBroker("correct-key");
    const server = createMcpServer(
      new BrokerClient(brokerUrl, { apiKey: "wrong-key" }),
    );
    const client = new Client(
      { name: "liveprobe-error-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const unauthorized = await client.callTool({
        name: "ping_broker",
        arguments: {},
      });
      expect(unauthorized.isError).toBe(true);
      expect(unauthorized.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining('"code": "unauthorized"'),
        }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }

    const serviceServer = createMcpServer(
      new BrokerClient(brokerUrl, { apiKey: "correct-key" }),
    );
    const serviceClient = new Client(
      { name: "liveprobe-service-error-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [serviceClientTransport, serviceServerTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await serviceServer.connect(serviceServerTransport);
      await serviceClient.connect(serviceClientTransport);
      const unknownService = await serviceClient.callTool({
        name: "set_counter_probe",
        arguments: {
          service_id: "missing-service",
          commit_hash: NORMALIZED_COMMIT,
          file: "src/missing.ts",
          line: 10,
        },
      });
      expect(unknownService.isError).toBe(true);
      expect(unknownService.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining('"code": "unknown_service"'),
        }),
      ]);
    } finally {
      await serviceClient.close();
      await serviceServer.close();
    }

    const unreachableServer = createMcpServer(
      new BrokerClient("http://127.0.0.1:1", {
        fetchImplementation: async () => {
          throw new TypeError("connection refused");
        },
      }),
    );
    const unreachableClient = new Client(
      { name: "liveprobe-connectivity-error-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [unreachableClientTransport, unreachableServerTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await unreachableServer.connect(unreachableServerTransport);
      await unreachableClient.connect(unreachableClientTransport);
      const unreachable = await unreachableClient.callTool({
        name: "ping_broker",
        arguments: {},
      });
      expect(unreachable.isError).toBe(true);
      expect(unreachable.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining('"code": "broker_unreachable"'),
        }),
      ]);
    } finally {
      await unreachableClient.close();
      await unreachableServer.close();
    }
  });

  it("bounds broker requests with a configurable timeout", async () => {
    const client = new BrokerClient("http://127.0.0.1:7070", {
      requestTimeoutMs: 10,
      fetchImplementation: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    });

    await expect(client.ping()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("defaults probe collection to a short long-poll rather than a bare peek", () => {
    // A probe armed moments ago has usually not been hit yet. Returning empty
    // by default costs the caller an extra round trip, and round trips are
    // what drive token cost.
    const parsed = GetProbeDataInputSchema.parse({
      probe_id: "prb_01JAZM3Y6S8X2V4K9N7Q1T5WCE",
    });
    expect(parsed.wait_seconds).toBeGreaterThan(0);
    expect(parsed.wait_seconds).toBeLessThanOrEqual(30);
    // Zero stays reachable for callers that genuinely want a peek.
    expect(
      GetProbeDataInputSchema.parse({
        probe_id: "prb_01JAZM3Y6S8X2V4K9N7Q1T5WCE",
        wait_seconds: 0,
      }).wait_seconds,
    ).toBe(0);
  });

  it("retries long enough to outlast a broker restart", () => {
    // The outage this exists for is a pod rollout or a port-forward
    // reattaching, which take seconds. Backoff must total seconds, not
    // milliseconds; campaign r11 lost calls to a sub-second window.
    const client = new BrokerClient("http://127.0.0.1:7070");
    const attempts = (client as unknown as { maxAttempts: number }).maxAttempts;
    const base = (client as unknown as { retryBaseDelayMs: number })
      .retryBaseDelayMs;
    const totalBackoffMs = Array.from(
      { length: attempts - 1 },
      (_unused, index) => base * 2 ** index,
    ).reduce((sum, value) => sum + value, 0);
    expect(totalBackoffMs).toBeGreaterThanOrEqual(4_000);
  });

  it("retries an idempotent read through a transient transport failure", async () => {
    let attempts = 0;
    const client = new BrokerClient("http://127.0.0.1:7070", {
      retryBaseDelayMs: 0,
      fetchImplementation: async () => {
        attempts += 1;
        if (attempts < 3) throw new TypeError("connection reset");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(client.ping()).resolves.toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it("retries an idempotent read through a transient 503", async () => {
    let attempts = 0;
    const client = new BrokerClient("http://127.0.0.1:7070", {
      retryBaseDelayMs: 0,
      fetchImplementation: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response("", { status: 503 });
        }
        return new Response(JSON.stringify({ services: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(client.listServices()).resolves.toEqual({ services: [] });
    expect(attempts).toBe(2);
  });

  it("does not retry a rejected request, so a wrong call fails once", async () => {
    let attempts = 0;
    const client = new BrokerClient("http://127.0.0.1:7070", {
      retryBaseDelayMs: 0,
      fetchImplementation: async () => {
        attempts += 1;
        return new Response(
          JSON.stringify({
            error: { code: "not_found", message: "no such probe" },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(client.listServices()).rejects.toMatchObject({
      status: 404,
    });
    expect(attempts).toBe(1);
  });

  it("never retries probe creation, so a retry cannot deploy a second probe", async () => {
    let attempts = 0;
    const client = new BrokerClient("http://127.0.0.1:7070", {
      retryBaseDelayMs: 0,
      fetchImplementation: async () => {
        attempts += 1;
        throw new TypeError("connection reset");
      },
    });

    await expect(
      client.createProbe({
        serviceId: "recommendation",
        sourceCommit: NORMALIZED_COMMIT,
        type: "snapshot",
        file: "recommendation_server.py",
        line: 96,
        ttlSeconds: 60,
        createdBy: "retry-test",
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(attempts).toBe(1);
  });
});

/**
 * Campaign r12 measured `graph_liveprobe` making 80 LiveProbe calls across 13
 * runs and reaching probe deployment in 7. `start_probe_investigation` was the
 * only investigation tool that failed: 3 of its 13 calls were rejected, and
 * both recorded rejection payloads were argument-contract rejections, not
 * analyzer failures. `prepare_repository_analysis` never failed, so the
 * subprocess itself was healthy throughout.
 *
 * Reproduced by byte-and-digest matching against the ledgers in
 * `evaluation/praxis/results/artifacts/praxis-campaign-r12`:
 *
 * - 309 bytes, twice (incidents 403 and 411, seed 20). Exact sha256 match on
 *   the full JSON-RPC frame at request id 4: the SDK rejecting `watch_path`
 *   and `expression` together. The rule lived in a `.refine()`, which never
 *   reaches the published JSON Schema, so the caller could not have known it.
 * - 460 bytes, once (incident 401, seed 10). Every response-schema and
 *   `toolErrorResult` shape was enumerated and none reproduces it; the only
 *   payload that serialises to 460 bytes at id 4 is a `.strict()`
 *   `unrecognized_keys` rejection carrying three unknown key names.
 * - 421 bytes, twice (incident 412, seed 10, `get_probe_data`). Exact sha256
 *   match at request ids 13 and 14: `broker_unreachable` / "request timed
 *   out", the client aborting its own long poll.
 *
 * These tests hold the reporting contract those failures violated.
 */
describe("investigation failure reporting", () => {
  interface ErrorEnvelope {
    code: string;
    message: string;
    retryable: boolean;
    checks: string[];
  }

  function envelopeOf(result: unknown): ErrorEnvelope {
    const content = ((result as { content?: unknown }).content ?? []) as Array<{
      type: string;
      text?: string;
    }>;
    const text = content.find((item) => item.type === "text")?.text ?? "";
    // A raw SDK validation dump is not JSON, so this parse is itself part of
    // the assertion: every rejection must arrive as the structured envelope.
    return (JSON.parse(text) as { error: ErrorEnvelope }).error;
  }

  function offlineBroker(): BrokerClient {
    return new BrokerClient("https://probe.example.invalid", {
      retryBaseDelayMs: 0,
      fetchImplementation: async () =>
        new Response(JSON.stringify({ services: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
  }

  async function withMcp<T>(
    analyzer: AnalyzerClient,
    broker: BrokerClient,
    body: (client: Client) => Promise<T>,
  ): Promise<T> {
    const server = createMcpServer(broker, analyzer);
    const client = new Client(
      { name: "liveprobe-failure-reporting-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return await body(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  function analyzerReturning(value: unknown): AnalyzerClient {
    return {
      async run() {
        return value;
      },
      async getPlan(): Promise<AnalyzerPlan> {
        return analysisPlan();
      },
    };
  }

  const START_ARGUMENTS = {
    repository_root: "/repo",
    commit_hash: NORMALIZED_COMMIT,
    service_id: "payments",
    file: "services/payments/app.py",
    line: 64,
    symptom: "fare is non-numeric on trace ride-42",
  };

  it("answers the watch_path/expression conflict with a recoverable envelope", async () => {
    const result = await withMcp(
      new FakeAnalyzer(),
      offlineBroker(),
      (client) =>
        client.callTool({
          name: "start_probe_investigation",
          arguments: {
            ...START_ARGUMENTS,
            watch_path: "amount",
            expression: "quote(order)",
          },
        }),
    );

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    // The r12 payload was a raw Zod issue dump from the SDK, which carries no
    // code, no retryable flag and no remediation.
    expect(text).not.toContain("Input validation error");
    const error = envelopeOf(result);
    expect(error.code).toBe("invalid_tool_input");
    expect(error.message).toContain("mutually exclusive");
    expect(error.checks.length).toBeGreaterThanOrEqual(2);
    expect(error.checks.join(" ")).toContain("watch_path only");
    expect(error.checks.join(" ")).toContain("expression only");
  });

  it("publishes the watch_path/expression exclusion instead of hiding it in a refinement", async () => {
    const tools = await withMcp(
      new FakeAnalyzer(),
      offlineBroker(),
      (client) => client.listTools(),
    );
    const start = tools.tools.find(
      (tool) => tool.name === "start_probe_investigation",
    );
    const properties = (
      start?.inputSchema as {
        properties?: Record<string, { description?: string }>;
      }
    ).properties;

    expect(start?.description).toContain(
      "exactly one of watch_path or expression",
    );
    expect(properties?.["watch_path"]?.description).toContain("never both");
    expect(properties?.["expression"]?.description).toContain("never both");
  });

  it("names the tools that continue a started investigation", async () => {
    const tools = await withMcp(
      new FakeAnalyzer(),
      offlineBroker(),
      (client) => client.listTools(),
    );
    const description =
      tools.tools.find((tool) => tool.name === "start_probe_investigation")
        ?.description ?? "";

    // Starting an investigation is not a terminal step, but nothing in the
    // returned view names its successor. Six of the ten r12 runs that started
    // one either stopped immediately or fell back to manual probes.
    expect(description).toContain("deploy_investigation_probes");
    expect(description).toContain("apply_investigation_decision");
    expect(description).toContain("investigation_id");
  });

  it("does not blame tool arguments for an analyzer response it cannot read", async () => {
    const skewed = { ...investigationView(), phase: "TRIAGE" };
    const result = await withMcp(
      analyzerReturning(skewed),
      offlineBroker(),
      (client) =>
        client.callTool({
          name: "start_probe_investigation",
          arguments: START_ARGUMENTS,
        }),
    );

    const error = envelopeOf(result);
    expect(error.code).toBe("analyzer_response_mismatch");
    expect(error.code).not.toBe("invalid_tool_input");
    expect(error.message).toContain("response.phase");
    expect(error.checks.join(" ")).toContain("not an argument problem");
    expect(error.checks.join(" ")).not.toContain("Correct the tool arguments");
  });

  it("does not blame tool arguments for a broker response it cannot read", async () => {
    const broker = new BrokerClient("https://probe.example.invalid", {
      retryBaseDelayMs: 0,
      fetchImplementation: async () =>
        new Response(JSON.stringify({ services: [{ serviceId: 42 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const result = await withMcp(new FakeAnalyzer(), broker, (client) =>
      client.callTool({ name: "list_services", arguments: {} }),
    );

    const error = envelopeOf(result);
    expect(error.code).toBe("broker_response_mismatch");
    expect(error.checks.join(" ")).toContain("not an argument problem");
  });

  it("tells a caller with no probe bundle what to call next", async () => {
    const result = await withMcp(
      analyzerReturning({ ...investigationView(), probe_bundle: null }),
      offlineBroker(),
      (client) =>
        client.callTool({
          name: "deploy_investigation_probes",
          arguments: {
            repository_root: "/repo",
            investigation_id: INVESTIGATION_ID,
            created_by: "regression-test",
          },
        }),
    );

    const error = envelopeOf(result);
    expect(error.code).toBe("no_probe_bundle");
    // The old fallback bucket answered every server-raised state error with
    // analyzer installation advice.
    expect(error.checks.join(" ")).not.toContain("Python 3.12");
    expect(error.checks.join(" ")).toContain("apply_investigation_decision");
    expect(error.checks.join(" ")).toContain("get_investigation_context");
  });

  it("reports an offline bundle service as a service problem", async () => {
    const result = await withMcp(
      new FakeAnalyzer(),
      offlineBroker(),
      (client) =>
        client.callTool({
          name: "deploy_investigation_probes",
          arguments: {
            repository_root: "/repo",
            investigation_id: INVESTIGATION_ID,
            created_by: "regression-test",
          },
        }),
    );

    const error = envelopeOf(result);
    expect(error.code).toBe("service_offline");
    expect(error.checks.join(" ")).not.toContain("Python 3.12");
    expect(error.checks.join(" ")).toContain("list_services");
  });

  it("reports an unsupported correlation filter without analyzer install advice", async () => {
    const { broker, brokerUrl } = await startBroker();
    broker.liveprobeState.ingest({
      serviceId: "payments",
      sdk: "node",
      commitSha: NORMALIZED_COMMIT,
      commitSource: "config",
      agentStatus: { state: "green" },
      events: [],
    });
    const result = await withMcp(
      new FakeAnalyzer(),
      new BrokerClient(brokerUrl),
      (client) =>
        client.callTool({
          name: "deploy_investigation_probes",
          arguments: {
            repository_root: "/repo",
            investigation_id: INVESTIGATION_ID,
            created_by: "regression-test",
            correlation_trace_id: "trace-1",
          },
        }),
    );

    const error = envelopeOf(result);
    expect(error.code).toBe("unsupported_correlation_filter");
    expect(error.checks.join(" ")).not.toContain("Python 3.12");
    expect(error.checks.join(" ")).toContain("without correlation_trace_id");
  });

  it("still reports a genuine analyzer failure as analysis_failed", async () => {
    const failing: AnalyzerClient = {
      async run(): Promise<unknown> {
        throw new AnalyzerClientError("could not start python3.12: ENOENT");
      },
      async getPlan(): Promise<AnalyzerPlan> {
        throw new AnalyzerClientError("could not start python3.12: ENOENT");
      },
    };
    const result = await withMcp(failing, offlineBroker(), (client) =>
      client.callTool({
        name: "start_probe_investigation",
        arguments: START_ARGUMENTS,
      }),
    );

    const error = envelopeOf(result);
    expect(error.code).toBe("analysis_failed");
    expect(error.checks.join(" ")).toContain("Python 3.12");
  });

  it("keeps a long poll inside the request deadline instead of aborting itself", async () => {
    // The broker holds a `get_probe_data` request open for `wait_seconds`
    // before answering. A flat request deadline aborts our own long poll,
    // retries it four more times, and then reports a healthy broker as
    // unreachable, which is the r12 `get_probe_data` failure exactly.
    let attempts = 0;
    const brokerClient = new BrokerClient("https://probe.example.invalid", {
      requestTimeoutMs: 40,
      retryBaseDelayMs: 0,
      fetchImplementation: async (input, init) => {
        attempts += 1;
        expect(new URL(String(input)).searchParams.get("waitSeconds")).toBe(
          "1",
        );
        await delay(120);
        if (init?.signal?.aborted === true) throw init.signal.reason;
        return new Response(
          JSON.stringify({
            probe: {
              id: "prb_01JAZM3Y6S8X2V4K9N7Q1T5WCE",
              serviceId: "payments",
              type: "snapshot",
              file: "services/payments/app.py",
              line: 64,
              hitLimit: 5,
              ttlSeconds: 60,
              version: 1,
              createdBy: "regression-test",
              sourceCommit: NORMALIZED_COMMIT,
            },
            status: { status: "armed", updatedAt: new Date().toISOString() },
            events: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(
      brokerClient.getProbeData("prb_01JAZM3Y6S8X2V4K9N7Q1T5WCE", 1),
    ).resolves.toMatchObject({ events: [] });
    expect(attempts).toBe(1);
  });

  it("still aborts a request the broker never answers", async () => {
    // The long-poll allowance must extend the deadline, not remove it.
    const brokerClient = new BrokerClient("https://probe.example.invalid", {
      requestTimeoutMs: 10,
      retryBaseDelayMs: 0,
      maxAttempts: 1,
      fetchImplementation: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    });

    await expect(
      brokerClient.getProbeData("prb_01JAZM3Y6S8X2V4K9N7Q1T5WCE", 0),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
