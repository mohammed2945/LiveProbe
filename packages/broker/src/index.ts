import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { z, ZodError } from "zod";

import { PostgresStore } from "./store/postgres.js";
import {
  resolveSourceLocation,
  stripSourcesContent,
  validateSourceMap,
  type StoredSourceMap,
} from "./source-map-resolver.js";

export { PostgresStore } from "./store/postgres.js";
export {
  DEFAULT_ENVIRONMENT_ID,
  DEFAULT_PROJECT_ID,
  DEFAULT_TENANT_ID,
} from "./store/migrations.js";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DEFAULT_TTL_SECONDS = 1_800;
const DEFAULT_RING_CAPACITY = 500;
const DEFAULT_TTL_SWEEP_INTERVAL_MS = 10_000;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 15_000;
const SOURCE_MAP_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const SOURCE_MAP_COMMITS_PER_SERVICE = 5;

const serviceIdSchema = z.string().trim().min(1).max(200);
const probeIdSchema = z
  .string()
  .regex(/^prb_[0-9A-HJKMNP-TV-Z]{26}$/, "invalid probe id");
const sourceFileSchema = z.string().trim().min(1).max(4_096);
const sourceCommitSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F]{7,64}$/,
    "must be a 7-64 character hexadecimal Git object ID",
  )
  .transform((value) => value.toLowerCase());
const commitShaSchema = sourceCommitSchema;
const commitSourceSchema = z.enum(["env", "config"]);
const uploaderIdSchema = z.string().trim().min(1).max(200);
const sourceMapPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => value.endsWith(".js.map"), "must end with .js.map")
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").includes(".."),
    "must be a normalized relative path",
  );
const dotPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .regex(/^[^.]+(?:\.[^.]+)*$/, "must be a dot path with non-empty segments");
const timestampSchema = z.string().datetime({ offset: true });
const jsonScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const ConditionSchema = z
  .object({
    path: dotPathSchema,
    op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]),
    value: jsonScalarSchema,
  })
  .strict();

const createCommonShape = {
  serviceId: serviceIdSchema,
  sourceCommit: sourceCommitSchema.optional(),
  file: sourceFileSchema,
  line: z.number().int().positive(),
  condition: ConditionSchema.optional(),
  ttlSeconds: z.number().int().positive().default(DEFAULT_TTL_SECONDS),
  createdBy: z.string().trim().min(1).max(500),
} as const;

export const CreateProbeSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...createCommonShape,
      type: z.literal("snapshot"),
      watchPaths: z.array(dotPathSchema).max(100).optional(),
      hitLimit: z.number().int().positive().default(1),
    })
    .strict(),
  z
    .object({
      ...createCommonShape,
      type: z.literal("log"),
      template: z.string().min(1).max(16_384),
      hitLimit: z.number().int().positive().default(100),
    })
    .strict(),
  z
    .object({
      ...createCommonShape,
      type: z.literal("counter"),
      hitLimit: z.number().int().positive().default(10_000),
    })
    .strict(),
  z
    .object({
      ...createCommonShape,
      type: z.literal("metric"),
      metricPath: dotPathSchema,
      hitLimit: z.number().int().positive().default(10_000),
    })
    .strict(),
]);

const definitionCommonShape = {
  id: probeIdSchema,
  serviceId: serviceIdSchema,
  sourceCommit: sourceCommitSchema.optional(),
  file: sourceFileSchema,
  line: z.number().int().positive(),
  runtimeLocation: sourceFileSchema.optional(),
  runtimeLine: z.number().int().positive().optional(),
  runtimeColumn: z.number().int().nonnegative().optional(),
  condition: ConditionSchema.optional(),
  ttlSeconds: z.number().int().positive(),
  hitLimit: z.number().int().positive(),
  version: z.number().int().positive(),
  createdBy: z.string().trim().min(1).max(500),
} as const;

export const ProbeDefinitionSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...definitionCommonShape,
      type: z.literal("snapshot"),
      watchPaths: z.array(dotPathSchema).max(100).optional(),
    })
    .strict(),
  z
    .object({
      ...definitionCommonShape,
      type: z.literal("log"),
      template: z.string().min(1).max(16_384),
    })
    .strict(),
  z
    .object({
      ...definitionCommonShape,
      type: z.literal("counter"),
    })
    .strict(),
  z
    .object({
      ...definitionCommonShape,
      type: z.literal("metric"),
      metricPath: dotPathSchema,
    })
    .strict(),
]);

export type CreateProbeInput = z.infer<typeof CreateProbeSchema>;
export type ProbeDefinition = z.infer<typeof ProbeDefinitionSchema>;
export type ProbeType = ProbeDefinition["type"];

export type SerializedNode =
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "null"; v: null }
  | { t: "fn" }
  | { t: "redacted" }
  | {
      t: "truncated";
      v: "depth" | "array" | "props" | "string" | "circular" | "unsupported";
    }
  | {
      t: "obj";
      c: Record<string, SerializedNode>;
      m?: { t: "truncated"; v: "props" } | undefined;
    }
  | {
      t: "arr";
      c: SerializedNode[];
      m?: { t: "truncated"; v: "array" } | undefined;
    };

export const SerializedNodeSchema: z.ZodType<SerializedNode> = z.lazy(() =>
  z.discriminatedUnion("t", [
    z.object({ t: z.literal("str"), v: z.string() }).strict(),
    z.object({ t: z.literal("num"), v: z.number().finite() }).strict(),
    z.object({ t: z.literal("bool"), v: z.boolean() }).strict(),
    z.object({ t: z.literal("null"), v: z.null() }).strict(),
    z.object({ t: z.literal("fn") }).strict(),
    z.object({ t: z.literal("redacted") }).strict(),
    z
      .object({
        t: z.literal("truncated"),
        v: z.enum([
          "depth",
          "array",
          "props",
          "string",
          "circular",
          "unsupported",
        ]),
      })
      .strict(),
    z
      .object({
        t: z.literal("obj"),
        c: z.record(z.string(), SerializedNodeSchema),
        m: z
          .object({
            t: z.literal("truncated"),
            v: z.literal("props"),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        t: z.literal("arr"),
        c: z.array(SerializedNodeSchema),
        m: z
          .object({
            t: z.literal("truncated"),
            v: z.literal("array"),
          })
          .strict()
          .optional(),
      })
      .strict(),
  ]),
);

const stackFrameSchema = z
  .object({
    fn: z.string().max(1_024),
    file: z.string().max(4_096),
    line: z.number().int().positive(),
  })
  .strict();

export const StatusNameSchema = z.enum([
  "armed",
  "error",
  "hit-limit-reached",
  "suspended",
  "expired",
]);

const eventCommonShape = {
  probeId: probeIdSchema,
  ts: timestampSchema,
} as const;

export const ProbeEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...eventCommonShape,
      type: z.literal("snapshot"),
      variables: SerializedNodeSchema,
      watches: z.record(z.string(), SerializedNodeSchema),
      stack: z.array(stackFrameSchema).max(8),
    })
    .strict(),
  z
    .object({
      ...eventCommonShape,
      type: z.literal("log"),
      message: z.string().max(65_536),
      level: z.enum(["debug", "info", "warn", "error"]),
    })
    .strict(),
  z
    .object({
      ...eventCommonShape,
      type: z.literal("counter"),
      delta: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...eventCommonShape,
      type: z.literal("metric"),
      count: z.number().int().positive(),
      sum: z.number().finite(),
      min: z.number().finite(),
      max: z.number().finite(),
      last: z.number().finite(),
    })
    .strict()
    .superRefine((event, context) => {
      if (event.min > event.max) {
        context.addIssue({
          code: "custom",
          message: "metric min must be less than or equal to max",
          path: ["min"],
        });
      }
    }),
  z
    .object({
      ...eventCommonShape,
      type: z.literal("status"),
      status: StatusNameSchema,
      detail: z.string().max(4_096).optional(),
    })
    .strict(),
]);

export type ProbeEvent = z.infer<typeof ProbeEventSchema>;
export type ProbeStatusName = z.infer<typeof StatusNameSchema>;

export const AgentStatusSchema = z
  .object({
    state: z.enum(["green", "red"]),
    detail: z.string().max(4_096).optional(),
  })
  .strict();

export const IngestSchema = z
  .object({
    serviceId: serviceIdSchema,
    sdk: z.enum(["node", "python", "jvm"]),
    commitSha: commitShaSchema,
    commitSource: commitSourceSchema.optional(),
    agentStatus: AgentStatusSchema,
    events: z.array(ProbeEventSchema).max(10_000),
  })
  .strict();

export type AgentSdk = z.infer<typeof IngestSchema>["sdk"];
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type IngestInput = z.infer<typeof IngestSchema>;

export interface ProbeStatus {
  status: ProbeStatusName;
  updatedAt: string;
  detail?: string | undefined;
}

export interface ServiceRecord {
  serviceId: string;
  lastSeen: string;
  sdk?: AgentSdk | undefined;
  commitSha?: string | undefined;
  commitSource?: "env" | "config" | undefined;
  agentStatus?: AgentStatus | undefined;
}

interface StoredProbe {
  probe: ProbeDefinition;
  expiresAt: number;
  expired: boolean;
}

type ActivityReason = "activity" | "timeout" | "aborted";
type ActivityListener = (reason: ActivityReason) => void;

export interface BrokerStateOptions {
  clock?: () => number;
  idGenerator?: (now: number) => string;
  ringCapacity?: number;
}

export interface PersistenceOptions {
  path: string;
  intervalMs?: number;
}

export interface BrokerStore {
  readonly incremental?: boolean;
  close?(): Promise<void>;
  healthCheck?(): Promise<void>;
  restore(state: BrokerState): Promise<void>;
  persist(state: BrokerState): Promise<void>;
  persistProbe?(state: BrokerState, probeId: string): Promise<void>;
  deleteProbe?(state: BrokerState, probeId: string): Promise<void>;
  persistIngest?(state: BrokerState, input: IngestInput): Promise<void>;
  persistSourceMapSet?(
    state: BrokerState,
    serviceId: string,
    commitSha: string,
  ): Promise<void>;
}

export interface BuildBrokerOptions {
  logger?: FastifyServerOptions["logger"];
  state?: BrokerState;
  apiKey?: string;
  apiKeys?: readonly string[];
  store?: BrokerStore | false;
  clock?: () => number;
  idGenerator?: (now: number) => string;
  ringCapacity?: number;
  ttlSweepIntervalMs?: number;
  persistence?: PersistenceOptions | false;
}

export interface StartBrokerOptions extends BuildBrokerOptions {
  host?: string;
  port?: number;
}

class BrokerHttpError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrokerHttpError";
  }
}

function bearerTokenMatches(
  authorization: string | undefined,
  apiKeys: readonly string[],
): boolean {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return false;
  }
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  return apiKeys.some((apiKey) => {
    const expected = Buffer.from(apiKey);
    return (
      supplied.length === expected.length && timingSafeEqual(supplied, expected)
    );
  });
}

function encodeCrockford(value: bigint, length: number): string {
  let remaining = value;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    const alphabetIndex = Number(remaining & 31n);
    output = `${CROCKFORD_BASE32[alphabetIndex]}${output}`;
    remaining >>= 5n;
  }
  return output;
}

/**
 * Generates a time-sortable, ULID-shaped identifier using cryptographic
 * randomness. It does not promise monotonic ordering for IDs created within
 * the same millisecond.
 */
export function createProbeId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffff_ffff_ffff) {
    throw new RangeError("now must fit in the ULID 48-bit timestamp field");
  }

  const timestamp = encodeCrockford(BigInt(now), 10);
  const randomness = encodeCrockford(
    BigInt(`0x${randomBytes(10).toString("hex")}`),
    16,
  );
  return `prb_${timestamp}${randomness}`;
}

const persistedStatusSchema = z
  .object({
    status: StatusNameSchema,
    updatedAt: timestampSchema,
    detail: z.string().max(4_096).optional(),
  })
  .strict();

const persistedServiceSchema = z
  .object({
    serviceId: serviceIdSchema,
    lastSeen: timestampSchema,
    sdk: z.enum(["node", "python", "jvm"]).optional(),
    commitSha: commitShaSchema.optional(),
    commitSource: commitSourceSchema.optional(),
    agentStatus: AgentStatusSchema.optional(),
  })
  .strict();

const persistedSourceMapSetSchema = z
  .object({
    serviceId: serviceIdSchema,
    commitSha: commitShaSchema,
    complete: z.boolean(),
    updatedAt: timestampSchema,
    maps: z.array(
      z
        .object({
          mapPath: sourceMapPathSchema,
          map: z.record(z.string(), z.unknown()),
          uploadedAt: timestampSchema,
        })
        .strict(),
    ),
  })
  .strict();

const snapshotSchema = z
  .object({
    formatVersion: z.literal(1),
    savedAt: timestampSchema,
    probes: z.array(
      z
        .object({
          probe: ProbeDefinitionSchema,
          expiresAt: z.number().int().nonnegative(),
          expired: z.boolean(),
        })
        .strict(),
    ),
    serviceVersions: z.array(
      z.tuple([serviceIdSchema, z.number().int().nonnegative()]),
    ),
    events: z.array(
      z
        .object({
          probeId: probeIdSchema,
          values: z.array(ProbeEventSchema),
        })
        .strict(),
    ),
    services: z.array(persistedServiceSchema),
    statuses: z.array(z.tuple([probeIdSchema, persistedStatusSchema])),
    sourceMapSets: z.array(persistedSourceMapSetSchema).default([]),
  })
  .strict();

interface SourceMapSet {
  serviceId: string;
  commitSha: string;
  complete: boolean;
  updatedAt: string;
  maps: Map<string, StoredSourceMap>;
}

interface SourceMapLease {
  uploaderId: string;
  expiresAt: number;
}

export class BrokerState {
  private readonly probes = new Map<string, StoredProbe>();
  private readonly serviceVersions = new Map<string, number>();
  private readonly events = new Map<string, ProbeEvent[]>();
  private readonly services = new Map<string, ServiceRecord>();
  private readonly statuses = new Map<string, ProbeStatus>();
  private readonly sourceMapSets = new Map<string, SourceMapSet>();
  private readonly sourceMapLeases = new Map<string, SourceMapLease>();
  private readonly listeners = new Map<string, Set<ActivityListener>>();
  private readonly clock: () => number;
  private readonly idGenerator: (now: number) => string;
  private readonly ringCapacity: number;

  public constructor(options: BrokerStateOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.idGenerator = options.idGenerator ?? createProbeId;
    this.ringCapacity = options.ringCapacity ?? DEFAULT_RING_CAPACITY;
    if (!Number.isInteger(this.ringCapacity) || this.ringCapacity <= 0) {
      throw new RangeError("ringCapacity must be a positive integer");
    }
  }

  public now(): number {
    return this.clock();
  }

  public timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  public createProbe(input: CreateProbeInput): ProbeDefinition {
    const now = this.now();
    let id = this.idGenerator(now);
    for (let attempt = 0; this.probes.has(id); attempt += 1) {
      if (attempt >= 10) {
        throw new Error("probe id generator repeatedly produced collisions");
      }
      id = this.idGenerator(now);
    }
    probeIdSchema.parse(id);

    const version = this.incrementServiceVersion(input.serviceId);
    const probe = ProbeDefinitionSchema.parse({ ...input, id, version });
    this.probes.set(id, {
      probe,
      expiresAt: now + probe.ttlSeconds * 1_000,
      expired: false,
    });
    this.events.set(id, []);
    return probe;
  }

  public deleteProbe(id: string): boolean {
    const stored = this.probes.get(id);
    if (stored === undefined) {
      return false;
    }
    if (!stored.expired) {
      this.incrementServiceVersion(stored.probe.serviceId);
    }
    this.probes.delete(id);
    this.events.delete(id);
    this.statuses.delete(id);
    this.signalActivity(id);
    return true;
  }

  public listProbes(serviceId?: string): Array<{
    probe: ProbeDefinition;
    status: ProbeStatus | null;
  }> {
    this.expireDueProbes();
    const result: Array<{
      probe: ProbeDefinition;
      status: ProbeStatus | null;
    }> = [];
    for (const stored of this.probes.values()) {
      if (
        serviceId === undefined ||
        stored.probe.serviceId === serviceId
      ) {
        result.push({
          probe: stored.probe,
          status: this.statuses.get(stored.probe.id) ?? null,
        });
      }
    }
    return result;
  }

  public getProbe(id: string): ProbeDefinition | undefined {
    this.expireDueProbes();
    return this.probes.get(id)?.probe;
  }

  public pollProbes(
    serviceId: string,
    since: number,
    commitSha?: string,
  ):
    | { version: number; unchanged: true }
    | { version: number; probes: ProbeDefinition[] } {
    this.expireDueProbes();
    this.touchService(serviceId);
    const version = this.serviceVersions.get(serviceId) ?? 0;
    if (since === version) {
      return { version, unchanged: true };
    }
    const probes = [...this.probes.values()]
      .filter(
        (stored) =>
          stored.probe.serviceId === serviceId && !stored.expired,
      )
      .map((stored) => this.withRuntimeLocation(stored.probe, commitSha));
    return { version, probes };
  }

  public sourceMapStatus(
    serviceId: string,
    commitSha: string,
    uploaderId: string,
  ): { isUploader: boolean; isComplete: boolean } {
    const key = this.sourceMapKey(serviceId, commitSha);
    const set = this.sourceMapSets.get(key);
    if (set?.complete === true) {
      return { isUploader: false, isComplete: true };
    }

    const now = this.now();
    const lease = this.sourceMapLeases.get(key);
    if (
      lease === undefined ||
      lease.expiresAt <= now ||
      lease.uploaderId === uploaderId
    ) {
      if (
        set !== undefined &&
        (lease === undefined || lease.uploaderId !== uploaderId)
      ) {
        set.maps.clear();
        set.updatedAt = this.timestamp();
      }
      this.sourceMapLeases.set(key, {
        uploaderId,
        expiresAt: now + 120_000,
      });
      return { isUploader: true, isComplete: false };
    }
    return { isUploader: false, isComplete: false };
  }

  public uploadSourceMap(input: {
    serviceId: string;
    commitSha: string;
    uploaderId: string;
    mapPath: string;
    map: Record<string, unknown>;
  }): void {
    this.assertSourceMapUploader(input.serviceId, input.commitSha, input.uploaderId);
    const cleanMap = stripSourcesContent(input.map);
    validateSourceMap(input.mapPath, cleanMap);
    const key = this.sourceMapKey(input.serviceId, input.commitSha);
    const existing = this.sourceMapSets.get(key);
    const set: SourceMapSet = existing ?? {
      serviceId: input.serviceId,
      commitSha: input.commitSha,
      complete: false,
      updatedAt: this.timestamp(),
      maps: new Map<string, StoredSourceMap>(),
    };
    const uploadedAt = this.timestamp();
    set.complete = false;
    set.updatedAt = uploadedAt;
    set.maps.set(input.mapPath, {
      mapPath: input.mapPath,
      map: cleanMap,
      uploadedAt,
    });
    this.sourceMapSets.set(key, set);
  }

  public completeSourceMaps(
    serviceId: string,
    commitSha: string,
    uploaderId: string,
  ): void {
    this.assertSourceMapUploader(serviceId, commitSha, uploaderId);
    const key = this.sourceMapKey(serviceId, commitSha);
    const existing = this.sourceMapSets.get(key);
    const set: SourceMapSet = existing ?? {
      serviceId,
      commitSha,
      complete: false,
      updatedAt: this.timestamp(),
      maps: new Map<string, StoredSourceMap>(),
    };
    set.complete = true;
    set.updatedAt = this.timestamp();
    this.sourceMapSets.set(key, set);
    this.sourceMapLeases.delete(key);
    this.incrementServiceVersion(serviceId);
    const retained = [...this.sourceMapSets.entries()]
      .filter(([, candidate]) => candidate.serviceId === serviceId)
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
          rightKey.localeCompare(leftKey),
      );
    for (const [expiredKey] of retained.slice(SOURCE_MAP_COMMITS_PER_SERVICE)) {
      this.sourceMapSets.delete(expiredKey);
      this.sourceMapLeases.delete(expiredKey);
    }
  }

  public getSourceMapSet(
    serviceId: string,
    commitSha: string,
  ): {
    serviceId: string;
    commitSha: string;
    complete: boolean;
    updatedAt: string;
    maps: StoredSourceMap[];
  } | undefined {
    const set = this.sourceMapSets.get(this.sourceMapKey(serviceId, commitSha));
    if (set === undefined) return undefined;
    return {
      serviceId: set.serviceId,
      commitSha: set.commitSha,
      complete: set.complete,
      updatedAt: set.updatedAt,
      maps: [...set.maps.values()],
    };
  }

  public ingest(input: z.infer<typeof IngestSchema>): number {
    this.expireDueProbes();
    for (const event of input.events) {
      const stored = this.probes.get(event.probeId);
      if (stored === undefined) {
        throw new BrokerHttpError(
          400,
          "invalid_request",
          `event references unknown probe ${event.probeId}`,
        );
      }
      if (stored.probe.serviceId !== input.serviceId) {
        throw new BrokerHttpError(
          400,
          "invalid_request",
          `probe ${event.probeId} does not belong to service ${input.serviceId}`,
        );
      }
      if (event.type !== "status" && event.type !== stored.probe.type) {
        throw new BrokerHttpError(
          400,
          "invalid_request",
          `event type ${event.type} does not match ${stored.probe.type} probe`,
        );
      }
      if (
        event.type === "metric" &&
        (event.sum < event.min * event.count ||
          event.sum > event.max * event.count)
      ) {
        throw new BrokerHttpError(
          400,
          "invalid_request",
          "metric sum is inconsistent with count, min, and max",
        );
      }
    }

    this.touchService(
      input.serviceId,
      input.sdk,
      input.agentStatus,
      input.commitSha,
      input.commitSource,
    );
    for (const event of input.events) {
      this.appendEvent(event);
      if (event.type === "status") {
        const status: ProbeStatus = {
          status: event.status,
          updatedAt: event.ts,
          ...(event.detail === undefined ? {} : { detail: event.detail }),
        };
        this.statuses.set(event.probeId, status);
      }
    }
    return input.events.length;
  }

  public listServices(): ServiceRecord[] {
    return [...this.services.values()].sort((left, right) =>
      left.serviceId.localeCompare(right.serviceId),
    );
  }

  public safetyOverview(staleAfterMs = 45_000): {
    services: Array<{
      serviceId: string;
      sdk?: AgentSdk;
      commitSha?: string;
      lastSeen: string;
      online: boolean;
      agent: { state: "green" | "red" | "unknown"; detail?: string };
      probesSummary: Record<ProbeStatusName | "unknown", number>;
      caveats: string[];
    }>;
  } {
    this.expireDueProbes();
    const now = this.now();
    return {
      services: this.listServices().map((service) => {
        const summary: Record<ProbeStatusName | "unknown", number> = {
          armed: 0,
          error: 0,
          "hit-limit-reached": 0,
          suspended: 0,
          expired: 0,
          unknown: 0,
        };
        for (const { probe, status } of this.listProbes(service.serviceId)) {
          summary[status?.status ?? "unknown"] += 1;
          if (status === null && !this.probes.get(probe.id)?.expired) {
            summary.armed += 1;
            summary.unknown -= 1;
          }
        }
        const caveats = [
          "Safety state is agent-reported and scoped to LiveProbe runtime safeguards, not total process load.",
        ];
        if (service.sdk === "jvm") {
          caveats.push(
            "JVM red usually means rate-limited or suspended JDI breakpoints, not a whole-process GC pause signal.",
          );
        } else if (service.sdk === "python") {
          caveats.push(
            "Python red means monitoring callback budget protection tripped for LiveProbe probes.",
          );
        } else if (service.sdk === "node") {
          caveats.push(
            "Node red means event-loop lag safety protection suspended LiveProbe probes.",
          );
        }
        const agent =
          service.agentStatus === undefined
            ? { state: "unknown" as const }
            : {
                state: service.agentStatus.state,
                ...(service.agentStatus.detail === undefined
                  ? {}
                  : { detail: service.agentStatus.detail }),
              };
        return {
          serviceId: service.serviceId,
          ...(service.sdk === undefined ? {} : { sdk: service.sdk }),
          ...(service.commitSha === undefined
            ? {}
            : { commitSha: service.commitSha }),
          lastSeen: service.lastSeen,
          online: now - Date.parse(service.lastSeen) <= staleAfterMs,
          agent,
          probesSummary: summary,
          caveats,
        };
      }),
    };
  }

  public getEvents(id: string): ProbeEvent[] {
    return [...(this.events.get(id) ?? [])];
  }

  public getStatus(id: string): ProbeStatus | null {
    return this.statuses.get(id) ?? null;
  }

  /**
   * Atomically waits only when a probe has no retained events.
   *
   * The listener is installed before the ring is checked. An event that
   * arrives before registration is observed by the post-registration check;
   * an event that arrives afterwards signals the installed listener.
   */
  public waitForEvents(
    probeId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ActivityReason> {
    return this.registerActivityListener(
      probeId,
      timeoutMs,
      signal,
    );
  }

  private registerActivityListener(
    probeId: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<ActivityReason> {
    if (timeoutMs <= 0) {
      return Promise.resolve("timeout");
    }

    return new Promise<ActivityReason>((resolvePromise) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const listeners =
        this.listeners.get(probeId) ?? new Set<ActivityListener>();

      const finish = (reason: ActivityReason): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        listeners.delete(finish);
        if (listeners.size === 0) {
          this.listeners.delete(probeId);
        }
        signal?.removeEventListener("abort", onAbort);
        resolvePromise(reason);
      };
      const onAbort = (): void => {
        finish("aborted");
      };

      listeners.add(finish);
      this.listeners.set(probeId, listeners);
      timeout = setTimeout(() => {
        finish("timeout");
      }, timeoutMs);
      timeout.unref();

      if (signal?.aborted === true) {
        finish("aborted");
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }

      if (
        !settled &&
        (this.events.get(probeId)?.length ?? 0) > 0
      ) {
        finish("activity");
      }
    });
  }

  public pendingLongPollCount(probeId?: string): number {
    if (probeId !== undefined) {
      return this.listeners.get(probeId)?.size ?? 0;
    }
    let total = 0;
    for (const listeners of this.listeners.values()) {
      total += listeners.size;
    }
    return total;
  }

  public expireDueProbes(): number {
    const now = this.now();
    let expired = 0;
    for (const stored of this.probes.values()) {
      if (!stored.expired && stored.expiresAt <= now) {
        stored.expired = true;
        expired += 1;
        this.incrementServiceVersion(stored.probe.serviceId);
        const status: ProbeStatus = {
          status: "expired",
          updatedAt: new Date(now).toISOString(),
        };
        this.statuses.set(stored.probe.id, status);
        this.appendEvent({
          probeId: stored.probe.id,
          type: "status",
          ts: status.updatedAt,
          status: "expired",
        });
      }
    }
    return expired;
  }

  public async restore(path: string): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch (error: unknown) {
      throw new Error(`invalid broker snapshot JSON at ${path}`, {
        cause: error,
      });
    }
    const snapshot = snapshotSchema.parse(decoded);

    this.probes.clear();
    this.serviceVersions.clear();
    this.events.clear();
    this.services.clear();
    this.statuses.clear();
    this.sourceMapSets.clear();
    this.sourceMapLeases.clear();

    for (const stored of snapshot.probes) {
      this.probes.set(stored.probe.id, stored);
    }
    for (const [serviceId, version] of snapshot.serviceVersions) {
      this.serviceVersions.set(serviceId, version);
    }
    for (const entry of snapshot.events) {
      this.events.set(
        entry.probeId,
        entry.values.slice(-this.ringCapacity),
      );
    }
    for (const service of snapshot.services) {
      this.services.set(service.serviceId, service);
    }
    for (const [probeId, status] of snapshot.statuses) {
      this.statuses.set(probeId, status);
    }
    this.loadSourceMapSets(snapshot.sourceMapSets);
    this.expireDueProbes();
  }

  public loadSnapshot(snapshot: unknown): void {
    const parsed = snapshotSchema.parse(snapshot);

    this.probes.clear();
    this.serviceVersions.clear();
    this.events.clear();
    this.services.clear();
    this.statuses.clear();
    this.sourceMapSets.clear();
    this.sourceMapLeases.clear();

    for (const stored of parsed.probes) {
      this.probes.set(stored.probe.id, stored);
    }
    for (const [serviceId, version] of parsed.serviceVersions) {
      this.serviceVersions.set(serviceId, version);
    }
    for (const entry of parsed.events) {
      this.events.set(
        entry.probeId,
        entry.values.slice(-this.ringCapacity),
      );
    }
    for (const service of parsed.services) {
      this.services.set(service.serviceId, service);
    }
    for (const [probeId, status] of parsed.statuses) {
      this.statuses.set(probeId, status);
    }
    this.loadSourceMapSets(parsed.sourceMapSets);
    this.expireDueProbes();
  }

  public snapshot(): z.infer<typeof snapshotSchema> {
    return snapshotSchema.parse({
      formatVersion: 1,
      savedAt: this.timestamp(),
      probes: [...this.probes.values()],
      serviceVersions: [...this.serviceVersions.entries()],
      events: [...this.events.entries()].map(([probeId, values]) => ({
        probeId,
        values,
      })),
      services: [...this.services.values()],
      statuses: [...this.statuses.entries()],
      sourceMapSets: [...this.sourceMapSets.values()].map((set) => ({
        serviceId: set.serviceId,
        commitSha: set.commitSha,
        complete: set.complete,
        updatedAt: set.updatedAt,
        maps: [...set.maps.values()],
      })),
    });
  }

  public async persist(path: string): Promise<void> {
    const snapshot = this.snapshot();
    const target = resolve(path);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  public dispose(): void {
    for (const listeners of this.listeners.values()) {
      for (const listener of [...listeners]) {
        listener("aborted");
      }
    }
    this.listeners.clear();
  }

  private incrementServiceVersion(serviceId: string): number {
    const version = (this.serviceVersions.get(serviceId) ?? 0) + 1;
    this.serviceVersions.set(serviceId, version);
    return version;
  }

  private sourceMapKey(serviceId: string, commitSha: string): string {
    return `${serviceId}\u0000${commitSha}`;
  }

  private assertSourceMapUploader(
    serviceId: string,
    commitSha: string,
    uploaderId: string,
  ): void {
    const key = this.sourceMapKey(serviceId, commitSha);
    const lease = this.sourceMapLeases.get(key);
    if (
      lease === undefined ||
      lease.expiresAt <= this.now() ||
      lease.uploaderId !== uploaderId
    ) {
      throw new BrokerHttpError(
        409,
        "source_map_upload_not_claimed",
        "this agent is not the active source-map uploader",
      );
    }
    lease.expiresAt = this.now() + 120_000;
  }

  private withRuntimeLocation(
    probe: ProbeDefinition,
    commitSha: string | undefined,
  ): ProbeDefinition {
    if (commitSha === undefined) return probe;
    const set = this.sourceMapSets.get(this.sourceMapKey(probe.serviceId, commitSha));
    if (set?.complete !== true) return probe;
    const runtime = resolveSourceLocation([...set.maps.values()], probe.file, probe.line);
    return runtime === undefined
      ? probe
      : ProbeDefinitionSchema.parse({ ...probe, ...runtime });
  }

  private loadSourceMapSets(
    sourceMapSets: Array<z.infer<typeof persistedSourceMapSetSchema>>,
  ): void {
    for (const set of sourceMapSets) {
      this.sourceMapSets.set(this.sourceMapKey(set.serviceId, set.commitSha), {
        serviceId: set.serviceId,
        commitSha: set.commitSha,
        complete: set.complete,
        updatedAt: set.updatedAt,
        maps: new Map(set.maps.map((map) => [map.mapPath, map])),
      });
    }
  }

  private touchService(
    serviceId: string,
    sdk?: AgentSdk,
    agentStatus?: AgentStatus,
    commitSha?: string,
    commitSource?: "env" | "config",
  ): void {
    const previous = this.services.get(serviceId);
    const service: ServiceRecord = {
      serviceId,
      lastSeen: this.timestamp(),
      ...(sdk === undefined
        ? previous?.sdk === undefined
          ? {}
          : { sdk: previous.sdk }
        : { sdk }),
      ...(agentStatus === undefined
        ? previous?.agentStatus === undefined
          ? {}
          : { agentStatus: previous.agentStatus }
        : { agentStatus }),
      ...(commitSha === undefined
        ? previous?.commitSha === undefined
          ? {}
          : { commitSha: previous.commitSha }
        : { commitSha }),
      ...(commitSource === undefined
        ? previous?.commitSource === undefined
          ? {}
          : { commitSource: previous.commitSource }
        : { commitSource }),
    };
    this.services.set(serviceId, service);
  }

  private appendEvent(event: ProbeEvent): void {
    const buffer = this.events.get(event.probeId) ?? [];
    buffer.push(event);
    if (buffer.length > this.ringCapacity) {
      buffer.splice(0, buffer.length - this.ringCapacity);
    }
    this.events.set(event.probeId, buffer);
    this.signalActivity(event.probeId);
  }

  private signalActivity(probeId: string): void {
    const listeners = this.listeners.get(probeId);
    if (listeners === undefined) {
      return;
    }
    for (const listener of [...listeners]) {
      listener("activity");
    }
  }
}

export class JsonFileStore implements BrokerStore {
  public constructor(private readonly options: PersistenceOptions) {}

  public async restore(state: BrokerState): Promise<void> {
    await state.restore(this.options.path);
  }

  public async persist(state: BrokerState): Promise<void> {
    await state.persist(this.options.path);
  }
}

const pollParamsSchema = z
  .object({ serviceId: serviceIdSchema })
  .strict();
const pollQuerySchema = z
  .object({
    since: z.coerce.number().int().nonnegative().default(0),
    commitSha: commitShaSchema.optional(),
  })
  .strict();
const probeParamsSchema = z.object({ id: probeIdSchema }).strict();
const listProbeQuerySchema = z
  .object({ serviceId: serviceIdSchema.optional() })
  .strict();
const dataQuerySchema = z
  .object({
    waitSeconds: z.coerce.number().finite().default(0),
  })
  .strict();
const emptyQuerySchema = z.object({}).strict();
const sourceMapIdentityShape = {
  serviceId: serviceIdSchema,
  commitSha: commitShaSchema,
  uploaderId: uploaderIdSchema,
} as const;
const sourceMapStatusSchema = z.object(sourceMapIdentityShape).strict();
const sourceMapUploadSchema = z
  .object({
    ...sourceMapIdentityShape,
    mapPath: sourceMapPathSchema,
    map: z.record(z.string(), z.unknown()),
  })
  .strict();

export async function buildBroker(
  options: BuildBrokerOptions = {},
): Promise<FastifyInstance> {
  const state =
    options.state ??
    new BrokerState({
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.idGenerator === undefined
        ? {}
        : { idGenerator: options.idGenerator }),
      ...(options.ringCapacity === undefined
        ? {}
        : { ringCapacity: options.ringCapacity }),
    });
  const store: BrokerStore | false =
    options.store ??
    (process.env["DATABASE_URL"] !== undefined &&
    process.env["DATABASE_URL"].length > 0
      ? new PostgresStore(process.env["DATABASE_URL"], {
          maxConnections:
            optionalPositiveInteger(
              process.env["LIVEPROBE_DB_POOL_SIZE"],
              "LIVEPROBE_DB_POOL_SIZE",
            ) ?? 10,
        })
      : options.persistence === false || options.persistence === undefined
        ? false
        : new JsonFileStore(options.persistence));
  const persistence = options.persistence ?? false;
  if (store !== false) {
    await store.restore(state);
  }

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: SOURCE_MAP_BODY_LIMIT_BYTES,
  });
  app.decorate("liveprobeState", state);

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (request, reply) => {
    try {
      if (store !== false) {
        await store.healthCheck?.();
      }
      return { ok: true };
    } catch (error: unknown) {
      request.log.warn({ err: error }, "broker readiness check failed");
      return reply.status(503).send({ ok: false });
    }
  });

  const apiKeys = Array.from(
    new Set([
      ...(options.apiKey === undefined ? [] : [options.apiKey]),
      ...(options.apiKeys ?? []),
    ]),
  );
  if (apiKeys.some((apiKey) => apiKey.length === 0)) {
    throw new Error("API keys must be non-empty when configured");
  }
  if (apiKeys.length > 2) {
    throw new Error("at most two API keys can be configured");
  }
  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/v1/") || apiKeys.length === 0) {
      return;
    }
    if (!bearerTokenMatches(request.headers.authorization, apiKeys)) {
      throw new BrokerHttpError(
        401,
        "unauthorized",
        "missing or invalid Authorization bearer token",
      );
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const first = error.issues[0];
      const path =
        first === undefined || first.path.length === 0
          ? ""
          : `${first.path.join(".")}: `;
      void reply.status(400).send({
        error: {
          code: "invalid_request",
          message: `${path}${first?.message ?? "invalid request"}`,
        },
      });
      return;
    }
    if (error instanceof BrokerHttpError) {
      void reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      void reply.status(error.statusCode).send({
        error: {
          code: "invalid_request",
          message: error.message,
        },
      });
      return;
    }
    request.log.error({ err: error }, "broker request failed");
    void reply.status(500).send({
      error: {
        code: "internal_error",
        message: "internal broker error",
      },
    });
  });

  let mutationQueue: Promise<void> = Promise.resolve();
  const mutateDurably = async <T>(
    mutate: () => T,
    persist: (value: T) => Promise<void>,
  ): Promise<T> => {
    let result: T | undefined;
    let failure: unknown;
    const operation = mutationQueue.then(async () => {
      const before = state.snapshot();
      result = mutate();
      try {
        await persist(result);
      } catch (error: unknown) {
        state.loadSnapshot(before);
        failure = error;
      }
    });
    mutationQueue = operation.catch(() => undefined);
    await operation;
    if (failure !== undefined) throw failure;
    return result as T;
  };
  const persistSnapshot = async (): Promise<void> => {
    if (store !== false) await store.persist(state);
  };
  const persistSourceMapSet = async (
    serviceId: string,
    commitSha: string,
  ): Promise<void> => {
    if (store === false) return;
    await (store.persistSourceMapSet === undefined
      ? store.persist(state)
      : store.persistSourceMapSet(state, serviceId, commitSha));
  };

  app.post("/v1/probes", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = CreateProbeSchema.parse(request.body);
    const probe = await mutateDurably(
      () => state.createProbe(input),
      async (created) => {
        if (store === false) return;
        await (store.persistProbe === undefined
          ? store.persist(state)
          : store.persistProbe(state, created.id));
      },
    );
    return reply.status(201).send({ probe });
  });

  app.delete("/v1/probes/:id", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const { id } = probeParamsSchema.parse(request.params);
    await mutateDurably(
      () => state.deleteProbe(id),
      async () => {
        if (store === false) return;
        await (store.deleteProbe === undefined
          ? store.persist(state)
          : store.deleteProbe(state, id));
      },
    );
    return reply.status(204).send();
  });

  app.get("/v1/probes", async (request) => {
    const { serviceId } = listProbeQuerySchema.parse(request.query);
    return { probes: state.listProbes(serviceId) };
  });

  app.get("/v1/services", async (request) => {
    emptyQuerySchema.parse(request.query);
    return { services: state.listServices() };
  });

  app.get("/v1/ping", async (request) => {
    emptyQuerySchema.parse(request.query);
    return { ok: true };
  });

  app.get("/v1/safety", async (request) => {
    emptyQuerySchema.parse(request.query);
    return state.safetyOverview();
  });

  app.get(
    "/v1/services/:serviceId/probes",
    async (request) => {
      const { serviceId } = pollParamsSchema.parse(request.params);
      const { since, commitSha } = pollQuerySchema.parse(request.query);
      return state.pollProbes(serviceId, since, commitSha);
    },
  );

  app.post("/v1/source-maps/status", async (request) => {
    emptyQuerySchema.parse(request.query);
    const input = sourceMapStatusSchema.parse(request.body);
    const previousMapCount =
      state.getSourceMapSet(input.serviceId, input.commitSha)?.maps.length ?? 0;
    const status = state.sourceMapStatus(
      input.serviceId,
      input.commitSha,
      input.uploaderId,
    );
    if (
      previousMapCount > 0 &&
      status.isUploader &&
      state.getSourceMapSet(input.serviceId, input.commitSha)?.maps.length === 0
    ) {
      await persistSourceMapSet(input.serviceId, input.commitSha);
    }
    return status;
  });

  app.post("/v1/source-maps/upload", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = sourceMapUploadSchema.parse(request.body);
    await mutateDurably(
      () => state.uploadSourceMap(input),
      async () => persistSourceMapSet(input.serviceId, input.commitSha),
    );
    return reply.status(202).send({ accepted: true });
  });

  app.post("/v1/source-maps/complete", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = sourceMapStatusSchema.parse(request.body);
    await mutateDurably(
      () =>
        state.completeSourceMaps(
          input.serviceId,
          input.commitSha,
          input.uploaderId,
        ),
      async () => persistSourceMapSet(input.serviceId, input.commitSha),
    );
    return reply.status(202).send({ complete: true });
  });

  app.post("/v1/ingest", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = IngestSchema.parse(request.body);
    const accepted = await mutateDurably(
      () => state.ingest(input),
      async () => {
        if (store === false) return;
        await (store.persistIngest === undefined
          ? store.persist(state)
          : store.persistIngest(state, input));
      },
    );
    return reply.status(202).send({ accepted });
  });

  app.get("/v1/probes/:id/data", async (request, reply) => {
    const { id } = probeParamsSchema.parse(request.params);
    const query = dataQuerySchema.parse(request.query);
    const waitSeconds = Math.min(30, Math.max(0, query.waitSeconds));
    let probe = state.getProbe(id);
    if (probe === undefined) {
      throw new BrokerHttpError(404, "not_found", `probe ${id} was not found`);
    }

    if (waitSeconds > 0) {
      const abortController = new AbortController();
      const abort = (): void => {
        abortController.abort();
      };
      request.raw.once("aborted", abort);
      request.raw.socket.once("close", abort);
      try {
        await state.waitForEvents(
          id,
          Math.round(waitSeconds * 1_000),
          abortController.signal,
        );
      } finally {
        request.raw.off("aborted", abort);
        request.raw.socket.off("close", abort);
      }
      probe = state.getProbe(id);
      if (probe === undefined) {
        throw new BrokerHttpError(
          404,
          "not_found",
          `probe ${id} was removed while waiting`,
        );
      }
    }

    return reply.send({
      probe,
      status: state.getStatus(id),
      events: state.getEvents(id),
    });
  });

  const ttlSweepIntervalMs =
    options.ttlSweepIntervalMs ?? DEFAULT_TTL_SWEEP_INTERVAL_MS;
  if (
    !Number.isInteger(ttlSweepIntervalMs) ||
    ttlSweepIntervalMs <= 0
  ) {
    throw new RangeError("ttlSweepIntervalMs must be a positive integer");
  }
  const ttlTimer = setInterval(() => {
    void mutateDurably(
      () => state.expireDueProbes(),
      async (expired) => {
        if (expired > 0) await persistSnapshot();
      },
    ).catch((error: unknown) => {
      app.log.error({ err: error }, "failed to persist expired probes");
    });
  }, ttlSweepIntervalMs);
  ttlTimer.unref();

  let persistenceTimer: NodeJS.Timeout | undefined;
  if (store !== false && store.incremental !== true) {
    const intervalMs =
      persistence === false
        ? DEFAULT_SNAPSHOT_INTERVAL_MS
        : (persistence.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS);
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      clearInterval(ttlTimer);
      throw new RangeError(
        "persistence.intervalMs must be a positive integer",
      );
    }
    persistenceTimer = setInterval(() => {
      mutationQueue = mutationQueue
        .then(persistSnapshot)
        .catch((error: unknown) => {
          app.log.error({ err: error }, "failed to persist broker state");
        });
    }, intervalMs);
    persistenceTimer.unref();
  }

  app.addHook("onClose", async () => {
    clearInterval(ttlTimer);
    if (persistenceTimer !== undefined) {
      clearInterval(persistenceTimer);
    }
    try {
      try {
        await mutationQueue;
        if (store !== false) {
          await store.persist(state);
        }
      } finally {
        if (store !== false) {
          await store.close?.();
        }
      }
    } finally {
      state.dispose();
    }
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    liveprobeState: BrokerState;
  }
}

export async function startBroker(
  options: StartBrokerOptions = {},
): Promise<FastifyInstance> {
  const app = await buildBroker(options);
  await app.listen({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 7_070,
  });
  return app;
}

function optionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const port = optionalPositiveInteger(process.env["PORT"], "PORT") ?? 7_070;
  const snapshotIntervalMs = optionalPositiveInteger(
    process.env["LIVEPROBE_SNAPSHOT_INTERVAL_MS"],
    "LIVEPROBE_SNAPSHOT_INTERVAL_MS",
  );
  const persistencePath = process.env["LIVEPROBE_STATE_FILE"];
  const apiKey = process.env["LIVEPROBE_API_KEY"];
  const apiKeys = (process.env["LIVEPROBE_API_KEYS"] ?? "")
    .split(",")
    .filter((value) => value.length > 0);
  if (apiKey !== undefined && apiKey.length > 0) apiKeys.unshift(apiKey);
  const configuredApiKeys = Array.from(new Set(apiKeys));
  if (
    (process.env["NODE_ENV"] === "production" ||
      process.env["LIVEPROBE_REQUIRE_API_KEY"] === "true") &&
    configuredApiKeys.length === 0
  ) {
    throw new Error(
      "LIVEPROBE_API_KEY or LIVEPROBE_API_KEYS is required in production",
    );
  }
  const persistence =
    persistencePath === undefined || persistencePath.length === 0
      ? false
      : {
          path: persistencePath,
          ...(snapshotIntervalMs === undefined
            ? {}
            : { intervalMs: snapshotIntervalMs }),
        };
  const app = await startBroker({
    host: process.env["HOST"] ?? "0.0.0.0",
    port,
    logger: true,
    ...(configuredApiKeys.length === 0 ? {} : { apiKeys: configuredApiKeys }),
    persistence,
  });
  app.log.info(
    {
      address: app.server.address(),
      persistence:
        persistence === false ? "disabled" : persistence.path,
    },
    "liveprobe broker listening",
  );
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(executedPath)).href
) {
  main().catch((error: unknown) => {
    console.error("[liveprobe] broker failed to start", error);
    process.exitCode = 1;
  });
}
