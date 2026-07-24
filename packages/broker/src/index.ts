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
import {
  BuildIdSchema,
  ConditionSchema as SharedConditionSchema,
  CreateProbeInputSchema as SharedCreateProbeInputSchema,
  NativeAgentRegistrationSchema,
  NativeInstanceSchema,
  NativeInstanceSetSchema,
  NativeIngestEnvelopeSchema,
  NativeProbeStatusSchema,
  NativeReasonCodeSchema,
  NativeStatusMetadataSchema,
  ProbeDefinitionSchema as SharedProbeDefinitionSchema,
  type NativeAgentRegistration,
  type NativeInstance,
} from "@liveprobe/protocol";
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
  NATIVE_API_KEY_PREFIX,
  DEFAULT_RESOURCE_SCOPE,
  createServiceCredentialMaterial,
  createNativeCredentialMaterial,
  hashBearerToken,
  servicePrincipal,
  nativePrincipal,
  sharedPrincipal,
  type BrokerPrincipal,
  type BearerAuthenticator,
  type ResourceScope,
  type ResourceScopeLabels,
  type ServiceCredentialRecord,
  type StoredServiceCredential,
  type NativeCredentialRecord,
  type StoredNativeCredential,
} from "./auth.js";
import {
  clerkAuthenticatorFromEnv,
  clerkOAuthAuthenticatorFromEnv,
  combineBearerAuthenticators,
} from "./clerk-auth.js";
import {
  compileExpression,
  compileTemplate,
  type CompiledExpression,
  type ExpressionNode,
  type TemplateSegment,
} from "./expression.js";
import type {
  EnvironmentRecord,
  ProjectRecord,
  RegisteredServiceRecord,
} from "./resource-catalog.js";
import { PostgresStore } from "./store/postgres.js";
import {
  resolveSourceLocation,
  stripSourcesContent,
  validateSourceMap,
  type StoredSourceMap,
} from "./source-map-resolver.js";

export { PostgresStore } from "./store/postgres.js";
export { compileExpression, compileTemplate } from "./expression.js";
export type {
  CompiledExpression,
  ExpressionNode,
  TemplateSegment,
} from "./expression.js";
export {
  BearerAuthenticationError,
  SERVICE_API_KEY_PREFIX,
  NATIVE_API_KEY_PREFIX,
  createServiceCredentialMaterial,
  createNativeCredentialMaterial,
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
  NativeCredentialRecord,
  StoredNativeCredential,
} from "./auth.js";
export type {
  AuditEventRecord,
  AuditListOptions,
  AuditMetadataValue,
  AuditOutcome,
} from "./audit.js";
export type {
  EnvironmentRecord,
  ProjectRecord,
  RegisteredServiceRecord,
} from "./resource-catalog.js";
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
const ACTIVE_AGENT_WINDOW_MS = 45_000;
const KNOWN_AGENT_CAPABILITIES = [
  "log-levels-v1",
  "expression-ast-v1",
  "frame-locals-v1",
] as const;
const SOURCE_MAP_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const SOURCE_MAP_COMMITS_PER_SERVICE = 5;

const serviceIdSchema = z.string().trim().min(1).max(200);
const catalogIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "must start with a lowercase letter or digit and contain only lowercase letters, digits, dots, underscores, or hyphens",
  );
const displayNameSchema = z.string().trim().min(1).max(200);
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
const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export const AgentCapabilitySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9.-]*$/,
    "must be a lowercase capability identifier",
  );
const agentIdSchema = z.string().trim().min(1).max(200);
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
const expressionScalarSchema = z.union([
  z.string(),
  z
    .number()
    .finite()
    .refine(
      (value) => !Number.isInteger(value) || Number.isSafeInteger(value),
      "integer expression values must be within the IEEE-754 safe range",
    ),
  z.boolean(),
  z.null(),
]);

export const ConditionSchema = SharedConditionSchema;

const expressionPathSegmentSchema = z.union([
  z.string().min(1).max(128),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]);
export const ExpressionNodeSchema: z.ZodType<ExpressionNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("literal"),
        value: expressionScalarSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("reference"),
        path: z.array(expressionPathSegmentSchema).min(1).max(64),
      })
      .strict(),
    z
      .object({
        type: z.literal("unary"),
        operator: z.enum(["not", "negate"]),
        operand: ExpressionNodeSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("binary"),
        operator: z.enum([
          "add",
          "subtract",
          "multiply",
          "divide",
          "modulo",
          "eq",
          "ne",
          "gt",
          "gte",
          "lt",
          "lte",
          "and",
          "or",
        ]),
        left: ExpressionNodeSchema,
        right: ExpressionNodeSchema,
      })
      .strict(),
  ]),
);

export const CompiledExpressionSchema: z.ZodType<CompiledExpression> = z
  .object({
    source: z.string().min(1).max(4_096),
    ast: ExpressionNodeSchema,
  })
  .strict();

const TemplateSegmentSchema: z.ZodType<TemplateSegment> =
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("text"),
        value: z.string().max(16_384),
      })
      .strict(),
    z
      .object({
        type: z.literal("expression"),
        expression: CompiledExpressionSchema,
      })
      .strict(),
  ]);

export const CreateProbeSchema = SharedCreateProbeInputSchema;

export const ProbeDefinitionSchema = SharedProbeDefinitionSchema;

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
      t: "unavailable";
      v: {
        reasonCode: z.infer<typeof NativeReasonCodeSchema>;
        detail?: string | undefined;
        siteId?: string | undefined;
        buildId?: string | undefined;
      };
    }
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
    z.object({
      t: z.literal("unavailable"),
      v: z.object({
        reasonCode: NativeReasonCodeSchema,
        detail: z.string().max(4_096).optional(),
        siteId: z.string().max(300).optional(),
        buildId: BuildIdSchema.optional(),
      }).strict(),
    }).strict(),
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
    variables: SerializedNodeSchema.optional(),
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
  probeVersion: z.number().int().positive().optional(),
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
      level: logLevelSchema,
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
      ...NativeStatusMetadataSchema.shape,
    })
    .strict(),
]);

export type ProbeEvent = z.infer<typeof ProbeEventSchema>;
export type ProbeStatusName = z.infer<typeof StatusNameSchema>;

export const SafetyReasonCodeSchema = z.enum([
  "event_loop_lag",
  "pause_budget",
  "rate_limited",
  "instrumentation_failure",
  "agent_worker_failure",
]);

export const SafetyLimitsSchema = z
  .object({
    maxProbeHitsPerSecond: z.number().finite().nonnegative().optional(),
    maxProbePauseMsPerSecond: z.number().finite().nonnegative().optional(),
    safetyCooldownMs: z.number().int().nonnegative().optional(),
    maxTelemetryBytesPerSecond: z.number().finite().nonnegative().optional(),
    maxBufferedEventBytes: z.number().int().positive().optional(),
    maxEventLoopLagMs: z.number().finite().positive().optional(),
  })
  .strict();

function nativeStatusEndsAssignment(status: ProbeStatusName): boolean {
  return status === "hit-limit-reached" ||
    status === "suspended" ||
    status === "expired";
}

export const AgentStatusSchema = z
  .object({
    state: z.enum(["green", "red"]),
    detail: z.string().max(4_096).optional(),
    reasonCode: SafetyReasonCodeSchema.optional(),
    limits: SafetyLimitsSchema.optional(),
  })
  .strict()
  .superRefine((status, context) => {
    if (status.state === "green" && status.reasonCode !== undefined) {
      context.addIssue({
        code: "custom",
        message: "reasonCode is only valid when agent state is red",
        path: ["reasonCode"],
      });
    }
  });

export const IngestSchema = z
  .object({
    serviceId: serviceIdSchema,
    sdk: z.enum(["node", "python", "jvm"]),
    agentId: agentIdSchema.optional(),
    commitSha: commitShaSchema,
    commitSource: commitSourceSchema.optional(),
    capabilities: z.array(AgentCapabilitySchema).max(32).default([]),
    agentStatus: AgentStatusSchema,
    events: z.array(ProbeEventSchema).max(10_000),
  })
  .strict();

export type AgentSdk = z.infer<typeof IngestSchema>["sdk"];
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
type ParsedIngestInput = z.infer<typeof IngestSchema>;
export type IngestInput = Omit<ParsedIngestInput, "capabilities"> & {
  capabilities?: AgentCapability[];
};

export interface ProbeStatus {
  status: ProbeStatusName;
  updatedAt: string;
  detail?: string | undefined;
  reasonCode?: z.infer<typeof NativeReasonCodeSchema> | undefined;
  agentId?: string | undefined;
  instanceId?: string | undefined;
  buildId?: string | undefined;
  probeVersion?: number | undefined;
  siteId?: string | undefined;
  resolution?: z.infer<typeof NativeStatusMetadataSchema>["resolution"];
  variableAvailability?: z.infer<typeof NativeStatusMetadataSchema>["variableAvailability"];
  physicalSiteCount?: number | undefined;
  rawHitRate?: number | undefined;
  droppedEventCount?: number | undefined;
}

export interface ServiceRecord {
  serviceId: string;
  lastSeen: string;
  sdk?: AgentSdk | undefined;
  commitSha?: string | undefined;
  commitSource?: "env" | "config" | undefined;
  capabilities?: AgentCapability[] | undefined;
  agentStatus?: AgentStatus | undefined;
  backend?: "managed-runtime" | "native-ebpf" | undefined;
  language?: "node" | "python" | "jvm" | "rust" | "cpp" | undefined;
  instanceCount?: number | undefined;
  buildIds?: string[] | undefined;
  nativeLimitations?: string[] | undefined;
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
  createProject?(
    tenantId: string,
    projectId: string,
    displayName: string,
  ): Promise<ProjectRecord | undefined>;
  listProjects?(
    tenantId: string,
    includeArchived?: boolean,
  ): Promise<ProjectRecord[]>;
  archiveProject?(tenantId: string, projectId: string): Promise<boolean>;
  createEnvironment?(
    scope: ResourceScope,
    displayName: string,
  ): Promise<EnvironmentRecord | undefined>;
  listEnvironments?(
    tenantId: string,
    projectId: string,
    includeArchived?: boolean,
  ): Promise<EnvironmentRecord[]>;
  archiveEnvironment?(scope: ResourceScope): Promise<boolean>;
  createRegisteredService?(
    tenantId: string,
    projectId: string,
    serviceId: string,
    displayName: string,
  ): Promise<RegisteredServiceRecord | undefined>;
  getRegisteredService?(
    tenantId: string,
    projectId: string,
    serviceId: string,
  ): Promise<RegisteredServiceRecord | undefined>;
  listRegisteredServices?(
    tenantId: string,
    projectId: string,
    includeArchived?: boolean,
  ): Promise<RegisteredServiceRecord[]>;
  archiveRegisteredService?(
    tenantId: string,
    projectId: string,
    serviceId: string,
  ): Promise<boolean>;
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
  createNativeCredential?(
    credential: StoredNativeCredential,
  ): Promise<NativeCredentialRecord>;
  listNativeCredentials?(
    scope: ResourceScope,
  ): Promise<NativeCredentialRecord[]>;
  revokeNativeCredential?(
    credentialId: string,
    scope: ResourceScope,
  ): Promise<boolean>;
  authenticateNativeCredential?(
    secretHash: string,
  ): Promise<NativeCredentialRecord | undefined>;
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

function scopeFor(request: FastifyRequest): ResourceScope {
  if (request.liveprobeScope === null) {
    throw new Error("authenticated request is missing its resource scope");
  }
  return request.liveprobeScope;
}

function requireHumanRead(request: FastifyRequest): BrokerPrincipal {
  const principal = principalFor(request);
  if (principal.type === "service" || principal.type === "native") {
    throw new BrokerHttpError(
      403,
      "forbidden",
      "runtime credentials cannot read human control-plane resources",
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

function selectedResourceScope(
  base: ResourceScope,
  selection: {
    projectId?: string | undefined;
    environmentId?: string | undefined;
  },
): ResourceScope {
  return {
    tenantId: base.tenantId,
    projectId: selection.projectId ?? base.projectId,
    environmentId: selection.environmentId ?? base.environmentId,
  };
}

function requireServiceAccess(
  request: FastifyRequest,
  serviceId: string,
): BrokerPrincipal {
  const principal = principalFor(request);
  if (principal.type === "native") {
    throw new BrokerHttpError(
      403,
      "forbidden",
      "native credentials cannot call managed runtime routes",
    );
  }
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

function requireNativeAccess(
  request: FastifyRequest,
  agentId: string,
): ResourceScope & { allowedServiceIds: readonly string[] } {
  const principal = principalFor(request);
  if (principal.type === "shared") {
    return { ...resourceScope(principal), allowedServiceIds: ["*"] };
  }
  if (principal.type !== "native") {
    throw new BrokerHttpError(
      403,
      "forbidden",
      "only native host-agent credentials may call native runtime routes",
    );
  }
  if (principal.agentId !== agentId) {
    throw new BrokerHttpError(403, "forbidden", "native credential agent ID mismatch");
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
    ...NativeStatusMetadataSchema.shape,
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
    capabilities: z.array(AgentCapabilitySchema).max(32).default([]),
    agentStatus: AgentStatusSchema.optional(),
    backend: z.enum(["managed-runtime", "native-ebpf"]).optional(),
    language: z.enum(["node", "python", "jvm", "rust", "cpp"]).optional(),
    instanceCount: z.number().int().nonnegative().optional(),
    buildIds: z.array(BuildIdSchema).optional(),
    nativeLimitations: z.array(z.string()).optional(),
  })
  .strict();

const persistedNativeAgentSchema = NativeAgentRegistrationSchema.extend({
  ...resourceScopeShape,
  lastSeen: timestampSchema,
}).strict();
const persistedNativeInstanceSchema = NativeInstanceSchema.extend({
  ...resourceScopeShape,
  agentId: z.string().trim().min(1).max(200),
  capabilities: z.array(z.string()).default([]),
}).strict();
const persistedNativeStatusSchema = z.object({
  ...resourceScopeShape,
  probeId: probeIdSchema,
  probeVersion: z.number().int().positive(),
  agentId: z.string().trim().min(1).max(200),
  instanceId: z.string().trim().min(1).max(300),
  buildId: BuildIdSchema,
  value: persistedStatusSchema,
}).strict();
const persistedNativeAssignmentVersionSchema = z.object({
  ...resourceScopeShape,
  agentId: z.string().trim().min(1).max(200),
  version: z.number().int().nonnegative(),
}).strict();

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
    nativeAgents: z.array(persistedNativeAgentSchema).default([]),
    nativeInstances: z.array(persistedNativeInstanceSchema).default([]),
    nativeStatuses: z.array(persistedNativeStatusSchema).default([]),
    nativeAssignmentVersions: z
      .array(persistedNativeAssignmentVersionSchema)
      .default([]),
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

interface AgentCapabilityReport {
  lastSeen: number;
  capabilities: AgentCapability[];
}

function normalizeAgentCapabilities(
  capabilities: AgentCapability[],
): AgentCapability[] {
  const unique = new Set(capabilities);
  return [
    ...KNOWN_AGENT_CAPABILITIES.filter((capability) => unique.delete(capability)),
    ...[...unique].sort(),
  ];
}

type ScopedServiceRecord = ServiceRecord & ResourceScope;
type NativeAgentRecord = z.infer<typeof persistedNativeAgentSchema>;
type NativeInstanceRecord = z.infer<typeof persistedNativeInstanceSchema>;
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

function invalidExpression(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new BrokerHttpError(400, "invalid_expression", message);
}

function compileProbeInput(input: CreateProbeInput): Record<string, unknown> {
  if (input.condition !== undefined && input.conditionExpression !== undefined) {
    throw new BrokerHttpError(
      400,
      "invalid_request",
      "condition and conditionExpression are mutually exclusive",
    );
  }

  let conditionExpression: CompiledExpression | undefined;
  try {
    conditionExpression =
      input.conditionExpression === undefined
        ? undefined
        : compileExpression(input.conditionExpression);
  } catch (error) {
    invalidExpression(error);
  }

  const { conditionExpression: _conditionExpression, ...common } = input;
  const compiledCommon: Record<string, unknown> = {
    ...common,
    ...(conditionExpression === undefined ? {} : { conditionExpression }),
  };

  if (input.type === "snapshot") {
    let watchExpressions: CompiledExpression[] | undefined;
    try {
      watchExpressions = input.watchExpressions?.map(compileExpression);
    } catch (error) {
      invalidExpression(error);
    }
    const { watchExpressions: _watchExpressions, ...snapshot } = compiledCommon;
    return {
      ...snapshot,
      ...(watchExpressions === undefined ? {} : { watchExpressions }),
    };
  }

  if (input.type === "log") {
    let templateSegments: TemplateSegment[] | undefined;
    try {
      templateSegments = compileTemplate(input.template);
    } catch (error) {
      invalidExpression(error);
    }
    return {
      ...compiledCommon,
      ...(templateSegments === undefined ? {} : { templateSegments }),
    };
  }

  if (input.type === "metric") {
    if (
      (input.metricPath === undefined) ===
      (input.metricExpression === undefined)
    ) {
      throw new BrokerHttpError(
        400,
        "invalid_request",
        "metric probes require exactly one of metricPath or metricExpression",
      );
    }
    let metricExpression: CompiledExpression | undefined;
    try {
      metricExpression =
        input.metricExpression === undefined
          ? undefined
          : compileExpression(input.metricExpression);
    } catch (error) {
      invalidExpression(error);
    }
    const { metricExpression: _metricExpression, ...metric } = compiledCommon;
    return {
      ...metric,
      ...(metricExpression === undefined ? {} : { metricExpression }),
    };
  }

  return compiledCommon;
}

function requiresExpressionCapability(
  input: Record<string, unknown>,
): boolean {
  return (
    input["conditionExpression"] !== undefined ||
    input["watchExpressions"] !== undefined ||
    input["templateSegments"] !== undefined ||
    input["metricExpression"] !== undefined
  );
}

export class BrokerState {
  private readonly probes = new Map<string, StoredProbe>();
  private readonly serviceVersions = new Map<string, ScopedServiceVersion>();
  private readonly events = new Map<string, ProbeEvent[]>();
  private readonly services = new Map<string, ScopedServiceRecord>();
  private readonly agentCapabilityReports = new Map<
    string,
    Map<string, AgentCapabilityReport>
  >();
  private readonly statuses = new Map<string, ProbeStatus>();
  private readonly sourceMapSets = new Map<string, SourceMapSet>();
  private readonly sourceMapLeases = new Map<string, SourceMapLease>();
  private readonly nativeAgents = new Map<string, NativeAgentRecord>();
  private readonly nativeInstances = new Map<string, NativeInstanceRecord>();
  private readonly nativeStatuses = new Map<string, ProbeStatus>();
  private readonly nativeAssignmentVersions = new Map<string, number>();
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
    const compiledInput = compileProbeInput(input);
    this.refreshServiceCapabilities(scope, input.serviceId);
    const service = this.services.get(this.serviceKey(scope, input.serviceId));
    if (service?.backend === "native-ebpf") {
      const unsupported =
        input.conditionExpression !== undefined
          ? ["conditionExpression", "simple condition"]
          : input.type === "snapshot" && input.watchExpressions !== undefined
            ? ["watchExpressions", "watchPaths"]
            : input.type === "snapshot" && input.includeStackLocals
              ? ["includeStackLocals", "bounded watchPaths"]
              : input.type === "snapshot" && input.stackFrameLimit !== 3
                ? ["stackFrameLimit", "omit stack capture options"]
                : input.type === "metric" && input.metricExpression !== undefined
                  ? ["metricExpression", "metricPath"]
                  : input.type === "log" && input.logLevel !== "info"
                    ? ["logLevel", "info"]
                    : undefined;
      if (unsupported !== undefined) {
        throw new BrokerHttpError(
          409,
          "unsupported_by_backend",
          `native-ebpf service ${input.serviceId} does not support ${unsupported[0]}; use ${unsupported[1]}`,
        );
      }
      if (
        input.type === "snapshot" &&
        (input.watchPaths === undefined || input.watchPaths.length === 0)
      ) {
        throw new BrokerHttpError(
          409,
          "unsupported_by_backend",
          `native-ebpf service ${input.serviceId} requires at least one bounded watchPath`,
        );
      }
    }
    if (input.type === "log" && input.logLevel !== "info") {
      if (!service?.capabilities?.includes("log-levels-v1")) {
        throw new BrokerHttpError(
          409,
          "agent_upgrade_required",
          `service ${input.serviceId} does not report log-levels-v1`,
        );
      }
    }
    if (
      requiresExpressionCapability(compiledInput) &&
      !service?.capabilities?.includes("expression-ast-v1")
    ) {
      throw new BrokerHttpError(
        409,
        "agent_upgrade_required",
        `service ${input.serviceId} does not report expression-ast-v1`,
      );
    }
    if (
      input.type === "snapshot" &&
      input.includeStackLocals &&
      !service?.capabilities?.includes("frame-locals-v1")
    ) {
      throw new BrokerHttpError(
        409,
        "agent_upgrade_required",
        `service ${input.serviceId} does not report frame-locals-v1`,
      );
    }
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
    const probe = ProbeDefinitionSchema.parse({ ...compiledInput, id, version });
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
    input: IngestInput,
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

    const capabilities = this.reportAgentCapabilities(
      scope,
      input.serviceId,
      input.agentId ?? `legacy:${input.sdk}:${input.commitSha}`,
      input.capabilities ?? [],
    );
    this.touchService(
      input.serviceId,
      input.sdk,
      input.agentStatus,
      input.commitSha,
      input.commitSource,
      scope,
      capabilities,
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

  public registerNativeAgent(
    input: NativeAgentRegistration,
    scope: ResourceScope,
  ): NativeAgentRecord {
    const record = persistedNativeAgentSchema.parse({
      ...input,
      ...resourceScope(scope),
      lastSeen: this.timestamp(),
    });
    this.nativeAgents.set(this.nativeAgentKey(scope, input.agentId), record);
    if (!this.nativeAssignmentVersions.has(this.nativeAgentKey(scope, input.agentId))) {
      this.nativeAssignmentVersions.set(this.nativeAgentKey(scope, input.agentId), 0);
    }
    return record;
  }

  public replaceNativeInstances(
    agentId: string,
    instances: NativeInstance[],
    scope: ResourceScope,
    allowedServiceIds: readonly string[],
  ): number {
    const agentKey = this.nativeAgentKey(scope, agentId);
    const agent = this.nativeAgents.get(agentKey);
    if (agent === undefined) {
      throw new BrokerHttpError(404, "native_agent_not_found", "native agent is not registered");
    }
    const allowed = new Set(allowedServiceIds);
    const ids = new Set<string>();
    for (const instance of instances) {
      if (!allowed.has("*") && !allowed.has(instance.serviceId)) {
        throw new BrokerHttpError(403, "forbidden", `service ${instance.serviceId} is not allowed`);
      }
      if (ids.has(instance.instanceId)) {
        throw new BrokerHttpError(400, "invalid_request", "duplicate native instance");
      }
      ids.add(instance.instanceId);
      const existing = [...this.nativeInstances.values()].find((candidate) =>
        sameResourceScope(candidate, scope) &&
        candidate.instanceId === instance.instanceId &&
        candidate.agentId !== agentId
      );
      if (existing !== undefined) {
        throw new BrokerHttpError(409, "native_instance_owned", "native instance has another owner");
      }
    }
    const previous = [...this.nativeInstances.values()]
      .filter((item) => sameResourceScope(item, scope) && item.agentId === agentId)
      .map((item) => `${item.instanceId}\0${item.serviceId}\0${item.buildId}`)
      .sort();
    const next = instances
      .map((item) => `${item.instanceId}\0${item.serviceId}\0${item.buildId}`)
      .sort();
    for (const [key, item] of this.nativeInstances) {
      if (
        sameResourceScope(item, scope) &&
        item.agentId === agentId &&
        !ids.has(item.instanceId)
      ) {
        this.nativeInstances.delete(key);
      }
    }
    for (const instance of instances) {
      this.nativeInstances.set(
        this.nativeInstanceKey(scope, agentId, instance.instanceId),
        persistedNativeInstanceSchema.parse({
          ...instance,
          ...resourceScope(scope),
          agentId,
          capabilities: instance.capabilities ?? agent.capabilities,
        }),
      );
    }
    this.nativeAgents.set(agentKey, { ...agent, lastSeen: this.timestamp() });
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      this.bumpNativeAssignmentVersion(scope, agentId);
    }
    this.rebuildNativeServices(scope);
    return instances.length;
  }

  public nativeAssignments(
    agentId: string,
    since: number,
    scope: ResourceScope,
    allowedServiceIds: readonly string[],
  ): {
    version: number;
    assignments: Array<{
      instanceId: string;
      serviceId: string;
      backend?: "managed-runtime" | "native-ebpf";
      language?: "node" | "python" | "jvm" | "rust" | "cpp";
      buildId: string;
      probes: ProbeDefinition[];
    }>;
  } {
    const agentKey = this.nativeAgentKey(scope, agentId);
    if (!this.nativeAgents.has(agentKey)) {
      throw new BrokerHttpError(404, "native_agent_not_found", "native agent is not registered");
    }
    this.expireDueProbes();
    const version = this.nativeAssignmentVersions.get(agentKey) ?? 0;
    if (since === version) return { version, assignments: [] };
    const allowed = new Set(allowedServiceIds);
    const assignments = [...this.nativeInstances.values()]
      .filter((instance) =>
        sameResourceScope(instance, scope) &&
        instance.agentId === agentId &&
        (allowed.has("*") || allowed.has(instance.serviceId)))
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId))
      .map((instance) => ({
        instanceId: instance.instanceId,
        serviceId: instance.serviceId,
        buildId: instance.buildId,
        probes: [...this.probes.values()]
          .filter((stored) =>
            sameResourceScope(stored.scope, scope) &&
            stored.probe.serviceId === instance.serviceId &&
            !stored.expired &&
            !this.nativeTerminal(
              stored.probe,
              agentId,
              instance.instanceId,
              instance.buildId,
              scope,
            ))
          .map((stored) => stored.probe),
      }));
    return { version, assignments };
  }

  public ingestNative(
    input: {
      agentId: string;
      serviceId: string;
      instanceId: string;
      buildId: string;
      agentStatus: AgentStatus;
      events: ProbeEvent[];
    },
    scope: ResourceScope,
  ): number {
    const instance = this.nativeInstances.get(
      this.nativeInstanceKey(scope, input.agentId, input.instanceId),
    );
    if (
      instance === undefined ||
      instance.serviceId !== input.serviceId ||
      instance.buildId !== input.buildId
    ) {
      throw new BrokerHttpError(409, "target-instance-changed", "native instance identity changed");
    }
    for (const event of input.events) {
      const stored = this.probes.get(event.probeId);
      if (
        stored === undefined ||
        !sameResourceScope(stored.scope, scope) ||
        stored.probe.serviceId !== input.serviceId ||
        (event.type !== "status" && event.type !== stored.probe.type)
      ) {
        throw new BrokerHttpError(400, "invalid_request", "native event does not match its logical probe");
      }
      if (event.probeVersion !== stored.probe.version) {
        throw new BrokerHttpError(
          409,
          "probe_version_changed",
          "native event probe version does not match the logical probe",
        );
      }
      if (event.type === "status") {
        if (
          event.agentId !== input.agentId ||
          event.instanceId !== input.instanceId ||
          event.buildId !== input.buildId
        ) {
          throw new BrokerHttpError(409, "target-instance-changed", "native status identity mismatch");
        }
      }
    }
    for (const event of input.events) {
      this.appendEvent(event);
      if (event.type === "status") {
        const stored = this.probes.get(event.probeId)!;
        const { probeId: _probeId, type: _type, ts, status, ...metadata } = event;
        const statusKey = this.nativeStatusKey(
          scope,
          event.probeId,
          event.probeVersion!,
          input.agentId,
          input.instanceId,
          input.buildId,
        );
        const previous = this.nativeStatuses.get(statusKey);
        this.nativeStatuses.set(
          statusKey,
          { status, updatedAt: ts, ...metadata },
        );
        if (
          nativeStatusEndsAssignment(status) &&
          (previous === undefined || !nativeStatusEndsAssignment(previous.status))
        ) {
          this.bumpNativeAssignmentVersion(scope, input.agentId);
        }
        this.deriveNativeLogicalStatus(event.probeId, scope);
      }
    }
    const serviceKey = this.serviceKey(scope, input.serviceId);
    const service = this.services.get(serviceKey);
    if (service !== undefined) {
      this.services.set(serviceKey, {
        ...service,
        lastSeen: this.timestamp(),
        agentStatus: input.agentStatus,
      });
    }
    return input.events.length;
  }

  public listServices(
    scope: ResourceScope = DEFAULT_RESOURCE_SCOPE,
  ): ServiceRecord[] {
    for (const service of this.services.values()) {
      if (sameResourceScope(service, scope)) {
        this.refreshServiceCapabilities(scope, service.serviceId);
      }
    }
    return [...this.services.values()]
      .filter((service) => sameResourceScope(service, scope))
      .map((service) => {
        const {
          tenantId: _tenantId,
          projectId: _projectId,
          environmentId: _environmentId,
          ...record
        } = service;
        return {
          ...record,
          backend: record.backend ?? "managed-runtime",
          language: record.language ?? record.sdk,
          instanceCount: record.instanceCount ?? 1,
        };
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
      instanceCount?: number;
      buildIds?: string[];
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
        if (service.backend === "native-ebpf") {
          caveats.splice(0, caveats.length, ...(service.nativeLimitations ?? []));
        } else if (service.sdk === "jvm") {
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
                ...(service.agentStatus.reasonCode === undefined
                  ? {}
                  : { reasonCode: service.agentStatus.reasonCode }),
                ...(service.agentStatus.limits === undefined
                  ? {}
                  : { limits: service.agentStatus.limits }),
              };
        return {
          serviceId: service.serviceId,
          ...(service.backend === undefined ? {} : { backend: service.backend }),
          ...(service.language === undefined ? {} : { language: service.language }),
          ...(service.sdk === undefined ? {} : { sdk: service.sdk }),
          ...(service.commitSha === undefined
            ? {}
            : { commitSha: service.commitSha }),
          lastSeen: service.lastSeen,
          online: now - Date.parse(service.lastSeen) <= staleAfterMs,
          agent,
          probesSummary: summary,
          caveats,
          ...(service.instanceCount === undefined ? {} : {
            instanceCount: service.instanceCount,
          }),
          ...(service.buildIds === undefined ? {} : {
            buildIds: service.buildIds,
          }),
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
    this.agentCapabilityReports.clear();
    this.statuses.clear();
    this.sourceMapSets.clear();
    this.sourceMapLeases.clear();
    this.nativeAgents.clear();
    this.nativeInstances.clear();
    this.nativeStatuses.clear();
    this.nativeAssignmentVersions.clear();

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
      this.services.set(this.serviceKey(service, service.serviceId), {
        ...service,
        capabilities: [],
      });
    }
    for (const status of parsed.statuses) {
      this.statuses.set(status.probeId, status.value);
    }
    this.loadSourceMapSets(parsed.sourceMapSets);
    for (const agent of parsed.nativeAgents) {
      this.nativeAgents.set(this.nativeAgentKey(agent, agent.agentId), agent);
    }
    for (const instance of parsed.nativeInstances) {
      this.nativeInstances.set(
        this.nativeInstanceKey(instance, instance.agentId, instance.instanceId),
        instance,
      );
    }
    for (const entry of parsed.nativeStatuses) {
      this.nativeStatuses.set(this.nativeStatusKey(
        entry, entry.probeId, entry.probeVersion, entry.agentId,
        entry.instanceId, entry.buildId,
      ), entry.value);
    }
    for (const entry of parsed.nativeAssignmentVersions) {
      this.nativeAssignmentVersions.set(
        this.nativeAgentKey(entry, entry.agentId),
        entry.version,
      );
    }
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
      nativeAgents: [...this.nativeAgents.values()],
      nativeInstances: [...this.nativeInstances.values()],
      nativeStatuses: [...this.nativeStatuses.entries()].flatMap(
        ([key, value]) => {
          const parts = key.split("\u0000");
          const probeId = parts[1];
          const probeVersion = Number(parts[2]);
          const agentId = parts[3];
          const instanceId = parts[4];
          const buildId = parts[5];
          if (
            probeId === undefined || agentId === undefined ||
            instanceId === undefined || buildId === undefined
          ) return [];
          const stored = this.probes.get(probeId);
          return stored === undefined ? [] : [{
            ...stored.scope,
            probeId,
            probeVersion,
            agentId,
            instanceId,
            buildId,
            value,
          }];
        },
      ),
      nativeAssignmentVersions: [...this.nativeAssignmentVersions.entries()]
        .flatMap(([key, version]) => {
          const parts = key.split("\u0000");
          const agentId = parts[1];
          if (agentId === undefined) return [];
          const scope = [...this.nativeAgents.values()].find(
            (agent) => this.nativeAgentKey(agent, agent.agentId) === key,
          );
          return scope === undefined ? [] : [{
            ...resourceScope(scope), agentId, version,
          }];
        }),
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
    this.agentCapabilityReports.clear();
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
    for (const instance of this.nativeInstances.values()) {
      if (
        sameResourceScope(instance, scope) &&
        instance.serviceId === serviceId
      ) {
        this.bumpNativeAssignmentVersion(scope, instance.agentId);
      }
    }
    return version;
  }

  private nativeAgentKey(scope: ResourceScope, agentId: string): string {
    return `${resourceScopeKey(scope)}\u0000${agentId}`;
  }

  private nativeInstanceKey(
    scope: ResourceScope,
    agentId: string,
    instanceId: string,
  ): string {
    return `${this.nativeAgentKey(scope, agentId)}\u0000${instanceId}`;
  }

  private nativeStatusKey(
    scope: ResourceScope,
    probeId: string,
    probeVersion: number,
    agentId: string,
    instanceId: string,
    buildId: string,
  ): string {
    return `${resourceScopeKey(scope)}\u0000${probeId}\u0000${probeVersion}\u0000${agentId}\u0000${instanceId}\u0000${buildId}`;
  }

  private bumpNativeAssignmentVersion(
    scope: ResourceScope,
    agentId: string,
  ): number {
    const key = this.nativeAgentKey(scope, agentId);
    const version = (this.nativeAssignmentVersions.get(key) ?? 0) + 1;
    this.nativeAssignmentVersions.set(key, version);
    return version;
  }

  private nativeTerminal(
    probe: ProbeDefinition,
    agentId: string,
    instanceId: string,
    buildId: string,
    scope: ResourceScope,
  ): boolean {
    const status = this.nativeStatuses.get(
      this.nativeStatusKey(
        scope, probe.id, probe.version, agentId, instanceId, buildId,
      ),
    );
    return status !== undefined && nativeStatusEndsAssignment(status.status);
  }

  private deriveNativeLogicalStatus(
    probeId: string,
    scope: ResourceScope,
  ): void {
    const stored = this.probes.get(probeId);
    if (
      stored === undefined ||
      !sameResourceScope(stored.scope, scope) ||
      stored.expired
    ) return;
    const instances = [...this.nativeInstances.values()].filter(
      (instance) =>
        sameResourceScope(instance, scope) &&
        instance.serviceId === stored.probe.serviceId,
    );
    const statuses = instances.map((instance) =>
      this.nativeStatuses.get(this.nativeStatusKey(
        scope, probeId, stored.probe.version, instance.agentId,
        instance.instanceId, instance.buildId,
      )));
    const defined = statuses.filter(
      (status): status is ProbeStatus => status !== undefined,
    );
    if (statuses.some((status) => status === undefined) ||
      defined.some((status) => status.status === "armed")) {
      this.statuses.set(probeId, {
        status: "armed",
        updatedAt: this.timestamp(),
      });
      return;
    }
    const latest = defined.sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )[0];
    if (latest !== undefined) this.statuses.set(probeId, latest);
  }

  private rebuildNativeServices(scope: ResourceScope): void {
    const grouped = new Map<string, NativeInstanceRecord[]>();
    for (const instance of this.nativeInstances.values()) {
      if (!sameResourceScope(instance, scope)) continue;
      const values = grouped.get(instance.serviceId) ?? [];
      values.push(instance);
      grouped.set(instance.serviceId, values);
    }
    for (const [serviceId, instances] of grouped) {
      const capabilitySets = instances.map(
        (instance) => new Set(instance.capabilities),
      );
      const capabilities = [...(capabilitySets[0] ?? new Set<string>())]
        .filter((capability) =>
          capabilitySets.every((set) => set.has(capability)))
        .sort();
      const latest = instances.reduce((left, right) =>
        Date.parse(left.lastSeen) >= Date.parse(right.lastSeen) ? left : right);
      this.services.set(this.serviceKey(scope, serviceId), {
        ...resourceScope(scope),
        serviceId,
        backend: "native-ebpf",
        language: latest.language,
        lastSeen: latest.lastSeen,
        capabilities,
        instanceCount: instances.length,
        buildIds: [...new Set(instances.map((item) => item.buildId))].sort(),
        nativeLimitations: [
          "Linux x86-64 only",
          "bounded scalar, C-string, and fixed-field DWARF capture only",
          "no floating-register, STL, deep traversal, or suspended-future capture",
        ],
      });
    }
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
    capabilities?: AgentCapability[],
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
      ...(capabilities === undefined
        ? previous?.capabilities === undefined
          ? {}
          : { capabilities: previous.capabilities }
        : { capabilities: [...capabilities] }),
    };
    this.services.set(key, service);
  }

  private reportAgentCapabilities(
    scope: ResourceScope,
    serviceId: string,
    agentId: string,
    capabilities: AgentCapability[],
  ): AgentCapability[] {
    const key = this.serviceKey(scope, serviceId);
    const reports =
      this.agentCapabilityReports.get(key) ??
      new Map<string, AgentCapabilityReport>();
    reports.set(agentId, {
      lastSeen: this.now(),
      capabilities: normalizeAgentCapabilities(capabilities),
    });
    this.agentCapabilityReports.set(key, reports);
    return this.activeCapabilityIntersection(reports);
  }

  private refreshServiceCapabilities(
    scope: ResourceScope,
    serviceId: string,
  ): void {
    const key = this.serviceKey(scope, serviceId);
    const service = this.services.get(key);
    if (service === undefined) return;
    const reports = this.agentCapabilityReports.get(key);
    const capabilities =
      reports === undefined ? [] : this.activeCapabilityIntersection(reports);
    this.services.set(key, { ...service, capabilities });
  }

  private activeCapabilityIntersection(
    reports: Map<string, AgentCapabilityReport>,
  ): AgentCapability[] {
    const cutoff = this.now() - ACTIVE_AGENT_WINDOW_MS;
    for (const [agentId, report] of reports) {
      if (report.lastSeen < cutoff) reports.delete(agentId);
    }
    const active = [...reports.values()];
    if (active.length === 0) return [];
    return active[0]?.capabilities.filter((capability) =>
      active.every((report) => report.capabilities.includes(capability)),
    ) ?? [];
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
const includeArchivedQuerySchema = z
  .object({
    includeArchived: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
  })
  .strict();
const projectCreateSchema = z
  .object({
    projectId: catalogIdSchema,
    displayName: displayNameSchema,
  })
  .strict();
const projectParamsSchema = z.object({ projectId: catalogIdSchema }).strict();
const environmentCreateSchema = z
  .object({
    environmentId: catalogIdSchema,
    displayName: displayNameSchema,
  })
  .strict();
const environmentParamsSchema = z
  .object({
    projectId: catalogIdSchema,
    environmentId: catalogIdSchema,
  })
  .strict();
const registeredServiceCreateSchema = z
  .object({
    serviceId: serviceIdSchema,
    displayName: displayNameSchema,
  })
  .strict();
const registeredServiceParamsSchema = z
  .object({
    projectId: catalogIdSchema,
    serviceId: serviceIdSchema,
  })
  .strict();
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
    projectId: catalogIdSchema.optional(),
    environmentId: catalogIdSchema.optional(),
    serviceId: serviceIdSchema,
    label: z.string().trim().min(1).max(200),
  })
  .strict();
const serviceCredentialQuerySchema = z
  .object({
    projectId: catalogIdSchema.optional(),
    environmentId: catalogIdSchema.optional(),
    serviceId: serviceIdSchema.optional(),
  })
  .strict();
const serviceCredentialParamsSchema = z
  .object({
    credentialId: z.string().regex(/^svc_[0-9a-f]{32}$/),
  })
  .strict();
const nativeCredentialCreateSchema = z.object({
  agentId: z.string().trim().min(1).max(200),
  allowedServiceIds: z.array(serviceIdSchema).min(1).max(1_000),
  label: z.string().trim().min(1).max(200),
}).strict();
const nativeCredentialParamsSchema = z.object({
  credentialId: z.string().regex(/^nat_[0-9a-f]{32}$/),
}).strict();
const nativeAgentParamsSchema = z.object({
  agentId: z.string().trim().min(1).max(200),
}).strict();
const nativeAssignmentsQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
}).strict();
const nativeIngestSchema = NativeIngestEnvelopeSchema;
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
  scope?: ResourceScope | undefined;
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
  app.decorateRequest("liveprobeScope", null);

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

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) {
      return;
    }
    let principal: BrokerPrincipal | undefined;
    if (apiKeys.length === 0 && options.authenticateBearer === undefined) {
      principal = sharedPrincipal("development");
    } else if (bearerTokenMatches(request.headers.authorization, apiKeys)) {
      principal = sharedPrincipal("shared-key");
    }
    const token = bearerToken(request.headers.authorization);
    if (
      principal === undefined &&
      token?.startsWith(NATIVE_API_KEY_PREFIX) === true &&
      store !== false &&
      store.authenticateNativeCredential !== undefined
    ) {
      const credential = await store.authenticateNativeCredential(
        hashBearerToken(token),
      );
      if (credential !== undefined) {
        principal = nativePrincipal(credential);
      }
    }
    if (
      principal === undefined &&
      token?.startsWith(SERVICE_API_KEY_PREFIX) === true &&
      store !== false &&
      store.authenticateServiceCredential !== undefined
    ) {
      const credential = await store.authenticateServiceCredential(
        hashBearerToken(token),
      );
      if (credential !== undefined) {
        principal = servicePrincipal(credential);
      }
    }
    if (
      principal === undefined &&
      token !== undefined &&
      options.authenticateBearer !== undefined
    ) {
      principal = await authenticateExternalBearer(
        token,
        options.authenticateBearer,
      );
    }
    if (principal === undefined) {
      throw new BrokerHttpError(
        401,
        "unauthorized",
        "missing or invalid Authorization bearer token",
      );
    }

    const projectHeader = request.headers["liveprobe-project"];
    const environmentHeader = request.headers["liveprobe-environment"];
    if (
      Array.isArray(projectHeader) ||
      Array.isArray(environmentHeader)
    ) {
      throw new BrokerHttpError(
        400,
        "invalid_scope",
        "LiveProbe project and environment headers may only occur once",
      );
    }
    const projectId =
      projectHeader === undefined
        ? principal.projectId
        : catalogIdSchema.parse(projectHeader);
    const environmentId =
      environmentHeader === undefined
        ? principal.environmentId
        : catalogIdSchema.parse(environmentHeader);
    const scope = {
      tenantId: principal.tenantId,
      projectId,
      environmentId,
    };
    if (
      (principal.type === "service" || principal.type === "native") &&
      (projectId !== principal.projectId ||
        environmentId !== principal.environmentId)
    ) {
      throw new BrokerHttpError(
        403,
        "scope_mismatch",
        "runtime credentials cannot switch project or environment",
      );
    }
    if (
      principal.type !== "service" &&
      principal.type !== "native" &&
      (projectId !== principal.projectId ||
        environmentId !== principal.environmentId)
    ) {
      if (store === false || store.listEnvironments === undefined) {
        throw new BrokerHttpError(
          503,
          "scope_store_unavailable",
          "non-default environment routing requires the PostgreSQL durable store",
        );
      }
      const environments = await store.listEnvironments(
        principal.tenantId,
        projectId,
      );
      if (
        !environments.some(
          (environment) => environment.environmentId === environmentId,
        )
      ) {
        throw new BrokerHttpError(
          404,
          "environment_not_found",
          `active environment ${projectId}/${environmentId} was not found`,
        );
      }
    }
    request.liveprobePrincipal = principal;
    request.liveprobeScope = scope;
    void reply.header("liveprobe-project", projectId);
    void reply.header("liveprobe-environment", environmentId);
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
    const auditScope = context.scope ?? scopeFor(request);
    await store.appendAuditEvent({
      auditId: `aud_${randomBytes(16).toString("hex")}`,
      tenantId: auditScope.tenantId,
      projectId: auditScope.projectId,
      environmentId: auditScope.environmentId,
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

  app.post("/v1/projects", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = projectCreateSchema.parse(request.body);
    const project = await runAuditedMutation(
      request,
      {
        action: "project.create",
        resourceType: "project",
        resourceId: input.projectId,
        metadata: { projectId: input.projectId },
        successStatus: 201,
      },
      async () => {
        const principal = requireAdmin(request);
        if (store === false || store.createProject === undefined) {
          throw new BrokerHttpError(
            503,
            "catalog_store_unavailable",
            "project management requires the PostgreSQL durable store",
          );
        }
        const created = await store.createProject(
          principal.tenantId,
          input.projectId,
          input.displayName,
        );
        if (created === undefined) {
          throw new BrokerHttpError(
            404,
            "tenant_not_found",
            `tenant ${principal.tenantId} was not found`,
          );
        }
        return created;
      },
    );
    return reply.status(201).send({ project });
  });

  app.get("/v1/projects", async (request) => {
    const principal = requireHumanRead(request);
    const query = includeArchivedQuerySchema.parse(request.query);
    if (store === false || store.listProjects === undefined) {
      throw new BrokerHttpError(
        503,
        "catalog_store_unavailable",
        "project management requires the PostgreSQL durable store",
      );
    }
    return {
      projects: await store.listProjects(
        principal.tenantId,
        query.includeArchived,
      ),
    };
  });

  app.delete("/v1/projects/:projectId", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const { projectId } = projectParamsSchema.parse(request.params);
    await runAuditedMutation(
      request,
      {
        action: "project.archive",
        resourceType: "project",
        resourceId: projectId,
        metadata: { projectId },
        successStatus: 204,
      },
      async () => {
        const principal = requireAdmin(request);
        if (store === false || store.archiveProject === undefined) {
          throw new BrokerHttpError(
            503,
            "catalog_store_unavailable",
            "project management requires the PostgreSQL durable store",
          );
        }
        if (!(await store.archiveProject(principal.tenantId, projectId))) {
          throw new BrokerHttpError(
            404,
            "not_found",
            `active project ${projectId} was not found`,
          );
        }
      },
    );
    return reply.status(204).send();
  });

  app.post(
    "/v1/projects/:projectId/environments",
    async (request, reply) => {
      emptyQuerySchema.parse(request.query);
      const { projectId } = projectParamsSchema.parse(request.params);
      const input = environmentCreateSchema.parse(request.body);
      const environment = await runAuditedMutation(
        request,
        {
          action: "environment.create",
          resourceType: "environment",
          resourceId: input.environmentId,
          metadata: {
            projectId,
            environmentId: input.environmentId,
          },
          successStatus: 201,
        },
        async () => {
          const principal = requireAdmin(request);
          if (store === false || store.createEnvironment === undefined) {
            throw new BrokerHttpError(
              503,
              "catalog_store_unavailable",
              "environment management requires the PostgreSQL durable store",
            );
          }
          const created = await store.createEnvironment(
            {
              tenantId: principal.tenantId,
              projectId,
              environmentId: input.environmentId,
            },
            input.displayName,
          );
          if (created === undefined) {
            throw new BrokerHttpError(
              404,
              "project_not_found",
              `active project ${projectId} was not found`,
            );
          }
          return created;
        },
      );
      return reply.status(201).send({ environment });
    },
  );

  app.get("/v1/projects/:projectId/environments", async (request) => {
    const principal = requireHumanRead(request);
    const { projectId } = projectParamsSchema.parse(request.params);
    const query = includeArchivedQuerySchema.parse(request.query);
    if (store === false || store.listEnvironments === undefined) {
      throw new BrokerHttpError(
        503,
        "catalog_store_unavailable",
        "environment management requires the PostgreSQL durable store",
      );
    }
    return {
      environments: await store.listEnvironments(
        principal.tenantId,
        projectId,
        query.includeArchived,
      ),
    };
  });

  app.delete(
    "/v1/projects/:projectId/environments/:environmentId",
    async (request, reply) => {
      emptyQuerySchema.parse(request.query);
      const { projectId, environmentId } = environmentParamsSchema.parse(
        request.params,
      );
      await runAuditedMutation(
        request,
        {
          action: "environment.archive",
          resourceType: "environment",
          resourceId: environmentId,
          metadata: { projectId, environmentId },
          successStatus: 204,
        },
        async () => {
          const principal = requireAdmin(request);
          if (store === false || store.archiveEnvironment === undefined) {
            throw new BrokerHttpError(
              503,
              "catalog_store_unavailable",
              "environment management requires the PostgreSQL durable store",
            );
          }
          const archived = await store.archiveEnvironment({
            tenantId: principal.tenantId,
            projectId,
            environmentId,
          });
          if (!archived) {
            throw new BrokerHttpError(
              404,
              "not_found",
              `active environment ${projectId}/${environmentId} was not found`,
            );
          }
        },
      );
      return reply.status(204).send();
    },
  );

  app.post(
    "/v1/projects/:projectId/services",
    async (request, reply) => {
      emptyQuerySchema.parse(request.query);
      const { projectId } = projectParamsSchema.parse(request.params);
      const input = registeredServiceCreateSchema.parse(request.body);
      const service = await runAuditedMutation(
        request,
        {
          action: "service.create",
          resourceType: "service",
          resourceId: input.serviceId,
          metadata: { projectId, serviceId: input.serviceId },
          successStatus: 201,
        },
        async () => {
          const principal = requireAdmin(request);
          if (
            store === false ||
            store.createRegisteredService === undefined
          ) {
            throw new BrokerHttpError(
              503,
              "catalog_store_unavailable",
              "service management requires the PostgreSQL durable store",
            );
          }
          const created = await store.createRegisteredService(
            principal.tenantId,
            projectId,
            input.serviceId,
            input.displayName,
          );
          if (created === undefined) {
            throw new BrokerHttpError(
              404,
              "project_not_found",
              `active project ${projectId} was not found`,
            );
          }
          return created;
        },
      );
      return reply.status(201).send({ service });
    },
  );

  app.get(
    "/v1/projects/:projectId/services",
    async (request) => {
      const principal = requireHumanRead(request);
      const { projectId } = projectParamsSchema.parse(request.params);
      const query = includeArchivedQuerySchema.parse(request.query);
      if (store === false || store.listRegisteredServices === undefined) {
        throw new BrokerHttpError(
          503,
          "catalog_store_unavailable",
          "service management requires the PostgreSQL durable store",
        );
      }
      return {
        services: await store.listRegisteredServices(
          principal.tenantId,
          projectId,
          query.includeArchived,
        ),
      };
    },
  );

  app.delete(
    "/v1/projects/:projectId/services/:serviceId",
    async (request, reply) => {
      emptyQuerySchema.parse(request.query);
      const { projectId, serviceId } =
        registeredServiceParamsSchema.parse(request.params);
      await runAuditedMutation(
        request,
        {
          action: "service.archive",
          resourceType: "service",
          resourceId: serviceId,
          metadata: { projectId, serviceId },
          successStatus: 204,
        },
        async () => {
          const principal = requireAdmin(request);
          if (
            store === false ||
            store.archiveRegisteredService === undefined
          ) {
            throw new BrokerHttpError(
              503,
              "catalog_store_unavailable",
              "service management requires the PostgreSQL durable store",
            );
          }
          const archived = await store.archiveRegisteredService(
            principal.tenantId,
            projectId,
            serviceId,
          );
          if (!archived) {
            throw new BrokerHttpError(
              404,
              "not_found",
              `active service ${projectId}/${serviceId} was not found`,
            );
          }
        },
      );
      return reply.status(204).send();
    },
  );
  const auditNativeRejection = async <T>(
    request: FastifyRequest,
    action: string,
    resourceId: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error: unknown) {
      if (
        error instanceof BrokerHttpError &&
        [400, 403, 404, 409].includes(error.statusCode)
      ) {
        await appendAuditEvent(
          request,
          principalFor(request),
          {
            action,
            resourceType: "native_runtime",
            resourceId,
            metadata: {},
            successStatus: 200,
          },
          error.statusCode === 403 ? "denied" : "error",
          error.statusCode,
          error.code,
        );
      }
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
      requireProbeManager(request);
      const scope = scopeFor(request);
      const created = await mutateDurably(
        () => state.createProbe(input, scope),
        async (persisted) => {
          if (store === false) return;
          await (store.persistProbe === undefined
            ? store.persist(state)
            : store.persistProbe(state, persisted.id, scope));
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
        requireProbeManager(request);
        const scope = scopeFor(request);
        await mutateDurably(
          () => state.deleteProbe(id, scope),
          async () => {
            if (store === false) return;
            await (store.deleteProbe === undefined
              ? store.persist(state)
              : store.deleteProbe(state, id, scope));
          },
        );
      },
    );
    return reply.status(204).send();
  });

  app.get("/v1/probes", async (request) => {
    requireHumanRead(request);
    const { serviceId } = listProbeQuerySchema.parse(request.query);
    return { probes: state.listProbes(serviceId, scopeFor(request)) };
  });

  app.get("/v1/services", async (request) => {
    requireHumanRead(request);
    emptyQuerySchema.parse(request.query);
    return { services: state.listServices(scopeFor(request)) };
  });

  app.post("/v1/native/agents/register", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = NativeAgentRegistrationSchema.parse(request.body);
    const agent = await auditNativeRejection(
      request,
      "native_agent.register",
      input.agentId,
      async () => {
        const principal = requireNativeAccess(request, input.agentId);
        return mutateDurably(
          () => state.registerNativeAgent(input, principal),
          persistSnapshot,
        );
      },
    );
    const principal = requireNativeAccess(request, input.agentId);
    return reply.status(201).send({
      agentId: agent.agentId,
      accepted: true,
      lastSeen: agent.lastSeen,
      allowedServiceIds: principal.allowedServiceIds,
    });
  });

  app.put("/v1/native/agents/:agentId/instances", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const { agentId } = nativeAgentParamsSchema.parse(request.params);
    const input = NativeInstanceSetSchema.parse(request.body);
    const accepted = await auditNativeRejection(
      request,
      "native_instance.reconcile",
      agentId,
      async () => {
        const principal = requireNativeAccess(request, agentId);
        return mutateDurably(
          () => state.replaceNativeInstances(
            agentId,
            input.instances,
            principal,
            principal.allowedServiceIds,
          ),
          persistSnapshot,
        );
      },
    );
    return reply.status(202).send({ accepted });
  });

  app.get("/v1/native/agents/:agentId/assignments", async (request) => {
    const { agentId } = nativeAgentParamsSchema.parse(request.params);
    const { since } = nativeAssignmentsQuerySchema.parse(request.query);
    return auditNativeRejection(
      request,
      "native_assignment.read",
      agentId,
      () => {
        const principal = requireNativeAccess(request, agentId);
        return state.nativeAssignments(
          agentId,
          since,
          principal,
          principal.allowedServiceIds,
        );
      },
    );
  });

  app.post("/v1/native/ingest", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = nativeIngestSchema.parse(request.body);
    const accepted = await auditNativeRejection(
      request,
      "native_ingest.write",
      input.agentId,
      async () => {
        const principal = requireNativeAccess(request, input.agentId);
        if (
          !principal.allowedServiceIds.includes("*") &&
          !principal.allowedServiceIds.includes(input.serviceId)
        ) {
          throw new BrokerHttpError(403, "forbidden", "native service is not allowed");
        }
        return mutateDurably(
          () => state.ingestNative(input, principal),
          persistSnapshot,
        );
      },
    );
    return reply.status(202).send({ accepted });
  });

  app.get("/v1/ping", async (request) => {
    emptyQuerySchema.parse(request.query);
    return { ok: true };
  });

  app.get("/v1/safety", async (request) => {
    requireHumanRead(request);
    emptyQuerySchema.parse(request.query);
    return state.safetyOverview(45_000, scopeFor(request));
  });

  app.post("/v1/service-credentials", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = serviceCredentialCreateSchema.parse(request.body);
    const principal = requireAdmin(request);
    const scope = selectedResourceScope(scopeFor(request), input);
    const audit: AuditMutationContext = {
      action: "service_credential.create",
      resourceType: "service_credential",
      metadata: {
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        serviceId: input.serviceId,
      },
      successStatus: 201,
      scope,
    };
    const { credential, apiKey } = await runAuditedMutation(
      request,
      audit,
      async () => {
        if (
          store === false ||
          store.createServiceCredential === undefined
        ) {
          throw new BrokerHttpError(
            503,
            "credential_store_unavailable",
            "service credentials require the PostgreSQL durable store",
          );
        }
        if (store.listEnvironments !== undefined) {
          const environments = await store.listEnvironments(
            scope.tenantId,
            scope.projectId,
          );
          if (
            !environments.some(
              (environment) =>
                environment.environmentId === scope.environmentId,
            )
          ) {
            throw new BrokerHttpError(
              404,
              "environment_not_found",
              `active environment ${scope.projectId}/${scope.environmentId} was not found`,
            );
          }
        }
        if (
          store.getRegisteredService !== undefined &&
          store.createRegisteredService !== undefined
        ) {
          const registered = await store.getRegisteredService(
            scope.tenantId,
            scope.projectId,
            input.serviceId,
          );
          if (registered?.archivedAt !== undefined) {
            throw new BrokerHttpError(
              409,
              "service_archived",
              `service ${scope.projectId}/${input.serviceId} is archived`,
            );
          }
          if (registered === undefined) {
            const created = await store.createRegisteredService(
              scope.tenantId,
              scope.projectId,
              input.serviceId,
              input.serviceId,
            );
            if (created === undefined) {
              throw new BrokerHttpError(
                404,
                "project_not_found",
                `active project ${scope.projectId} was not found`,
              );
            }
          }
        }
        const material = createServiceCredentialMaterial({
          serviceId: input.serviceId,
          label: input.label,
          scope,
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
    const query = serviceCredentialQuerySchema.parse(request.query);
    const scope = selectedResourceScope(scopeFor(request), query);
    if (store === false || store.listServiceCredentials === undefined) {
      throw new BrokerHttpError(
        503,
        "credential_store_unavailable",
        "service credentials require the PostgreSQL durable store",
      );
    }
    return {
      credentials: (
        await store.listServiceCredentials(scope)
      ).filter(
        (credential) =>
          query.serviceId === undefined ||
          credential.serviceId === query.serviceId,
      ),
    };
  });

  app.delete(
    "/v1/service-credentials/:credentialId",
    async (request, reply) => {
      const query = serviceCredentialQuerySchema.parse(request.query);
      const { credentialId } = serviceCredentialParamsSchema.parse(
        request.params,
      );
      const principal = requireAdmin(request);
      const scope = selectedResourceScope(scopeFor(request), query);
      await runAuditedMutation(
        request,
        {
          action: "service_credential.revoke",
          resourceType: "service_credential",
          resourceId: credentialId,
          metadata: {
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          successStatus: 204,
          scope,
        },
        async () => {
          if (store === false || store.revokeServiceCredential === undefined) {
            throw new BrokerHttpError(
              503,
              "credential_store_unavailable",
              "service credentials require the PostgreSQL durable store",
            );
          }
          const revoked = await store.revokeServiceCredential(
            credentialId,
            scope,
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

  app.post("/v1/native-credentials", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = nativeCredentialCreateSchema.parse(request.body);
    const audit: AuditMutationContext = {
      action: "native_credential.create",
      resourceType: "native_credential",
      metadata: { agentId: input.agentId },
      successStatus: 201,
    };
    const result = await runAuditedMutation(request, audit, async () => {
      const principal = requireAdmin(request);
      if (store === false || store.createNativeCredential === undefined) {
        throw new BrokerHttpError(
          503,
          "credential_store_unavailable",
          "native credentials require the PostgreSQL durable store",
        );
      }
      const material = createNativeCredentialMaterial({
        ...input,
        scope: principal,
        now: new Date(state.now()),
      });
      const credential = await store.createNativeCredential(material.record);
      audit.resourceId = credential.credentialId;
      return { credential, apiKey: material.apiKey };
    });
    return reply.status(201).send(result);
  });

  app.get("/v1/native-credentials", async (request) => {
    const principal = requireAdmin(request);
    emptyQuerySchema.parse(request.query);
    if (store === false || store.listNativeCredentials === undefined) {
      throw new BrokerHttpError(
        503,
        "credential_store_unavailable",
        "native credentials require the PostgreSQL durable store",
      );
    }
    return { credentials: await store.listNativeCredentials(principal) };
  });

  app.delete("/v1/native-credentials/:credentialId", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const { credentialId } = nativeCredentialParamsSchema.parse(request.params);
    await runAuditedMutation(
      request,
      {
        action: "native_credential.revoke",
        resourceType: "native_credential",
        resourceId: credentialId,
        metadata: {},
        successStatus: 204,
      },
      async () => {
        const principal = requireAdmin(request);
        if (store === false || store.revokeNativeCredential === undefined) {
          throw new BrokerHttpError(
            503,
            "credential_store_unavailable",
            "native credentials require the PostgreSQL durable store",
          );
        }
        if (!await store.revokeNativeCredential(credentialId, principal)) {
          throw new BrokerHttpError(404, "not_found", "native credential not found");
        }
      },
    );
    return reply.status(204).send();
  });

  app.get("/v1/audit-events", async (request) => {
    requireAdmin(request);
    const query = auditListQuerySchema.parse(request.query);
    if (store === false || store.listAuditEvents === undefined) {
      throw new BrokerHttpError(
        503,
        "audit_store_unavailable",
        "audit events require the PostgreSQL durable store",
      );
    }
    return {
      events: await store.listAuditEvents(scopeFor(request), query),
    };
  });

  app.get(
    "/v1/services/:serviceId/probes",
    async (request) => {
      const { serviceId } = pollParamsSchema.parse(request.params);
      requireServiceAccess(request, serviceId);
      const { since, commitSha } = pollQuerySchema.parse(request.query);
      return state.pollProbes(
        serviceId,
        since,
        commitSha,
        scopeFor(request),
      );
    },
  );

  app.post("/v1/source-maps/status", async (request) => {
    emptyQuerySchema.parse(request.query);
    const input = sourceMapStatusSchema.parse(request.body);
    requireServiceAccess(request, input.serviceId);
    const scope = scopeFor(request);
    const previousMapCount =
      state.getSourceMapSet(input.serviceId, input.commitSha, scope)?.maps
        .length ?? 0;
    const status = state.sourceMapStatus(
      input.serviceId,
      input.commitSha,
      input.uploaderId,
      scope,
    );
    if (
      previousMapCount > 0 &&
      status.isUploader &&
      state.getSourceMapSet(input.serviceId, input.commitSha, scope)?.maps
        .length === 0
    ) {
      await persistSourceMapSet(input.serviceId, input.commitSha, scope);
    }
    return status;
  });

  app.post("/v1/source-maps/upload", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = sourceMapUploadSchema.parse(request.body);
    requireServiceAccess(request, input.serviceId);
    const scope = scopeFor(request);
    await mutateDurably(
      () => state.uploadSourceMap(input, scope),
      async () =>
        persistSourceMapSet(input.serviceId, input.commitSha, scope),
    );
    return reply.status(202).send({ accepted: true });
  });

  app.post("/v1/source-maps/complete", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = sourceMapStatusSchema.parse(request.body);
    requireServiceAccess(request, input.serviceId);
    const scope = scopeFor(request);
    await mutateDurably(
      () =>
        state.completeSourceMaps(
          input.serviceId,
          input.commitSha,
          input.uploaderId,
          scope,
        ),
      async () =>
        persistSourceMapSet(input.serviceId, input.commitSha, scope),
    );
    return reply.status(202).send({ complete: true });
  });

  app.post("/v1/ingest", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = IngestSchema.parse(request.body);
    requireServiceAccess(request, input.serviceId);
    const scope = scopeFor(request);
    const accepted = await mutateDurably(
      () => state.ingest(input, scope),
      async () => {
        if (store === false) return;
        await (store.persistIngest === undefined
          ? store.persist(state)
          : store.persistIngest(state, input, scope));
      },
    );
    return reply.status(202).send({ accepted });
  });

  app.get("/v1/probes/:id/data", async (request, reply) => {
    requireHumanRead(request);
    const scope = scopeFor(request);
    const { id } = probeParamsSchema.parse(request.params);
    const query = dataQuerySchema.parse(request.query);
    const waitSeconds = Math.min(30, Math.max(0, query.waitSeconds));
    let probe = state.getProbe(id, scope);
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
      probe = state.getProbe(id, scope);
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
      status: state.getStatus(id, scope),
      events: state.getEvents(id, scope),
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
    liveprobeScope: ResourceScope | null;
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
