import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const serviceIdSchema = z.string().trim().min(1).max(200);
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
const investigationIdSchema = z
  .string()
  .regex(/^inv_[0-9a-f]{24}$/, "must be a LiveProbe investigation ID");
const candidateIdSchema = z
  .string()
  .regex(/^cand_[0-9a-f]{24}$/, "must be a LiveProbe candidate ID");
const scalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
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
  })
  .strict();

export const SetCounterProbeInputSchema = z
  .object(commonInputShape)
  .strict();

export const SetMetricProbeInputSchema = z
  .object({
    ...commonInputShape,
    metric_path: dotPathSchema.describe(
      "Dot path that resolves to the numeric value to aggregate",
    ),
  })
  .strict();

export const ListServicesInputSchema = z.object({}).strict();
export const PingBrokerInputSchema = z.object({}).strict();
export const GetSafetyOverviewInputSchema = z.object({}).strict();
export const ListAuditEventsInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional().default(50),
    before: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Return events strictly before this ISO-8601 timestamp"),
  })
  .strict();
export const ListProbesInputSchema = z
  .object({
    service_id: serviceIdSchema.optional(),
  })
  .strict();
export const GetProbeDataInputSchema = z
  .object({
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
    probe_id: probeIdSchema,
  })
  .strict();

const repositoryRootSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .describe("Local checkout root containing the deployed Python revision");

export const PrepareRepositoryAnalysisInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    commit_hash: commitHashSchema,
  })
  .strict();

export const AnalyzeProbeCandidatesInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    commit_hash: commitHashSchema,
    service_id: serviceIdSchema,
    file: sourceFileSchema,
    line: z.number().int().positive(),
    watch_path: dotPathSchema.optional(),
    expression: z.string().trim().min(1).max(4_096).optional(),
    probe_budget: z.number().int().min(1).max(10).optional().default(5),
    source_roots: z
      .array(z.string().trim().min(1).max(4_096))
      .max(50)
      .optional()
      .default([]),
  })
  .strict()
  .refine(
    (value) =>
      value.watch_path === undefined || value.expression === undefined,
    {
      message: "provide watch_path or expression, not both",
    },
  );

const serviceMapEntrySchema = z
  .object({
    source_root: z.string().trim().min(1).max(4_096),
    service_id: serviceIdSchema,
  })
  .strict();

export const DeployProbeFrontierInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    plan_id: investigationIdSchema,
    service_map: z.array(serviceMapEntrySchema).max(100).optional().default([]),
    default_service_id: serviceIdSchema.optional(),
    ttl_seconds: z.number().int().positive().optional().default(300),
    hit_limit: z.number().int().positive().optional().default(1),
    created_by: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .default("mcp:liveprobe-analysis"),
  })
  .strict();

const candidateAssessmentSchema = z
  .object({
    candidate_id: candidateIdSchema,
    classification: z.enum(["good", "bad", "unknown"]),
    occurrence_id: z.string().trim().min(1).max(500).optional(),
    reason: z.string().trim().min(1).max(4_096).optional(),
  })
  .strict();

export const RefineProbeCandidatesInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    plan_id: investigationIdSchema,
    assessments: z.array(candidateAssessmentSchema).max(100).optional().default([]),
    wait_seconds: z.number().finite().min(0).max(30).optional().default(0),
  })
  .strict();

const failureClassSchema = z.enum([
  "type_shape",
  "domain_range",
  "contract",
  "semantic",
  "absence",
]);
const expectedTypeSchema = z.enum([
  "numeric",
  "string",
  "boolean",
  "mapping",
  "sequence",
]);
const serviceSelectionSchema = z
  .object({
    source_root: z.string().trim().min(1).max(4_096),
    service_id: serviceIdSchema,
  })
  .strict();

export const StartProbeInvestigationInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    commit_hash: commitHashSchema,
    service_id: serviceIdSchema,
    file: sourceFileSchema,
    line: z.number().int().positive(),
    symptom: z.string().trim().min(1).max(16_000),
    watch_path: dotPathSchema.optional(),
    expression: z.string().trim().min(1).max(4_096).optional(),
    failure_class: failureClassSchema.optional().default("semantic"),
    expected_type: expectedTypeSchema.optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    minimum_exclusive: z.boolean().optional().default(false),
    maximum_exclusive: z.boolean().optional().default(false),
    probe_budget: z.number().int().min(1).max(10).optional().default(5),
    source_roots: z
      .array(z.string().trim().min(1).max(4_096))
      .max(50)
      .optional()
      .default([]),
    ownership_map: z
      .array(serviceSelectionSchema)
      .max(100)
      .optional()
      .default([]),
  })
  .strict()
  .refine(
    (value) =>
      value.watch_path === undefined || value.expression === undefined,
    { message: "provide watch_path or expression, not both" },
  );

export const GetInvestigationInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    investigation_id: investigationIdSchema,
    since_revision: z.number().int().nonnegative().optional(),
    focus_traversal_id: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const DeployInvestigationProbesInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    investigation_id: investigationIdSchema,
    service_map: z
      .array(serviceSelectionSchema)
      .max(100)
      .optional()
      .default([]),
    default_service_id: serviceIdSchema.optional(),
    ttl_seconds: z.number().int().positive().optional().default(300),
    hit_limit: z.number().int().positive().optional().default(1),
    created_by: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .default("mcp:liveprobe-investigation"),
  })
  .strict();

const occurrenceSelectionSchema = z
  .object({
    occurrence_id: z.string().trim().min(1).max(500),
  })
  .strict();

export const CollectInvestigationEvidenceInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    investigation_id: investigationIdSchema,
    occurrences: z
      .array(occurrenceSelectionSchema)
      .max(1)
      .optional()
      .default([]),
    wait_seconds: z.number().finite().min(0).max(30).optional().default(0),
  })
  .strict();

const candidatePredictionSchema = z
  .object({
    probe_candidate_id: z.string().trim().min(1).max(500),
    watch_path: dotPathSchema,
    operator: z.enum(["eq", "ne", "truthy", "falsy", "present"]),
    expected_value: z.unknown().optional(),
  })
  .strict();

const candidateMechanismSchema = z
  .object({
    statement: z.string().trim().min(1).max(4_000),
    anchor_node_ids: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(8),
    traversal_id: z.string().trim().min(1).max(500),
    predictions: z.array(candidatePredictionSchema).min(1).max(9),
  })
  .strict();

export const ApplyInvestigationDecisionInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    investigation_id: investigationIdSchema,
    based_on_revision: z.number().int().positive(),
    action_ids: z.array(z.string().trim().min(1)).max(2),
    exploration_question: z.string().trim().min(1).max(1_000).optional(),
    candidate_mechanism: candidateMechanismSchema.optional(),
    evidence_refs: z
      .array(z.string().trim().min(1).max(500))
      .max(100)
      .optional()
      .default([]),
  })
  .strict();

const conditionResponseSchema = z
  .object({
    path: z.string(),
    op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]),
    value: scalarSchema,
  })
  .strict();

const definitionCommonShape = {
  id: probeIdSchema,
  serviceId: serviceIdSchema,
  sourceCommit: commitHashSchema.optional(),
  file: sourceFileSchema,
  line: z.number().int().positive(),
  condition: conditionResponseSchema.optional(),
  hitLimit: z.number().int().positive(),
  ttlSeconds: z.number().int().positive(),
  version: z.number().int().positive(),
  createdBy: z.string().min(1),
  investigationId: investigationIdSchema.optional(),
  candidateId: candidateIdSchema.optional(),
  round: z.number().int().positive().optional(),
} as const;

export const BrokerProbeDefinitionSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...definitionCommonShape,
      type: z.literal("snapshot"),
      watchPaths: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      ...definitionCommonShape,
      type: z.literal("log"),
      template: z.string(),
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
      metricPath: z.string(),
    })
    .strict(),
]);

const probeStatusSchema = z
  .object({
    status: z.enum([
      "armed",
      "error",
      "hit-limit-reached",
      "suspended",
      "expired",
    ]),
    updatedAt: z.string().datetime({ offset: true }),
    detail: z.string().optional(),
  })
  .strict();

const serviceSchema = z
  .object({
    serviceId: serviceIdSchema,
    sdk: z.enum(["node", "python", "jvm"]).optional(),
    commitSha: commitHashSchema.optional(),
    commitSource: z.enum(["env", "config"]).optional(),
    lastSeen: z.string().datetime({ offset: true }),
    agentStatus: z
      .object({
        state: z.enum(["green", "red"]),
        detail: z.string().optional(),
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
          sdk: z.enum(["node", "python", "jvm"]).optional(),
          commitSha: commitHashSchema.optional(),
          lastSeen: z.string().datetime({ offset: true }),
          online: z.boolean(),
          agent: z
            .object({
              state: z.enum(["green", "red", "unknown"]),
              detail: z.string().optional(),
            })
            .strict(),
          probesSummary: z.record(z.string(), z.number().int().nonnegative()),
          caveats: z.array(z.string()),
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
    actorType: z.enum(["shared", "user", "service"]),
    actorId: z.string().min(1),
    actorRole: z.enum(["admin", "operator", "viewer", "agent"]),
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

export type BrokerProbeDefinition = z.infer<
  typeof BrokerProbeDefinitionSchema
>;
export type BrokerService = z.infer<typeof serviceSchema>;
export type BrokerProbeStatus = z.infer<typeof probeStatusSchema>;
export type BrokerProbeData = z.infer<typeof probeDataResponseSchema>;
export type BrokerAuditEvent = z.infer<typeof auditEventSchema>;

type BrokerCondition = z.infer<typeof McpConditionSchema>;

type InvestigationMetadata = {
  investigationId?: string;
  candidateId?: string;
  round?: number;
};

export type BrokerCreateProbeInput = InvestigationMetadata &
  (
  | {
      serviceId: string;
      sourceCommit: string;
      type: "snapshot";
      file: string;
      line: number;
      condition?: BrokerCondition;
      watchPaths?: string[];
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
      template: string;
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
      metricPath: string;
      hitLimit?: number;
      ttlSeconds: number;
      createdBy: string;
    }
  );

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

export class AnalyzerClientError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnalyzerClientError";
  }
}

const analyzerCandidateSchema = z
  .object({
    candidate_id: candidateIdSchema,
    function_id: z.string().min(1),
    hammock_id: z.string().min(1),
    file: sourceFileSchema,
    line: z.number().int().positive(),
    watch_paths: z.array(dotPathSchema).max(100),
    distance_from_sink: z.number().int().nonnegative(),
    upstream_weight: z.number().int().nonnegative(),
    reason: z.string(),
    certainty: z.enum(["MUST", "MAY", "UNKNOWN"]),
  })
  .strict();

const analyzerPlanSchema = z
  .object({
    plan_id: investigationIdSchema,
    criterion: z
      .object({
        repository_root: z.string(),
        commit: commitHashSchema,
        service_id: serviceIdSchema,
        file: sourceFileSchema,
        line: z.number().int().positive(),
        watch_path: z.string().nullable().optional(),
        expression: z.string().nullable().optional(),
        probe_budget: z.number().int().min(1).max(10),
        source_roots: z.array(z.string()).optional().default([]),
      })
      .strict(),
    slice_node_ids: z.array(z.string()),
    slice_edges: z.array(z.record(z.string(), z.unknown())),
    hammocks: z.array(z.record(z.string(), z.unknown())),
    frontier: z.array(analyzerCandidateSchema),
    coverage_notes: z.array(z.string()),
    round: z.number().int().positive(),
    status: z.enum(["ACTIVE", "LOCALIZED", "EXONERATED", "INSUFFICIENT"]),
    likely_hammock_id: z.string().nullable().optional(),
    stats: z.record(z.string(), z.union([z.string(), z.number()])),
  })
  .strict();

export type AnalyzerPlan = z.infer<typeof analyzerPlanSchema>;

const investigationSiteSchema = z
  .object({
    site_id: candidateIdSchema,
    node_id: z.string().min(1),
    function_id: z.string().min(1),
    file: sourceFileSchema,
    line: z.number().int().positive(),
    watch_paths: z.array(dotPathSchema).max(100),
    reason: z.string(),
    certainty: z.enum(["MUST", "MAY", "UNKNOWN"]),
    service_id: serviceIdSchema,
    traversal_ids: z.array(z.string().min(1)).min(1).max(100),
    path_node_ids: z
      .array(z.tuple([dotPathSchema, z.string().min(1)]))
      .max(100)
      .optional()
      .default([]),
  })
  .strict();

const investigationBundleSchema = z
  .object({
    bundle_id: z.string().min(1),
    round: z.number().int().positive(),
    sites: z.array(investigationSiteSchema).max(10),
    reason: z.string(),
  })
  .strict();

const investigationActionSchema = z
  .object({
    action_id: z.string().min(1),
    kind: z.enum([
      "FOLLOW_PATH",
      "PROBE_REGION",
      "INSPECT_MECHANISM",
      "CONFIRM_CANDIDATE",
      "COMPLETE_LOCALIZATION",
      "HANDOFF_BOUNDARY",
    ]),
    label: z.string(),
    reason: z.string(),
    function_id: z.string().nullable().optional(),
    anchor_node_id: z.string().nullable().optional(),
    tracked_paths: z.array(z.string()),
    boundary_kind: z.string().nullable().optional(),
    estimated_nodes: z.number().int().nonnegative(),
    source_traversal_id: z.string().nullable().optional(),
    target_service_id: serviceIdSchema.nullable().optional(),
    region_id: z.string().nullable().optional(),
    dependency_role: z
      .enum([
        "VALUE_PRODUCER",
        "CONTROL_GUARD",
        "ACTIVATION_SOURCE",
        "HISTORICAL_STATE_PRODUCER",
      ])
      .nullable()
      .optional(),
  })
  .strict();

const investigationViewSchema = z
  .object({
    investigation_id: investigationIdSchema,
    revision: z.number().int().positive(),
    criterion: z.record(z.string(), z.unknown()),
    phase: z.enum([
      "TRACING",
      "AWAITING_EVIDENCE",
      "DECIDING",
      "MECHANISM",
      "CONFIRMING",
      "LOCALIZED",
      "HANDOFF",
      "INSUFFICIENT",
    ]),
    status: z.enum(["ACTIVE", "LOCALIZED", "HANDOFF", "INSUFFICIENT"]),
    round: z.number().int().positive(),
    graph: z.record(z.string(), z.unknown()),
    probe_bundle: investigationBundleSchema.nullable(),
    value_dossiers: z.array(z.record(z.string(), z.unknown())),
    judgments: z.array(z.record(z.string(), z.unknown())),
    actions: z.array(investigationActionSchema),
    mechanism_context: z.record(z.string(), z.unknown()).nullable(),
    candidate_mechanism: z.record(z.string(), z.unknown()).nullable(),
    decision_context: z.record(z.string(), z.unknown()),
    decision_aliases: z.record(
      z.string(),
      z.record(z.string(), z.string()),
    ),
    coverage_notes: z.array(z.string()),
    decision_log: z.array(z.record(z.string(), z.unknown())),
    stats: z.record(z.string(), z.union([z.string(), z.number()])),
  })
  .strict();

export type InvestigationView = z.infer<typeof investigationViewSchema>;

export interface AnalyzerRunnerOptions {
  pythonCommand?: string;
  pythonPath?: string;
  timeoutMs?: number;
}

export interface AnalyzerClient {
  run(
    repositoryRoot: string,
    command: Record<string, unknown>,
  ): Promise<unknown>;
  getPlan(repositoryRoot: string, planId: string): Promise<AnalyzerPlan>;
}

export class AnalyzerRunner implements AnalyzerClient {
  private readonly pythonCommand: string;
  private readonly pythonPath: string;
  private readonly timeoutMs: number;

  public constructor(options: AnalyzerRunnerOptions = {}) {
    this.pythonCommand =
      options.pythonCommand ??
      process.env["LIVEPROBE_ANALYZER_PYTHON"] ??
      "python3.12";
    this.pythonPath =
      options.pythonPath ??
      process.env["LIVEPROBE_ANALYZER_PYTHONPATH"] ??
      fileURLToPath(new URL("../../../python/analyzer/src", import.meta.url));
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  public async run(
    repositoryRoot: string,
    command: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(
        this.pythonCommand,
        ["-m", "liveprobe_analysis"],
        {
          cwd: resolve(repositoryRoot),
          env: {
            ...process.env,
            PYTHONPATH: [
              this.pythonPath,
              process.env["PYTHONPATH"],
            ]
              .filter((value): value is string => value !== undefined && value.length > 0)
              .join(process.platform === "win32" ? ";" : ":"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        child.kill();
        if (!settled) {
          settled = true;
          reject(new AnalyzerClientError("analysis command timed out"));
        }
      }, this.timeoutMs);
      timeout.unref();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 32 * 1024 * 1024) child.kill();
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(
            new AnalyzerClientError(
              `could not start ${this.pythonCommand}: ${error.message}`,
            ),
          );
        }
      });
      child.on("close", () => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;
        try {
          const response = z
            .object({
              ok: z.boolean(),
              result: z.unknown().optional(),
              error: z
                .object({
                  type: z.string(),
                  message: z.string(),
                })
                .optional(),
            })
            .parse(JSON.parse(stdout));
          if (!response.ok) {
            reject(
              new AnalyzerClientError(
                response.error?.message ?? "analysis command failed",
              ),
            );
            return;
          }
          resolvePromise(response.result);
        } catch (error) {
          reject(
            new AnalyzerClientError(
              `invalid analyzer response${stderr ? `: ${stderr.trim()}` : ""}`,
            ),
          );
        }
      });
      child.stdin.end(
        JSON.stringify({
          ...command,
          repositoryRoot: resolve(repositoryRoot),
        }),
      );
    });
  }

  public async getPlan(
    repositoryRoot: string,
    planId: string,
  ): Promise<AnalyzerPlan> {
    return analyzerPlanSchema.parse(
      await this.run(repositoryRoot, { command: "get", planId }),
    );
  }
}

export interface BrokerClientOptions {
  fetchImplementation?: typeof fetch;
  apiKey?: string;
  requestTimeoutMs?: number;
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

  public async ping(): Promise<{ ok: true }> {
    return this.request("GET", "/v1/ping", pingResponseSchema);
  }

  public async createProbe(
    input: BrokerCreateProbeInput,
  ): Promise<BrokerProbeDefinition> {
    const result = await this.request(
      "POST",
      "/v1/probes",
      createProbeResponseSchema,
      input,
    );
    return result.probe;
  }

  public async listServices(): Promise<{ services: BrokerService[] }> {
    return this.request(
      "GET",
      "/v1/services",
      listServicesResponseSchema,
    );
  }

  public async listProbes(
    serviceId?: string,
  ): Promise<z.infer<typeof listProbesResponseSchema>> {
    const search =
      serviceId === undefined
        ? ""
        : `?${new URLSearchParams({ serviceId }).toString()}`;
    return this.request(
      "GET",
      `/v1/probes${search}`,
      listProbesResponseSchema,
    );
  }

  public async getProbeData(
    probeId: string,
    waitSeconds = 0,
  ): Promise<BrokerProbeData> {
    const search = new URLSearchParams({
      waitSeconds: String(waitSeconds),
    });
    return this.request(
      "GET",
      `/v1/probes/${encodeURIComponent(probeId)}/data?${search.toString()}`,
      probeDataResponseSchema,
    );
  }

  public async getSafetyOverview(): Promise<z.infer<typeof safetyResponseSchema>> {
    return this.request("GET", "/v1/safety", safetyResponseSchema);
  }

  public async listAuditEvents(input: {
    limit: number;
    before?: string | undefined;
  }): Promise<z.infer<typeof listAuditEventsResponseSchema>> {
    const search = new URLSearchParams({ limit: String(input.limit) });
    if (input.before !== undefined) search.set("before", input.before);
    return this.request(
      "GET",
      `/v1/audit-events?${search.toString()}`,
      listAuditEventsResponseSchema,
    );
  }

  public async removeProbe(probeId: string): Promise<void> {
    await this.requestNoContent(
      "DELETE",
      `/v1/probes/${encodeURIComponent(probeId)}`,
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
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
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw await this.toClientError(response);
    }
    return schema.parse(await response.json());
  }

  private async requestNoContent(
    method: "DELETE",
    path: string,
  ): Promise<void> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(this.apiKey === undefined
          ? {}
          : { authorization: `Bearer ${this.apiKey}` }),
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
  prepare_repository_analysis(
    input: z.input<typeof PrepareRepositoryAnalysisInputSchema>,
  ): Promise<unknown>;
  analyze_probe_candidates(
    input: z.input<typeof AnalyzeProbeCandidatesInputSchema>,
  ): Promise<AnalyzerPlan>;
  deploy_probe_frontier(
    input: z.input<typeof DeployProbeFrontierInputSchema>,
  ): Promise<{
    planId: string;
    round: number;
    probes: Array<{
      candidateId: string;
      probe: BrokerProbeDefinition;
      commitMismatch?: ProbeCreateResult["commitMismatch"];
    }>;
  }>;
  refine_probe_candidates(
    input: z.input<typeof RefineProbeCandidatesInputSchema>,
  ): Promise<{
    plan: AnalyzerPlan;
    occurrences: Array<{
      occurrenceId: string;
      correlated: boolean;
      events: Array<{
        candidateId?: string;
        probeId: string;
        event: Record<string, unknown>;
      }>;
    }>;
  }>;
  start_probe_investigation(
    input: z.input<typeof StartProbeInvestigationInputSchema>,
  ): Promise<InvestigationView>;
  get_investigation_context(
    input: z.input<typeof GetInvestigationInputSchema>,
  ): Promise<InvestigationView>;
  deploy_investigation_probes(
    input: z.input<typeof DeployInvestigationProbesInputSchema>,
  ): Promise<{
    investigationId: string;
    bundleId: string;
    round: number;
    probes: Array<{
      siteId: string;
      probe: BrokerProbeDefinition;
      commitMismatch?: ProbeCreateResult["commitMismatch"];
    }>;
  }>;
  collect_investigation_evidence(
    input: z.input<typeof CollectInvestigationEvidenceInputSchema>,
  ): Promise<{
    investigation: InvestigationView;
    occurrences: Array<{
      occurrenceId: string;
      correlated: boolean;
      events: Array<{
        candidateId?: string;
        probeId: string;
        event: Record<string, unknown>;
      }>;
    }>;
  }>;
  apply_investigation_decision(
    input: z.input<typeof ApplyInvestigationDecisionInputSchema>,
  ): Promise<InvestigationView>;
  get_investigation_result(
    input: z.input<typeof GetInvestigationInputSchema>,
  ): Promise<unknown>;
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
  hit_limit?: number | undefined;
}): {
  condition?: BrokerCondition;
  hitLimit?: number;
} {
  return {
    ...(input.condition === undefined
      ? {}
      : { condition: input.condition }),
    ...(input.hit_limit === undefined ? {} : { hitLimit: input.hit_limit }),
  };
}

function stableEvidenceId(...parts: Array<string | number>): string {
  return `obs_${createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 24)}`;
}

type InvestigationOccurrence = {
  occurrenceId: string;
  correlated: boolean;
  events: Array<{
    candidateId?: string;
    probeId: string;
    event: Record<string, unknown>;
  }>;
};

function groupInvestigationOccurrences(
  data: BrokerProbeData[],
): InvestigationOccurrence[] {
  const occurrenceMap = new Map<string, InvestigationOccurrence>();
  for (const result of data) {
    for (const [index, event] of result.events.entries()) {
      const correlation =
        typeof event["correlation"] === "object" &&
        event["correlation"] !== null
          ? (event["correlation"] as Record<string, unknown>)
          : undefined;
      const traceId =
        correlation?.["quality"] === "exact-execution" &&
        typeof correlation["traceId"] === "string"
          ? correlation["traceId"]
          : undefined;
      const occurrenceId =
        traceId === undefined
          ? `uncorrelated:${result.probe.id}:${index}`
          : `trace:${traceId}`;
      const group =
        occurrenceMap.get(occurrenceId) ?? {
          occurrenceId,
          correlated: traceId !== undefined,
          events: [],
        };
      group.events.push({
        ...(result.probe.candidateId === undefined
          ? {}
          : { candidateId: result.probe.candidateId }),
        probeId: result.probe.id,
        event: event as Record<string, unknown>,
      });
      occurrenceMap.set(occurrenceId, group);
    }
  }
  return [...occurrenceMap.values()].sort((left, right) =>
    left.occurrenceId.localeCompare(right.occurrenceId),
  );
}

export function createToolHandlers(
  client: BrokerClient,
  analyzer: AnalyzerClient = new AnalyzerRunner(),
): ToolHandlers {
  async function createWithCommitWarning(
    input: BrokerCreateProbeInput,
  ): Promise<ProbeCreateResult> {
    const services = await client.listServices();
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
    const probe = await client.createProbe(input);
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
      return createWithCommitWarning({
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
      });
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
        ttlSeconds: input.ttl_seconds,
        createdBy: input.created_by,
        ...optionalCommonFields(input),
      });
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
      });
    },
    async set_metric_probe(rawInput) {
      const input = SetMetricProbeInputSchema.parse(rawInput);
      return createWithCommitWarning({
        serviceId: input.service_id,
        sourceCommit: input.commit_hash,
        type: "metric",
        file: input.file,
        line: input.line,
        metricPath: input.metric_path,
        ttlSeconds: input.ttl_seconds,
        createdBy: input.created_by,
        ...optionalCommonFields(input),
      });
    },
    async list_services(rawInput = {}) {
      ListServicesInputSchema.parse(rawInput);
      const response = await client.listServices();
      const now = Date.now();
      return {
        services: response.services.map((service) => {
          const online = now - Date.parse(service.lastSeen) <= 45_000;
          return {
            ...service,
            online,
            caveats: [
              "commitSha is agent-reported audit metadata, not cryptographic proof of bytecode identity.",
              ...(online ? [] : ["service has not heartbeated within 45 seconds"]),
            ],
          };
        }),
      };
    },
    async ping_broker(rawInput = {}) {
      PingBrokerInputSchema.parse(rawInput);
      return client.ping();
    },
    async get_safety_overview(rawInput = {}) {
      GetSafetyOverviewInputSchema.parse(rawInput);
      return client.getSafetyOverview();
    },
    async list_audit_events(rawInput = {}) {
      const input = ListAuditEventsInputSchema.parse(rawInput);
      return client.listAuditEvents(input);
    },
    async list_probes(rawInput) {
      const input = ListProbesInputSchema.parse(rawInput);
      return client.listProbes(input.service_id);
    },
    async get_probe_data(rawInput) {
      const input = GetProbeDataInputSchema.parse(rawInput);
      return client.getProbeData(input.probe_id, input.wait_seconds);
    },
    async remove_probe(rawInput) {
      const input = RemoveProbeInputSchema.parse(rawInput);
      await client.removeProbe(input.probe_id);
      return { removed: true, probeId: input.probe_id };
    },
    async prepare_repository_analysis(rawInput) {
      const input = PrepareRepositoryAnalysisInputSchema.parse(rawInput);
      return analyzer.run(input.repository_root, {
        command: "prepare",
        commit: input.commit_hash,
      });
    },
    async analyze_probe_candidates(rawInput) {
      const input = AnalyzeProbeCandidatesInputSchema.parse(rawInput);
      return analyzerPlanSchema.parse(
        await analyzer.run(input.repository_root, {
          command: "analyze",
          criterion: {
            commit: input.commit_hash,
            serviceId: input.service_id,
            file: input.file,
            line: input.line,
            ...(input.watch_path === undefined
              ? {}
              : { watchPath: input.watch_path }),
            ...(input.expression === undefined
              ? {}
              : { expression: input.expression }),
            probeBudget: input.probe_budget,
            sourceRoots: input.source_roots,
          },
        }),
      );
    },
    async deploy_probe_frontier(rawInput) {
      const input = DeployProbeFrontierInputSchema.parse(rawInput);
      const plan = await analyzer.getPlan(input.repository_root, input.plan_id);
      const mappings = [...input.service_map].sort(
        (left, right) => right.source_root.length - left.source_root.length,
      );
      const services = await client.listServices();
      const serviceIds = new Set(
        services.services.map(({ serviceId }) => serviceId),
      );
      const targets = plan.frontier.map((candidate) => {
        const mapped = mappings.find(
          (entry) =>
            candidate.file === entry.source_root.replace(/\/+$/, "") ||
            candidate.file.startsWith(
              `${entry.source_root.replace(/\/+$/, "")}/`,
            ),
        );
        const pathParts = candidate.file.split("/");
        const conventionalService =
          pathParts[0] === "services" && pathParts.length > 2
            ? pathParts[1]
            : undefined;
        const inferred =
          conventionalService !== undefined &&
          serviceIds.has(conventionalService)
            ? conventionalService
            : undefined;
        const serviceId =
          mapped?.service_id ??
          inferred ??
          input.default_service_id ??
          plan.criterion.service_id;
        if (!serviceIds.has(serviceId)) {
          throw new AnalyzerClientError(
            `cannot map ${candidate.file} to an online service; add a service_map entry for its source root`,
          );
        }
        if (
          conventionalService !== undefined &&
          conventionalService !== plan.criterion.service_id &&
          mapped === undefined &&
          inferred === undefined &&
          input.default_service_id === undefined
        ) {
          throw new AnalyzerClientError(
            `candidate ${candidate.file} crossed into service ${conventionalService}, but no matching online service exists; add service_map`,
          );
        }
        return { candidate, serviceId };
      });
      const probes = await Promise.all(
        targets.map(async ({ candidate, serviceId }) => {
          const created = await createWithCommitWarning({
            serviceId,
            sourceCommit: plan.criterion.commit,
            type: "snapshot",
            file: candidate.file,
            line: candidate.line,
            watchPaths: candidate.watch_paths,
            hitLimit: input.hit_limit,
            ttlSeconds: input.ttl_seconds,
            createdBy: input.created_by,
            investigationId: plan.plan_id,
            candidateId: candidate.candidate_id,
            round: plan.round,
          });
          return {
            candidateId: candidate.candidate_id,
            probe: created.probe,
            ...(created.commitMismatch === undefined
              ? {}
              : { commitMismatch: created.commitMismatch }),
          };
        }),
      );
      return { planId: plan.plan_id, round: plan.round, probes };
    },
    async refine_probe_candidates(rawInput) {
      const input = RefineProbeCandidatesInputSchema.parse(rawInput);
      const listed = await client.listProbes();
      const investigationProbes = listed.probes
        .map((entry) => entry.probe)
        .filter((probe) => probe.investigationId === input.plan_id);
      const data = await Promise.all(
        investigationProbes.map((probe) =>
          client.getProbeData(probe.id, input.wait_seconds),
        ),
      );
      const occurrenceMap = new Map<
        string,
        {
          occurrenceId: string;
          correlated: boolean;
          events: Array<{
            candidateId?: string;
            probeId: string;
            event: Record<string, unknown>;
          }>;
        }
      >();
      for (const result of data) {
        for (const [index, event] of result.events.entries()) {
          const correlation =
            typeof event["correlation"] === "object" &&
            event["correlation"] !== null
              ? (event["correlation"] as Record<string, unknown>)
              : undefined;
          const traceId =
            correlation?.["quality"] === "exact-execution" &&
            typeof correlation["traceId"] === "string"
              ? correlation["traceId"]
              : undefined;
          const occurrenceId =
            traceId === undefined
              ? `uncorrelated:${result.probe.id}:${index}`
              : `trace:${traceId}`;
          const group =
            occurrenceMap.get(occurrenceId) ?? {
              occurrenceId,
              correlated: traceId !== undefined,
              events: [],
            };
          group.events.push({
            ...(result.probe.candidateId === undefined
              ? {}
              : { candidateId: result.probe.candidateId }),
            probeId: result.probe.id,
            event: event as Record<string, unknown>,
          });
          occurrenceMap.set(occurrenceId, group);
        }
      }
      const plan =
        input.assessments.length === 0
          ? await analyzer.getPlan(input.repository_root, input.plan_id)
          : analyzerPlanSchema.parse(
              await analyzer.run(input.repository_root, {
                command: "refine",
                planId: input.plan_id,
                assessments: input.assessments.map((assessment) => ({
                  candidateId: assessment.candidate_id,
                  classification: assessment.classification,
                  ...(assessment.occurrence_id === undefined
                    ? {}
                    : { occurrenceId: assessment.occurrence_id }),
                  ...(assessment.reason === undefined
                    ? {}
                    : { reason: assessment.reason }),
                })),
              }),
            );
      return {
        plan,
        occurrences: [...occurrenceMap.values()].sort((left, right) =>
          left.occurrenceId.localeCompare(right.occurrenceId),
        ),
      };
    },
    async start_probe_investigation(rawInput) {
      const input = StartProbeInvestigationInputSchema.parse(rawInput);
      return investigationViewSchema.parse(
        await analyzer.run(input.repository_root, {
          command: "start_investigation",
          criterion: {
            commit: input.commit_hash,
            serviceId: input.service_id,
            file: input.file,
            line: input.line,
            symptom: input.symptom,
            ...(input.watch_path === undefined
              ? {}
              : { watchPath: input.watch_path }),
            ...(input.expression === undefined
              ? {}
              : { expression: input.expression }),
            failureClass: input.failure_class,
            ...(input.expected_type === undefined
              ? {}
              : { expectedType: input.expected_type }),
            ...(input.minimum === undefined
              ? {}
              : { minimum: input.minimum }),
            ...(input.maximum === undefined
              ? {}
              : { maximum: input.maximum }),
            minimumExclusive: input.minimum_exclusive,
            maximumExclusive: input.maximum_exclusive,
            probeBudget: input.probe_budget,
            sourceRoots: input.source_roots,
            ownershipMap: input.ownership_map.map((entry) => ({
              sourceRoot: entry.source_root,
              serviceId: entry.service_id,
            })),
          },
        }),
      );
    },
    async get_investigation_context(rawInput) {
      const input = GetInvestigationInputSchema.parse(rawInput);
      return investigationViewSchema.parse(
        await analyzer.run(input.repository_root, {
          command: "get_investigation",
          investigationId: input.investigation_id,
          ...(input.since_revision === undefined
            ? {}
            : { sinceRevision: input.since_revision }),
          ...(input.focus_traversal_id === undefined
            ? {}
            : { focusTraversalId: input.focus_traversal_id }),
        }),
      );
    },
    async deploy_investigation_probes(rawInput) {
      const input = DeployInvestigationProbesInputSchema.parse(rawInput);
      const investigation = investigationViewSchema.parse(
        await analyzer.run(input.repository_root, {
          command: "get_investigation",
          investigationId: input.investigation_id,
        }),
      );
      const bundle = investigation.probe_bundle;
      if (bundle === null || bundle.sites.length === 0) {
        throw new AnalyzerClientError(
          "investigation has no deployable probe bundle",
        );
      }
      const commit = commitHashSchema.parse(investigation.criterion["commit"]);
      const services = await client.listServices();
      const serviceIds = new Set(
        services.services.map(({ serviceId }) => serviceId),
      );
      const targets = bundle.sites.map((site) => {
        const serviceId = site.service_id;
        if (!serviceIds.has(serviceId)) {
          throw new AnalyzerClientError(
            `traversal targets ${site.file} in offline service ${serviceId}; provide the deployed service in ownership_map when starting the investigation`,
          );
        }
        return { site, serviceId };
      });
      const probes = await Promise.all(
        targets.map(async ({ site, serviceId }) => {
          const created = await createWithCommitWarning({
            serviceId,
            sourceCommit: commit,
            type: "snapshot",
            file: site.file,
            line: site.line,
            watchPaths: site.watch_paths,
            hitLimit: input.hit_limit,
            ttlSeconds: input.ttl_seconds,
            createdBy: input.created_by,
            investigationId: investigation.investigation_id,
            candidateId: site.site_id,
            round: bundle.round,
          });
          return {
            siteId: site.site_id,
            probe: created.probe,
            ...(created.commitMismatch === undefined
              ? {}
              : { commitMismatch: created.commitMismatch }),
          };
        }),
      );
      return {
        investigationId: investigation.investigation_id,
        bundleId: bundle.bundle_id,
        round: bundle.round,
        probes,
        evidenceRequest: {
          investigationId: investigation.investigation_id,
          bundleId: bundle.bundle_id,
          round: bundle.round,
          replayRequired: true,
          occurrenceRole: "failing",
          correlation: "explicit-trace-occurrence",
        },
      };
    },
    async collect_investigation_evidence(rawInput) {
      const input = CollectInvestigationEvidenceInputSchema.parse(rawInput);
      const listed = await client.listProbes();
      const probes = listed.probes
        .map((entry) => entry.probe)
        .filter(
          (probe) => probe.investigationId === input.investigation_id,
        );
      const data = await Promise.all(
        probes.map((probe) =>
          client.getProbeData(probe.id, input.wait_seconds),
        ),
      );
      const occurrences = groupInvestigationOccurrences(data);
      const selections = new Map(
        input.occurrences.map((selection) => [
          selection.occurrence_id,
          selection,
        ]),
      );
      const observations: Array<Record<string, unknown>> = [];
      for (const occurrence of occurrences) {
        const selection = selections.get(occurrence.occurrenceId);
        if (selection === undefined) continue;
        if (!occurrence.correlated) {
          throw new AnalyzerClientError(
            `${occurrence.occurrenceId} is not explicitly correlated`,
          );
        }
        const orderedEvents = [...occurrence.events].sort((left, right) => {
          const sequence = (item: (typeof occurrence.events)[number]) => {
            const correlation =
              typeof item.event["correlation"] === "object" &&
              item.event["correlation"] !== null
                ? (item.event["correlation"] as Record<string, unknown>)
                : {};
            return typeof correlation["localHitSequence"] === "number"
              ? correlation["localHitSequence"]
              : Number.MAX_SAFE_INTEGER;
          };
          return sequence(left) - sequence(right);
        });
        const hitsByCandidate = new Map<string, number>();
        for (const [index, item] of orderedEvents.entries()) {
          if (
            item.candidateId === undefined ||
            item.event["type"] !== "snapshot" ||
            typeof item.event["watches"] !== "object" ||
            item.event["watches"] === null
          ) {
            continue;
          }
          const correlation =
            typeof item.event["correlation"] === "object" &&
            item.event["correlation"] !== null
              ? (item.event["correlation"] as Record<string, unknown>)
              : {};
          const capture =
            typeof item.event["capture"] === "object" &&
            item.event["capture"] !== null
              ? (item.event["capture"] as Record<string, unknown>)
              : {};
          const sequenceIndex =
            typeof correlation["localHitSequence"] === "number"
              ? correlation["localHitSequence"]
              : index + 1;
          const hitIndex =
            (hitsByCandidate.get(item.candidateId) ?? 0) + 1;
          hitsByCandidate.set(item.candidateId, hitIndex);
          observations.push({
            observationId: stableEvidenceId(
              input.investigation_id,
              occurrence.occurrenceId,
              item.candidateId,
              hitIndex,
            ),
            siteId: item.candidateId,
            occurrenceId: occurrence.occurrenceId,
            hitIndex,
            sequenceIndex,
            values: item.event["watches"],
            ...(typeof item.event["ts"] === "string"
              ? { timestamp: item.event["ts"] }
              : {}),
            ...(typeof correlation["serviceInstance"] === "string"
              ? { serviceInstance: correlation["serviceInstance"] }
              : {}),
            captureStatus:
              capture["status"] === "truncated" ? "truncated" : "complete",
          });
        }
      }
      const investigation =
        observations.length === 0
          ? investigationViewSchema.parse(
              await analyzer.run(input.repository_root, {
                command: "get_investigation",
                investigationId: input.investigation_id,
              }),
            )
          : investigationViewSchema.parse(
              await analyzer.run(input.repository_root, {
                command: "record_evidence",
                investigationId: input.investigation_id,
                observations,
              }),
            );
      return { investigation, occurrences };
    },
    async apply_investigation_decision(rawInput) {
      const input = ApplyInvestigationDecisionInputSchema.parse(rawInput);
      return investigationViewSchema.parse(
        await analyzer.run(input.repository_root, {
          command: "decide_investigation",
          investigationId: input.investigation_id,
          decision: {
            basedOnRevision: input.based_on_revision,
            actionIds: input.action_ids,
            ...(input.exploration_question === undefined
              ? {}
              : { explorationQuestion: input.exploration_question }),
            ...(input.candidate_mechanism === undefined
              ? {}
              : {
                  candidateMechanism: {
                    statement: input.candidate_mechanism.statement,
                    anchorNodeIds:
                      input.candidate_mechanism.anchor_node_ids,
                    traversalId:
                      input.candidate_mechanism.traversal_id,
                    predictions:
                      input.candidate_mechanism.predictions.map(
                        (prediction) => ({
                          probeCandidateId:
                            prediction.probe_candidate_id,
                          watchPath: prediction.watch_path,
                          operator: prediction.operator,
                          ...(prediction.expected_value === undefined
                            ? {}
                            : {
                                expectedValue:
                                  prediction.expected_value,
                              }),
                        }),
                      ),
                  },
                }),
            evidenceRefs: input.evidence_refs,
          },
        }),
      );
    },
    async get_investigation_result(rawInput) {
      const input = GetInvestigationInputSchema.parse(rawInput);
      return analyzer.run(input.repository_root, {
        command: "get_investigation_result",
        investigationId: input.investigation_id,
      });
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
        "Use a Clerk organization account with the role required by this tool.",
        "Ask an organization admin to update your role if access is expected.",
      ];
    } else if (error.status === 404) {
      checks = [
        "Refresh services or probes before retrying with the returned ID.",
      ];
    }
  } else if (error instanceof AnalyzerClientError) {
    code = "analysis_failed";
    message = error.message;
    checks = [
      "Install Python 3.12 and the liveprobe-analysis package beside the MCP server.",
      "Confirm repository_root is a Git checkout at commit_hash.",
      "Set LIVEPROBE_ANALYZER_PYTHON when Python 3.12 is not on PATH.",
    ];
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
  analyzer: AnalyzerClient = new AnalyzerRunner(),
): McpServer {
  const handlers = createToolHandlers(client, analyzer);
  const server = new McpServer({
    name: "liveprobe",
    version: "0.1.0",
  });

  server.registerTool(
    "set_snapshot_probe",
    {
      title: "Set snapshot probe",
      description: `${DEPLOYED_COMMIT_GUIDANCE} Use when you need local variables, selected watch paths, and a bounded stack from one source line. Snapshot probes default to one hit and never evaluate code in the target runtime.`,
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
      description: `${DEPLOYED_COMMIT_GUIDANCE} Use to add a temporary diagnostic log at a source line without redeploying. \${dot.path} placeholders are resolved from captured data; no target-runtime expression is evaluated.`,
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
      description: `${DEPLOYED_COMMIT_GUIDANCE} Use to aggregate count, sum, min, max, and last for one numeric dot path at a source line. Values are resolved read-only and pre-aggregated by the runtime agent.`,
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
        "List tenant-scoped probe and service-credential control events. This read-only tool requires the LiveProbe admin role and never returns bearer secrets or captured probe values.",
      inputSchema: ListAuditEventsInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => executeTool(() => handlers.list_audit_events(input)),
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
  server.registerTool(
    "prepare_repository_analysis",
    {
      title: "Prepare Python data-flow index",
      description:
        "Incrementally cache function-local CFG, def-use, and hammock fragments for the checked-out deployed Python revision. The analyzer runs locally beside this MCP server, never in the target service.",
      inputSchema: PrepareRepositoryAnalysisInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      executeTool(() => handlers.prepare_repository_analysis(input)),
  );
  server.registerTool(
    "start_probe_investigation",
    {
      title: "Start runtime-guided Python investigation",
      description:
        "Create a persistent, reversible causal investigation at an exact deployed Python revision. ownership_map establishes service transitions for runtime traversals while canonical source regions remain shared.",
      inputSchema: StartProbeInvestigationInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      executeTool(() => handlers.start_probe_investigation(input)),
  );
  server.registerTool(
    "get_investigation_context",
    {
      title: "Get bounded investigation context",
      description:
        "Return a revisioned, source-free decision packet containing focused region deltas, runtime traversal breadcrumbs, new failing evidence, and legal frontier actions.",
      inputSchema: GetInvestigationInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      executeTool(() => handlers.get_investigation_context(input)),
  );
  server.registerTool(
    "deploy_investigation_probes",
    {
      title: "Deploy investigation probe bundle",
      description:
        "Deploy the current immutable runtime-guided probe bundle to the authoritative service IDs carried by its traversal-aware probe sites.",
      inputSchema: DeployInvestigationProbesInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) =>
      executeTool(() => handlers.deploy_investigation_probes(input)),
  );
  server.registerTool(
    "collect_investigation_evidence",
    {
      title: "Collect correlated investigation evidence",
      description:
        "Group captures only by exact propagated occurrence identity and record one selected failing replay occurrence into the investigation ledger.",
      inputSchema: CollectInvestigationEvidenceInputSchema,
      annotations: { readOnlyHint: false },
    },
    async (input) =>
      executeTool(() => handlers.collect_investigation_evidence(input)),
  );
  server.registerTool(
    "apply_investigation_decision",
    {
      title: "Apply AI-SRE investigation decision",
      description:
        "Apply revision-scoped compiler-supplied frontier actions. Exploration needs no hypothesis; a structured candidate mechanism is accepted only for final confirmation.",
      inputSchema: ApplyInvestigationDecisionInputSchema,
      annotations: { readOnlyHint: false },
    },
    async (input) =>
      executeTool(() => handlers.apply_investigation_decision(input)),
  );
  server.registerTool(
    "get_investigation_result",
    {
      title: "Get evidence-backed investigation result",
      description:
        "Return terminal or in-progress status, confirmed candidate mechanism, coverage gaps, decisions, and performance statistics.",
      inputSchema: GetInvestigationInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      executeTool(() => handlers.get_investigation_result(input)),
  );
  server.registerTool(
    "analyze_probe_candidates",
    {
      title: "Analyze deterministic probe candidates",
      description:
        "Compute a demand-driven backward slice from a manifestation value, group it into hammock blocks, and return a bounded frontier of probeable locations with explicit uncertainty.",
      inputSchema: AnalyzeProbeCandidatesInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      executeTool(() => handlers.analyze_probe_candidates(input)),
  );
  server.registerTool(
    "deploy_probe_frontier",
    {
      title: "Deploy deterministic probe frontier",
      description:
        "Create ordinary bounded snapshot probes for the current analysis frontier. service_map maps source-directory prefixes to online runtime service IDs.",
      inputSchema: DeployProbeFrontierInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) =>
      executeTool(() => handlers.deploy_probe_frontier(input)),
  );
  server.registerTool(
    "refine_probe_candidates",
    {
      title: "Refine probe candidates",
      description:
        "Group investigation captures only by explicit occurrence correlation and, when assessments are supplied, prune the deterministic slice into the next frontier or a localized/insufficient verdict.",
      inputSchema: RefineProbeCandidatesInputSchema,
      annotations: { readOnlyHint: false },
    },
    async (input) =>
      executeTool(() => handlers.refine_probe_candidates(input)),
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
