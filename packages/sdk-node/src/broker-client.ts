import type {
  AgentEvent,
  AgentStatus,
  JsonScalar,
  PollResponse,
  ProbeCondition,
  ProbeDefinition,
  ProbeType,
} from "./types.js";

type FetchLike = (
  input: string | URL,
  init?: {
    body?: string;
    headers?: Record<string, string>;
    method?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export class BrokerIngestError extends Error {
  constructor(public readonly statusCode: number) {
    super(`broker ingest failed with HTTP ${String(statusCode)}`);
    this.name = "BrokerIngestError";
  }
}

const PROBE_TYPES = new Set<ProbeType>(["snapshot", "log", "counter", "metric"]);
const CONDITION_OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function parseCondition(value: unknown): ProbeCondition | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value["path"] !== "string" ||
    typeof value["op"] !== "string" ||
    !CONDITION_OPERATORS.has(value["op"]) ||
    !isJsonScalar(value["value"])
  ) {
    throw new Error("broker returned an invalid probe condition");
  }
  return value as unknown as ProbeCondition;
}

function parseProbe(value: unknown, serviceId: string): ProbeDefinition {
  if (!isRecord(value)) {
    throw new Error("broker returned a non-object probe");
  }
  const type = value["type"];
  if (
    typeof value["id"] !== "string" ||
    value["id"].length === 0 ||
    value["serviceId"] !== serviceId ||
    typeof type !== "string" ||
    !PROBE_TYPES.has(type as ProbeType) ||
    typeof value["file"] !== "string" ||
    value["file"].length === 0 ||
    !Number.isSafeInteger(value["line"]) ||
    (value["line"] as number) <= 0 ||
    !Number.isSafeInteger(value["hitLimit"]) ||
    (value["hitLimit"] as number) <= 0 ||
    !Number.isSafeInteger(value["ttlSeconds"]) ||
    (value["ttlSeconds"] as number) <= 0 ||
    !Number.isSafeInteger(value["version"]) ||
    (value["version"] as number) <= 0 ||
    typeof value["createdBy"] !== "string" ||
    value["createdBy"].length === 0
  ) {
    throw new Error("broker returned an invalid probe definition");
  }
  if (type === "log" && typeof value["template"] !== "string") {
    throw new Error("broker returned a log probe without a template");
  }
  if (type === "metric" && typeof value["metricPath"] !== "string") {
    throw new Error("broker returned a metric probe without a path");
  }
  if (
    value["watchPaths"] !== undefined &&
    (!Array.isArray(value["watchPaths"]) ||
      !value["watchPaths"].every((path) => typeof path === "string"))
  ) {
    throw new Error("broker returned invalid watch paths");
  }
  const runtimeFields = [
    value["runtimeLocation"],
    value["runtimeLine"],
    value["runtimeColumn"],
  ];
  const hasRuntimeFields = runtimeFields.some((field) => field !== undefined);
  if (
    hasRuntimeFields &&
    (typeof value["runtimeLocation"] !== "string" ||
      value["runtimeLocation"].length === 0 ||
      !Number.isSafeInteger(value["runtimeLine"]) ||
      (value["runtimeLine"] as number) <= 0 ||
      !Number.isSafeInteger(value["runtimeColumn"]) ||
      (value["runtimeColumn"] as number) < 0)
  ) {
    throw new Error("broker returned invalid runtime probe coordinates");
  }
  parseCondition(value["condition"]);
  return value as unknown as ProbeDefinition;
}

export function parsePollResponse(value: unknown, serviceId: string): PollResponse {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value["version"]) ||
    (value["version"] as number) < 0
  ) {
    throw new Error("broker returned an invalid poll response");
  }
  if (value["unchanged"] === true) {
    return { version: value["version"] as number, unchanged: true };
  }
  if (!Array.isArray(value["probes"])) {
    throw new Error("broker poll response is missing probes");
  }
  return {
    version: value["version"] as number,
    probes: value["probes"].map((probe) => parseProbe(probe, serviceId)),
  };
}

export class BrokerClient {
  readonly #baseUrl: URL;
  readonly #fetch: FetchLike;
  readonly #requestTimeoutMs: number;
  readonly #apiKey: string | undefined;
  readonly #controllers = new Set<AbortController>();
  #stopped = false;

  constructor(
    brokerUrl: string,
    options: { apiKey?: string; fetch?: FetchLike; requestTimeoutMs?: number } = {},
  ) {
    const baseUrl = new URL(brokerUrl);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new Error("brokerUrl must use http or https");
    }
    if (baseUrl.username.length > 0 || baseUrl.password.length > 0) {
      throw new Error("brokerUrl must not contain credentials");
    }
    if (!baseUrl.pathname.endsWith("/")) {
      baseUrl.pathname += "/";
    }
    this.#baseUrl = baseUrl;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.#apiKey = options.apiKey;
  }

  async poll(
    serviceId: string,
    since: number,
    commitSha?: string,
  ): Promise<PollResponse> {
    const query = new URLSearchParams({ since: String(since) });
    if (commitSha !== undefined) query.set("commitSha", commitSha);
    const path = `v1/services/${encodeURIComponent(serviceId)}/probes?${query.toString()}`;
    const response = await this.#request(path, { method: "GET" });
    if (!response.ok) {
      throw new Error(`broker poll failed with HTTP ${String(response.status)}`);
    }
    return parsePollResponse(await response.json(), serviceId);
  }

  async sourceMapStatus(identity: {
    serviceId: string;
    commitSha: string;
    uploaderId: string;
  }): Promise<{ isUploader: boolean; isComplete: boolean }> {
    const response = await this.#sourceMapRequest("status", identity);
    const decoded = (await response.json()) as unknown;
    if (
      !isRecord(decoded) ||
      typeof decoded["isUploader"] !== "boolean" ||
      typeof decoded["isComplete"] !== "boolean"
    ) {
      throw new Error("broker returned an invalid source-map status");
    }
    return {
      isUploader: decoded["isUploader"],
      isComplete: decoded["isComplete"],
    };
  }

  async uploadSourceMap(input: {
    serviceId: string;
    commitSha: string;
    uploaderId: string;
    mapPath: string;
    map: Record<string, unknown>;
  }): Promise<void> {
    await this.#sourceMapRequest("upload", input, 202);
  }

  async completeSourceMaps(identity: {
    serviceId: string;
    commitSha: string;
    uploaderId: string;
  }): Promise<void> {
    await this.#sourceMapRequest("complete", identity, 202);
  }

  async ingest(
    serviceId: string,
    commitSha: string,
    commitSource: "env" | "config",
    agentStatus: AgentStatus,
    events: readonly AgentEvent[],
  ): Promise<void> {
    const response = await this.#request("v1/ingest", {
      body: JSON.stringify({
        serviceId,
        sdk: "node",
        commitSha,
        commitSource,
        agentStatus,
        events,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (response.status !== 202) {
      throw new BrokerIngestError(response.status);
    }
  }

  stop(): void {
    this.#stopped = true;
    for (const controller of this.#controllers) {
      controller.abort();
    }
    this.#controllers.clear();
  }

  async #request(
    path: string,
    init: {
      body?: string;
      headers?: Record<string, string>;
      method: string;
    },
  ): Promise<Response> {
    if (this.#stopped) {
      throw new Error("broker client is stopped");
    }
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    timeout.unref();
    try {
      return await this.#fetch(new URL(path, this.#baseUrl), {
        ...init,
        headers: {
          ...(this.#apiKey === undefined
            ? {}
            : { authorization: `Bearer ${this.#apiKey}` }),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      this.#controllers.delete(controller);
    }
  }

  async #sourceMapRequest(
    operation: "status" | "upload" | "complete",
    body: object,
    expectedStatus = 200,
  ): Promise<Response> {
    const response = await this.#request(`v1/source-maps/${operation}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (response.status !== expectedStatus) {
      throw new Error(
        `broker source-map ${operation} failed with HTTP ${String(response.status)}`,
      );
    }
    return response;
  }
}
