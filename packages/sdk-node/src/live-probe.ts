import { randomUUID } from "node:crypto";

import { BrokerClient, BrokerIngestError } from "./broker-client.js";
import { AggregateBuffer, EventBuffer } from "./event-buffer.js";
import { InspectorClient } from "./inspector-client.js";
import { ProbeManager } from "./probe-manager.js";
import { TokenBucket } from "./rate-limiter.js";
import { EventLoopSafetyMonitor } from "./safety-monitor.js";
import { ScriptRegistry } from "./script-registry.js";
import { SourceMapUploader } from "./source-map-uploader.js";
import { normalizeSerializerConfig } from "./serializer.js";
import type { AgentStatus, SerializerConfigInput } from "./types.js";

export interface LiveProbeLimits {
  hitsPerSec?: number;
  bandwidthKbPerSec?: number;
  maxLagMs?: number;
  cooldownMs?: number;
  pollIntervalMs?: number;
  flushIntervalMs?: number;
  requestTimeoutMs?: number;
  maxQueueBytes?: number;
  maxDepth?: number;
  maxArray?: number;
  maxProps?: number;
  maxString?: number;
  maxStackFrames?: number;
}

export interface LiveProbeOptions {
  serviceId: string;
  brokerUrl: string;
  apiKey?: string;
  commitSha?: string;
  sourceMapDir?: string;
  distLocation?: string;
  appRoot?: string;
  environment?: string;
  redactKeys?: readonly string[];
  redactValues?: readonly string[];
  limits?: LiveProbeLimits;
}

interface ResolvedLimits {
  hitsPerSec: number;
  bandwidthKbPerSec: number;
  maxLagMs: number;
  cooldownMs: number;
  pollIntervalMs: number;
  flushIntervalMs: number;
  requestTimeoutMs: number;
  maxQueueBytes: number;
}

function positiveNumber(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be positive and finite`);
  }
  return resolved;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function resolveLimits(input: LiveProbeLimits = {}): ResolvedLimits {
  const bandwidthKbPerSec = positiveNumber(
    input.bandwidthKbPerSec,
    200,
    "bandwidthKbPerSec",
  );
  return {
    hitsPerSec: positiveNumber(input.hitsPerSec, 10, "hitsPerSec"),
    bandwidthKbPerSec,
    maxLagMs: positiveNumber(input.maxLagMs, 50, "maxLagMs"),
    cooldownMs: positiveInteger(input.cooldownMs, 10_000, "cooldownMs"),
    pollIntervalMs: positiveInteger(input.pollIntervalMs, 1000, "pollIntervalMs"),
    flushIntervalMs: positiveInteger(input.flushIntervalMs, 2000, "flushIntervalMs"),
    requestTimeoutMs: positiveInteger(input.requestTimeoutMs, 5000, "requestTimeoutMs"),
    maxQueueBytes: positiveInteger(
      input.maxQueueBytes,
      Math.max(64 * 1024, Math.floor(bandwidthKbPerSec * 1024 * 5)),
      "maxQueueBytes",
    ),
  };
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}

function resolveCommitSha(options: LiveProbeOptions): {
  commitSha: string;
  commitSource: "env" | "config";
} {
  const raw =
    options.commitSha?.trim() ??
    envValue("LIVEPROBE_COMMIT_SHA") ??
    envValue("GIT_COMMIT");
  if (raw === undefined || raw.toLowerCase() === "unknown") {
    throw new Error(
      "commitSha is required; pass commitSha or set LIVEPROBE_COMMIT_SHA/GIT_COMMIT",
    );
  }
  if (!/^[0-9a-f]{7,64}$/iu.test(raw)) {
    throw new Error("commitSha must be a 7-64 character hexadecimal Git object ID");
  }
  return {
    commitSha: raw.toLowerCase(),
    commitSource: options.commitSha === undefined ? "env" : "config",
  };
}

function serializerInput(options: LiveProbeOptions): SerializerConfigInput {
  const limits = options.limits;
  return {
    ...(options.redactKeys === undefined ? {} : { redactKeys: options.redactKeys }),
    ...(options.redactValues === undefined ? {} : { redactValues: options.redactValues }),
    ...(limits?.maxDepth === undefined ? {} : { maxDepth: limits.maxDepth }),
    ...(limits?.maxArray === undefined ? {} : { maxArray: limits.maxArray }),
    ...(limits?.maxProps === undefined ? {} : { maxProps: limits.maxProps }),
    ...(limits?.maxString === undefined ? {} : { maxString: limits.maxString }),
    ...(limits?.maxStackFrames === undefined
      ? {}
      : { maxStackFrames: limits.maxStackFrames }),
  };
}

export class LiveProbe {
  readonly #serviceId: string;
  readonly #commitSha: string;
  readonly #commitSource: "env" | "config";
  readonly #environment: string | undefined;
  readonly #limits: ResolvedLimits;
  readonly #inspector: InspectorClient;
  readonly #broker: BrokerClient;
  readonly #scripts: ScriptRegistry;
  readonly #sourceMaps: SourceMapUploader;
  readonly #events: EventBuffer;
  readonly #aggregates: AggregateBuffer;
  readonly #manager: ProbeManager;
  readonly #safety: EventLoopSafetyMonitor;
  #version = 0;
  #stopped = false;
  #pollTimer: NodeJS.Timeout | undefined;
  #flushTimer: NodeJS.Timeout | undefined;
  #sourceMapTimer: NodeJS.Timeout | undefined;
  #pollPromise: Promise<void> | undefined;
  #flushPromise: Promise<void> | undefined;
  #sourceMapPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #removeScriptListener: (() => void) | undefined;
  #removePausedListener: (() => void) | undefined;
  #lastBrokerError: string | undefined;

  private constructor(options: LiveProbeOptions) {
    if (options.serviceId.trim().length === 0) {
      throw new Error("serviceId must be non-empty");
    }
    const resolvedCommit = resolveCommitSha(options);
    this.#serviceId = options.serviceId;
    this.#commitSha = resolvedCommit.commitSha;
    this.#commitSource = resolvedCommit.commitSource;
    this.#environment = options.environment;
    this.#limits = resolveLimits(options.limits);
    const serializerConfig = normalizeSerializerConfig(serializerInput(options));
    this.#inspector = new InspectorClient();
    const apiKey = options.apiKey ?? envValue("LIVEPROBE_API_KEY");
    this.#broker = new BrokerClient(options.brokerUrl, {
      ...(apiKey === undefined ? {} : { apiKey }),
      requestTimeoutMs: this.#limits.requestTimeoutMs,
    });
    const sourceMapDir =
      options.sourceMapDir ?? envValue("LIVEPROBE_SOURCE_MAP_DIR");
    const distLocation =
      options.distLocation ?? envValue("LIVEPROBE_DIST_LOCATION") ?? "dist";
    const appRoot = options.appRoot ?? envValue("LIVEPROBE_APP_ROOT") ?? "";
    this.#scripts = new ScriptRegistry();
    this.#sourceMaps = new SourceMapUploader({
      broker: this.#broker,
      serviceId: this.#serviceId,
      commitSha: this.#commitSha,
      uploaderId: randomUUID(),
      ...(sourceMapDir === undefined ? {} : { sourceMapDir }),
      distLocation,
      appRoot,
    });
    this.#events = new EventBuffer(this.#limits.maxQueueBytes);
    this.#aggregates = new AggregateBuffer();
    this.#manager = new ProbeManager({
      inspector: this.#inspector,
      scripts: this.#scripts,
      serializerConfig,
      rateLimiter: new TokenBucket(this.#limits.hitsPerSec),
      events: this.#events,
      aggregates: this.#aggregates,
    });
    this.#safety = new EventLoopSafetyMonitor({
      maxLagMs: this.#limits.maxLagMs,
      sampleIntervalMs: 1000,
      cooldownMs: this.#limits.cooldownMs,
      onRed: async (p95Ms) => {
        process.stdout.write(
          `[liveprobe] SAFETY RED event-loop-p95=${p95Ms.toFixed(1)}ms\n`,
        );
        await this.#manager.suspendAll(`event-loop-p95=${p95Ms.toFixed(1)}ms`);
      },
      onRearm: async () => {
        process.stdout.write("[liveprobe] SAFETY GREEN re-arming probes\n");
        await this.#manager.rearm();
      },
    });
  }

  static async start(options: LiveProbeOptions): Promise<LiveProbe> {
    const liveProbe = new LiveProbe(options);
    await liveProbe.#start();
    return liveProbe;
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #start(): Promise<void> {
    this.#inspector.connect();
    this.#removeScriptListener = this.#inspector.onScriptParsed((event) => {
      if (this.#scripts.register(event) !== undefined) {
        void this.#manager.onScriptAvailable();
      }
    });
    this.#removePausedListener = this.#inspector.onPaused((event) => {
      this.#manager.handlePaused(event);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        this.#inspector.enable((error) => {
          if (error !== null) reject(error);
          else resolve();
        });
      });
    } catch (error) {
      this.#removeScriptListener();
      this.#removePausedListener();
      this.#inspector.disconnect();
      throw error;
    }

    this.#safety.start();
    this.#scheduleSourceMapSync(1);
    await this.#poll();
    this.#pollTimer = setInterval(() => this.#schedulePoll(), this.#limits.pollIntervalMs);
    this.#pollTimer.unref();
    this.#flushTimer = setInterval(() => this.#scheduleFlush(), this.#limits.flushIntervalMs);
    this.#flushTimer.unref();
    process.stdout.write(`[liveprobe] STARTED ${this.#serviceId}\n`);
  }

  #schedulePoll(): void {
    if (this.#pollPromise !== undefined || this.#stopped) return;
    this.#pollPromise = this.#poll().finally(() => {
      this.#pollPromise = undefined;
    });
  }

  async #poll(): Promise<void> {
    try {
      const response = await this.#broker.poll(
        this.#serviceId,
        this.#version,
        this.#commitSha,
      );
      if (this.#stopped) return;
      this.#version = response.version;
      if (response.unchanged !== true) {
        await this.#manager.reconcile(response.probes ?? []);
      }
      this.#clearBrokerError();
    } catch (error) {
      this.#reportBrokerError(error);
    }
  }

  #scheduleFlush(): void {
    if (this.#flushPromise !== undefined || this.#stopped) return;
    this.#flushPromise = this.#flush().finally(() => {
      this.#flushPromise = undefined;
    });
  }

  #scheduleSourceMapSync(attempt: number, delayMs = 0): void {
    if (
      this.#stopped ||
      this.#sourceMapTimer !== undefined ||
      (delayMs === 0 && this.#sourceMapPromise !== undefined)
    ) {
      return;
    }
    const run = (): void => {
      this.#sourceMapTimer = undefined;
      if (this.#stopped) return;
      this.#sourceMapPromise = this.#syncSourceMaps(attempt).finally(() => {
        this.#sourceMapPromise = undefined;
      });
    };
    if (delayMs === 0) {
      run();
      return;
    }
    this.#sourceMapTimer = setTimeout(run, delayMs);
    this.#sourceMapTimer.unref();
  }

  async #syncSourceMaps(attempt: number): Promise<void> {
    try {
      const result = await this.#sourceMaps.sync();
      if (result === "waiting" && attempt < 10) {
        this.#scheduleSourceMapSync(attempt + 1, 20_000);
      }
    } catch (error) {
      this.#reportBrokerError(error);
      if (attempt < 5) {
        this.#scheduleSourceMapSync(attempt + 1, 5_000);
      }
    }
  }

  async #flush(): Promise<void> {
    for (const event of this.#aggregates.flush()) {
      this.#events.enqueue(event);
    }
    const byteBudget = Math.max(
      1024,
      Math.floor(
        this.#limits.bandwidthKbPerSec *
          1024 *
          (this.#limits.flushIntervalMs / 1000),
      ),
    );
    const events = this.#events.takeBatch(byteBudget);
    const agentStatus: AgentStatus = {
      state: this.#safety.state,
      detail:
        `${String(this.#manager.armedCount)} probes armed; ` +
        `${String(this.#manager.droppedHits)} rate-dropped; ` +
        `${String(this.#events.droppedEvents)} queue-dropped` +
        (this.#environment === undefined ? "" : `; env=${this.#environment}`),
    };
    try {
      await this.#broker.ingest(
        this.#serviceId,
        this.#commitSha,
        this.#commitSource,
        agentStatus,
        events,
      );
      this.#clearBrokerError();
    } catch (error) {
      if (error instanceof BrokerIngestError && error.statusCode === 400) {
        this.#events.recordRejected(events);
      } else {
        this.#events.requeueFront(events);
      }
      this.#reportBrokerError(error);
    }
  }

  #reportBrokerError(error: unknown): void {
    if (this.#stopped) return;
    const message = error instanceof Error ? error.message : String(error);
    if (message !== this.#lastBrokerError) {
      this.#lastBrokerError = message;
      process.stdout.write(
        `[liveprobe] BROKER ERROR ${message.replace(/[\r\n]/gu, " ")}\n`,
      );
    }
  }

  #clearBrokerError(): void {
    if (this.#lastBrokerError !== undefined) {
      this.#lastBrokerError = undefined;
      process.stdout.write("[liveprobe] BROKER CONNECTED\n");
    }
  }

  async #stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#pollTimer !== undefined) clearInterval(this.#pollTimer);
    if (this.#flushTimer !== undefined) clearInterval(this.#flushTimer);
    if (this.#sourceMapTimer !== undefined) clearTimeout(this.#sourceMapTimer);
    this.#safety.stop();
    this.#removeScriptListener?.();
    this.#removePausedListener?.();

    await Promise.allSettled([
      this.#pollPromise ?? Promise.resolve(),
      this.#flushPromise ?? Promise.resolve(),
      this.#sourceMapPromise ?? Promise.resolve(),
    ]);
    await this.#manager.stop();
    for (const event of this.#aggregates.flush()) {
      this.#events.enqueue(event);
    }
    await this.#flush();
    this.#broker.stop();
    this.#scripts.clear();
    this.#inspector.disconnect();
    process.stdout.write(`[liveprobe] STOPPED ${this.#serviceId}\n`);
  }
}
