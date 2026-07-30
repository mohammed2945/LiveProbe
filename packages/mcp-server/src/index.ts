import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export const LIVEPROBE_AGENT_SKILL_VERSION = "liveprobe-investigation/v1.2";
export const LIVEPROBE_DECISION_PROTOCOL = "liveprobe-adaptive-v2";
export const INVESTIGATION_ACTION_KINDS = [
  "FOLLOW_PATH",
  "PROBE_REGION",
  "INSPECT_MECHANISM",
  "CONFIRM_CANDIDATE",
  "COMPLETE_LOCALIZATION",
  "HANDOFF_BOUNDARY",
] as const;

/**
 * How much of the investigation view a tool returns.
 *
 * A tool response is never prompt-cacheable, so every byte one returns is
 * charged as fresh input on the turn that reads it and again on every later
 * turn that keeps it in context. The investigation view mixes two things with
 * very different value per byte:
 *
 * - a decision surface — identifiers, the legal `actions` menu, the immutable
 *   `probe_bundle`, correlated `value_dossiers`, `judgments`, the bounded
 *   `decision_context` packet and its `decision_aliases` — which the caller
 *   must have to select a legal next action; and
 * - `graph`, a structural dump of the analyzer's focused nodes, edges,
 *   projections and runtime traversals, which no tool accepts as input and
 *   which grows with analysis depth rather than with decision complexity.
 *
 * Measured on an ordinary three-module Python service, `graph` is 80-90% of the
 * view and its `projections` sub-object alone is roughly two thirds; the whole
 * decision surface fits in a few kilobytes. `compact` therefore replaces
 * `graph` with a `graph_summary` of counts and returns everything else intact.
 * Nothing removed is accepted by any tool input, so a caller can run an entire
 * investigation on the compact view. `full` restores `graph` unchanged for a
 * caller that renders it.
 */
export const INVESTIGATION_VIEW_DETAIL_LEVELS = ["compact", "full"] as const;

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
  service_id: serviceIdSchema.describe(
    "Exact serviceId returned by list_services, for example pricing-api",
  ),
  commit_hash: commitHashSchema.describe(
    "Exact deployed Git SHA supplied by observability or the operator, for example 9f41a7c2; audit metadata, not runtime proof",
  ),
  file: sourceFileSchema.describe(
    "Source path as reported by the target runtime, for example services/pricing/app.py",
  ),
  line: z
    .number()
    .int()
    .positive()
    .describe("One-based executable source line, for example 74"),
  condition: McpConditionSchema.optional().describe(
    "Optional read-only post-capture condition; no target code is evaluated",
  ),
  correlation_trace_id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Optional exact trace identity supplied by observability or a prepared replay. Python runtimes discard unrelated requests before safety limits are charged; never invent this value.",
    ),
  hit_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum captures before suspension, for example 1"),
  ttl_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .default(1_800)
    .describe("Seconds before automatic expiry, for example 300"),
  created_by: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .default("mcp:liveprobe")
    .describe("Audit actor label, for example codex:incident-42"),
} as const;

export const SetSnapshotProbeInputSchema = z
  .object({
    ...commonInputShape,
    watch_paths: z
      .array(dotPathSchema)
      .max(100)
      .optional()
      .describe(
        "Read-only variable paths visible at the line, for example [quote.total, user.tier]",
      ),
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
        "Text with read-only ${dot.path} placeholders, for example total=${quote.total}",
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
      "Numeric variable path visible at the line, for example quote.total",
    ),
  })
  .strict();

export const ListServicesInputSchema = z.object({}).strict();
export const PingBrokerInputSchema = z.object({}).strict();
export const GetSafetyOverviewInputSchema = z.object({}).strict();
export const ListAuditEventsInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(50)
      .describe("Maximum events to return, for example 25"),
    before: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(
        "Return events before this cursor timestamp, for example 2026-07-28T18:30:00Z",
      ),
  })
  .strict();
export const ListProbesInputSchema = z
  .object({
    service_id: serviceIdSchema
      .optional()
      .describe(
        "Optional exact serviceId from list_services, for example pricing-api",
      ),
  })
  .strict();
export const GetProbeDataInputSchema = z
  .object({
    probe_id: probeIdSchema.describe(
      "Exact probe.id returned by a set/deploy/list tool, for example prb_01JAZM3Y6S8X2V4K9N7Q1T5WCE",
    ),
    wait_seconds: z
      .number()
      .finite()
      .min(0)
      .max(30)
      .optional()
      .default(5)
      .describe(
        "Long-poll duration; returns immediately when retained data already exists. Defaults to a short wait because a probe armed moments ago has usually not been hit yet, and returning empty forces another round trip. Pass 0 for a non-blocking peek.",
      ),
  })
  .strict();
export const RemoveProbeInputSchema = z
  .object({
    probe_id: probeIdSchema.describe(
      "Exact probe.id returned by a set/deploy/list tool, for example prb_01JAZM3Y6S8X2V4K9N7Q1T5WCE",
    ),
  })
  .strict();

const repositoryRootSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .describe(
    "Absolute local Git checkout containing the deployed Python revision, for example /workspace/riderush",
  );

export const PrepareRepositoryAnalysisInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    commit_hash: commitHashSchema.describe(
      "Exact deployed Git SHA to index, for example 9f41a7c2",
    ),
  })
  .strict();

export const AnalyzeProbeCandidatesInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    commit_hash: commitHashSchema.describe(
      "Exact deployed Git SHA, for example 9f41a7c2",
    ),
    service_id: serviceIdSchema.describe(
      "Exact serviceId returned by list_services, for example gateway-api",
    ),
    file: sourceFileSchema.describe(
      "Repository-relative criterion file, for example services/gateway/app.py",
    ),
    line: z
      .number()
      .int()
      .positive()
      .describe("One-based criterion line, for example 83"),
    watch_path: dotPathSchema
      .optional()
      .describe("Criterion value path, for example pricing.quote"),
    expression: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .optional()
      .describe("Criterion source expression, for example pricing.quote(order)"),
    probe_budget: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .default(5)
      .describe("Maximum frontier sites per round, for example 5"),
    source_roots: z
      .array(z.string().trim().min(1).max(4_096))
      .max(50)
      .optional()
      .default([])
      .describe(
        "Repository-relative Python source roots, for example [services]",
      ),
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
    source_root: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .describe("Source prefix from prior analysis output, for example services/pricing"),
    service_id: serviceIdSchema.describe(
      "Exact runtime serviceId from list_services, for example pricing-api",
    ),
  })
  .strict();

export const DeployProbeFrontierInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    plan_id: investigationIdSchema.describe(
      "Exact plan_id returned by analyze_probe_candidates",
    ),
    service_map: z
      .array(serviceMapEntrySchema)
      .max(100)
      .optional()
      .default([])
      .describe("Maps analyzed source prefixes to list_services service IDs"),
    default_service_id: serviceIdSchema
      .optional()
      .describe("Fallback exact serviceId from list_services"),
    ttl_seconds: z
      .number()
      .int()
      .positive()
      .optional()
      .default(300)
      .describe("Seconds before deployed frontier probes expire, for example 300"),
    hit_limit: z
      .number()
      .int()
      .positive()
      .optional()
      .default(1)
      .describe("Captures allowed per deployed site, normally 1"),
    created_by: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .default("mcp:liveprobe-analysis")
      .describe("Audit actor label, for example codex:incident-42"),
  })
  .strict();

const candidateAssessmentSchema = z
  .object({
    candidate_id: candidateIdSchema.describe(
      "Exact candidate_id returned by the current legacy frontier",
    ),
    classification: z
      .enum(["good", "bad", "unknown"])
      .describe("Verdict supported by captured evidence"),
    occurrence_id: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("Exact correlated event occurrence ID, for example trace:replay-42"),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .optional()
      .describe("Short evidence-based rationale, for example total became negative"),
  })
  .strict();

export const RefineProbeCandidatesInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    plan_id: investigationIdSchema.describe(
      "Exact plan_id returned by analyze_probe_candidates",
    ),
    assessments: z
      .array(candidateAssessmentSchema)
      .max(100)
      .optional()
      .default([])
      .describe("Assess only candidates from the current returned frontier"),
    wait_seconds: z
      .number()
      .finite()
      .min(0)
      .max(30)
      .optional()
      .default(0)
      .describe("Seconds to long-poll for capture data, for example 10"),
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
const investigationDetailSchema = z
  .enum(INVESTIGATION_VIEW_DETAIL_LEVELS)
  .optional()
  .default("compact")
  .describe(
    "compact (default) returns the decision surface — ids, phase, revision, actions, probe_bundle, dossiers, judgments, decision_context, decision_aliases, stats — and replaces the structural graph with graph_summary counts. full additionally returns graph nodes, edges, projections and runtime traversals; ask for it only to render or audit the graph, never to choose an action.",
  );

const serviceSelectionSchema = z
  .object({
    source_root: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .describe(
        "Repository-relative source prefix, for example services/pricing",
      ),
    service_id: serviceIdSchema.describe(
      "Exact runtime serviceId returned by list_services, for example pricing-api",
    ),
  })
  .strict();

export const StartProbeInvestigationInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    commit_hash: commitHashSchema.describe(
      "Exact deployed Git SHA supplied by observability or the operator, for example 9f41a7c2",
    ),
    service_id: serviceIdSchema.describe(
      "Starting exact serviceId returned by list_services, for example gateway-api",
    ),
    file: sourceFileSchema.describe(
      "Repository-relative criterion file identified from observability, for example services/gateway/app.py",
    ),
    line: z
      .number()
      .int()
      .positive()
      .describe("One-based executable criterion line, for example 83"),
    symptom: z
      .string()
      .trim()
      .min(1)
      .max(16_000)
      .describe(
        "Observed failure for the selected occurrence, for example fare total is negative on trace ride-42",
      ),
    watch_path: dotPathSchema
      .optional()
      .describe(
        "Starting value path identified at the criterion, for example pricing.quote",
      ),
    expression: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .optional()
      .describe(
        "Starting source expression when a dot path is unavailable, for example pricing.quote(order)",
      ),
    failure_class: failureClassSchema
      .optional()
      .default("semantic")
      .describe(
        "Mechanical oracle class; use semantic when correctness requires a pre-registered hypothesis",
      ),
    expected_type: expectedTypeSchema
      .optional()
      .describe("Expected runtime shape for type_shape, for example numeric"),
    minimum: z
      .number()
      .finite()
      .optional()
      .describe("Inclusive lower domain bound, for example 0"),
    maximum: z
      .number()
      .finite()
      .optional()
      .describe("Inclusive upper domain bound, for example 10000"),
    minimum_exclusive: z
      .boolean()
      .optional()
      .default(false)
      .describe("Whether the minimum bound is strict"),
    maximum_exclusive: z
      .boolean()
      .optional()
      .default(false)
      .describe("Whether the maximum bound is strict"),
    probe_budget: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .default(5)
      .describe("Maximum canonical probe sites per round, for example 5"),
    source_roots: z
      .array(z.string().trim().min(1).max(4_096))
      .max(50)
      .optional()
      .default([])
      .describe(
        "Repository-relative Python source roots, for example [services]",
      ),
    ownership_map: z
      .array(serviceSelectionSchema)
      .max(100)
      .optional()
      .default([])
      .describe(
        "Source-root to runtime-service mappings using service IDs from list_services",
      ),
    detail: investigationDetailSchema,
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
    investigation_id: investigationIdSchema.describe(
      "Exact investigation_id returned by start_probe_investigation",
    ),
    since_revision: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "A prior response revision; unchanged state may return a compact delta",
      ),
    focus_traversal_id: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Exact traversal_id from graph.runtimeTraversals, or the value behind a decision_aliases.traversals alias; do not pass a short alias such as t1",
      ),
    detail: investigationDetailSchema,
  })
  .strict();

export const GetInvestigationResultInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    investigation_id: investigationIdSchema.describe(
      "Exact investigation_id returned by start_probe_investigation",
    ),
  })
  .strict();

export const DeployInvestigationProbesInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    investigation_id: investigationIdSchema.describe(
      "Exact investigation_id returned by start_probe_investigation",
    ),
    service_map: z
      .array(serviceSelectionSchema)
      .max(100)
      .optional()
      .default([])
      .describe(
        "Compatibility-only field; persistent investigation bundles ignore overrides and use canonical site service IDs established by start ownership_map",
      ),
    default_service_id: serviceIdSchema
      .optional()
      .describe(
        "Compatibility-only field ignored for persistent bundles; canonical site service IDs are authoritative",
      ),
    ttl_seconds: z
      .number()
      .int()
      .positive()
      .optional()
      .default(300)
      .describe("Seconds before the current bundle expires, for example 300"),
    hit_limit: z
      .number()
      .int()
      .positive()
      .optional()
      .default(1)
      .describe("Captures per canonical site, normally 1 for a replay"),
    correlation_trace_id: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "Optional exact trace identity supplied by observability or a prepared replay, for example 4c010000000000000000000000000001. On Python runtimes, unrelated requests are discarded before probe safety limits are charged; never invent this value.",
      ),
    created_by: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .default("mcp:liveprobe-investigation")
      .describe("Audit actor label, for example codex:incident-42"),
  })
  .strict();

const occurrenceSelectionSchema = z
  .object({
    occurrence_id: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        "Exact propagated identity for the failing replay, for example trace:investigation-semantic-fail-2",
      ),
  })
  .strict();

export const CollectInvestigationEvidenceInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    investigation_id: investigationIdSchema.describe(
      "Exact investigation_id returned by start_probe_investigation",
    ),
    occurrences: z
      .array(occurrenceSelectionSchema)
      .max(1)
      .optional()
      .default([])
      .describe(
        "Zero or one failing occurrence selected by exact propagated identity; never synthesize this ID",
      ),
    wait_seconds: z
      .number()
      .finite()
      .min(0)
      .max(30)
      .optional()
      .default(0)
      .describe("Seconds to long-poll for matching captures, for example 10"),
    detail: investigationDetailSchema,
  })
  .strict();

const candidatePredictionSchema = z
  .object({
    probe_candidate_id: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        "Exact probe candidate ID supplied by the current mechanism_context",
      ),
    watch_path: dotPathSchema.describe(
      "Exact watch path supplied for that probe candidate",
    ),
    operator: z
      .enum(["eq", "ne", "truthy", "falsy", "present"])
      .describe("Pre-registered comparison for the fresh confirmation replay"),
    expected_value: z
      .unknown()
      .optional()
      .describe("Expected JSON value when required by eq or ne"),
  })
  .strict();

const candidateMechanismSchema = z
  .object({
    statement: z
      .string()
      .trim()
      .min(1)
      .max(4_000)
      .describe("Falsifiable mechanism statement, for example surge_poison is true"),
    anchor_node_ids: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(8)
      .describe(
        "Exact canonical node IDs supplied by mechanism_context.statements",
      ),
    traversal_id: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("Exact traversal ID supplied by mechanism_context"),
    predictions: z
      .array(candidatePredictionSchema)
      .min(1)
      .max(9)
      .describe(
        "One or more pre-registered predictions using supplied mechanism probe candidates",
      ),
  })
  .strict();

export const ApplyInvestigationDecisionInputSchema = z
  .object({
    repository_root: repositoryRootSchema,
    investigation_id: investigationIdSchema.describe(
      "Exact investigation_id returned by start_probe_investigation",
    ),
    based_on_revision: z
      .number()
      .int()
      .positive()
      .describe("Exact revision from the current investigation response"),
    action_ids: z
      .array(z.string().trim().min(1))
      .max(2)
      .describe(
        "Zero to two exact action_id values from the current actions menu; never construct IDs",
      ),
    exploration_question: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .optional()
      .describe("Optional question describing what the selected legal action tests"),
    candidate_mechanism: candidateMechanismSchema
      .optional()
      .describe(
        "Only for CONFIRM_CANDIDATE; all anchors, traversal, and probe candidates must come from mechanism_context",
      ),
    evidence_refs: z
      .array(z.string().trim().min(1).max(500))
      .max(100)
      .optional()
      .default([])
      .describe(
        "For completion, exact observation IDs from EVIDENCE_RECORDED decision_log events",
      ),
    detail: investigationDetailSchema,
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
  correlationTraceId: z.string().trim().min(1).max(128).optional(),
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
  correlationTraceId?: string;
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
    kind: z.enum(INVESTIGATION_ACTION_KINDS),
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

export type InvestigationViewDetail =
  (typeof INVESTIGATION_VIEW_DETAIL_LEVELS)[number];

export interface InvestigationGraphSummary {
  detail: "compact";
  focus_nodes: number;
  focus_edges: number;
  collapsed_functions: number;
  runtime_traversals: { total: number; returned: number };
  unresolved_branches: number;
  manifestation_traversal_id: string | null;
  full_graph: string;
}

/**
 * A view as returned to a caller: `graph` is present only at `full` detail and
 * `graph_summary` only at `compact` detail. Declaring both optional keeps one
 * type for both projections, so callers that read the decision surface need no
 * narrowing.
 */
export type ProjectedInvestigationView = Omit<InvestigationView, "graph"> & {
  graph?: InvestigationView["graph"];
  graph_summary?: InvestigationGraphSummary;
};

const GRAPH_DETAIL_HINT =
  'omitted at detail="compact"; re-request the same tool, or get_investigation_context, with detail="full" for nodes, edges, projections and runtime traversals';

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

/**
 * Projects an investigation view to the requested detail level.
 *
 * `compact` drops exactly one field, `graph`, and replaces it with counts. No
 * tool accepts a graph node, edge, projection or traversal record as input:
 * action IDs come from `actions`, probe sites from `probe_bundle`, mechanism
 * anchors and probe candidates from `mechanism_context`, traversal IDs from
 * `mechanism_context` or `decision_aliases.traversals`, and completion
 * observation IDs from `decision_log` and `value_dossiers`. Every one of those
 * fields is retained, so the compact view is sufficient to drive the loop to a
 * terminal status.
 */
export function projectInvestigationView(
  view: InvestigationView,
  detail: InvestigationViewDetail,
): ProjectedInvestigationView {
  if (detail === "full") return view;
  const { graph, ...rest } = view;
  const summary =
    typeof graph["runtimeTraversalSummary"] === "object" &&
    graph["runtimeTraversalSummary"] !== null
      ? (graph["runtimeTraversalSummary"] as Record<string, unknown>)
      : {};
  const manifestation = graph["manifestationTraversalId"];
  return {
    ...rest,
    graph_summary: {
      detail: "compact",
      focus_nodes: arrayLength(graph["nodes"]),
      focus_edges: arrayLength(graph["edges"]),
      collapsed_functions: arrayLength(graph["collapsedFunctions"]),
      runtime_traversals: {
        total: integerOr(
          summary["total"],
          arrayLength(graph["runtimeTraversals"]),
        ),
        returned: integerOr(
          summary["returned"],
          arrayLength(graph["runtimeTraversals"]),
        ),
      },
      unresolved_branches: integerOr(graph["unresolvedBranches"], 0),
      manifestation_traversal_id:
        typeof manifestation === "string" ? manifestation : null,
      full_graph: GRAPH_DETAIL_HINT,
    },
  };
}

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
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}

export class BrokerClient {
  /**
   * Statuses that mean "the broker is not answering right now" rather than
   * "the request was wrong". A broker that is restarting, or a proxy or
   * port-forward that has not finished reattaching, produces these.
   */
  private static readonly retryableStatuses: ReadonlySet<number> = new Set([
    502, 503, 504,
  ]);

  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly apiKey: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;

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
    // Five attempts at 300ms exponential backoff spans roughly 4.5 seconds of
    // outage. The failure this exists for is a broker that is restarting, or a
    // proxy or port-forward reattaching to a replacement pod, and those take
    // seconds. An earlier 3-attempt/150ms window totalled under half a second
    // and was too short to survive one: campaign r11 still lost 5 of 16
    // LiveProbe calls to `broker_unreachable`, and an arm that loses its first
    // call abandons LiveProbe for the rest of the incident.
    this.maxAttempts = options.maxAttempts ?? 5;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new RangeError("maxAttempts must be a positive safe integer");
    }
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 300;
    if (
      !Number.isSafeInteger(this.retryBaseDelayMs) ||
      this.retryBaseDelayMs < 0
    ) {
      throw new RangeError(
        "retryBaseDelayMs must be a non-negative safe integer",
      );
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
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}${path}`,
      {
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
      },
      { idempotent: method === "GET" },
    );
    if (!response.ok) {
      throw await this.toClientError(response);
    }
    return schema.parse(await response.json());
  }

  private async requestNoContent(
    method: "DELETE",
    path: string,
  ): Promise<void> {
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}${path}`,
      {
        method,
        headers: {
          accept: "application/json",
          ...(this.apiKey === undefined
            ? {}
            : { authorization: `Bearer ${this.apiKey}` }),
        },
      },
      { idempotent: true },
    );
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

  /**
   * A transport-layer failure: the request never produced an HTTP response.
   * `fetch` reports these as `TypeError`, and our own timeout surfaces as an
   * `AbortError`. Neither tells us the broker rejected the request, so an
   * idempotent call is safe to repeat.
   */
  private static isTransportFailure(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.name === "AbortError" ||
        error.name === "TypeError" ||
        error.name === "FetchError")
    );
  }

  private async delay(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return;
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, milliseconds);
    });
  }

  /**
   * Retries only when the method is idempotent and the failure is transient.
   * A broker restart, or a port-forward or proxy that has not finished
   * reattaching, otherwise surfaces to the caller as a hard tool error even
   * though repeating the request would have succeeded. Probe creation is a
   * POST and is never retried, so a retry can never deploy a second probe.
   */
  private async fetchWithTimeout(
    input: string,
    init: RequestInit,
    { idempotent }: { idempotent: boolean },
  ): Promise<Response> {
    const attempts = idempotent ? this.maxAttempts : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.requestTimeoutMs,
      );
      timeout.unref();
      try {
        const response = await this.fetchImplementation(input, {
          ...init,
          signal: controller.signal,
        });
        if (
          attempt < attempts &&
          BrokerClient.retryableStatuses.has(response.status)
        ) {
          lastError = new BrokerClientError(
            `broker request failed with HTTP ${response.status}`,
            response.status,
          );
          await this.delay(this.retryBaseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        return response;
      } catch (error: unknown) {
        lastError = error;
        if (
          attempt >= attempts ||
          !BrokerClient.isTransportFailure(error)
        ) {
          throw error;
        }
        await this.delay(this.retryBaseDelayMs * 2 ** (attempt - 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
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
  ): Promise<ProjectedInvestigationView>;
  get_investigation_context(
    input: z.input<typeof GetInvestigationInputSchema>,
  ): Promise<ProjectedInvestigationView>;
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
    investigation: ProjectedInvestigationView;
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
  ): Promise<ProjectedInvestigationView>;
  get_investigation_result(
    input: z.input<typeof GetInvestigationResultInputSchema>,
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
  correlation_trace_id?: string | undefined;
  hit_limit?: number | undefined;
}): {
  condition?: BrokerCondition;
  correlationTraceId?: string;
  hitLimit?: number;
} {
  return {
    ...(input.condition === undefined
      ? {}
      : { condition: input.condition }),
    ...(input.correlation_trace_id === undefined
      ? {}
      : { correlationTraceId: input.correlation_trace_id }),
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
      return projectInvestigationView(
        investigationViewSchema.parse(
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
        ),
        input.detail,
      );
    },
    async get_investigation_context(rawInput) {
      const input = GetInvestigationInputSchema.parse(rawInput);
      return projectInvestigationView(
        investigationViewSchema.parse(
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
        ),
        input.detail,
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
      const servicesById = new Map(
        services.services.map((service) => [service.serviceId, service]),
      );
      const targets = bundle.sites.map((site) => {
        const serviceId = site.service_id;
        const service = servicesById.get(serviceId);
        if (service === undefined) {
          throw new AnalyzerClientError(
            `traversal targets ${site.file} in offline service ${serviceId}; provide the deployed service in ownership_map when starting the investigation`,
          );
        }
        if (
          input.correlation_trace_id !== undefined &&
          service.sdk !== "python"
        ) {
          throw new AnalyzerClientError(
            `correlation_trace_id requires service ${serviceId} to report sdk=python; omit the filter or use a runtime that supports exact trace filtering`,
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
            ...(input.correlation_trace_id === undefined
              ? {}
              : { correlationTraceId: input.correlation_trace_id }),
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
          ...(input.correlation_trace_id === undefined
            ? {}
            : { correlationTraceId: input.correlation_trace_id }),
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
      return {
        investigation: projectInvestigationView(investigation, input.detail),
        occurrences,
      };
    },
    async apply_investigation_decision(rawInput) {
      const input = ApplyInvestigationDecisionInputSchema.parse(rawInput);
      return projectInvestigationView(
        investigationViewSchema.parse(
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
        ),
        input.detail,
      );
    },
    async get_investigation_result(rawInput) {
      const input = GetInvestigationResultInputSchema.parse(rawInput);
      return analyzer.run(input.repository_root, {
        command: "get_investigation_result",
        investigationId: input.investigation_id,
      });
    },
  };
}

/**
 * Successful results are serialized without indentation.
 *
 * The indentation carries no information, but it is charged twice: once as
 * spaces and newlines inside the text block, and again because those newlines
 * are escaped when the block is embedded in the JSON-RPC response. Measured on
 * a compact investigation view it added 66% to the bytes on the wire, and tool
 * responses are never prompt-cacheable, so that overhead is re-charged on every
 * turn that keeps the response in context. Error results stay indented: they
 * are small, rare, and read by humans debugging a failed call.
 */
function toolResult(value: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
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
    message = error.message;
    const normalizedMessage = error.message.toLowerCase();
    if (normalizedMessage.includes("stale investigation decision")) {
      code = "stale_revision";
      retryable = true;
      checks = [
        "Call get_investigation_context and copy its latest revision.",
        "Choose only action_id values present in that refreshed actions menu.",
      ];
    } else if (
      normalizedMessage.includes("not available") ||
      normalizedMessage.includes("unknown action") ||
      normalizedMessage.includes("illegal action")
    ) {
      code = "illegal_action";
      checks = [
        "Call get_investigation_context and select an exact current action_id.",
        "Do not construct, repair, or reuse an action ID from an older revision.",
      ];
    } else if (
      normalizedMessage.includes("budget") ||
      normalizedMessage.includes("at most 2 actions") ||
      normalizedMessage.includes("at most 9")
    ) {
      code = "budget_exceeded";
      checks = [
        "Choose a smaller current legal frontier or fewer confirmation predictions.",
        "Use observability only to rank the returned legal options.",
      ];
    } else {
      code = "analysis_failed";
      checks = [
        "Install Python 3.12 and the liveprobe-analysis package beside the MCP server.",
        "Confirm repository_root is a Git checkout containing commit_hash.",
        "Set LIVEPROBE_ANALYZER_PYTHON when Python 3.12 is not on PATH.",
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

const MANUAL_PROBE_SCOPE =
  "This is a manual diagnostic probe: supply a known service, deployed commit, and source location. Do not use it to deploy a persistent investigation bundle; use deploy_investigation_probes, whose canonical sites are authoritative.";

export interface CreateMcpServerOptions {
  /**
   * Expose the superseded `analyze_probe_candidates` /
   * `deploy_probe_frontier` / `refine_probe_candidates` trio.
   *
   * Off by default. Every registered tool's name, description and input schema
   * is re-sent on every model turn, and these three are 5,987 of the 37,137
   * bytes the full surface costs — 16% spent describing tools whose own
   * descriptions tell the caller to use the investigation tools instead.
   * Offering a deprecated path beside its replacement also invites callers to
   * take it and spend turns on the wrong protocol.
   *
   * The handlers remain available through `createToolHandlers` regardless, so
   * a client that already drives the legacy protocol directly is unaffected.
   */
  includeLegacyTools?: boolean;
}

export function createMcpServer(
  client: BrokerClient,
  analyzer: AnalyzerClient = new AnalyzerRunner(),
  options: CreateMcpServerOptions = {},
): McpServer {
  const includeLegacyTools = options.includeLegacyTools ?? false;
  const handlers = createToolHandlers(client, analyzer);
  const server = new McpServer({
    name: "liveprobe",
    version: "0.1.0",
  });

  server.registerTool(
    "set_snapshot_probe",
    {
      title: "Set snapshot probe",
      description: `${MANUAL_PROBE_SCOPE} Creates a bounded snapshot of locals, selected watch paths, and stack frames at one line. Returns {probe}; copy probe.id into get_probe_data or remove_probe.`,
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
      description: `${MANUAL_PROBE_SCOPE} Creates a temporary log whose \${dot.path} placeholders are read from captured variables without evaluating target code. Returns {probe}; copy probe.id into get_probe_data or remove_probe.`,
      inputSchema: SetLogProbeInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => executeTool(() => handlers.set_log_probe(input)),
  );
  server.registerTool(
    "set_counter_probe",
    {
      title: "Set counter probe",
      description: `${MANUAL_PROBE_SCOPE} Counts executions of one source line and pre-aggregates hot-path hits. Returns {probe}; copy probe.id into get_probe_data or remove_probe.`,
      inputSchema: SetCounterProbeInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => executeTool(() => handlers.set_counter_probe(input)),
  );
  server.registerTool(
    "set_metric_probe",
    {
      title: "Set metric probe",
      description: `${MANUAL_PROBE_SCOPE} Aggregates count, sum, min, max, and last for one numeric variable path without evaluating target code. Returns {probe}; copy probe.id into get_probe_data or remove_probe.`,
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
        "Returns {services:[{serviceId,sdk,commitSha,lastSeen,agentStatus}]} for runtimes recently seen by the broker. Copy serviceId values into probe or investigation service fields; an empty list means no runtime is currently registered.",
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
        "Performs a cheap authenticated broker connectivity check and returns {ok:true}. It does not prove a target service is online; use list_services for service discovery.",
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
        "Returns per-service online state, runtime-agent health, probe status counts, and capture-semantics caveats. It is read-only and does not replace list_services when an exact serviceId is needed.",
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
        "Returns {events:[...]} for tenant-scoped probe and service-credential control actions, newest first. Requires the LiveProbe admin role; it never returns secrets or captured runtime values.",
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
        "Returns {probes:[{probe,status}]} for current probe definitions and latest states, optionally filtered by an exact serviceId. Use returned probe.id with get_probe_data or remove_probe; this does not create or redeploy probes.",
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
        "Returns {probe,status,events} for an exact probe.id from a set, deploy, or list response. wait_seconds may long-poll up to 30 seconds; empty events require checking arm state, reachability, runtime path, and replay correlation rather than assuming a value was absent.",
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
        "Idempotently removes the exact probe.id returned by a prior tool; runtime agents uninstall it on their next poll. It removes one probe only and does not delete an investigation or its evidence ledger.",
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
        "Builds or refreshes the local CFG, def-use, call, and region index for repository_root at commit_hash and returns preparation statistics. The checkout must contain that exact deployed revision; this performs no runtime capture and must precede a new persistent investigation.",
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
        `Creates a persistent investigation from an observability-derived service, file, line, value, and failure criterion at an exact deployed Python commit. Returns {investigation_id,revision,phase,probe_bundle,actions,decision_context,graph_summary}; actions and bundle sites are legal menus, not templates. detail defaults to compact, which is sufficient to run the whole loop; pass detail=full only to render the structural graph. Requires prepared analysis and must not be used for cold incident discovery. Skill ${LIVEPROBE_AGENT_SKILL_VERSION}; decision protocol ${LIVEPROBE_DECISION_PROTOCOL}.`,
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
        "Returns the latest revisioned investigation view: phase/status, correlated dossiers, immutable probe_bundle, legal actions, deferred-frontier counts, and mechanism context. Call it after start or any stale_revision/illegal_action rejection; copy revision and current action_id values exactly. detail defaults to compact and carries graph_summary counts instead of the graph; this is the tool to call with detail=full when the structural graph itself is needed.",
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
        "Deploys every site in the investigation's current immutable probe_bundle and returns the created probes with canonical site metadata. The investigation must exist and expose a nonempty bundle; never substitute model-created file/line/watch paths. correlation_trace_id, when copied from observability or a prepared replay, filters unrelated Python requests before safety capacity is consumed. Use get_investigation_context first when the bundle may have changed.",
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
        "Reads deployed bundle captures, groups them by exact propagated occurrence identity, and records at most one selected failing replay in the investigation ledger. Call after deployment and replay; occurrence_id must be the real propagated ID such as trace:replay-42. Returns a revised view with typed value dossiers and evidence events; missing captures are not negative evidence. detail defaults to compact; pass detail=full only to render the structural graph.",
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
        "Applies up to two exact legal actions from the current actions menu and returns the revised investigation view. based_on_revision must equal the current revision; stale_revision or illegal_action requires refreshing context, while budget_exceeded requires a smaller returned cut. Candidate anchors/predictions are accepted only with CONFIRM_CANDIDATE, and completion evidence_refs must be returned observation IDs. detail defaults to compact; pass detail=full only to render the structural graph.",
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
        "Returns the current or terminal status, confirmed mechanism or boundary/insufficient reason, evidence/decision history, coverage gaps, and performance statistics for an existing investigation. It is read-only and does not advance the loop; use get_investigation_context for the next legal actions.",
      inputSchema: GetInvestigationResultInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) =>
      executeTool(() => handlers.get_investigation_result(input)),
  );
  if (includeLegacyTools) {
    server.registerTool(
      "analyze_probe_candidates",
      {
        title: "Analyze deterministic probe candidates",
        description:
          "Legacy stateless workflow: computes a backward slice and bounded canonical frontier from a known Python criterion, returning plan_id and candidates. Use start_probe_investigation for new agent-driven work; continue here only when a client already implements the legacy analyze/deploy/refine protocol.",
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
          "Legacy stateless workflow: deploys the exact current frontier for plan_id and returns created probes. plan_id and source mappings must come from analyze_probe_candidates and list_services; do not invent candidate locations. Use deploy_investigation_probes for persistent investigations.",
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
          "Legacy stateless workflow: groups captures by explicit occurrence identity, applies assessments only to current candidate IDs, and returns the next frontier or terminal verdict. Use collect_investigation_evidence plus apply_investigation_decision for persistent investigations.",
        inputSchema: RefineProbeCandidatesInputSchema,
        annotations: { readOnlyHint: false },
      },
      async (input) =>
        executeTool(() => handlers.refine_probe_candidates(input)),
    );
  }
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
  options: CreateMcpServerOptions = {},
): Promise<McpServer> {
  const apiKey = process.env["LIVEPROBE_API_KEY"];
  const server = createMcpServer(
    new BrokerClient(brokerUrl, {
      ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    }),
    new AnalyzerRunner(),
    options,
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
