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
  type AnalyzerPlan,
  BrokerClient,
  createMcpServer,
  createToolHandlers,
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
        "analyze_probe_candidates",
        "apply_investigation_decision",
        "collect_investigation_evidence",
        "deploy_investigation_probes",
        "deploy_probe_frontier",
        "get_investigation_context",
        "get_investigation_result",
        "get_probe_data",
        "get_safety_overview",
        "list_audit_events",
        "list_probes",
        "list_services",
        "ping_broker",
        "prepare_repository_analysis",
        "refine_probe_candidates",
        "remove_probe",
        "set_counter_probe",
        "set_log_probe",
        "set_metric_probe",
        "set_snapshot_probe",
        "start_probe_investigation",
      ]);
      const ping = await client.callTool({ name: "ping_broker", arguments: {} });
      expect(ping.isError).not.toBe(true);
      expect(ping.content).toEqual([{ type: "text", text: '{\n  "ok": true\n}' }]);
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
        "analyze_probe_candidates",
        "apply_investigation_decision",
        "collect_investigation_evidence",
        "deploy_investigation_probes",
        "deploy_probe_frontier",
        "get_investigation_context",
        "get_investigation_result",
        "get_probe_data",
        "get_safety_overview",
        "list_audit_events",
        "list_probes",
        "list_services",
        "ping_broker",
        "prepare_repository_analysis",
        "refine_probe_candidates",
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
});
