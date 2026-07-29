import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  NativeProbeStatusSchema,
  ProbeDefinitionSchema,
  RuntimeBackendSchema,
  RuntimeLanguageSchema,
} from "@doomslayer2945/liveprobe-protocol";
import { z } from "zod";

const serviceIdSchema = z.string().trim().min(1).max(200);
const catalogIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const displayNameSchema = z.string().trim().min(1).max(200);
const scopeInputShape = {
  project_id: catalogIdSchema.optional().default("default"),
  environment_id: catalogIdSchema.optional().default("default"),
} as const;
const sourceFileSchema = z.string().trim().min(1).max(4_096);
const commitHashSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F]{7,64}$/,
    "must be a 7-64 character hexadecimal Git object ID",
  )
  .transform((value) => value.toLowerCase());
const dotPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .regex(/^[^.]+(?:\.[^.]+)*$/, "must be a valid dot path");
const probeIdSchema = z
  .string()
  .regex(/^prb_[0-9A-HJKMNP-TV-Z]{26}$/, "must be a LiveProbe probe ID");
const scalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const agentCapabilitySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9.-]*$/);
const requiredAgentCapabilities = [
  "log-levels-v1",
  "expression-ast-v1",
  "frame-locals-v1",
] as const;
const expressionSourceSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .describe(
    "Safe expression: literals, fixed property/index access, arithmetic, comparisons, boolean operators, and parentheses; no calls or mutation",
  );

type ExpressionNode =
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "reference"; path: Array<string | number> }
  | {
      type: "unary";
      operator: "not" | "negate";
      operand: ExpressionNode;
    }
  | {
      type: "binary";
      operator:
        | "add"
        | "subtract"
        | "multiply"
        | "divide"
        | "modulo"
        | "eq"
        | "ne"
        | "gt"
        | "gte"
        | "lt"
        | "lte"
        | "and"
        | "or";
      left: ExpressionNode;
      right: ExpressionNode;
    };

const expressionNodeSchema: z.ZodType<ExpressionNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("literal"),
        value: z.union([
          z.string(),
          z
            .number()
            .finite()
            .refine(
              (value) =>
                !Number.isInteger(value) || Number.isSafeInteger(value),
            ),
          z.boolean(),
          z.null(),
        ]),
      })
      .strict(),
    z
      .object({
        type: z.literal("reference"),
        path: z.array(
          z.union([
            z.string(),
            z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          ]),
        ),
      })
      .strict(),
    z
      .object({
        type: z.literal("unary"),
        operator: z.enum(["not", "negate"]),
        operand: expressionNodeSchema,
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
        left: expressionNodeSchema,
        right: expressionNodeSchema,
      })
      .strict(),
  ]),
);
const compiledExpressionSchema = z
  .object({ source: z.string(), ast: expressionNodeSchema })
  .strict();
const templateSegmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: z.string() }).strict(),
  z
    .object({
      type: z.literal("expression"),
      expression: compiledExpressionSchema,
    })
    .strict(),
]);

export const McpConditionSchema = z
  .object({
    path: dotPathSchema.describe(
      "Dot path in captured variables, such as user.tier",
    ),
    op: z
      .enum(["eq", "ne", "gt", "gte", "lt", "lte"])
      .describe("Pure comparison performed after capture"),
    value: scalarSchema.describe("JSON scalar to compare without coercion"),
  })
  .strict();

const commonInputShape = {
  ...scopeInputShape,
  service_id: serviceIdSchema.describe("Target service from list_services"),
  commit_hash: commitHashSchema.describe(
    "User-supplied deployed commit SHA retained as audit metadata; not runtime proof",
  ),
  file: sourceFileSchema.describe(
    "Source path suffix as known by the target runtime",
  ),
  line: z.number().int().positive().describe("One-based source line"),
  condition: McpConditionSchema.optional().describe(
    "Optional read-only post-capture condition; no target code is evaluated",
  ),
  condition_expression: expressionSourceSchema.optional(),
  hit_limit: z.number().int().positive().optional(),
  ttl_seconds: z.number().int().positive().optional().default(1_800),
  created_by: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .default("mcp:liveprobe"),
} as const;

export const SetSnapshotProbeInputSchema = z
  .object({
    ...commonInputShape,
    watch_paths: z
      .array(dotPathSchema)
      .max(100)
      .optional()
      .describe("Extra dot paths to capture alongside local variables"),
    watch_expressions: z.array(expressionSourceSchema).max(100).optional(),
    include_stack_locals: z
      .boolean()
      .optional()
      .default(false)
      .describe("Capture redacted, bounded locals for selected stack frames"),
    stack_frame_limit: z.number().int().min(1).max(8).optional().default(3),
  })
  .strict();

export const SetLogProbeInputSchema = z
  .object({
    ...commonInputShape,
    template: z
      .string()
      .min(1)
      .max(16_384)
      .describe(
        "Log template with optional ${dot.path} placeholders resolved read-only",
      ),
    log_level: logLevelSchema
      .optional()
      .default("info")
      .describe("Severity attached to the captured telemetry event"),
  })
  .strict();

export const SetCounterProbeInputSchema = z
  .object(commonInputShape)
  .strict();

export const SetMetricProbeInputSchema = z
  .object({
    ...commonInputShape,
    metric_path: dotPathSchema.optional().describe(
      "Dot path that resolves to the numeric value to aggregate",
    ),
    metric_expression: expressionSourceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.metric_path === undefined) ===
      (value.metric_expression === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "provide exactly one of metric_path or metric_expression",
      });
    }
  });

export const ListServicesInputSchema = z.object(scopeInputShape).strict();
export const PingBrokerInputSchema = z.object(scopeInputShape).strict();
export const GetSafetyOverviewInputSchema = z.object(scopeInputShape).strict();
export const ListAuditEventsInputSchema = z
  .object({
    ...scopeInputShape,
    limit: z.number().int().min(1).max(100).optional().default(50),
    before: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Return events strictly before this ISO-8601 timestamp"),
  })
  .strict();
export const ListProjectsInputSchema = z
  .object({
    include_archived: z.boolean().optional().default(false),
  })
  .strict();
export const CreateProjectInputSchema = z
  .object({
    project_id: catalogIdSchema,
    display_name: displayNameSchema,
  })
  .strict();
export const ArchiveProjectInputSchema = z
  .object({ project_id: catalogIdSchema })
  .strict();
export const ListEnvironmentsInputSchema = z
  .object({
    project_id: catalogIdSchema,
    include_archived: z.boolean().optional().default(false),
  })
  .strict();
export const CreateEnvironmentInputSchema = z
  .object({
    project_id: catalogIdSchema,
    environment_id: catalogIdSchema,
    display_name: displayNameSchema,
  })
  .strict();
export const ArchiveEnvironmentInputSchema = z
  .object({
    project_id: catalogIdSchema,
    environment_id: catalogIdSchema,
  })
  .strict();
export const ListRegisteredServicesInputSchema = z
  .object({
    project_id: catalogIdSchema,
    include_archived: z.boolean().optional().default(false),
  })
  .strict();
export const RegisterServiceInputSchema = z
  .object({
    project_id: catalogIdSchema,
    service_id: serviceIdSchema,
    display_name: displayNameSchema,
  })
  .strict();
export const ArchiveServiceInputSchema = z
  .object({
    project_id: catalogIdSchema,
    service_id: serviceIdSchema,
  })
  .strict();
export const CreateServiceCredentialInputSchema = z
  .object({
    project_id: catalogIdSchema,
    environment_id: catalogIdSchema,
    service_id: serviceIdSchema.describe("Service ID that will use this key"),
    label: z.string().trim().min(1).max(200).describe("Human-readable key label"),
  })
  .strict();
export const ListServiceCredentialsInputSchema = z
  .object({
    project_id: catalogIdSchema,
    environment_id: catalogIdSchema,
    service_id: serviceIdSchema.optional(),
  })
  .strict();
export const RevokeServiceCredentialInputSchema = z
  .object({
    project_id: catalogIdSchema,
    environment_id: catalogIdSchema,
    credential_id: z.string().regex(/^svc_[0-9a-f]{32}$/),
  })
  .strict();
export const ListProbesInputSchema = z
  .object({
    ...scopeInputShape,
    service_id: serviceIdSchema.optional(),
  })
  .strict();
export const GetProbeDataInputSchema = z
  .object({
    ...scopeInputShape,
    probe_id: probeIdSchema,
    wait_seconds: z
      .number()
      .finite()
      .min(0)
      .max(30)
      .optional()
      .default(0)
      .describe(
        "Long-poll duration; returns immediately when retained data already exists",
      ),
  })
  .strict();
export const RemoveProbeInputSchema = z
  .object({
    ...scopeInputShape,
    probe_id: probeIdSchema,
  })
  .strict();

export const BrokerProbeDefinitionSchema = ProbeDefinitionSchema;

const probeStatusSchema = NativeProbeStatusSchema;

const safetyReasonCodeSchema = z.enum([
  "event_loop_lag",
  "pause_budget",
  "rate_limited",
  "instrumentation_failure",
  "agent_worker_failure",
]);

const safetyLimitsSchema = z
  .object({
    maxProbeHitsPerSecond: z.number().finite().nonnegative().optional(),
    maxProbePauseMsPerSecond: z.number().finite().nonnegative().optional(),
    safetyCooldownMs: z.number().int().nonnegative().optional(),
    maxTelemetryBytesPerSecond: z.number().finite().nonnegative().optional(),
    maxBufferedEventBytes: z.number().int().positive().optional(),
    maxEventLoopLagMs: z.number().finite().positive().optional(),
  })
  .strict();

const serviceSchema = z
  .object({
    serviceId: serviceIdSchema,
    backend: RuntimeBackendSchema.optional(),
    language: RuntimeLanguageSchema.optional(),
    sdk: z.enum(["node", "python", "jvm"]).optional(),
    commitSha: commitHashSchema.optional(),
    commitSource: z.enum(["env", "config"]).optional(),
    capabilities: z.array(agentCapabilitySchema).optional(),
    instanceCount: z.number().int().nonnegative().optional(),
    buildIds: z.array(z.string()).optional(),
    nativeLimitations: z.array(z.string()).optional(),
    lastSeen: z.string().datetime({ offset: true }),
    agentStatus: z
      .object({
        state: z.enum(["green", "red"]),
        detail: z.string().optional(),
        reasonCode: safetyReasonCodeSchema.optional(),
        limits: safetyLimitsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const probeEventResponseSchema = z.record(z.string(), z.json());

const createProbeResponseSchema = z
  .object({ probe: BrokerProbeDefinitionSchema })
  .strict();
const pingResponseSchema = z.object({ ok: z.literal(true) }).strict();
const listServicesResponseSchema = z
  .object({ services: z.array(serviceSchema) })
  .strict();
const safetyResponseSchema = z
  .object({
    services: z.array(
      z
        .object({
          serviceId: serviceIdSchema,
          backend: RuntimeBackendSchema.optional(),
          language: RuntimeLanguageSchema.optional(),
          sdk: z.enum(["node", "python", "jvm"]).optional(),
          commitSha: commitHashSchema.optional(),
          instanceCount: z.number().int().nonnegative().optional(),
          buildIds: z.array(z.string()).optional(),
          lastSeen: z.string().datetime({ offset: true }),
          online: z.boolean(),
          agent: z
            .object({
              state: z.enum(["green", "red", "unknown"]),
              detail: z.string().optional(),
              reasonCode: safetyReasonCodeSchema.optional(),
              limits: safetyLimitsSchema.optional(),
            })
            .strict(),
          probesSummary: z.record(z.string(), z.number().int().nonnegative()),
          caveats: z.array(z.string()),
          // Present only when native evidence has failed to reach storage.
          // `rejectedBatches` above zero means probes can report armed while
          // returning nothing, which is otherwise indistinguishable from a
          // probe on a line that has not executed.
          evidence: z
            .object({
              staleEventsDropped: z.number().int().nonnegative(),
              rejectedBatches: z.number().int().nonnegative(),
              lastRejectionAt: z.string().optional(),
              lastRejectionCode: z.string().optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();
const listProbesResponseSchema = z
  .object({
    probes: z.array(
      z
        .object({
          probe: BrokerProbeDefinitionSchema,
          status: probeStatusSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
const probeDataResponseSchema = z
  .object({
    probe: BrokerProbeDefinitionSchema,
    status: probeStatusSchema.nullable(),
    events: z.array(probeEventResponseSchema),
  })
  .strict();
const auditEventSchema = z
  .object({
    auditId: z.string().min(1),
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    occurredAt: z.string().datetime({ offset: true }),
    requestId: z.string().min(1),
    actorType: z.enum(["shared", "user", "service", "native"]),
    actorId: z.string().min(1),
    actorRole: z.enum(["admin", "operator", "viewer", "agent", "native-agent"]),
    action: z.string().min(1),
    resourceType: z.string().min(1),
    resourceId: z.string().min(1).optional(),
    outcome: z.enum(["attempt", "success", "denied", "error"]),
    statusCode: z.number().int().optional(),
    errorCode: z.string().min(1).optional(),
    metadata: z.record(z.string(), scalarSchema),
  })
  .strict();
const listAuditEventsResponseSchema = z
  .object({ events: z.array(auditEventSchema) })
  .strict();
const projectSchema = z
  .object({
    tenantId: z.string().min(1),
    projectId: catalogIdSchema,
    displayName: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    archivedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const environmentSchema = z
  .object({
    tenantId: z.string().min(1),
    projectId: catalogIdSchema,
    environmentId: catalogIdSchema,
    displayName: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    archivedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const registeredServiceSchema = z
  .object({
    tenantId: z.string().min(1),
    projectId: catalogIdSchema,
    serviceId: serviceIdSchema,
    displayName: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    archivedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const projectResponseSchema = z.object({ project: projectSchema }).strict();
const listProjectsResponseSchema = z
  .object({ projects: z.array(projectSchema) })
  .strict();
const environmentResponseSchema = z
  .object({ environment: environmentSchema })
  .strict();
const listEnvironmentsResponseSchema = z
  .object({ environments: z.array(environmentSchema) })
  .strict();
const registeredServiceResponseSchema = z
  .object({ service: registeredServiceSchema })
  .strict();
const listRegisteredServicesResponseSchema = z
  .object({ services: z.array(registeredServiceSchema) })
  .strict();
const serviceCredentialSchema = z
  .object({
    credentialId: z.string().regex(/^svc_[0-9a-f]{32}$/),
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    serviceId: serviceIdSchema,
    label: z.string().min(1),
    keyPrefix: z.string().startsWith("lp_service_"),
    createdAt: z.string().datetime({ offset: true }),
    lastUsedAt: z.string().datetime({ offset: true }).optional(),
    revokedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const createServiceCredentialResponseSchema = z
  .object({
    credential: serviceCredentialSchema,
    apiKey: z.string().startsWith("lp_service_"),
  })
  .strict();
const listServiceCredentialsResponseSchema = z
  .object({ credentials: z.array(serviceCredentialSchema) })
  .strict();

export type BrokerProbeDefinition = z.infer<
  typeof BrokerProbeDefinitionSchema
>;
export type BrokerService = z.infer<typeof serviceSchema>;
export type BrokerProbeStatus = z.infer<typeof probeStatusSchema>;
export type BrokerProbeData = z.infer<typeof probeDataResponseSchema>;
export type BrokerAuditEvent = z.infer<typeof auditEventSchema>;
export type BrokerServiceCredential = z.infer<typeof serviceCredentialSchema>;

type BrokerCondition = z.infer<typeof McpConditionSchema>;

export type BrokerCreateProbeInput =
  | {
      serviceId: string;
      sourceCommit: string;
      type: "snapshot";
      file: string;
      line: number;
      condition?: BrokerCondition;
      conditionExpression?: string;
      watchPaths?: string[];
      watchExpressions?: string[];
      includeStackLocals: boolean;
      stackFrameLimit: number;
      hitLimit?: number;
      ttlSeconds: number;
      createdBy: string;
    }
  | {
      serviceId: string;
      sourceCommit: string;
      type: "log";
      file: string;
      line: number;
      condition?: BrokerCondition;
      conditionExpression?: string;
      template: string;
      logLevel: z.infer<typeof logLevelSchema>;
      hitLimit?: number;
      ttlSeconds: number;
      createdBy: string;
    }
  | {
      serviceId: string;
      sourceCommit: string;
      type: "counter";
      file: string;
      line: number;
      condition?: BrokerCondition;
      conditionExpression?: string;
      hitLimit?: number;
      ttlSeconds: number;
      createdBy: string;
    }
  | {
      serviceId: string;
      sourceCommit: string;
      type: "metric";
      file: string;
      line: number;
      condition?: BrokerCondition;
      conditionExpression?: string;
      metricPath?: string;
      metricExpression?: string;
      hitLimit?: number;
      ttlSeconds: number;
      createdBy: string;
    };

export class BrokerClientError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "BrokerClientError";
  }
}

export interface BrokerClientOptions {
  fetchImplementation?: typeof fetch;
  apiKey?: string;
  requestTimeoutMs?: number;
}

interface RequestScope {
  projectId: string;
  environmentId: string;
}

export class BrokerClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly apiKey: string | undefined;
  private readonly requestTimeoutMs: number;

  public constructor(
    brokerUrl: string,
    options: BrokerClientOptions = {},
  ) {
    const parsed = new URL(brokerUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("BROKER_URL must use http or https");
    }
    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error(
        "BROKER_URL must not include credentials, query parameters, or a fragment",
      );
    }
    this.baseUrl = parsed.href.replace(/\/+$/, "");
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.apiKey = options.apiKey;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0
    ) {
      throw new RangeError("requestTimeoutMs must be a positive safe integer");
    }
  }

  public async ping(
    scope: RequestScope = { projectId: "default", environmentId: "default" },
  ): Promise<{ ok: true }> {
    return this.request("GET", "/v1/ping", pingResponseSchema, undefined, scope);
  }

  public async createProbe(
    input: BrokerCreateProbeInput,
    scope: RequestScope,
  ): Promise<BrokerProbeDefinition> {
    const result = await this.request(
      "POST",
      "/v1/probes",
      createProbeResponseSchema,
      input,
      scope,
    );
    return result.probe;
  }

  public async listServices(
    scope: RequestScope,
  ): Promise<{ services: BrokerService[] }> {
    return this.request(
      "GET",
      "/v1/services",
      listServicesResponseSchema,
      undefined,
      scope,
    );
  }

  public async listProbes(
    serviceId?: string,
    scope: RequestScope = { projectId: "default", environmentId: "default" },
  ): Promise<z.infer<typeof listProbesResponseSchema>> {
    const search =
      serviceId === undefined
        ? ""
        : `?${new URLSearchParams({ serviceId }).toString()}`;
    return this.request(
      "GET",
      `/v1/probes${search}`,
      listProbesResponseSchema,
      undefined,
      scope,
    );
  }

  public async getProbeData(
    probeId: string,
    waitSeconds = 0,
    scope: RequestScope = { projectId: "default", environmentId: "default" },
  ): Promise<BrokerProbeData> {
    const search = new URLSearchParams({
      waitSeconds: String(waitSeconds),
    });
    return this.request(
      "GET",
      `/v1/probes/${encodeURIComponent(probeId)}/data?${search.toString()}`,
      probeDataResponseSchema,
      undefined,
      scope,
    );
  }

  public async getSafetyOverview(
    scope: RequestScope,
  ): Promise<z.infer<typeof safetyResponseSchema>> {
    return this.request(
      "GET",
      "/v1/safety",
      safetyResponseSchema,
      undefined,
      scope,
    );
  }

  public async listAuditEvents(input: {
    projectId: string;
    environmentId: string;
    limit: number;
    before?: string | undefined;
  }): Promise<z.infer<typeof listAuditEventsResponseSchema>> {
    const search = new URLSearchParams({ limit: String(input.limit) });
    if (input.before !== undefined) search.set("before", input.before);
    return this.request(
      "GET",
      `/v1/audit-events?${search.toString()}`,
      listAuditEventsResponseSchema,
      undefined,
      input,
    );
  }

  public async listProjects(
    includeArchived = false,
  ): Promise<z.infer<typeof listProjectsResponseSchema>> {
    const search = includeArchived ? "?includeArchived=true" : "";
    return this.request(
      "GET",
      `/v1/projects${search}`,
      listProjectsResponseSchema,
    );
  }

  public async createProject(input: {
    projectId: string;
    displayName: string;
  }): Promise<z.infer<typeof projectResponseSchema>> {
    return this.request(
      "POST",
      "/v1/projects",
      projectResponseSchema,
      input,
    );
  }

  public async archiveProject(projectId: string): Promise<void> {
    await this.requestNoContent(
      "DELETE",
      `/v1/projects/${encodeURIComponent(projectId)}`,
    );
  }

  public async listEnvironments(
    projectId: string,
    includeArchived = false,
  ): Promise<z.infer<typeof listEnvironmentsResponseSchema>> {
    const search = includeArchived ? "?includeArchived=true" : "";
    return this.request(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/environments${search}`,
      listEnvironmentsResponseSchema,
    );
  }

  public async createEnvironment(input: {
    projectId: string;
    environmentId: string;
    displayName: string;
  }): Promise<z.infer<typeof environmentResponseSchema>> {
    return this.request(
      "POST",
      `/v1/projects/${encodeURIComponent(input.projectId)}/environments`,
      environmentResponseSchema,
      {
        environmentId: input.environmentId,
        displayName: input.displayName,
      },
    );
  }

  public async archiveEnvironment(
    projectId: string,
    environmentId: string,
  ): Promise<void> {
    await this.requestNoContent(
      "DELETE",
      `/v1/projects/${encodeURIComponent(projectId)}/environments/` +
        encodeURIComponent(environmentId),
    );
  }

  public async listRegisteredServices(
    projectId: string,
    includeArchived = false,
  ): Promise<z.infer<typeof listRegisteredServicesResponseSchema>> {
    const search = includeArchived ? "?includeArchived=true" : "";
    return this.request(
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/services${search}`,
      listRegisteredServicesResponseSchema,
    );
  }

  public async registerService(input: {
    projectId: string;
    serviceId: string;
    displayName: string;
  }): Promise<z.infer<typeof registeredServiceResponseSchema>> {
    return this.request(
      "POST",
      `/v1/projects/${encodeURIComponent(input.projectId)}/services`,
      registeredServiceResponseSchema,
      {
        serviceId: input.serviceId,
        displayName: input.displayName,
      },
    );
  }

  public async archiveService(
    projectId: string,
    serviceId: string,
  ): Promise<void> {
    await this.requestNoContent(
      "DELETE",
      `/v1/projects/${encodeURIComponent(projectId)}/services/` +
        encodeURIComponent(serviceId),
    );
  }

  public async createServiceCredential(input: {
    projectId: string;
    environmentId: string;
    serviceId: string;
    label: string;
  }): Promise<z.infer<typeof createServiceCredentialResponseSchema>> {
    return this.request(
      "POST",
      "/v1/service-credentials",
      createServiceCredentialResponseSchema,
      input,
      input,
    );
  }

  public async listServiceCredentials(input: {
    projectId: string;
    environmentId: string;
    serviceId?: string | undefined;
  }): Promise<
    z.infer<typeof listServiceCredentialsResponseSchema>
  > {
    const search = new URLSearchParams({
      projectId: input.projectId,
      environmentId: input.environmentId,
    });
    if (input.serviceId !== undefined) {
      search.set("serviceId", input.serviceId);
    }
    return this.request(
      "GET",
      `/v1/service-credentials?${search.toString()}`,
      listServiceCredentialsResponseSchema,
      undefined,
      input,
    );
  }

  public async revokeServiceCredential(
    projectId: string,
    environmentId: string,
    credentialId: string,
  ): Promise<void> {
    const search = new URLSearchParams({ projectId, environmentId });
    await this.requestNoContent(
      "DELETE",
      `/v1/service-credentials/${encodeURIComponent(credentialId)}?` +
        search.toString(),
      { projectId, environmentId },
    );
  }

  public async removeProbe(
    probeId: string,
    scope: RequestScope,
  ): Promise<void> {
    await this.requestNoContent(
      "DELETE",
      `/v1/probes/${encodeURIComponent(probeId)}`,
      scope,
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    scope?: RequestScope,
  ): Promise<T> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(this.apiKey === undefined
          ? {}
          : { authorization: `Bearer ${this.apiKey}` }),
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(scope === undefined
          ? {}
          : {
              "liveprobe-project": scope.projectId,
              "liveprobe-environment": scope.environmentId,
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw await this.toClientError(response);
    }
    try {
      const result = schema.safeParse(await response.json());
      if (result.success) {
        return result.data;
      }
    } catch {
      // Normalize malformed JSON and schema drift to one protocol error.
    }
    throw new BrokerClientError(
      "broker response does not match the LiveProbe protocol",
      502,
      "invalid_broker_response",
    );
  }

  private async requestNoContent(
    method: "DELETE",
    path: string,
    scope?: RequestScope,
  ): Promise<void> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(this.apiKey === undefined
          ? {}
          : { authorization: `Bearer ${this.apiKey}` }),
        ...(scope === undefined
          ? {}
          : {
              "liveprobe-project": scope.projectId,
              "liveprobe-environment": scope.environmentId,
            }),
      },
    });
    if (!response.ok) {
      throw await this.toClientError(response);
    }
    if (response.status !== 204) {
      throw new BrokerClientError(
        `broker returned HTTP ${response.status}; expected 204`,
        response.status,
      );
    }
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref();
    try {
      return await this.fetchImplementation(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async toClientError(response: Response): Promise<BrokerClientError> {
    let message = `broker request failed with HTTP ${response.status}`;
    let code: string | undefined;
    try {
      const payload = z
        .object({
          error: z
            .object({
              code: z.string(),
              message: z.string(),
            })
            .strict(),
        })
        .strict()
        .parse(await response.json());
      message = payload.error.message;
      code = payload.error.code;
    } catch {
      // The status is still preserved when a proxy returns a non-protocol body.
    }
    return new BrokerClientError(
      message,
      response.status,
      ...(code === undefined ? [] : [code]),
    );
  }
}

type SetSnapshotInput = z.input<typeof SetSnapshotProbeInputSchema>;
type SetLogInput = z.input<typeof SetLogProbeInputSchema>;
type SetCounterInput = z.input<typeof SetCounterProbeInputSchema>;
type SetMetricInput = z.input<typeof SetMetricProbeInputSchema>;

export interface ToolHandlers {
  set_snapshot_probe(input: SetSnapshotInput): Promise<ProbeCreateResult>;
  set_log_probe(input: SetLogInput): Promise<ProbeCreateResult>;
  set_counter_probe(input: SetCounterInput): Promise<ProbeCreateResult>;
  set_metric_probe(input: SetMetricInput): Promise<ProbeCreateResult>;
  ping_broker(input?: unknown): Promise<{ ok: true }>;
  get_safety_overview(input?: unknown): Promise<z.infer<typeof safetyResponseSchema>>;
  list_audit_events(
    input?: z.input<typeof ListAuditEventsInputSchema>,
  ): Promise<z.infer<typeof listAuditEventsResponseSchema>>;
  list_projects(
    input?: z.input<typeof ListProjectsInputSchema>,
  ): Promise<z.infer<typeof listProjectsResponseSchema>>;
  create_project(
    input: z.input<typeof CreateProjectInputSchema>,
  ): Promise<z.infer<typeof projectResponseSchema>>;
  archive_project(
    input: z.input<typeof ArchiveProjectInputSchema>,
  ): Promise<{ archived: true; projectId: string }>;
  list_environments(
    input: z.input<typeof ListEnvironmentsInputSchema>,
  ): Promise<z.infer<typeof listEnvironmentsResponseSchema>>;
  create_environment(
    input: z.input<typeof CreateEnvironmentInputSchema>,
  ): Promise<z.infer<typeof environmentResponseSchema>>;
  archive_environment(
    input: z.input<typeof ArchiveEnvironmentInputSchema>,
  ): Promise<{ archived: true; projectId: string; environmentId: string }>;
  list_registered_services(
    input: z.input<typeof ListRegisteredServicesInputSchema>,
  ): Promise<z.infer<typeof listRegisteredServicesResponseSchema>>;
  register_service(
    input: z.input<typeof RegisterServiceInputSchema>,
  ): Promise<z.infer<typeof registeredServiceResponseSchema>>;
  archive_service(
    input: z.input<typeof ArchiveServiceInputSchema>,
  ): Promise<{ archived: true; projectId: string; serviceId: string }>;
  create_service_credential(
    input: z.input<typeof CreateServiceCredentialInputSchema>,
  ): Promise<z.infer<typeof createServiceCredentialResponseSchema>>;
  list_service_credentials(
    input: z.input<typeof ListServiceCredentialsInputSchema>,
  ): Promise<z.infer<typeof listServiceCredentialsResponseSchema>>;
  revoke_service_credential(
    input: z.input<typeof RevokeServiceCredentialInputSchema>,
  ): Promise<{ revoked: true; credentialId: string }>;
  list_services(input?: unknown): Promise<{ services: EnrichedService[] }>;
  list_probes(
    input: z.input<typeof ListProbesInputSchema>,
  ): Promise<z.infer<typeof listProbesResponseSchema>>;
  get_probe_data(
    input: z.input<typeof GetProbeDataInputSchema>,
  ): Promise<BrokerProbeData>;
  remove_probe(
    input: z.input<typeof RemoveProbeInputSchema>,
  ): Promise<{ removed: true; probeId: string }>;
}

export interface EnrichedService extends BrokerService {
  online: boolean;
  caveats: string[];
}

export type ProbeCreateResult = BrokerProbeDefinition & {
  probe: BrokerProbeDefinition;
  commitMismatch?: {
    requested: string;
    reported: string;
    warning: string;
  };
};

function optionalCommonFields(input: {
  condition?: BrokerCondition | undefined;
  condition_expression?: string | undefined;
  hit_limit?: number | undefined;
}): {
  condition?: BrokerCondition;
  conditionExpression?: string;
  hitLimit?: number;
} {
  return {
    ...(input.condition === undefined
      ? {}
      : { condition: input.condition }),
    ...(input.condition_expression === undefined
      ? {}
      : { conditionExpression: input.condition_expression }),
    ...(input.hit_limit === undefined ? {} : { hitLimit: input.hit_limit }),
  };
}

function requestScope(input: {
  project_id: string;
  environment_id: string;
}): RequestScope {
  return {
    projectId: input.project_id,
    environmentId: input.environment_id,
  };
}

export function createToolHandlers(client: BrokerClient): ToolHandlers {
  async function createWithCommitWarning(
    input: BrokerCreateProbeInput,
    scope: RequestScope,
  ): Promise<ProbeCreateResult> {
    const services = await client.listServices(scope);
    const service = services.services.find(
      (candidate) => candidate.serviceId === input.serviceId,
    );
    if (service === undefined) {
      throw new BrokerClientError(
        `service ${input.serviceId} has not reported to the broker; call list_services and use an online service ID`,
        404,
        "unknown_service",
      );
    }
    const probe = await client.createProbe(input, scope);
    if (
      service?.commitSha !== undefined &&
      service.commitSha !== input.sourceCommit
    ) {
      return {
        ...probe,
        probe,
        commitMismatch: {
          requested: input.sourceCommit,
          reported: service.commitSha,
          warning:
            `commit_hash ${input.sourceCommit} does not match service ` +
            `${input.serviceId} reported commitSha ${service.commitSha}`,
        },
      };
    }
    return { ...probe, probe };
  }

  return {
    async set_snapshot_probe(rawInput) {
      const input = SetSnapshotProbeInputSchema.parse(rawInput);
      return createWithCommitWarning(
        {
          serviceId: input.service_id,
          sourceCommit: input.commit_hash,
          type: "snapshot",
          file: input.file,
          line: input.line,
          ttlSeconds: input.ttl_seconds,
          createdBy: input.created_by,
          ...optionalCommonFields(input),
          ...(input.watch_paths === undefined
            ? {}
            : { watchPaths: input.watch_paths }),
          ...(input.watch_expressions === undefined
            ? {}
            : { watchExpressions: input.watch_expressions }),
          includeStackLocals: input.include_stack_locals,
          stackFrameLimit: input.stack_frame_limit,
        },
        requestScope(input),
      );
    },
    async set_log_probe(rawInput) {
      const input = SetLogProbeInputSchema.parse(rawInput);
      return createWithCommitWarning({
        serviceId: input.service_id,
        sourceCommit: input.commit_hash,
        type: "log",
        file: input.file,
        line: input.line,
        template: input.template,
        logLevel: input.log_level,
        ttlSeconds: input.ttl_seconds,
        createdBy: input.created_by,
        ...optionalCommonFields(input),
      }, requestScope(input));
    },
    async set_counter_probe(rawInput) {
      const input = SetCounterProbeInputSchema.parse(rawInput);
      return createWithCommitWarning({
        serviceId: input.service_id,
        sourceCommit: input.commit_hash,
        type: "counter",
        file: input.file,
        line: input.line,
        ttlSeconds: input.ttl_seconds,
        createdBy: input.created_by,
        ...optionalCommonFields(input),
      }, requestScope(input));
    },
    async set_metric_probe(rawInput) {
      const input = SetMetricProbeInputSchema.parse(rawInput);
      return createWithCommitWarning({
        serviceId: input.service_id,
        sourceCommit: input.commit_hash,
        type: "metric",
        file: input.file,
        line: input.line,
        ...(input.metric_path === undefined
          ? {}
          : { metricPath: input.metric_path }),
        ...(input.metric_expression === undefined
          ? {}
          : { metricExpression: input.metric_expression }),
        ttlSeconds: input.ttl_seconds,
        createdBy: input.created_by,
        ...optionalCommonFields(input),
      }, requestScope(input));
    },
    async list_services(rawInput = {}) {
      const input = ListServicesInputSchema.parse(rawInput);
      const response = await client.listServices(requestScope(input));
      const now = Date.now();
      return {
        services: response.services.map((service) => {
          const online = now - Date.parse(service.lastSeen) <= 45_000;
          const missingCapabilities = requiredAgentCapabilities.filter(
            (capability) => !service.capabilities?.includes(capability),
          );
          return {
            ...service,
            online,
            caveats: [
              "commitSha is agent-reported audit metadata, not cryptographic proof of bytecode identity.",
              ...(online ? [] : ["service has not heartbeated within 45 seconds"]),
              ...(missingCapabilities.length === 0
                ? []
                : [
                    `agent upgrade required for: ${missingCapabilities.join(", ")}`,
                  ]),
            ],
          };
        }),
      };
    },
    async ping_broker(rawInput = {}) {
      const input = PingBrokerInputSchema.parse(rawInput);
      return client.ping(requestScope(input));
    },
    async get_safety_overview(rawInput = {}) {
      const input = GetSafetyOverviewInputSchema.parse(rawInput);
      return client.getSafetyOverview(requestScope(input));
    },
    async list_audit_events(rawInput = {}) {
      const input = ListAuditEventsInputSchema.parse(rawInput);
      return client.listAuditEvents({
        ...requestScope(input),
        limit: input.limit,
        ...(input.before === undefined ? {} : { before: input.before }),
      });
    },
    async list_projects(rawInput = {}) {
      const input = ListProjectsInputSchema.parse(rawInput);
      return client.listProjects(input.include_archived);
    },
    async create_project(rawInput) {
      const input = CreateProjectInputSchema.parse(rawInput);
      return client.createProject({
        projectId: input.project_id,
        displayName: input.display_name,
      });
    },
    async archive_project(rawInput) {
      const input = ArchiveProjectInputSchema.parse(rawInput);
      await client.archiveProject(input.project_id);
      return { archived: true, projectId: input.project_id };
    },
    async list_environments(rawInput) {
      const input = ListEnvironmentsInputSchema.parse(rawInput);
      return client.listEnvironments(
        input.project_id,
        input.include_archived,
      );
    },
    async create_environment(rawInput) {
      const input = CreateEnvironmentInputSchema.parse(rawInput);
      return client.createEnvironment({
        projectId: input.project_id,
        environmentId: input.environment_id,
        displayName: input.display_name,
      });
    },
    async archive_environment(rawInput) {
      const input = ArchiveEnvironmentInputSchema.parse(rawInput);
      await client.archiveEnvironment(
        input.project_id,
        input.environment_id,
      );
      return {
        archived: true,
        projectId: input.project_id,
        environmentId: input.environment_id,
      };
    },
    async list_registered_services(rawInput) {
      const input = ListRegisteredServicesInputSchema.parse(rawInput);
      return client.listRegisteredServices(
        input.project_id,
        input.include_archived,
      );
    },
    async register_service(rawInput) {
      const input = RegisterServiceInputSchema.parse(rawInput);
      return client.registerService({
        projectId: input.project_id,
        serviceId: input.service_id,
        displayName: input.display_name,
      });
    },
    async archive_service(rawInput) {
      const input = ArchiveServiceInputSchema.parse(rawInput);
      await client.archiveService(input.project_id, input.service_id);
      return {
        archived: true,
        projectId: input.project_id,
        serviceId: input.service_id,
      };
    },
    async create_service_credential(rawInput) {
      const input = CreateServiceCredentialInputSchema.parse(rawInput);
      return client.createServiceCredential({
        projectId: input.project_id,
        environmentId: input.environment_id,
        serviceId: input.service_id,
        label: input.label,
      });
    },
    async list_service_credentials(rawInput) {
      const input = ListServiceCredentialsInputSchema.parse(rawInput);
      return client.listServiceCredentials({
        projectId: input.project_id,
        environmentId: input.environment_id,
        ...(input.service_id === undefined
          ? {}
          : { serviceId: input.service_id }),
      });
    },
    async revoke_service_credential(rawInput) {
      const input = RevokeServiceCredentialInputSchema.parse(rawInput);
      await client.revokeServiceCredential(
        input.project_id,
        input.environment_id,
        input.credential_id,
      );
      return { revoked: true, credentialId: input.credential_id };
    },
    async list_probes(rawInput) {
      const input = ListProbesInputSchema.parse(rawInput);
      return client.listProbes(input.service_id, requestScope(input));
    },
    async get_probe_data(rawInput) {
      const input = GetProbeDataInputSchema.parse(rawInput);
      return client.getProbeData(
        input.probe_id,
        input.wait_seconds,
        requestScope(input),
      );
    },
    async remove_probe(rawInput) {
      const input = RemoveProbeInputSchema.parse(rawInput);
      await client.removeProbe(input.probe_id, requestScope(input));
      return { removed: true, probeId: input.probe_id };
    },
  };
}

function toolResult(value: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function toolErrorResult(error: unknown): {
  isError: true;
  content: [{ type: "text"; text: string }];
} {
  let code = "internal_error";
  let message = "LiveProbe tool failed unexpectedly";
  let retryable = false;
  let checks: string[] = [];

  if (error instanceof BrokerClientError) {
    code = error.code ?? (error.status === 404 ? "not_found" : "broker_error");
    message = error.message;
    if (error.status === 401 || code === "unauthorized") {
      code = "unauthorized";
      checks = [
        "Set LIVEPROBE_API_KEY to the same value used by the broker.",
        "Restart the MCP server after changing its environment.",
      ];
    } else if (code === "unknown_service") {
      checks = [
        "Call list_services and use a reported serviceId.",
        "Confirm the runtime agent is online and heartbeating.",
      ];
    } else if (error.status === 403 || code === "forbidden") {
      code = "forbidden";
      checks = [
        "Use a Clerk account that is a member of the intended organization.",
        "Confirm the correct Clerk organization is selected if access is expected.",
      ];
    } else if (error.status === 404) {
      checks = [
        "Refresh services or probes before retrying with the returned ID.",
      ];
    }
  } else if (error instanceof z.ZodError) {
    code = "invalid_tool_input";
    message = error.issues[0]?.message ?? "tool input is invalid";
    checks = ["Correct the tool arguments and retry."];
  } else if (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    code = "broker_unreachable";
    message =
      error instanceof Error && error.name === "AbortError"
        ? "The LiveProbe broker request timed out"
        : "The LiveProbe broker could not be reached";
    retryable = true;
    checks = [
      "Confirm BROKER_URL uses the reachable broker host and port.",
      "Check that the broker is running and its /healthz endpoint is healthy.",
    ];
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { error: { code, message, retryable, checks } },
          null,
          2,
        ),
      },
    ],
  };
}

async function executeTool(
  action: () => Promise<unknown>,
  transform: (value: unknown) => unknown = (value) => value,
): Promise<
  | ReturnType<typeof toolResult>
  | ReturnType<typeof toolErrorResult>
> {
  try {
    return toolResult(transform(await action()));
  } catch (error: unknown) {
    return toolErrorResult(error);
  }
}

function withEmptyStateGuidance(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "probes" in value &&
    Array.isArray((value as { probes: unknown[] }).probes) &&
    (value as { probes: unknown[] }).probes.length === 0
  ) {
    return {
      ...value,
      guidance: [
        "No probes matched. Check service_id, whether the service is online, and whether probes have expired or been removed.",
      ],
    };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "events" in value &&
    Array.isArray((value as { events: unknown[] }).events) &&
    (value as { events: unknown[] }).events.length === 0
  ) {
    return {
      ...value,
      guidance: [
        "No retained events yet. Check that the probe is armed, the service is online, the line is reachable, and the runtime path matches the probe file.",
      ],
    };
  }
  return value;
}

const DEPLOYED_COMMIT_GUIDANCE =
  "Before creating this probe, if the deployed commit SHA is not already known, ask the user for it. When possible, validate that the revision exists in the local repository and inspect source at that exact revision before choosing file and line. commit_hash is user-supplied audit metadata, not runtime proof or runtime verification of the deployed code.";

export function createMcpServer(
  client: BrokerClient,
): McpServer {
  const handlers = createToolHandlers(client);
  const server = new McpServer({
    name: "liveprobe",
    version: "0.4.0",
  });

  server.registerTool(
    "set_snapshot_probe",
    {
      title: "Set snapshot probe",
      description: `${DEPLOYED_COMMIT_GUIDANCE} Use when you need local variables, selected watch paths or safe watch expressions, and a bounded stack from one source line. Safe expressions support fixed reads and operators only; calls and mutation are rejected.`,
      inputSchema: SetSnapshotProbeInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) =>
      executeTool(() => handlers.set_snapshot_probe(input)),
  );
  server.registerTool(
    "set_log_probe",
    {
      title: "Set dynamic log probe",
      description: `${DEPLOYED_COMMIT_GUIDANCE} Use to add a temporary diagnostic log at a source line without redeploying. Choose debug, info, warn, or error severity. \${expression} placeholders use the bounded safe-expression engine; calls and mutation are rejected.`,
      inputSchema: SetLogProbeInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => executeTool(() => handlers.set_log_probe(input)),
  );
  server.registerTool(
    "set_counter_probe",
    {
      title: "Set counter probe",
      description: `${DEPLOYED_COMMIT_GUIDANCE} Use to measure how often a source line executes. Agents pre-aggregate hits, so this is preferable to snapshots on hot paths.`,
      inputSchema: SetCounterProbeInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => executeTool(() => handlers.set_counter_probe(input)),
  );
  server.registerTool(
    "set_metric_probe",
    {
      title: "Set metric probe",
      description: `${DEPLOYED_COMMIT_GUIDANCE} Use to aggregate count, sum, min, max, and last for one numeric dot path or safe numeric expression at a source line. Values are resolved read-only and pre-aggregated by the runtime agent.`,
      inputSchema: SetMetricProbeInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => executeTool(() => handlers.set_metric_probe(input)),
  );
  server.registerTool(
    "list_services",
    {
      title: "List live services",
      description:
        "List services recently seen by the broker, including runtime SDK, heartbeat time, and safety state. Use this before placing a probe to confirm the service ID.",
      inputSchema: ListServicesInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => executeTool(() => handlers.list_services(input)),
  );
  server.registerTool(
    "ping_broker",
    {
      title: "Ping broker",
      description:
        "Check cheap broker connectivity. Use this to distinguish broker auth/connectivity failures from empty service state.",
      inputSchema: PingBrokerInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => executeTool(() => handlers.ping_broker(input)),
  );
  server.registerTool(
    "get_safety_overview",
    {
      title: "Get safety overview",
      description:
        "Return broker-derived per-service safety state, online status, probe status counts, and caveats about runtime semantics.",
      inputSchema: GetSafetyOverviewInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      executeTool(() => handlers.get_safety_overview(input)),
  );
  server.registerTool(
    "list_audit_events",
    {
      title: "List audit events",
      description:
        "List tenant-scoped probe and service-credential control events. This read-only tool is available to authenticated organization members and never returns bearer secrets or captured probe values.",
      inputSchema: ListAuditEventsInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => executeTool(() => handlers.list_audit_events(input)),
  );
  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List the current organization's LiveProbe projects, optionally including archived projects.",
      inputSchema: ListProjectsInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => executeTool(() => handlers.list_projects(input)),
  );
  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description:
        "Create or restore a project using a stable lowercase ID and a human-readable display name.",
      inputSchema: CreateProjectInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => executeTool(() => handlers.create_project(input)),
  );
  server.registerTool(
    "archive_project",
    {
      title: "Archive project",
      description:
        "Archive a project and its environments and revoke their active service credentials while retaining diagnostic and audit history.",
      inputSchema: ArchiveProjectInputSchema,
      annotations: { destructiveHint: true },
    },
    async (input) => executeTool(() => handlers.archive_project(input)),
  );
  server.registerTool(
    "list_environments",
    {
      title: "List environments",
      description:
        "List environments such as development, staging, and production for a project.",
      inputSchema: ListEnvironmentsInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => executeTool(() => handlers.list_environments(input)),
  );
  server.registerTool(
    "create_environment",
    {
      title: "Create environment",
      description:
        "Create or restore an environment within an existing project.",
      inputSchema: CreateEnvironmentInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => executeTool(() => handlers.create_environment(input)),
  );
  server.registerTool(
    "archive_environment",
    {
      title: "Archive environment",
      description:
        "Archive an environment and revoke its active service credentials while retaining diagnostic and audit history.",
      inputSchema: ArchiveEnvironmentInputSchema,
      annotations: { destructiveHint: true },
    },
    async (input) => executeTool(() => handlers.archive_environment(input)),
  );
  server.registerTool(
    "list_registered_services",
    {
      title: "List registered services",
      description:
        "List project-level service identities. A registered service can be deployed into multiple environments.",
      inputSchema: ListRegisteredServicesInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      executeTool(() => handlers.list_registered_services(input)),
  );
  server.registerTool(
    "register_service",
    {
      title: "Register service",
      description:
        "Register or restore one project-level service ID before issuing environment-scoped runtime credentials.",
      inputSchema: RegisterServiceInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => executeTool(() => handlers.register_service(input)),
  );
  server.registerTool(
    "archive_service",
    {
      title: "Archive service",
      description:
        "Archive a project-level service and revoke its active credentials in every environment while retaining history.",
      inputSchema: ArchiveServiceInputSchema,
      annotations: { destructiveHint: true },
    },
    async (input) => executeTool(() => handlers.archive_service(input)),
  );
  server.registerTool(
    "create_service_credential",
    {
      title: "Create service credential",
      description:
        "Create an environment-scoped API key for a registered service. The plaintext key is returned once and cannot be recovered. Store it in the target service's secret manager.",
      inputSchema: CreateServiceCredentialInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => executeTool(() => handlers.create_service_credential(input)),
  );
  server.registerTool(
    "list_service_credentials",
    {
      title: "List service credentials",
      description:
        "List non-secret service credential metadata for the current organization. Plaintext keys are never returned.",
      inputSchema: ListServiceCredentialsInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => executeTool(() => handlers.list_service_credentials(input)),
  );
  server.registerTool(
    "revoke_service_credential",
    {
      title: "Revoke service credential",
      description:
        "Revoke a service credential in the current organization. Revocation is idempotent only until the credential is revoked.",
      inputSchema: RevokeServiceCredentialInputSchema,
      annotations: { destructiveHint: true },
    },
    async (input) => executeTool(() => handlers.revoke_service_credential(input)),
  );
  server.registerTool(
    "list_probes",
    {
      title: "List probes",
      description:
        "List probe definitions and their latest status. Filter by service to diagnose armed, suspended, expired, line-not-found, or hit-limit states.",
      inputSchema: ListProbesInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      executeTool(
        () => handlers.list_probes(input),
        withEmptyStateGuidance,
      ),
  );
  server.registerTool(
    "get_probe_data",
    {
      title: "Get probe evidence",
      description:
        "Read retained probe events. Set wait_seconds (up to 30) to long-poll until the first event arrives, avoiding repeated polling while waiting for a line to execute.",
      inputSchema: GetProbeDataInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      executeTool(
        () => handlers.get_probe_data(input),
        withEmptyStateGuidance,
      ),
  );
  server.registerTool(
    "remove_probe",
    {
      title: "Remove probe",
      description:
        "Remove a probe when enough evidence has been collected. Deletion is idempotent and causes agents to uninstall it on their next poll.",
      inputSchema: RemoveProbeInputSchema,
      annotations: { destructiveHint: true },
    },
    async (input) => executeTool(() => handlers.remove_probe(input)),
  );
  return server;
}

export interface StatelessHttpMcpRequest {
  brokerUrl: string;
  bearerToken: string;
  request: IncomingMessage;
  response: ServerResponse;
  body: unknown;
}

export async function handleStatelessHttpMcpRequest(
  input: StatelessHttpMcpRequest,
): Promise<void> {
  const server = createMcpServer(
    new BrokerClient(input.brokerUrl, { apiKey: input.bearerToken }),
  );
  const transport = new StreamableHTTPServerTransport();
  const close = (): void => {
    void transport.close();
    void server.close();
  };
  input.response.once("close", close);
  try {
    await server.connect(
      transport as Parameters<McpServer["connect"]>[0],
    );
    await transport.handleRequest(input.request, input.response, input.body);
  } catch (error: unknown) {
    input.response.off("close", close);
    close();
    throw error;
  }
}

export async function startStdioServer(
  brokerUrl = process.env["BROKER_URL"] ?? "http://127.0.0.1:7070",
): Promise<McpServer> {
  const apiKey = process.env["LIVEPROBE_API_KEY"];
  const server = createMcpServer(
    new BrokerClient(brokerUrl, {
      ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    }),
  );
  await server.connect(new StdioServerTransport());
  return server;
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(executedPath)).href
) {
  startStdioServer().catch((error: unknown) => {
    console.error("[liveprobe] MCP server failed", error);
    process.exitCode = 1;
  });
}
