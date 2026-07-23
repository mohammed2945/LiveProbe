import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { handleStatelessHttpMcpRequest } from "@doomslayer2945/liveprobe-mcp";
import { z, ZodError } from "zod";

import type {
  AuditEventRecord,
  AuditListOptions,
  AuditMetadataValue,
  AuditOutcome,
} from "./audit.js";
import {
  BearerAuthenticationError,
  SERVICE_API_KEY_PREFIX,
  DEFAULT_RESOURCE_SCOPE,
  createServiceCredentialMaterial,
  hashBearerToken,
  servicePrincipal,
  sharedPrincipal,
  type BrokerPrincipal,
  type BearerAuthenticator,
  type ResourceScope,
  type ResourceScopeLabels,
  type ServiceCredentialRecord,
  type StoredServiceCredential,
} from "./auth.js";
import {
  clerkAuthenticatorFromEnv,
  clerkOAuthAuthenticatorFromEnv,
  combineBearerAuthenticators,
} from "./clerk-auth.js";
import { PostgresStore } from "./store/postgres.js";
import {
  resolveSourceLocation,
  stripSourcesContent,
  validateSourceMap,
  type StoredSourceMap,
} from "./source-map-resolver.js";

export { PostgresStore } from "./store/postgres.js";
export {
  BearerAuthenticationError,
  SERVICE_API_KEY_PREFIX,
  createServiceCredentialMaterial,
  hashBearerToken,
} from "./auth.js";
export {
  clerkAuthenticatorFromEnv,
  createClerkAuthenticator,
  clerkOAuthAuthenticatorFromEnv,
  combineBearerAuthenticators,
  createClerkOAuthAuthenticator,
  createClerkMembershipResolver,
  liveProbeRoleForClerkRole,
} from "./clerk-auth.js";
export type {
  ClerkMembership,
  ClerkMembershipResolver,
  ClerkOAuthTokenVerifier,
  ClerkOAuthVerificationResult,
  ClerkTokenVerifier,
  ClerkVerificationOptions,
  CreateClerkAuthenticatorOptions,
  CreateClerkOAuthAuthenticatorOptions,
} from "./clerk-auth.js";
export type {
  BearerAuthenticator,
  BrokerPrincipal,
  HumanRole,
  ResourceScope,
  ResourceScopeLabels,
  ServiceCredentialRecord,
  StoredServiceCredential,
} from "./auth.js";
export type {
  AuditEventRecord,
  AuditListOptions,
  AuditMetadataValue,
  AuditOutcome,
} from "./audit.js";
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
  scope: ResourceScope;
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
  ensureResourceScope?(
    scope: ResourceScope,
    labels?: ResourceScopeLabels,
  ): Promise<void>;
  restore(state: BrokerState): Promise<void>;
  persist(state: BrokerState): Promise<void>;
  persistProbe?(
    state: BrokerState,
    probeId: string,
    scope: ResourceScope,
  ): Promise<void>;
  deleteProbe?(
    state: BrokerState,
    probeId: string,
    scope: ResourceScope,
  ): Promise<void>;
  persistIngest?(
    state: BrokerState,
    input: IngestInput,
    scope: ResourceScope,
  ): Promise<void>;
  persistSourceMapSet?(
    state: BrokerState,
    serviceId: string,
    commitSha: string,
    scope: ResourceScope,
  ): Promise<void>;
  createServiceCredential?(
    credential: StoredServiceCredential,
  ): Promise<ServiceCredentialRecord>;
  listServiceCredentials?(
    scope: ResourceScope,
  ): Promise<ServiceCredentialRecord[]>;
  revokeServiceCredential?(
    credentialId: string,
    scope: ResourceScope,
  ): Promise<boolean>;
  authenticateServiceCredential?(
    secretHash: string,
  ): Promise<ServiceCredentialRecord | undefined>;
  appendAuditEvent?(event: AuditEventRecord): Promise<void>;
  listAuditEvents?(
    scope: ResourceScope,
    options: AuditListOptions,
  ): Promise<AuditEventRecord[]>;
}

export interface BuildBrokerOptions {
  logger?: FastifyServerOptions["logger"];
  state?: BrokerState;
  apiKey?: string;
  apiKeys?: readonly string[];
  authenticateBearer?: BearerAuthenticator;
  store?: BrokerStore | false;
  clock?: () => number;
  idGenerator?: (now: number) => string;
  ringCapacity?: number;
  ttlSweepIntervalMs?: number;
  persistence?: PersistenceOptions | false;
  remoteMcp?: RemoteMcpOptions;
}

export interface RemoteMcpOptions {
  publicUrl: string;
  brokerUrl: string;
  authorizationServerUrl: string;
  authenticateBearer: BearerAuthenticator;
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

function bearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length);
  return token.length === 0 ? undefined : token;
}

function principalFor(request: FastifyRequest): BrokerPrincipal {
  if (request.liveprobePrincipal === null) {
    throw new Error("authenticated request is missing its principal");
  }
  return request.liveprobePrincipal;
}

function requireHumanRead(request: FastifyRequest): BrokerPrincipal {
  const principal = principalFor(request);
  if (principal.role === "agent") {
    throw new BrokerHttpError(
      403,
      "forbidden",
      "service credentials cannot read human control-plane resources",
    );
  }
  return principal;
}

function requireProbeManager(request: FastifyRequest): BrokerPrincipal {
  return requireHumanRead(request);
}

function requireAdmin(request: FastifyRequest): BrokerPrincipal {
  // The pilot has no separate human admin/operator/viewer boundary.
  return requireHumanRead(request);
}

function requireServiceAccess(
  request: FastifyRequest,
  serviceId: string,
): BrokerPrincipal {
  const principal = principalFor(request);
  if (principal.type === "user") {
    throw new BrokerHttpError(
      403,
      "forbidden",
      "human credentials cannot call runtime agent routes",
    );
  }
  if (principal.type === "service" && principal.serviceId !== serviceId) {
    throw new BrokerHttpError(
      403,
      "forbidden",
      `service credential cannot access service ${serviceId}`,
    );
  }
  return principal;
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

const resourceScopeShape = {
  tenantId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  environmentId: z.string().min(1).max(200),
} as const;

const persistedServiceSchema = z
  .object({
    ...resourceScopeShape,
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
    ...resourceScopeShape,
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

const legacyPersistedServiceSchema = persistedServiceSchema.omit({
  tenantId: true,
  projectId: true,
  environmentId: true,
});
const legacyPersistedSourceMapSetSchema = persistedSourceMapSetSchema.omit({
  tenantId: true,
  projectId: true,
  environmentId: true,
});

const legacySnapshotSchema = z
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
    services: z.array(legacyPersistedServiceSchema),
    statuses: z.array(z.tuple([probeIdSchema, persistedStatusSchema])),
    sourceMapSets: z.array(legacyPersistedSourceMapSetSchema).default([]),
  })
  .strict();

const snapshotSchema = z
  .object({
    formatVersion: z.literal(2),
    savedAt: timestampSchema,
    probes: z.array(
      z
        .object({
          scope: z.object(resourceScopeShape).strict(),
          probe: ProbeDefinitionSchema,
          expiresAt: z.number().int().nonnegative(),
          expired: z.boolean(),
        })
        .strict(),
    ),
    serviceVersions: z.array(
      z
        .object({
          ...resourceScopeShape,
          serviceId: serviceIdSchema,
          version: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    events: z.array(
      z
        .object({
          scope: z.object(resourceScopeShape).strict(),
          probeId: probeIdSchema,
          values: z.array(ProbeEventSchema),
        })
        .strict(),
    ),
    services: z.array(persistedServiceSchema),
    statuses: z.array(
      z
        .object({
          scope: z.object(resourceScopeShape).strict(),
          probeId: probeIdSchema,
          value: persistedStatusSchema,
        })
        .strict(),
    ),
    sourceMapSets: z.array(persistedSourceMapSetSchema).default([]),
  })
  .strict();

type BrokerSnapshot = z.infer<typeof snapshotSchema>;

function parseBrokerSnapshot(value: unknown): BrokerSnapshot {
  const candidate = value as { formatVersion?: unknown };
  if (candidate?.formatVersion !== 1) {
    return snapshotSchema.parse(value);
  }
  const legacy = legacySnapshotSchema.parse(value);
  return snapshotSchema.parse({
    formatVersion: 2,
    savedAt: legacy.savedAt,
    probes: legacy.probes.map((stored) => ({
      scope: DEFAULT_RESOURCE_SCOPE,
      ...stored,
    })),
    serviceVersions: legacy.serviceVersions.map(([serviceId, version]) => ({
      ...DEFAULT_RESOURCE_SCOPE,
      serviceId,
      version,
    })),
    events: legacy.events.map((entry) => ({
      scope: DEFAULT_RESOURCE_SCOPE,
      ...entry,
    })),
    services: legacy.services.map((service) => ({
      ...DEFAULT_RESOURCE_SCOPE,
      ...service,
    })),
    statuses: legacy.statuses.map(([probeId, status]) => ({
      scope: DEFAULT_RESOURCE_SCOPE,
      probeId,
      value: status,
    })),
    sourceMapSets: legacy.sourceMapSets.map((set) => ({
      ...DEFAULT_RESOURCE_SCOPE,
      ...set,
    })),
  });
}

interface SourceMapSet extends ResourceScope {
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

type ScopedServiceRecord = ServiceRecord & ResourceScope;
type ScopedServiceVersion = ResourceScope & {
  serviceId: string;
  version: number;
};

function resourceScope(scope: ResourceScope): ResourceScope {
  return {
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

function resourceScopeKey(scope: ResourceScope): string {
  return JSON.stringify([
    scope.tenantId,
    scope.projectId,
    scope.environmentId,
  ]);
}

function sameResourceScope(
  left: ResourceScope,
  right: ResourceScope,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId
  );
}

export class BrokerState {
  private readonly probes = new Map<string, StoredProbe>();
  private readonly serviceVersions = new Map<string, ScopedServiceVersion>();
  private readonly events = new Map<string, ProbeEvent[]>();
  private readonly services = new Map<string, ScopedServiceRecord>();
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

  public createProbe(
    input: CreateProbeInput,
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): ProbeDefinition {
    const now = this.now();
    let id = this.idGenerator(now);
    for (let attempt = 0; this.probes.has(id); attempt += 1) {
      if (attempt >= 10) {
        throw new Error("probe id generator repeatedly produced collisions");
      }
      id = this.idGenerator(now);
    }
    probeIdSchema.parse(id);

    const version = this.incrementServiceVersion(input.serviceId, scope);
    const probe = ProbeDefinitionSchema.parse({ ...input, id, version });
    this.probes.set(id, {
      scope: resourceScope(scope),
      probe,
      expiresAt: now + probe.ttlSeconds * 1_000,
      expired: false,
    });
    this.events.set(id, []);
    return probe;
  }

  public deleteProbe(
    id: string,
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): boolean {
    const stored = this.probes.get(id);
    if (stored === undefined || !sameResourceScope(stored.scope, scope)) {
      return false;
    }
    if (!stored.expired) {
      this.incrementServiceVersion(stored.probe.serviceId, stored.scope);
    }
    this.probes.delete(id);
    this.events.delete(id);
    this.statuses.delete(id);
    this.signalActivity(id);
    return true;
  }

  public listProbes(
    serviceId?: string,
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): Array<{
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
        sameResourceScope(stored.scope, scope) &&
        (serviceId === undefined || stored.probe.serviceId === serviceId)
      ) {
        result.push({
          probe: stored.probe,
          status: this.statuses.get(stored.probe.id) ?? null,
        });
      }
    }
    return result;
  }

  public getProbe(
    id: string,
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): ProbeDefinition | undefined {
    this.expireDueProbes();
    const stored = this.probes.get(id);
    return stored !== undefined && sameResourceScope(stored.scope, scope)
      ? stored.probe
      : undefined;
  }

  public pollProbes(
    serviceId: string,
    since: number,
    commitSha?: string,
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ):
    | { version: number; unchanged: true }
    | { version: number; probes: ProbeDefinition[] } {
    this.expireDueProbes();
    this.touchService(serviceId, undefined, undefined, undefined, undefined, scope);
    const version =
      this.serviceVersions.get(this.serviceKey(scope, serviceId))?.version ?? 0;
    if (since === version) {
      return { version, unchanged: true };
    }
    const probes = [...this.probes.values()]
      .filter(
        (stored) =>
          sameResourceScope(stored.scope, scope) &&
          stored.probe.serviceId === serviceId &&
          !stored.expired,
      )
      .map((stored) =>
        this.withRuntimeLocation(stored.probe, commitSha, scope),
      );
    return { version, probes };
  }

  public sourceMapStatus(
    serviceId: string,
    commitSha: string,
    uploaderId: string,
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): { isUploader: boolean; isComplete: boolean } {
    const key = this.sourceMapKey(scope, serviceId, commitSha);
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
  }, scope: ResourceScope = DEFAULT_RESOURCE_SCOPE): void {
    this.assertSourceMapUploader(
      input.serviceId,
      input.commitSha,
      input.uploaderId,
      scope,
    );
    const cleanMap = stripSourcesContent(input.map);
    validateSourceMap(input.mapPath, cleanMap);
    const key = this.sourceMapKey(scope, input.serviceId, input.commitSha);
    const existing = this.sourceMapSets.get(key);
    const set: SourceMapSet = existing ?? {
      ...resourceScope(scope),
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
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): void {
    this.assertSourceMapUploader(serviceId, commitSha, uploaderId, scope);
    const key = this.sourceMapKey(scope, serviceId, commitSha);
    const existing = this.sourceMapSets.get(key);
    const set: SourceMapSet = existing ?? {
      ...resourceScope(scope),
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
    this.incrementServiceVersion(serviceId, scope);
    const retained = [...this.sourceMapSets.entries()]
      .filter(
        ([, candidate]) =>
          sameResourceScope(candidate, scope) &&
          candidate.serviceId === serviceId,
      )
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
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): {
    tenantId: string;
    projectId: string;
    environmentId: string;
    serviceId: string;
    commitSha: string;
    complete: boolean;
    updatedAt: string;
    maps: StoredSourceMap[];
  } | undefined {
    const set = this.sourceMapSets.get(
      this.sourceMapKey(scope, serviceId, commitSha),
    );
    if (set === undefined) return undefined;
    return {
      ...resourceScope(set),
      serviceId: set.serviceId,
      commitSha: set.commitSha,
      complete: set.complete,
      updatedAt: set.updatedAt,
      maps: [...set.maps.values()],
    };
  }

  public ingest(
    input: z.infer<typeof IngestSchema>,
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): number {
    this.expireDueProbes();
    for (const event of input.events) {
      const stored = this.probes.get(event.probeId);
      if (
        stored === undefined ||
        !sameResourceScope(stored.scope, scope)
      ) {
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
      scope,
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

  public listServices(
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): ServiceRecord[] {
    return [...this.services.values()]
      .filter((service) => sameResourceScope(service, scope))
      .map((service) => {
        const {
          tenantId: _tenantId,
          projectId: _projectId,
          environmentId: _environmentId,
          ...record
        } = service;
        return record;
      })
      .sort((left, right) => left.serviceId.localeCompare(right.serviceId));
  }

  public safetyOverview(
    staleAfterMs = 45_000,
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): {
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
      services: this.listServices(scope).map((service) => {
        const summary: Record<ProbeStatusName | "unknown", number> = {
          armed: 0,
          error: 0,
          "hit-limit-reached": 0,
          suspended: 0,
          expired: 0,
          unknown: 0,
        };
        for (const { probe, status } of this.listProbes(
          service.serviceId,
          scope,
        )) {
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

  public getEvents(
    id: string,
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): ProbeEvent[] {
    return this.getProbe(id, scope) === undefined
      ? []
      : [...(this.events.get(id) ?? [])];
  }

  public getStatus(
    id: string,
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): ProbeStatus | null {
    return this.getProbe(id, scope) === undefined
      ? null
      : (this.statuses.get(id) ?? null);
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
        this.incrementServiceVersion(stored.probe.serviceId, stored.scope);
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
    this.replaceWithSnapshot(parseBrokerSnapshot(decoded));
  }

  public loadSnapshot(snapshot: unknown): void {
    this.replaceWithSnapshot(parseBrokerSnapshot(snapshot));
  }

  private replaceWithSnapshot(parsed: BrokerSnapshot): void {

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
    for (const version of parsed.serviceVersions) {
      this.serviceVersions.set(
        this.serviceKey(version, version.serviceId),
        version,
      );
    }
    for (const entry of parsed.events) {
      this.events.set(
        entry.probeId,
        entry.values.slice(-this.ringCapacity),
      );
    }
    for (const service of parsed.services) {
      this.services.set(this.serviceKey(service, service.serviceId), service);
    }
    for (const status of parsed.statuses) {
      this.statuses.set(status.probeId, status.value);
    }
    this.loadSourceMapSets(parsed.sourceMapSets);
    this.expireDueProbes();
  }

  public snapshot(): z.infer<typeof snapshotSchema> {
    return snapshotSchema.parse({
      formatVersion: 2,
      savedAt: this.timestamp(),
      probes: [...this.probes.values()],
      serviceVersions: [...this.serviceVersions.values()],
      events: [...this.events.entries()].flatMap(([probeId, values]) => {
        const stored = this.probes.get(probeId);
        return stored === undefined
          ? []
          : [{ scope: stored.scope, probeId, values }];
      }),
      services: [...this.services.values()],
      statuses: [...this.statuses.entries()].flatMap(([probeId, value]) => {
        const stored = this.probes.get(probeId);
        return stored === undefined
          ? []
          : [{ scope: stored.scope, probeId, value }];
      }),
      sourceMapSets: [...this.sourceMapSets.values()].map((set) => ({
        ...resourceScope(set),
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

  private incrementServiceVersion(
    serviceId: string,
    scope: ResourceScope,
  ): number {
    const key = this.serviceKey(scope, serviceId);
    const version = (this.serviceVersions.get(key)?.version ?? 0) + 1;
    this.serviceVersions.set(key, {
      ...resourceScope(scope),
      serviceId,
      version,
    });
    return version;
  }

  private serviceKey(scope: ResourceScope, serviceId: string): string {
    return `${resourceScopeKey(scope)}\u0000${serviceId}`;
  }

  private sourceMapKey(
    scope: ResourceScope,
    serviceId: string,
    commitSha: string,
  ): string {
    return `${this.serviceKey(scope, serviceId)}\u0000${commitSha}`;
  }

  private assertSourceMapUploader(
    serviceId: string,
    commitSha: string,
    uploaderId: string,
    scope: ResourceScope,
  ): void {
    const key = this.sourceMapKey(scope, serviceId, commitSha);
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
    scope: ResourceScope,
  ): ProbeDefinition {
    if (commitSha === undefined) return probe;
    const set = this.sourceMapSets.get(
      this.sourceMapKey(scope, probe.serviceId, commitSha),
    );
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
      this.sourceMapSets.set(this.sourceMapKey(set, set.serviceId, set.commitSha), {
        ...resourceScope(set),
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
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): void {
    const key = this.serviceKey(scope, serviceId);
    const previous = this.services.get(key);
    const service: ScopedServiceRecord = {
      ...resourceScope(scope),
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
    this.services.set(key, service);
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
const serviceCredentialCreateSchema = z
  .object({
    serviceId: serviceIdSchema,
    label: z.string().trim().min(1).max(200),
  })
  .strict();
const serviceCredentialParamsSchema = z
  .object({
    credentialId: z.string().regex(/^svc_[0-9a-f]{32}$/),
  })
  .strict();
const auditListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: timestampSchema.optional(),
  })
  .strict();

interface AuditMutationContext {
  action: string;
  resourceType: string;
  resourceId?: string | undefined;
  metadata: Record<string, AuditMetadataValue>;
  successStatus: number;
}

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
  app.decorateRequest("liveprobePrincipal", null);

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

  const authenticateExternalBearer = async (
    token: string,
    authenticate: BearerAuthenticator,
  ): Promise<BrokerPrincipal | undefined> => {
    let principal: BrokerPrincipal | undefined;
    try {
      principal = await authenticate(token);
    } catch (error: unknown) {
      if (error instanceof BearerAuthenticationError) {
        throw new BrokerHttpError(error.statusCode, error.code, error.message);
      }
      throw error;
    }
    if (
      principal?.type === "user" &&
      store !== false &&
      store.ensureResourceScope !== undefined
    ) {
      await store.ensureResourceScope(principal, {
        ...(principal.tenantDisplayName === undefined
          ? {}
          : { tenantDisplayName: principal.tenantDisplayName }),
      });
    }
    return principal;
  };

  if (options.remoteMcp !== undefined) {
    const publicUrl = new URL(options.remoteMcp.publicUrl);
    const brokerUrl = new URL(options.remoteMcp.brokerUrl);
    const authorizationServerUrl = new URL(
      options.remoteMcp.authorizationServerUrl,
    );
    if (publicUrl.protocol !== "https:") {
      throw new Error("remote MCP publicUrl must use https");
    }
    if (brokerUrl.protocol !== "http:" && brokerUrl.protocol !== "https:") {
      throw new Error("remote MCP brokerUrl must use http or https");
    }
    if (authorizationServerUrl.protocol !== "https:") {
      throw new Error("remote MCP authorizationServerUrl must use https");
    }
    const resourceUrl = new URL("/mcp", publicUrl).href;
    const resourceMetadataUrl = new URL(
      "/.well-known/oauth-protected-resource/mcp",
      publicUrl,
    ).href;
    const protectedResourceMetadata = {
      resource: resourceUrl,
      authorization_servers: [authorizationServerUrl.href.replace(/\/$/, "")],
      scopes_supported: ["user:org:read"],
      bearer_methods_supported: ["header"],
      resource_name: "LiveProbe MCP",
    };
    app.get("/.well-known/oauth-protected-resource", async () =>
      protectedResourceMetadata,
    );
    app.get("/.well-known/oauth-protected-resource/mcp", async () =>
      protectedResourceMetadata,
    );

    const requireMcpPrincipal = async (
      request: FastifyRequest,
    ): Promise<string> => {
      const token = bearerToken(request.headers.authorization);
      const principal =
        token === undefined
          ? undefined
          : await authenticateExternalBearer(
              token,
              options.remoteMcp!.authenticateBearer,
            );
      if (principal === undefined) {
        throw new BrokerHttpError(
          401,
          "unauthorized",
          "missing or invalid Clerk OAuth bearer token",
        );
      }
      request.liveprobePrincipal = principal;
      return token!;
    };

    app.options("/mcp", async (_request, reply) => reply.status(204).send());
    app.get("/mcp", async (request, reply) => {
      await requireMcpPrincipal(request);
      return reply.status(405).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
    });
    app.delete("/mcp", async (request, reply) => {
      await requireMcpPrincipal(request);
      return reply.status(405).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
    });
    app.post("/mcp", async (request, reply) => {
      const token = await requireMcpPrincipal(request);
      reply.hijack();
      try {
        await handleStatelessHttpMcpRequest({
          brokerUrl: brokerUrl.href,
          bearerToken: token,
          request: request.raw,
          response: reply.raw,
          body: request.body,
        });
      } catch (error: unknown) {
        request.log.error({ err: error }, "remote MCP request failed");
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { "content-type": "application/json" });
          reply.raw.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            }),
          );
        }
      }
    });

    app.addHook("onSend", async (request, reply, payload) => {
      if (request.url.startsWith("/.well-known/oauth-protected-resource")) {
        void reply.header("access-control-allow-origin", "*");
      }
      return payload;
    });

    app.addHook("onError", async (request, reply, error) => {
      if (
        request.url.startsWith("/mcp") &&
        error instanceof BrokerHttpError &&
        error.statusCode === 401
      ) {
        void reply.header(
          "www-authenticate",
          `Bearer resource_metadata="${resourceMetadataUrl}", scope="user:org:read"`,
        );
      }
    });
  }

  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/v1/")) {
      return;
    }
    if (apiKeys.length === 0 && options.authenticateBearer === undefined) {
      request.liveprobePrincipal = sharedPrincipal("development");
      return;
    }
    if (bearerTokenMatches(request.headers.authorization, apiKeys)) {
      request.liveprobePrincipal = sharedPrincipal("shared-key");
      return;
    }
    const token = bearerToken(request.headers.authorization);
    if (
      token?.startsWith(SERVICE_API_KEY_PREFIX) === true &&
      store !== false &&
      store.authenticateServiceCredential !== undefined
    ) {
      const credential = await store.authenticateServiceCredential(
        hashBearerToken(token),
      );
      if (credential !== undefined) {
        request.liveprobePrincipal = servicePrincipal(credential);
        return;
      }
    }
    if (token !== undefined && options.authenticateBearer !== undefined) {
      const principal = await authenticateExternalBearer(
        token,
        options.authenticateBearer,
      );
      if (principal !== undefined) {
        request.liveprobePrincipal = principal;
        return;
      }
    }
    throw new BrokerHttpError(
      401,
      "unauthorized",
      "missing or invalid Authorization bearer token",
    );
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
    scope: ResourceScope,
  ): Promise<void> => {
    if (store === false) return;
    await (store.persistSourceMapSet === undefined
      ? store.persist(state)
      : store.persistSourceMapSet(state, serviceId, commitSha, scope));
  };

  const appendAuditEvent = async (
    request: FastifyRequest,
    principal: BrokerPrincipal,
    context: AuditMutationContext,
    outcome: AuditOutcome,
    statusCode?: number,
    errorCode?: string,
  ): Promise<void> => {
    if (store === false || store.appendAuditEvent === undefined) return;
    await store.appendAuditEvent({
      auditId: `aud_${randomBytes(16).toString("hex")}`,
      tenantId: principal.tenantId,
      projectId: principal.projectId,
      environmentId: principal.environmentId,
      occurredAt: new Date(state.now()).toISOString(),
      requestId: String(request.id),
      actorType: principal.type,
      actorId: principal.principalId,
      actorRole: principal.role,
      action: context.action,
      resourceType: context.resourceType,
      ...(context.resourceId === undefined
        ? {}
        : { resourceId: context.resourceId }),
      outcome,
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(errorCode === undefined ? {} : { errorCode }),
      metadata: context.metadata,
    });
  };

  const runAuditedMutation = async <T>(
    request: FastifyRequest,
    context: AuditMutationContext,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const principal = principalFor(request);
    await appendAuditEvent(request, principal, context, "attempt");
    try {
      const result = await operation();
      await appendAuditEvent(
        request,
        principal,
        context,
        "success",
        context.successStatus,
      );
      return result;
    } catch (error: unknown) {
      const statusCode =
        error instanceof BrokerHttpError
          ? error.statusCode
          : error instanceof ZodError
            ? 400
            : 500;
      const errorCode =
        error instanceof BrokerHttpError
          ? error.code
          : error instanceof ZodError
            ? "invalid_request"
            : "internal_error";
      await appendAuditEvent(
        request,
        principal,
        context,
        statusCode === 401 || statusCode === 403 ? "denied" : "error",
        statusCode,
        errorCode,
      );
      throw error;
    }
  };

  app.post("/v1/probes", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = CreateProbeSchema.parse(request.body);
    const audit: AuditMutationContext = {
      action: "probe.create",
      resourceType: "probe",
      metadata: { serviceId: input.serviceId, probeType: input.type },
      successStatus: 201,
    };
    const probe = await runAuditedMutation(request, audit, async () => {
      const principal = requireProbeManager(request);
      const created = await mutateDurably(
        () => state.createProbe(input, principal),
        async (persisted) => {
          if (store === false) return;
          await (store.persistProbe === undefined
            ? store.persist(state)
            : store.persistProbe(state, persisted.id, principal));
        },
      );
      audit.resourceId = created.id;
      return created;
    });
    return reply.status(201).send({ probe });
  });

  app.delete("/v1/probes/:id", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const { id } = probeParamsSchema.parse(request.params);
    await runAuditedMutation(
      request,
      {
        action: "probe.delete",
        resourceType: "probe",
        resourceId: id,
        metadata: {},
        successStatus: 204,
      },
      async () => {
        const principal = requireProbeManager(request);
        await mutateDurably(
          () => state.deleteProbe(id, principal),
          async () => {
            if (store === false) return;
            await (store.deleteProbe === undefined
              ? store.persist(state)
              : store.deleteProbe(state, id, principal));
          },
        );
      },
    );
    return reply.status(204).send();
  });

  app.get("/v1/probes", async (request) => {
    const principal = requireHumanRead(request);
    const { serviceId } = listProbeQuerySchema.parse(request.query);
    return { probes: state.listProbes(serviceId, principal) };
  });

  app.get("/v1/services", async (request) => {
    const principal = requireHumanRead(request);
    emptyQuerySchema.parse(request.query);
    return { services: state.listServices(principal) };
  });

  app.get("/v1/ping", async (request) => {
    emptyQuerySchema.parse(request.query);
    return { ok: true };
  });

  app.get("/v1/safety", async (request) => {
    const principal = requireHumanRead(request);
    emptyQuerySchema.parse(request.query);
    return state.safetyOverview(45_000, principal);
  });

  app.post("/v1/service-credentials", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = serviceCredentialCreateSchema.parse(request.body);
    const audit: AuditMutationContext = {
      action: "service_credential.create",
      resourceType: "service_credential",
      metadata: { serviceId: input.serviceId },
      successStatus: 201,
    };
    const { credential, apiKey } = await runAuditedMutation(
      request,
      audit,
      async () => {
        const principal = requireAdmin(request);
        if (store === false || store.createServiceCredential === undefined) {
          throw new BrokerHttpError(
            503,
            "credential_store_unavailable",
            "service credentials require the PostgreSQL durable store",
          );
        }
        const material = createServiceCredentialMaterial({
          serviceId: input.serviceId,
          label: input.label,
          scope: principal,
          now: new Date(state.now()),
        });
        const created = await store.createServiceCredential(material.record);
        audit.resourceId = created.credentialId;
        return { credential: created, apiKey: material.apiKey };
      },
    );
    return reply.status(201).send({
      credential,
      apiKey,
    });
  });

  app.get("/v1/service-credentials", async (request) => {
    const principal = requireAdmin(request);
    emptyQuerySchema.parse(request.query);
    if (store === false || store.listServiceCredentials === undefined) {
      throw new BrokerHttpError(
        503,
        "credential_store_unavailable",
        "service credentials require the PostgreSQL durable store",
      );
    }
    return {
      credentials: await store.listServiceCredentials(principal),
    };
  });

  app.delete(
    "/v1/service-credentials/:credentialId",
    async (request, reply) => {
      emptyQuerySchema.parse(request.query);
      const { credentialId } = serviceCredentialParamsSchema.parse(
        request.params,
      );
      await runAuditedMutation(
        request,
        {
          action: "service_credential.revoke",
          resourceType: "service_credential",
          resourceId: credentialId,
          metadata: {},
          successStatus: 204,
        },
        async () => {
          const principal = requireAdmin(request);
          if (store === false || store.revokeServiceCredential === undefined) {
            throw new BrokerHttpError(
              503,
              "credential_store_unavailable",
              "service credentials require the PostgreSQL durable store",
            );
          }
          const revoked = await store.revokeServiceCredential(
            credentialId,
            principal,
          );
          if (!revoked) {
            throw new BrokerHttpError(
              404,
              "not_found",
              `service credential ${credentialId} was not found or is already revoked`,
            );
          }
        },
      );
      return reply.status(204).send();
    },
  );

  app.get("/v1/audit-events", async (request) => {
    const principal = requireAdmin(request);
    const query = auditListQuerySchema.parse(request.query);
    if (store === false || store.listAuditEvents === undefined) {
      throw new BrokerHttpError(
        503,
        "audit_store_unavailable",
        "audit events require the PostgreSQL durable store",
      );
    }
    return {
      events: await store.listAuditEvents(principal, query),
    };
  });

  app.get(
    "/v1/services/:serviceId/probes",
    async (request) => {
      const { serviceId } = pollParamsSchema.parse(request.params);
      const principal = requireServiceAccess(request, serviceId);
      const { since, commitSha } = pollQuerySchema.parse(request.query);
      return state.pollProbes(serviceId, since, commitSha, principal);
    },
  );

  app.post("/v1/source-maps/status", async (request) => {
    emptyQuerySchema.parse(request.query);
    const input = sourceMapStatusSchema.parse(request.body);
    const principal = requireServiceAccess(request, input.serviceId);
    const previousMapCount =
      state.getSourceMapSet(input.serviceId, input.commitSha, principal)?.maps
        .length ?? 0;
    const status = state.sourceMapStatus(
      input.serviceId,
      input.commitSha,
      input.uploaderId,
      principal,
    );
    if (
      previousMapCount > 0 &&
      status.isUploader &&
      state.getSourceMapSet(input.serviceId, input.commitSha, principal)?.maps
        .length === 0
    ) {
      await persistSourceMapSet(input.serviceId, input.commitSha, principal);
    }
    return status;
  });

  app.post("/v1/source-maps/upload", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = sourceMapUploadSchema.parse(request.body);
    const principal = requireServiceAccess(request, input.serviceId);
    await mutateDurably(
      () => state.uploadSourceMap(input, principal),
      async () =>
        persistSourceMapSet(input.serviceId, input.commitSha, principal),
    );
    return reply.status(202).send({ accepted: true });
  });

  app.post("/v1/source-maps/complete", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = sourceMapStatusSchema.parse(request.body);
    const principal = requireServiceAccess(request, input.serviceId);
    await mutateDurably(
      () =>
        state.completeSourceMaps(
          input.serviceId,
          input.commitSha,
          input.uploaderId,
          principal,
        ),
      async () =>
        persistSourceMapSet(input.serviceId, input.commitSha, principal),
    );
    return reply.status(202).send({ complete: true });
  });

  app.post("/v1/ingest", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = IngestSchema.parse(request.body);
    const principal = requireServiceAccess(request, input.serviceId);
    const accepted = await mutateDurably(
      () => state.ingest(input, principal),
      async () => {
        if (store === false) return;
        await (store.persistIngest === undefined
          ? store.persist(state)
          : store.persistIngest(state, input, principal));
      },
    );
    return reply.status(202).send({ accepted });
  });

  app.get("/v1/probes/:id/data", async (request, reply) => {
    const principal = requireHumanRead(request);
    const { id } = probeParamsSchema.parse(request.params);
    const query = dataQuerySchema.parse(request.query);
    const waitSeconds = Math.min(30, Math.max(0, query.waitSeconds));
    let probe = state.getProbe(id, principal);
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
      probe = state.getProbe(id, principal);
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
      status: state.getStatus(id, principal),
      events: state.getEvents(id, principal),
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

  interface FastifyRequest {
    liveprobePrincipal: BrokerPrincipal | null;
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
  const clerkSessionAuthenticator = clerkAuthenticatorFromEnv();
  const clerkOAuthAuthenticator = clerkOAuthAuthenticatorFromEnv();
  const clerkFrontendApiUrl = process.env["CLERK_FRONTEND_API_URL"];
  if (
    clerkOAuthAuthenticator !== undefined &&
    (clerkFrontendApiUrl === undefined ||
      clerkFrontendApiUrl.trim().length === 0)
  ) {
    throw new Error(
      "CLERK_FRONTEND_API_URL is required for remote MCP OAuth discovery",
    );
  }
  const authenticateBearer = combineBearerAuthenticators(
    [clerkOAuthAuthenticator, clerkSessionAuthenticator].filter(
      (authenticate): authenticate is BearerAuthenticator =>
        authenticate !== undefined,
    ),
  );
  if (
    (process.env["NODE_ENV"] === "production" ||
      process.env["LIVEPROBE_REQUIRE_API_KEY"] === "true") &&
    configuredApiKeys.length === 0 &&
    authenticateBearer === undefined
  ) {
    throw new Error(
      "shared API keys or Clerk authentication are required in production",
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
    ...(authenticateBearer === undefined ? {} : { authenticateBearer }),
    ...(clerkOAuthAuthenticator === undefined
      ? {}
      : {
          remoteMcp: {
            publicUrl: process.env["LIVEPROBE_PUBLIC_URL"]!,
            brokerUrl:
              process.env["LIVEPROBE_INTERNAL_BROKER_URL"] ??
              `http://127.0.0.1:${port}`,
            authorizationServerUrl: clerkFrontendApiUrl!,
            authenticateBearer: clerkOAuthAuthenticator,
          },
        }),
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
