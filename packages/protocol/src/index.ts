import { z } from "zod";

export const RuntimeBackendSchema = z.enum(["managed-runtime", "native-ebpf"]);
export const RuntimeLanguageSchema = z.enum([
  "node", "python", "jvm", "rust", "cpp",
]);
export const ResourceScopeSchema = z.object({
  tenantId: z.string().trim().min(1).max(200),
  projectId: z.string().trim().min(1).max(200),
  environmentId: z.string().trim().min(1).max(200),
}).strict();
export const AgentCapabilitySchema = z.string().trim().min(1).max(64)
  .regex(/^[a-z0-9][a-z0-9.-]*$/);
export const ServiceIdSchema = z.string().trim().min(1).max(200);
export const ProbeIdSchema = z.string()
  .regex(/^prb_[0-9A-HJKMNP-TV-Z]{26}$/, "invalid probe id");
export const SourceFileSchema = z.string().trim().min(1).max(4_096);
export const SourceCommitSchema = z.string().trim()
  .regex(/^[0-9a-fA-F]{7,64}$/).transform((value) => value.toLowerCase());
export const TimestampSchema = z.string().datetime({ offset: true });
export const DotPathSchema = z.string().trim().min(1).max(1_024)
  .regex(/^[^.]+(?:\.[^.]+)*$/);
export const BuildIdSchema = z.string().regex(/^[0-9a-fA-F]{8,128}$/)
  .transform((value) => value.toLowerCase());
export const JsonScalarSchema = z.union([
  z.string(),
  z.number().finite().refine(
    (value) => !Number.isInteger(value) || Number.isSafeInteger(value),
    "integer values must be within the IEEE-754 safe range",
  ),
  z.boolean(),
  z.null(),
]);

export const ConditionSchema = z.object({
  path: DotPathSchema,
  op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]),
  value: JsonScalarSchema,
}).strict();

export const ProbeTypeSchema = z.enum(["snapshot", "log", "counter", "metric"]);
export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

const createCommon = {
  serviceId: ServiceIdSchema,
  sourceCommit: SourceCommitSchema.optional(),
  file: SourceFileSchema,
  line: z.number().int().positive(),
  condition: ConditionSchema.optional(),
  conditionExpression: z.string().trim().min(1).max(4_096).optional(),
  ttlSeconds: z.number().int().positive().default(1_800),
  createdBy: z.string().trim().min(1).max(500),
} as const;

export const CreateProbeInputSchema = z.discriminatedUnion("type", [
  z.object({
    ...createCommon,
    type: z.literal("snapshot"),
    watchPaths: z.array(DotPathSchema).max(100).optional(),
    watchExpressions: z.array(z.string().trim().min(1).max(4_096)).max(100).optional(),
    includeStackLocals: z.boolean().default(false),
    stackFrameLimit: z.number().int().min(1).max(8).default(3),
    hitLimit: z.number().int().positive().default(1),
  }).strict(),
  z.object({
    ...createCommon,
    type: z.literal("log"),
    template: z.string().min(1).max(16_384),
    logLevel: LogLevelSchema.default("info"),
    hitLimit: z.number().int().positive().default(100),
  }).strict(),
  z.object({
    ...createCommon,
    type: z.literal("counter"),
    hitLimit: z.number().int().positive().default(10_000),
  }).strict(),
  z.object({
    ...createCommon,
    type: z.literal("metric"),
    metricPath: DotPathSchema.optional(),
    metricExpression: z.string().trim().min(1).max(4_096).optional(),
    hitLimit: z.number().int().positive().default(10_000),
  }).strict(),
]);

export const ExpressionPathSegmentSchema = z.union([
  z.string().trim().min(1).max(256),
  z.number().int().nonnegative(),
]);
export type ExpressionNode =
  | { type: "literal"; value: z.infer<typeof JsonScalarSchema> }
  | { type: "reference"; path: Array<string | number> }
  | { type: "unary"; operator: "not" | "negate"; operand: ExpressionNode }
  | {
      type: "binary";
      operator: "add" | "subtract" | "multiply" | "divide" | "modulo" |
        "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "and" | "or";
      left: ExpressionNode;
      right: ExpressionNode;
    };
export const ExpressionNodeSchema: z.ZodType<ExpressionNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("literal"), value: JsonScalarSchema }).strict(),
    z.object({
      type: z.literal("reference"),
      path: z.array(ExpressionPathSegmentSchema).min(1).max(64),
    }).strict(),
    z.object({
      type: z.literal("unary"),
      operator: z.enum(["not", "negate"]),
      operand: ExpressionNodeSchema,
    }).strict(),
    z.object({
      type: z.literal("binary"),
      operator: z.enum([
        "add", "subtract", "multiply", "divide", "modulo",
        "eq", "ne", "gt", "gte", "lt", "lte", "and", "or",
      ]),
      left: ExpressionNodeSchema,
      right: ExpressionNodeSchema,
    }).strict(),
  ])
);
export const CompiledExpressionSchema = z.object({
  source: z.string().min(1).max(4_096),
  ast: ExpressionNodeSchema,
}).strict();
export type CompiledExpression = z.infer<typeof CompiledExpressionSchema>;
export type TemplateSegment =
  | { type: "text"; value: string }
  | { type: "expression"; expression: CompiledExpression };
export const TemplateSegmentSchema: z.ZodType<TemplateSegment> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: z.string().max(16_384) }).strict(),
  z.object({
    type: z.literal("expression"),
    expression: CompiledExpressionSchema,
  }).strict(),
]);
const definitionCommon = {
  id: ProbeIdSchema,
  serviceId: ServiceIdSchema,
  sourceCommit: SourceCommitSchema.optional(),
  file: SourceFileSchema,
  line: z.number().int().positive(),
  runtimeLocation: SourceFileSchema.optional(),
  runtimeLine: z.number().int().positive().optional(),
  runtimeColumn: z.number().int().nonnegative().optional(),
  condition: ConditionSchema.optional(),
  conditionExpression: CompiledExpressionSchema.optional(),
  ttlSeconds: z.number().int().positive(),
  hitLimit: z.number().int().positive(),
  version: z.number().int().positive(),
  createdBy: z.string().trim().min(1).max(500),
} as const;
export const ProbeDefinitionSchema = z.discriminatedUnion("type", [
  z.object({
    ...definitionCommon,
    type: z.literal("snapshot"),
    watchPaths: z.array(DotPathSchema).max(100).optional(),
    watchExpressions: z.array(CompiledExpressionSchema).max(100).optional(),
    includeStackLocals: z.boolean().default(false),
    stackFrameLimit: z.number().int().min(1).max(8).default(3),
  }).strict(),
  z.object({
    ...definitionCommon,
    type: z.literal("log"),
    template: z.string().min(1).max(16_384),
    logLevel: LogLevelSchema.default("info"),
    templateSegments: z.array(TemplateSegmentSchema).max(201).optional(),
  }).strict(),
  z.object({ ...definitionCommon, type: z.literal("counter") }).strict(),
  z.object({
    ...definitionCommon,
    type: z.literal("metric"),
    metricPath: DotPathSchema.optional(),
    metricExpression: CompiledExpressionSchema.optional(),
  }).strict(),
]);

export const NATIVE_STATUS_NAMES = [
  "armed", "error", "hit-limit-reached", "suspended", "expired",
] as const;

export const NATIVE_REASON_CODES = [
  "service-not-found",
  "ambiguous-service-match",
  "target-instance-changed",
  "build-mismatch",
  "no-build-id",
  "no-debug-info",
  "no-line-info",
  "source-file-not-found",
  "source-file-ambiguous",
  "no-executable-address",
  "variable-not-found",
  "variable-optimized-out",
  "unsupported-location-expression",
  "unsupported-register-piece",
  "unsupported-type",
  "floating-point-register-unavailable",
  "attach-permission-denied",
  "uprobe-attach-failed",
  "raw-hit-budget-exceeded",
  "ring-buffer-full",
  "local-policy-denied",
  "process-inspection-permission-denied",
  "capture-event-invalid",
  "process-inspection-failed",
  "process-metadata-invalid",
  "invalid-build-identity",
  "unsupported-architecture",
] as const;

export const NativeStatusNameSchema = z.enum(NATIVE_STATUS_NAMES);
export const NativeReasonCodeSchema = z.enum(NATIVE_REASON_CODES);

const sourceFileSchema = z.string().trim().min(1).max(4_096);
const dotPathSchema = z.string().trim().min(1).max(1_024)
  .regex(/^[^.]+(?:\.[^.]+)*$/, "must be a dot path with non-empty segments");
const buildIdSchema = z.string().regex(/^[0-9a-fA-F]{8,128}$/);
const boundedIdSchema = (maximum: number) => z.string().trim().min(1).max(maximum);

export const NativeStatusMetadataSchema = z.object({
  reasonCode: NativeReasonCodeSchema.optional(),
  agentId: boundedIdSchema(200).optional(),
  instanceId: boundedIdSchema(300).optional(),
  buildId: buildIdSchema.optional(),
  probeVersion: z.number().int().positive().optional(),
  siteId: boundedIdSchema(300).optional(),
  resolution: z.object({
    sourceFile: sourceFileSchema,
    line: z.number().int().positive(),
    resolvedSiteCount: z.number().int().nonnegative(),
    requestedPathCount: z.number().int().nonnegative(),
  }).strict().optional(),
  variableAvailability: z.array(z.object({
    path: dotPathSchema,
    available: z.boolean(),
    reasonCode: NativeReasonCodeSchema.optional(),
    siteIds: z.array(boundedIdSchema(300)).max(256),
  }).strict()).max(100).optional(),
  physicalSiteCount: z.number().int().nonnegative().optional(),
  rawHitRate: z.number().finite().nonnegative().optional(),
  droppedEventCount: z.number().int().nonnegative().optional(),
}).strict();

export const NativeProbeStatusSchema = NativeStatusMetadataSchema.extend({
  status: NativeStatusNameSchema,
  updatedAt: z.string().datetime({ offset: true }),
  detail: z.string().max(4_096).optional(),
}).strict();

export const UnavailableValueMetadataSchema = z.object({
  reasonCode: NativeReasonCodeSchema,
  detail: z.string().max(4_096).optional(),
  siteId: boundedIdSchema(300).optional(),
  buildId: buildIdSchema.optional(),
}).strict();

export type NativeReasonCode = z.infer<typeof NativeReasonCodeSchema>;
export type NativeProbeStatus = z.infer<typeof NativeProbeStatusSchema>;

export const NativeCapabilitySchema = z.enum([
  "uprobe", "ring-buffer", "btf", "dwarf", "count",
  "snapshot-scalar", "log", "counter", "metric",
]);
export const NativeArchitectureSchema = z.literal("x86_64");
export const NativeAgentRegistrationSchema = z.object({
  agentId: z.string().trim().min(1).max(200),
  hostname: z.string().trim().min(1).max(255),
  backend: z.literal("native-ebpf"),
  architecture: NativeArchitectureSchema,
  capabilities: z.array(NativeCapabilitySchema).min(1).max(32),
  agentVersion: z.string().trim().min(1).max(100),
}).strict();
export const NativeInstanceSchema = z.object({
  instanceId: z.string().trim().min(1).max(300),
  serviceId: ServiceIdSchema,
  language: z.enum(["rust", "cpp"]),
  pid: z.number().int().positive(),
  processStartTime: z.string().trim().min(1).max(100),
  executablePath: z.string().startsWith("/").max(4_096),
  executableDevice: z.string().trim().min(1).max(100).optional(),
  executableInode: z.string().regex(/^\d+$/).optional(),
  buildId: BuildIdSchema,
  architecture: NativeArchitectureSchema,
  capabilities: z.array(NativeCapabilitySchema).min(1).max(32).optional(),
  cgroup: z.string().max(4_096).optional(),
  containerId: z.string().max(256).optional(),
  lastSeen: TimestampSchema,
}).strict();
export const NativeInstanceSetSchema = z.object({
  instances: z.array(NativeInstanceSchema).max(10_000),
}).strict();

export const AgentStatusSchema = z.object({
  state: z.enum(["green", "red"]),
  detail: z.string().max(4_096).optional(),
}).strict();

export type SerializedNode =
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "null"; v: null }
  | { t: "fn" }
  | { t: "redacted" }
  | { t: "unavailable"; v: z.infer<typeof UnavailableValueMetadataSchema> }
  | { t: "truncated"; v: "depth" | "array" | "props" | "string" | "circular" | "unsupported" }
  | { t: "obj"; c: Record<string, SerializedNode>; m?: { t: "truncated"; v: "props" } | undefined }
  | { t: "arr"; c: SerializedNode[]; m?: { t: "truncated"; v: "array" } | undefined };

export const SerializedNodeSchema: z.ZodType<SerializedNode> = z.lazy(() =>
  z.discriminatedUnion("t", [
    z.object({ t: z.literal("str"), v: z.string() }).strict(),
    z.object({ t: z.literal("num"), v: z.number().finite() }).strict(),
    z.object({ t: z.literal("bool"), v: z.boolean() }).strict(),
    z.object({ t: z.literal("null"), v: z.null() }).strict(),
    z.object({ t: z.literal("fn") }).strict(),
    z.object({ t: z.literal("redacted") }).strict(),
    z.object({ t: z.literal("unavailable"), v: UnavailableValueMetadataSchema }).strict(),
    z.object({
      t: z.literal("truncated"),
      v: z.enum(["depth", "array", "props", "string", "circular", "unsupported"]),
    }).strict(),
    z.object({
      t: z.literal("obj"),
      c: z.record(z.string(), SerializedNodeSchema),
      m: z.object({ t: z.literal("truncated"), v: z.literal("props") }).strict().optional(),
    }).strict(),
    z.object({
      t: z.literal("arr"),
      c: z.array(SerializedNodeSchema),
      m: z.object({ t: z.literal("truncated"), v: z.literal("array") }).strict().optional(),
    }).strict(),
  ])
);

const nativeEventIdentity = {
  probeId: ProbeIdSchema,
  probeVersion: z.number().int().positive(),
  ts: TimestampSchema,
} as const;
export const NativeProbeEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...nativeEventIdentity,
    type: z.literal("snapshot"),
    variables: SerializedNodeSchema,
    watches: z.record(z.string(), SerializedNodeSchema),
    stack: z.array(z.object({
      fn: z.string().max(1_024),
      file: SourceFileSchema,
      line: z.number().int().positive(),
      variables: SerializedNodeSchema.optional(),
    }).strict()).max(8),
  }).strict(),
  z.object({
    ...nativeEventIdentity,
    type: z.literal("log"),
    message: z.string().max(65_536),
    level: LogLevelSchema,
  }).strict(),
  z.object({
    ...nativeEventIdentity,
    type: z.literal("counter"),
    delta: z.number().int().positive(),
  }).strict(),
  z.object({
    ...nativeEventIdentity,
    type: z.literal("metric"),
    count: z.number().int().positive(),
    sum: z.number().finite(),
    min: z.number().finite(),
    max: z.number().finite(),
    last: z.number().finite(),
  }).strict().refine((event) => event.min <= event.max, {
    message: "metric min must be less than or equal to max",
    path: ["min"],
  }),
  z.object({
    ...nativeEventIdentity,
    type: z.literal("status"),
    status: NativeStatusNameSchema,
    detail: z.string().max(4_096).optional(),
    ...NativeStatusMetadataSchema.omit({ probeVersion: true }).shape,
  }).strict(),
]);
export const NativeIngestEnvelopeSchema = z.object({
  agentId: z.string().trim().min(1).max(200),
  serviceId: ServiceIdSchema,
  instanceId: z.string().trim().min(1).max(300),
  buildId: BuildIdSchema,
  backend: z.literal("native-ebpf"),
  agentStatus: AgentStatusSchema,
  events: z.array(NativeProbeEventSchema).max(1_000),
}).strict();
export const NativeAssignmentSchema = z.object({
  instanceId: z.string().trim().min(1).max(300),
  serviceId: ServiceIdSchema,
  buildId: BuildIdSchema,
  probes: z.array(ProbeDefinitionSchema).max(10_000),
}).strict();
export const NativeAssignmentsResponseSchema = z.object({
  version: z.number().int().nonnegative(),
  assignments: z.array(NativeAssignmentSchema).max(10_000),
}).strict();

export const ServiceRecordSchema = z.object({
  serviceId: ServiceIdSchema,
  backend: RuntimeBackendSchema,
  language: RuntimeLanguageSchema,
  capabilities: z.array(AgentCapabilitySchema).max(64),
  instanceCount: z.number().int().nonnegative(),
  buildIds: z.array(BuildIdSchema).max(10_000).optional(),
  lastSeen: TimestampSchema,
  safetyStatus: z.enum(["green", "red", "unknown"]),
  sdk: z.enum(["node", "python", "jvm"]).optional(),
  commitSha: SourceCommitSchema.optional(),
  commitSource: z.enum(["env", "config"]).optional(),
  agentStatus: AgentStatusSchema.optional(),
  nativeLimitations: z.array(z.string().max(500)).max(32).optional(),
}).strict();
export const ListServicesResponseSchema = z.object({
  services: z.array(ServiceRecordSchema),
}).strict();

export const NativeCredentialRecordSchema = ResourceScopeSchema.extend({
  credentialId: z.string().regex(/^nat_[0-9a-f]{32}$/),
  agentId: z.string().trim().min(1).max(200),
  allowedServiceIds: z.array(ServiceIdSchema).min(1).max(1_000),
  label: z.string().trim().min(1).max(200),
  keyPrefix: z.string().startsWith("lp_native_"),
  createdAt: TimestampSchema,
  revokedAt: TimestampSchema.optional(),
  lastUsedAt: TimestampSchema.optional(),
}).strict();

export type RuntimeBackend = z.infer<typeof RuntimeBackendSchema>;
export type RuntimeLanguage = z.infer<typeof RuntimeLanguageSchema>;
export type ResourceScope = z.infer<typeof ResourceScopeSchema>;
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type CreateProbeInput = z.infer<typeof CreateProbeInputSchema>;
export type ProbeDefinition = z.infer<typeof ProbeDefinitionSchema>;
export type ProbeType = z.infer<typeof ProbeTypeSchema>;
export type NativeAgentRegistration = z.infer<typeof NativeAgentRegistrationSchema>;
export type NativeInstance = z.infer<typeof NativeInstanceSchema>;
export type NativeIngestEnvelope = z.infer<typeof NativeIngestEnvelopeSchema>;
export type NativeProbeEvent = z.infer<typeof NativeProbeEventSchema>;
export type NativeAssignmentsResponse = z.infer<typeof NativeAssignmentsResponseSchema>;
export type ServiceRecord = z.infer<typeof ServiceRecordSchema>;
export type NativeCredentialRecord = z.infer<typeof NativeCredentialRecordSchema>;
