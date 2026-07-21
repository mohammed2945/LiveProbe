import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import {
  ProbeDefinitionSchema,
  type AgentSdk,
  type ProbeDefinition,
  type ProbeEvent,
  type SerializedNode,
} from "./index.js";

const pollResponseSchema = z.union([
  z
    .object({
      version: z.number().int().nonnegative(),
      unchanged: z.literal(true),
    })
    .strict(),
  z
    .object({
      version: z.number().int().nonnegative(),
      probes: z.array(ProbeDefinitionSchema),
    })
    .strict(),
]);

export interface FakeAgentOptions {
  brokerUrl: string;
  serviceId: string;
  apiKey?: string;
  commitSha?: string;
  sdk?: AgentSdk;
  pollIntervalMs?: number;
  fetchImplementation?: typeof fetch;
  clock?: () => Date;
}

export interface FakeAgentTickResult {
  version: number;
  armed: string[];
  emitted: string[];
}

function serializedString(value: string): SerializedNode {
  return { t: "str", v: value };
}

function renderFakeLog(probe: Extract<ProbeDefinition, { type: "log" }>): string {
  return probe.template.replaceAll(
    /\$\{([^.}]+(?:\.[^.}]+)*)\}/g,
    (_match: string, path: string) => `<fake:${path}>`,
  );
}

export function fabricateEvent(
  probe: ProbeDefinition,
  timestamp: string,
): Exclude<ProbeEvent, { type: "status" }> {
  switch (probe.type) {
    case "snapshot": {
      const watches: Record<string, SerializedNode> = {};
      for (const path of probe.watchPaths ?? []) {
        watches[path] = serializedString(`<fake:${path}>`);
      }
      return {
        probeId: probe.id,
        type: "snapshot",
        ts: timestamp,
        variables: {
          t: "obj",
          c: {
            fakeAgent: { t: "bool", v: true },
            serviceId: serializedString(probe.serviceId),
          },
        },
        watches,
        stack: [
          {
            fn: "fakeAgentHit",
            file: probe.file,
            line: probe.line,
          },
        ],
      };
    }
    case "log":
      return {
        probeId: probe.id,
        type: "log",
        ts: timestamp,
        message: renderFakeLog(probe),
        level: "info",
      };
    case "counter":
      return {
        probeId: probe.id,
        type: "counter",
        ts: timestamp,
        delta: 7,
      };
    case "metric":
      return {
        probeId: probe.id,
        type: "metric",
        ts: timestamp,
        count: 3,
        sum: 42,
        min: 10,
        max: 18,
        last: 14,
      };
  }
}

export class FakeAgent {
  private readonly brokerUrl: string;
  private readonly serviceId: string;
  private readonly apiKey: string | undefined;
  private readonly commitSha: string;
  private readonly sdk: AgentSdk;
  private readonly pollIntervalMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly clock: () => Date;
  private readonly active = new Map<string, ProbeDefinition>();
  private readonly emitted = new Set<string>();
  private version = 0;

  public constructor(options: FakeAgentOptions) {
    this.brokerUrl = options.brokerUrl.replace(/\/+$/, "");
    this.serviceId = options.serviceId;
    this.apiKey = options.apiKey;
    this.commitSha = options.commitSha ?? "abcdef1234567890";
    this.sdk = options.sdk ?? "node";
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.clock = options.clock ?? (() => new Date());

    if (this.brokerUrl.length === 0) {
      throw new Error("brokerUrl must not be empty");
    }
    if (this.serviceId.trim().length === 0) {
      throw new Error("serviceId must not be empty");
    }
    if (
      !Number.isInteger(this.pollIntervalMs) ||
      this.pollIntervalMs <= 0
    ) {
      throw new Error("pollIntervalMs must be a positive integer");
    }
  }

  /**
   * A tick is intentionally deterministic: newly discovered probes are armed
   * first, and fabricated data is emitted on a later tick. This lets clients
   * observe the armed status before the hit status.
   */
  public async tick(): Promise<FakeAgentTickResult> {
    const newlyArmed = await this.poll();
    if (newlyArmed.length > 0) {
      await this.ingest(
        newlyArmed.map((probe) => ({
          probeId: probe.id,
          type: "status" as const,
          ts: this.timestamp(),
          status: "armed" as const,
          detail: `${probe.file}:${probe.line}`,
        })),
      );
      return {
        version: this.version,
        armed: newlyArmed.map((probe) => probe.id),
        emitted: [],
      };
    }

    const events: ProbeEvent[] = [];
    const emitted: string[] = [];
    for (const probe of this.active.values()) {
      if (this.emitted.has(probe.id)) {
        continue;
      }
      const timestamp = this.timestamp();
      events.push(fabricateEvent(probe, timestamp));
      emitted.push(probe.id);
      this.emitted.add(probe.id);
      if (probe.hitLimit === 1) {
        events.push({
          probeId: probe.id,
          type: "status",
          ts: timestamp,
          status: "hit-limit-reached",
          detail: "fake agent consumed the configured hit limit",
        });
      }
    }
    await this.ingest(events);
    return { version: this.version, armed: [], emitted };
  }

  public async heartbeat(): Promise<void> {
    await this.ingest([]);
  }

  public async run(signal?: AbortSignal): Promise<void> {
    const isAborted = (): boolean => signal?.aborted ?? false;
    while (!isAborted()) {
      await this.tick();
      try {
        await delay(this.pollIntervalMs, undefined, {
          signal,
        });
      } catch (error: unknown) {
        if (isAborted()) {
          return;
        }
        throw error;
      }
    }
  }

  private timestamp(): string {
    return this.clock().toISOString();
  }

  private async poll(): Promise<ProbeDefinition[]> {
    const query = new URLSearchParams({ since: String(this.version) });
    const response = await this.fetchImplementation(
      `${this.brokerUrl}/v1/services/${encodeURIComponent(this.serviceId)}/probes?${query.toString()}`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      throw new Error(
        `broker poll failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const payload = pollResponseSchema.parse(await response.json());
    this.version = payload.version;
    if ("unchanged" in payload) {
      return [];
    }

    const nextIds = new Set(payload.probes.map((probe) => probe.id));
    for (const id of this.active.keys()) {
      if (!nextIds.has(id)) {
        this.active.delete(id);
        this.emitted.delete(id);
      }
    }

    const newlyArmed: ProbeDefinition[] = [];
    for (const probe of payload.probes) {
      if (!this.active.has(probe.id)) {
        newlyArmed.push(probe);
      }
      this.active.set(probe.id, probe);
    }
    return newlyArmed;
  }

  private async ingest(events: ProbeEvent[]): Promise<void> {
    const response = await this.fetchImplementation(
      `${this.brokerUrl}/v1/ingest`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          ...(this.apiKey === undefined
            ? {}
            : { authorization: `Bearer ${this.apiKey}` }),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          serviceId: this.serviceId,
          sdk: this.sdk,
          commitSha: this.commitSha,
          commitSource: "config",
          agentStatus: {
            state: "green",
            detail: `${this.active.size} fake probes active`,
          },
          events,
        }),
      },
    );
    if (response.status !== 202) {
      throw new Error(
        `broker ingest failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
  }
}
