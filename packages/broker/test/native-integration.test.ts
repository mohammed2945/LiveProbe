import { describe, expect, it } from "vitest";

import {
  buildBroker,
  createServiceCredentialMaterial,
  hashBearerToken,
  type BrokerState,
  type BrokerStore,
  type NativeCredentialRecord,
  type ResourceScope,
  type ServiceCredentialRecord,
  type StoredNativeCredential,
  type StoredServiceCredential,
} from "../src/index.js";

class CredentialTestStore implements BrokerStore {
  private readonly native = new Map<string, StoredNativeCredential>();
  private readonly services = new Map<string, StoredServiceCredential>();

  public async restore(_state: BrokerState): Promise<void> {}
  public async persist(_state: BrokerState): Promise<void> {}
  public async close(): Promise<void> {}

  public async createNativeCredential(
    credential: StoredNativeCredential,
  ): Promise<NativeCredentialRecord> {
    this.native.set(credential.secretHash, credential);
    const { secretHash: _secretHash, ...record } = credential;
    return record;
  }

  public async listNativeCredentials(
    scope: ResourceScope,
  ): Promise<NativeCredentialRecord[]> {
    return [...this.native.values()]
      .filter((item) =>
        item.tenantId === scope.tenantId &&
        item.projectId === scope.projectId &&
        item.environmentId === scope.environmentId)
      .map(({ secretHash: _secretHash, ...record }) => record);
  }

  public async revokeNativeCredential(
    credentialId: string,
    scope: ResourceScope,
  ): Promise<boolean> {
    for (const [hash, credential] of this.native) {
      if (
        credential.credentialId === credentialId &&
        credential.tenantId === scope.tenantId &&
        credential.projectId === scope.projectId &&
        credential.environmentId === scope.environmentId
      ) {
        this.native.set(hash, {
          ...credential,
          revokedAt: new Date().toISOString(),
        });
        return true;
      }
    }
    return false;
  }

  public async authenticateNativeCredential(
    secretHash: string,
  ): Promise<NativeCredentialRecord | undefined> {
    const credential = this.native.get(secretHash);
    if (credential === undefined || credential.revokedAt !== undefined) {
      return undefined;
    }
    const { secretHash: _secretHash, ...record } = credential;
    return record;
  }

  public addServiceCredential(credential: StoredServiceCredential): void {
    this.services.set(credential.secretHash, credential);
  }

  public async authenticateServiceCredential(
    secretHash: string,
  ): Promise<ServiceCredentialRecord | undefined> {
    const credential = this.services.get(secretHash);
    if (credential === undefined) return undefined;
    const { secretHash: _secretHash, ...record } = credential;
    return record;
  }
}

const adminAuthorization = { authorization: "Bearer admin-test-key" };
const instance = {
  instanceId: "orders-100-10",
  serviceId: "orders-native",
  language: "rust" as const,
  pid: 100,
  processStartTime: "10",
  executablePath: "/opt/orders",
  buildId: "abcdef1234567890",
  architecture: "x86_64" as const,
  capabilities: ["uprobe", "count", "counter"] as const,
  lastSeen: "2026-07-24T00:00:00.000Z",
};

describe("scoped native integration", () => {
  it("versions every attachment-relevant native instance change", async () => {
    const broker = await buildBroker({ store: false });
    try {
      expect((await broker.inject({
        method: "POST",
        url: "/v1/native/agents/register",
        payload: {
          agentId: "host-a",
          hostname: "local",
          backend: "native-ebpf",
          architecture: "x86_64",
          capabilities: ["uprobe", "count", "counter"],
          agentVersion: "0.2.0",
        },
      })).statusCode).toBe(201);
      expect((await broker.inject({
        method: "PUT",
        url: "/v1/native/agents/host-a/instances",
        payload: { instances: [instance] },
      })).statusCode).toBe(202);
      const initial = (await broker.inject({
        method: "GET",
        url: "/v1/native/agents/host-a/assignments?since=0",
      })).json<{ version: number }>();

      expect((await broker.inject({
        method: "PUT",
        url: "/v1/native/agents/host-a/instances",
        payload: {
          instances: [{
            ...instance,
            cgroup: "/system.slice/orders-v2",
            lastSeen: "2026-07-24T00:01:00.000Z",
          }],
        },
      })).statusCode).toBe(202);
      const changed = (await broker.inject({
        method: "GET",
        url: `/v1/native/agents/host-a/assignments?since=${initial.version}`,
      })).json<{ version: number; assignments: unknown[] }>();
      expect(changed.version).toBeGreaterThan(initial.version);
      expect(changed.assignments).toHaveLength(1);

      expect((await broker.inject({
        method: "PUT",
        url: "/v1/native/agents/host-a/instances",
        payload: {
          instances: [{
            ...instance,
            cgroup: "/system.slice/orders-v2",
            lastSeen: "2026-07-24T00:02:00.000Z",
          }],
        },
      })).statusCode).toBe(202);
      expect((await broker.inject({
        method: "GET",
        url: `/v1/native/agents/host-a/assignments?since=${changed.version}`,
      })).json()).toEqual({ version: changed.version, assignments: [] });

      expect((await broker.inject({
        method: "PUT",
        url: "/v1/native/agents/host-a/instances",
        payload: { instances: [] },
      })).statusCode).toBe(202);
      expect((await broker.inject({
        method: "GET",
        url: "/v1/services",
      })).json<{ services: Array<{ serviceId: string }> }>().services)
        .not.toContainEqual(expect.objectContaining({
          serviceId: instance.serviceId,
        }));
    } finally {
      await broker.close();
    }
  });

  it("creates, scopes, uses, lists, and immediately revokes a host credential", async () => {
    const store = new CredentialTestStore();
    const broker = await buildBroker({ apiKey: "admin-test-key", store });
    try {
      const created = await broker.inject({
        method: "POST",
        url: "/v1/native-credentials",
        headers: adminAuthorization,
        payload: {
          agentId: "host-a",
          allowedServiceIds: ["orders-native"],
          label: "local test host",
        },
      });
      expect(created.statusCode).toBe(201);
      const material = created.json<{
        apiKey: string;
        credential: NativeCredentialRecord;
      }>();
      expect(material.apiKey).toMatch(/^lp_native_/);
      expect(JSON.stringify(material.credential)).not.toContain(material.apiKey);

      const nativeAuthorization = {
        authorization: `Bearer ${material.apiKey}`,
      };
      expect((await broker.inject({
        method: "POST",
        url: "/v1/native/agents/register",
        headers: nativeAuthorization,
        payload: {
          agentId: "wrong-host",
          hostname: "local",
          backend: "native-ebpf",
          architecture: "x86_64",
          capabilities: ["uprobe"],
          agentVersion: "0.2.0",
        },
      })).statusCode).toBe(403);

      const registered = await broker.inject({
        method: "POST",
        url: "/v1/native/agents/register",
        headers: nativeAuthorization,
        payload: {
          agentId: "host-a",
          hostname: "local",
          backend: "native-ebpf",
          architecture: "x86_64",
          capabilities: ["uprobe", "count", "counter"],
          agentVersion: "0.2.0",
        },
      });
      expect(registered.statusCode).toBe(201);
      expect(registered.json()).toMatchObject({
        agentId: "host-a",
        allowedServiceIds: ["orders-native"],
      });

      expect((await broker.inject({
        method: "PUT",
        url: "/v1/native/agents/host-a/instances",
        headers: nativeAuthorization,
        payload: {
          instances: [{ ...instance, serviceId: "not-allowed" }],
        },
      })).statusCode).toBe(403);
      expect((await broker.inject({
        method: "PUT",
        url: "/v1/native/agents/host-a/instances",
        headers: nativeAuthorization,
        payload: { instances: [instance, {
          ...instance,
          instanceId: "orders-101-11",
          pid: 101,
          processStartTime: "11",
        }] },
      })).statusCode).toBe(202);

      const listed = await broker.inject({
        method: "GET",
        url: "/v1/native-credentials",
        headers: adminAuthorization,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.body).not.toContain(material.apiKey);
      expect(listed.body).not.toContain(hashBearerToken(material.apiKey));

      expect((await broker.inject({
        method: "DELETE",
        url: `/v1/native-credentials/${material.credential.credentialId}`,
        headers: adminAuthorization,
      })).statusCode).toBe(204);
      expect((await broker.inject({
        method: "GET",
        url: "/v1/native/agents/host-a/assignments?since=0",
        headers: nativeAuthorization,
      })).statusCode).toBe(401);
    } finally {
      await broker.close();
    }
  });

  it("keeps native assignment/status identity per instance and rejects advanced input", async () => {
    const broker = await buildBroker({ store: false });
    try {
      await broker.inject({
        method: "POST",
        url: "/v1/native/agents/register",
        payload: {
          agentId: "host-a",
          hostname: "local",
          backend: "native-ebpf",
          architecture: "x86_64",
          capabilities: ["uprobe", "count", "counter"],
          agentVersion: "0.2.0",
        },
      });
      await broker.inject({
        method: "PUT",
        url: "/v1/native/agents/host-a/instances",
        payload: { instances: [instance, {
          ...instance,
          instanceId: "orders-101-11",
          pid: 101,
          processStartTime: "11",
        }] },
      });
      const unsupported = await broker.inject({
        method: "POST",
        url: "/v1/probes",
        payload: {
          serviceId: "orders-native",
          sourceCommit: "abcdef1",
          type: "snapshot",
          file: "src/main.rs",
          line: 10,
          watchExpressions: ["request.user.id"],
          createdBy: "test",
        },
      });
      expect(unsupported.statusCode).toBe(409);
      expect(unsupported.json()).toMatchObject({
        error: { code: "unsupported_by_backend" },
      });

      const tooManyCapturePaths = await broker.inject({
        method: "POST",
        url: "/v1/probes",
        payload: {
          serviceId: "orders-native",
          sourceCommit: "abcdef1",
          type: "snapshot",
          file: "src/main.rs",
          line: 10,
          watchPaths: Array.from(
            { length: 8 },
            (_, index) => `request.value_${index}`,
          ),
          condition: {
            path: "request.condition_only",
            op: "eq",
            value: 1,
          },
          createdBy: "test",
        },
      });
      expect(tooManyCapturePaths.statusCode).toBe(409);
      expect(tooManyCapturePaths.json()).toMatchObject({
        error: { code: "unsupported_by_backend" },
      });
      expect(tooManyCapturePaths.json()).toMatchObject({
        error: { message: expect.stringContaining("at most 8") },
      });

      const duplicateConditionPath = await broker.inject({
        method: "POST",
        url: "/v1/probes",
        payload: {
          serviceId: "orders-native",
          sourceCommit: "abcdef1",
          type: "snapshot",
          file: "src/main.rs",
          line: 10,
          watchPaths: Array.from(
            { length: 8 },
            (_, index) => `request.value_${index}`,
          ),
          condition: {
            path: "request.value_0",
            op: "eq",
            value: 1,
          },
          createdBy: "test",
        },
      });
      expect(duplicateConditionPath.statusCode).toBe(201);

      const conditionalCounter = await broker.inject({
        method: "POST",
        url: "/v1/probes",
        payload: {
          serviceId: "orders-native",
          sourceCommit: "abcdef1",
          type: "counter",
          file: "src/main.rs",
          line: 10,
          condition: {
            path: "request.value_0",
            op: "eq",
            value: 1,
          },
          createdBy: "test",
        },
      });
      expect(conditionalCounter.statusCode).toBe(409);
      expect(conditionalCounter.json()).toMatchObject({
        error: { code: "unsupported_by_backend" },
      });

      const created = await broker.inject({
        method: "POST",
        url: "/v1/probes",
        payload: {
          serviceId: "orders-native",
          sourceCommit: "abcdef1",
          type: "counter",
          file: "src/main.rs",
          line: 10,
          createdBy: "test",
        },
      });
      const probe = created.json<{ probe: { id: string; version: number } }>().probe;
      const assigned = await broker.inject({
        method: "GET",
        url: "/v1/native/agents/host-a/assignments?since=0",
      });
      expect(assigned.json<{ assignments: unknown[] }>().assignments).toHaveLength(2);
      const version = assigned.json<{ version: number }>().version;
      expect((await broker.inject({
        method: "GET",
        url: `/v1/native/agents/host-a/assignments?since=${version}`,
      })).json()).toEqual({ version, assignments: [] });

      // The ingest guard drops a status older than the one already stored, so
      // this scenario only exercises anything if each timestamp is ordered
      // against the one before it. Anchoring them to the run's own clock keeps
      // that true; fixed literals silently stop testing the guard on the day
      // the wall clock passes them.
      const firstArmedTs = Date.now();
      const terminalTs = new Date(firstArmedTs + 120_000).toISOString();
      const staleArmedTs = new Date(firstArmedTs + 60_000).toISOString();

      const armed = await broker.inject({
        method: "POST",
        url: "/v1/native/ingest",
        payload: {
          agentId: "host-a",
          serviceId: "orders-native",
          instanceId: instance.instanceId,
          buildId: instance.buildId,
          backend: "native-ebpf",
          agentStatus: { state: "green" },
          events: [{
            probeId: probe.id,
            probeVersion: probe.version,
            type: "status",
            ts: new Date(firstArmedTs).toISOString(),
            status: "armed",
            agentId: "host-a",
            instanceId: instance.instanceId,
            buildId: instance.buildId,
            physicalSiteCount: 1,
          }],
        },
      });
      expect(armed.statusCode).toBe(202);
      expect((await broker.inject({
        method: "GET",
        url: `/v1/probes/${probe.id}/data`,
      })).json()).toMatchObject({
        status: {
          status: "armed",
          agentId: "host-a",
          instanceId: instance.instanceId,
          buildId: instance.buildId,
          probeVersion: probe.version,
          physicalSiteCount: 1,
        },
      });

      const rejected = await broker.inject({
        method: "POST",
        url: "/v1/native/ingest",
        payload: {
          agentId: "host-a",
          serviceId: "orders-native",
          instanceId: instance.instanceId,
          buildId: instance.buildId,
          backend: "native-ebpf",
          agentStatus: { state: "green" },
          events: [{
            probeId: probe.id,
            probeVersion: probe.version,
            type: "counter",
            ts: new Date().toISOString(),
            delta: 1,
          }, {
            probeId: "prb_00000000000000000000000000",
            probeVersion: probe.version,
            type: "counter",
            ts: new Date().toISOString(),
            delta: 1,
          }],
        },
      });
      expect(rejected.statusCode).toBe(400);
      expect((await broker.inject({
        method: "GET",
        url: `/v1/probes/${probe.id}/data`,
      })).json<{ events: unknown[] }>().events).toEqual([
        expect.objectContaining({ type: "status", status: "armed" }),
      ]);

      const stale = await broker.inject({
        method: "POST",
        url: "/v1/native/ingest",
        payload: {
          agentId: "host-a",
          serviceId: "orders-native",
          instanceId: instance.instanceId,
          buildId: instance.buildId,
          backend: "native-ebpf",
          agentStatus: { state: "green" },
          events: [{
            probeId: probe.id,
            probeVersion: probe.version + 1,
            type: "counter",
            ts: new Date().toISOString(),
            delta: 1,
          }],
        },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        error: { code: "probe_version_changed" },
      });

      expect((await broker.inject({
        method: "POST",
        url: "/v1/native/ingest",
        payload: {
          agentId: "host-a",
          serviceId: "orders-native",
          instanceId: instance.instanceId,
          buildId: instance.buildId,
          backend: "native-ebpf",
          agentStatus: { state: "green" },
          events: [{
            probeId: probe.id,
            probeVersion: probe.version,
            type: "status",
            ts: terminalTs,
            status: "hit-limit-reached",
            agentId: "host-a",
            instanceId: instance.instanceId,
            buildId: instance.buildId,
          }],
        },
      })).statusCode).toBe(202);
      expect((await broker.inject({
        method: "POST",
        url: "/v1/native/ingest",
        payload: {
          agentId: "host-a",
          serviceId: "orders-native",
          instanceId: instance.instanceId,
          buildId: instance.buildId,
          backend: "native-ebpf",
          agentStatus: { state: "green" },
          events: [{
            probeId: probe.id,
            probeVersion: probe.version,
            type: "status",
            ts: staleArmedTs,
            status: "armed",
            agentId: "host-a",
            instanceId: instance.instanceId,
            buildId: instance.buildId,
          }],
        },
      })).statusCode).toBe(202);
      const afterTerminal = (await broker.inject({
        method: "GET",
        url: "/v1/native/agents/host-a/assignments?since=0",
      })).json<{
        assignments: Array<{
          instanceId: string;
          probes: Array<{ id: string }>;
        }>;
      }>();
      expect(
        afterTerminal.assignments.find(
          (assignment) => assignment.instanceId === instance.instanceId,
        )?.probes,
      ).not.toContainEqual(expect.objectContaining({ id: probe.id }));

      await broker.inject({
        method: "POST",
        url: "/v1/native/agents/register",
        payload: {
          agentId: "host-b",
          hostname: "host-b",
          backend: "native-ebpf",
          architecture: "x86_64",
          capabilities: ["uprobe", "counter"],
          agentVersion: "0.2.0",
        },
      });
      const collision = await broker.inject({
        method: "PUT",
        url: "/v1/native/agents/host-b/instances",
        payload: { instances: [instance] },
      });
      expect(collision.statusCode).toBe(409);
      expect(collision.json()).toMatchObject({
        error: { code: "native_instance_owned" },
      });
    } finally {
      await broker.close();
    }
  });

  it("does not allow managed service credentials onto native routes", async () => {
    const store = new CredentialTestStore();
    const material = createServiceCredentialMaterial({
      serviceId: "orders-native",
      label: "managed",
    });
    store.addServiceCredential(material.record);
    const broker = await buildBroker({ apiKey: "admin-test-key", store });
    try {
      expect((await broker.inject({
        method: "POST",
        url: "/v1/native/agents/register",
        headers: { authorization: `Bearer ${material.apiKey}` },
        payload: {
          agentId: "host-a",
          hostname: "local",
          backend: "native-ebpf",
          architecture: "x86_64",
          capabilities: ["uprobe"],
          agentVersion: "0.2.0",
        },
      })).statusCode).toBe(403);
    } finally {
      await broker.close();
    }
  });

  it("does not let a later armed status resurrect a suspended probe", async () => {
    const broker = await buildBroker({ store: false });
    try {
      await broker.inject({
        method: "POST",
        url: "/v1/native/agents/register",
        payload: {
          agentId: "host-a",
          hostname: "local",
          backend: "native-ebpf",
          architecture: "x86_64",
          capabilities: ["uprobe", "count", "counter"],
          agentVersion: "0.2.0",
        },
      });
      await broker.inject({
        method: "PUT",
        url: "/v1/native/agents/host-a/instances",
        payload: { instances: [instance] },
      });
      const probe = (await broker.inject({
        method: "POST",
        url: "/v1/probes",
        payload: {
          serviceId: "orders-native",
          sourceCommit: "abcdef1",
          type: "counter",
          file: "src/main.rs",
          line: 10,
          createdBy: "test",
        },
      })).json<{ probe: { id: string; version: number } }>().probe;

      const base = Date.now();
      const ingestStatus = (offsetMs: number, status: string) => broker.inject({
        method: "POST",
        url: "/v1/native/ingest",
        payload: {
          agentId: "host-a",
          serviceId: "orders-native",
          instanceId: instance.instanceId,
          buildId: instance.buildId,
          backend: "native-ebpf",
          agentStatus: { state: "green" },
          events: [{
            probeId: probe.id,
            probeVersion: probe.version,
            type: "status",
            ts: new Date(base + offsetMs).toISOString(),
            status,
            ...(status === "suspended"
              ? { reasonCode: "raw-hit-budget-exceeded" as const }
              : {}),
            agentId: "host-a",
            instanceId: instance.instanceId,
            buildId: instance.buildId,
          }],
        },
      });

      expect((await ingestStatus(0, "armed")).statusCode).toBe(202);
      expect((await ingestStatus(100, "suspended")).statusCode).toBe(202);
      const assignedAfterSuspend = (await broker.inject({
        method: "GET",
        url: "/v1/native/agents/host-a/assignments?since=0",
      })).json<{ assignments: Array<{ probes: Array<{ id: string }> }> }>();
      expect(assignedAfterSuspend.assignments.flatMap((a) => a.probes))
        .not.toContainEqual(expect.objectContaining({ id: probe.id }));

      // A sibling physical site of the same probe reports armed after the
      // suspension. Status is not keyed by site, so honouring the newer write
      // would erase the suspension and put the probe back into desired state
      // with its raw-hit budget already blown.
      expect((await ingestStatus(200, "armed")).statusCode).toBe(202);
      const assignedAfterRearm = (await broker.inject({
        method: "GET",
        url: "/v1/native/agents/host-a/assignments?since=0",
      })).json<{ assignments: Array<{ probes: Array<{ id: string }> }> }>();
      expect(assignedAfterRearm.assignments.flatMap((a) => a.probes))
        .not.toContainEqual(expect.objectContaining({ id: probe.id }));
      expect((await broker.inject({
        method: "GET",
        url: `/v1/probes/${probe.id}/data`,
      })).json()).toMatchObject({
        status: { status: "suspended", reasonCode: "raw-hit-budget-exceeded" },
      });
    } finally {
      await broker.close();
    }
  });

  it("keeps armedAt on a native probe that arms and then hits its limit", async () => {
    const broker = await buildBroker({ store: false });
    try {
      await broker.inject({
        method: "POST",
        url: "/v1/native/agents/register",
        payload: {
          agentId: "host-a",
          hostname: "local",
          backend: "native-ebpf",
          architecture: "x86_64",
          capabilities: ["uprobe", "count", "counter"],
          agentVersion: "0.2.0",
        },
      });
      await broker.inject({
        method: "PUT",
        url: "/v1/native/agents/host-a/instances",
        payload: { instances: [instance] },
      });
      const probe = (await broker.inject({
        method: "POST",
        url: "/v1/probes",
        payload: {
          serviceId: "orders-native",
          sourceCommit: "abcdef1",
          type: "counter",
          file: "src/main.rs",
          line: 10,
          createdBy: "test",
        },
      })).json<{ probe: { id: string; version: number } }>().probe;

      const armedTs = new Date().toISOString();
      const terminalTs = new Date(Date.parse(armedTs) + 60_000).toISOString();
      const ingestStatus = (ts: string, status: string) => broker.inject({
        method: "POST",
        url: "/v1/native/ingest",
        payload: {
          agentId: "host-a",
          serviceId: "orders-native",
          instanceId: instance.instanceId,
          buildId: instance.buildId,
          backend: "native-ebpf",
          agentStatus: { state: "green" },
          events: [{
            probeId: probe.id,
            probeVersion: probe.version,
            type: "status",
            ts,
            status,
            agentId: "host-a",
            instanceId: instance.instanceId,
            buildId: instance.buildId,
          }],
        },
      });

      expect((await ingestStatus(armedTs, "armed")).statusCode).toBe(202);
      expect((await broker.inject({
        method: "GET",
        url: `/v1/probes/${probe.id}/data`,
      })).json()).toMatchObject({
        status: { status: "armed", armedAt: armedTs },
      });

      // The per-instance native statuses this derives from never carry
      // armedAt, so leaving `armed` must not take it with them.
      expect(
        (await ingestStatus(terminalTs, "hit-limit-reached")).statusCode,
      ).toBe(202);
      expect((await broker.inject({
        method: "GET",
        url: `/v1/probes/${probe.id}/data`,
      })).json()).toMatchObject({
        status: { status: "hit-limit-reached", armedAt: armedTs },
      });
    } finally {
      await broker.close();
    }
  });

  it("keeps a live probe's evidence when the same batch carries a removed probe's late events", async () => {
    // `remove_probe` deletes the logical probe at once, but the uprobe detaches
    // only on the agent's next poll, so hits captured in between arrive after
    // the probe is gone. They ride in the same batch as evidence for probes
    // that are still live. Rejecting the batch discarded all of it, and since
    // the condition recurred on every flush the agent stopped delivering
    // anything until it was restarted — while probes still reported `armed`.
    const broker = await buildBroker({ store: false });
    try {
      await broker.inject({
        method: "POST",
        url: "/v1/native/agents/register",
        payload: {
          agentId: "host-a",
          hostname: "local",
          backend: "native-ebpf",
          architecture: "x86_64",
          capabilities: ["uprobe", "count", "counter"],
          agentVersion: "0.2.0",
        },
      });
      await broker.inject({
        method: "PUT",
        url: "/v1/native/agents/host-a/instances",
        payload: { instances: [instance] },
      });

      const createProbe = async (line: number) => (await broker.inject({
        method: "POST",
        url: "/v1/probes",
        payload: {
          serviceId: "orders-native",
          sourceCommit: "abcdef1",
          type: "counter",
          file: "src/main.rs",
          line,
          createdBy: "test",
        },
      })).json<{ probe: { id: string; version: number } }>().probe;

      const removed = await createProbe(10);
      const live = await createProbe(20);

      expect((await broker.inject({
        method: "DELETE",
        url: `/v1/probes/${removed.id}`,
      })).statusCode).toBe(204);

      const status = (probe: { id: string; version: number }) => ({
        probeId: probe.id,
        probeVersion: probe.version,
        type: "status" as const,
        ts: new Date().toISOString(),
        status: "armed",
        agentId: "host-a",
        instanceId: instance.instanceId,
        buildId: instance.buildId,
      });

      // The stale event is deliberately first: the old code threw on it before
      // ever reaching the live probe's event.
      const response = await broker.inject({
        method: "POST",
        url: "/v1/native/ingest",
        payload: {
          agentId: "host-a",
          serviceId: "orders-native",
          instanceId: instance.instanceId,
          buildId: instance.buildId,
          backend: "native-ebpf",
          agentStatus: { state: "green" },
          events: [status(removed), status(live)],
        },
      });

      expect(response.statusCode).toBe(202);
      // Only the live event is retained, and the caller is told so rather than
      // being given the submitted count.
      expect(response.json()).toMatchObject({ accepted: 1 });
      expect((await broker.inject({
        method: "GET",
        url: `/v1/probes/${live.id}/data`,
      })).json()).toMatchObject({ status: { status: "armed" } });
    } finally {
      await broker.close();
    }
  });

  it("reports discarded evidence in the safety overview instead of failing silently", async () => {
    // The bug this guards against was invisible: probes reported `armed` while
    // every batch was rejected and dropped. Whatever else changes, a service
    // losing evidence must say so somewhere the client actually looks.
    const broker = await buildBroker({ store: false });
    try {
      await broker.inject({
        method: "POST",
        url: "/v1/native/agents/register",
        payload: {
          agentId: "host-a",
          hostname: "local",
          backend: "native-ebpf",
          architecture: "x86_64",
          capabilities: ["uprobe", "count", "counter"],
          agentVersion: "0.2.0",
        },
      });
      await broker.inject({
        method: "PUT",
        url: "/v1/native/agents/host-a/instances",
        payload: { instances: [instance] },
      });

      const clean = (await broker.inject({
        method: "GET",
        url: "/v1/safety",
      })).json<{ services: Array<{ serviceId: string; evidence?: unknown }> }>();
      expect(
        clean.services.find((s) => s.serviceId === "orders-native")?.evidence,
      ).toBeUndefined();

      // An id that was never issued is a genuine inconsistency and still 400s.
      expect((await broker.inject({
        method: "POST",
        url: "/v1/native/ingest",
        payload: {
          agentId: "host-a",
          serviceId: "orders-native",
          instanceId: instance.instanceId,
          buildId: instance.buildId,
          backend: "native-ebpf",
          agentStatus: { state: "green" },
          events: [{
            probeId: "prb_00000000000000000000000000",
            probeVersion: 1,
            type: "counter",
            ts: new Date().toISOString(),
            delta: 1,
          }],
        },
      })).statusCode).toBe(400);

      const after = (await broker.inject({
        method: "GET",
        url: "/v1/safety",
      })).json<{
        services: Array<{
          serviceId: string;
          caveats: string[];
          evidence?: { rejectedBatches: number; lastRejectionCode?: string };
        }>;
      }>();
      const service = after.services.find((s) => s.serviceId === "orders-native");
      expect(service?.evidence).toMatchObject({
        rejectedBatches: 1,
        lastRejectionCode: "invalid_request",
      });
      expect(service?.caveats.join(" ")).toContain("Evidence is being discarded");
    } finally {
      await broker.close();
    }
  });

  it("still rejects a batch carrying another service's probe", async () => {
    // The skip above must not become a blanket amnesty: a probe belonging to a
    // different service is an inconsistency, not a detach race.
    const broker = await buildBroker({ store: false });
    try {
      await broker.inject({
        method: "POST",
        url: "/v1/native/agents/register",
        payload: {
          agentId: "host-a",
          hostname: "local",
          backend: "native-ebpf",
          architecture: "x86_64",
          capabilities: ["uprobe", "count", "counter"],
          agentVersion: "0.2.0",
        },
      });
      await broker.inject({
        method: "PUT",
        url: "/v1/native/agents/host-a/instances",
        payload: { instances: [instance] },
      });
      const foreign = (await broker.inject({
        method: "POST",
        url: "/v1/probes",
        payload: {
          serviceId: "some-other-service",
          sourceCommit: "abcdef1",
          type: "counter",
          file: "src/main.rs",
          line: 10,
          createdBy: "test",
        },
      })).json<{ probe: { id: string; version: number } }>().probe;

      const response = await broker.inject({
        method: "POST",
        url: "/v1/native/ingest",
        payload: {
          agentId: "host-a",
          serviceId: "orders-native",
          instanceId: instance.instanceId,
          buildId: instance.buildId,
          backend: "native-ebpf",
          agentStatus: { state: "green" },
          events: [{
            probeId: foreign.id,
            probeVersion: foreign.version,
            type: "status",
            ts: new Date().toISOString(),
            status: "armed",
            agentId: "host-a",
            instanceId: instance.instanceId,
            buildId: instance.buildId,
          }],
        },
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await broker.close();
    }
  });
});
