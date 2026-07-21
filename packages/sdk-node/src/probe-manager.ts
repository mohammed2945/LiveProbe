import { capturePaused, type RawCapture } from "./capture.js";
import { AggregateBuffer, EventBuffer } from "./event-buffer.js";
import type { InspectorClient } from "./inspector-client.js";
import { TokenBucket } from "./rate-limiter.js";
import {
  matchesCondition,
  renderTemplate,
  resolveDotPath,
  templatePaths,
} from "./safe-values.js";
import { ScriptRegistry } from "./script-registry.js";
import { isRedactedKey, serialize } from "./serializer.js";
import type {
  PausedEvent,
  ProbeDefinition,
  SanitizedNode,
  SerializerConfig,
  StatusEvent,
} from "./types.js";

interface InstalledProbe {
  active: boolean;
  breakpointId: string;
  definition: ProbeDefinition;
  fingerprint: string;
  hits: number;
  pending: number;
  scriptId: string;
}

interface ProbeManagerOptions {
  inspector: Pick<
    InspectorClient,
    "disconnect" | "getProperties" | "removeBreakpoint" | "resume" | "setBreakpointByUrl"
  >;
  scripts: ScriptRegistry;
  serializerConfig: SerializerConfig;
  rateLimiter: TokenBucket;
  events: EventBuffer;
  aggregates: AggregateBuffer;
  audit?: (line: string) => void;
}

function fingerprint(probe: ProbeDefinition): string {
  return JSON.stringify(probe);
}

function safeAuditText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}

function setSafe(
  target: Record<string, SanitizedNode>,
  key: string,
  value: SanitizedNode,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export class ProbeManager {
  readonly #inspector: ProbeManagerOptions["inspector"];
  readonly #scripts: ScriptRegistry;
  readonly #serializerConfig: SerializerConfig;
  readonly #rateLimiter: TokenBucket;
  readonly #events: EventBuffer;
  readonly #aggregates: AggregateBuffer;
  readonly #audit: (line: string) => void;
  readonly #desired = new Map<string, ProbeDefinition>();
  readonly #installed = new Map<string, InstalledProbe>();
  readonly #byBreakpoint = new Map<string, string>();
  readonly #exhausted = new Map<string, string>();
  readonly #installing = new Set<string>();
  readonly #lastError = new Map<string, string>();
  #suspended = false;
  #stopped = false;
  #inspectorFailed = false;
  #epoch = 0;
  #droppedHits = 0;

  constructor(options: ProbeManagerOptions) {
    this.#inspector = options.inspector;
    this.#scripts = options.scripts;
    this.#serializerConfig = options.serializerConfig;
    this.#rateLimiter = options.rateLimiter;
    this.#events = options.events;
    this.#aggregates = options.aggregates;
    this.#audit = options.audit ?? ((line) => process.stdout.write(`${line}\n`));
  }

  get armedCount(): number {
    return this.#installed.size;
  }

  get droppedHits(): number {
    return this.#droppedHits;
  }

  async reconcile(probes: readonly ProbeDefinition[]): Promise<void> {
    if (this.#stopped) return;
    const changed =
      probes.length !== this.#desired.size ||
      probes.some((probe) => {
        const current = this.#desired.get(probe.id);
        return current === undefined || fingerprint(probe) !== fingerprint(current);
      });
    if (changed) {
      this.#epoch += 1;
    }
    const next = new Map(probes.map((probe) => [probe.id, probe]));

    for (const [id, installed] of [...this.#installed]) {
      const wanted = next.get(id);
      if (wanted === undefined || fingerprint(wanted) !== installed.fingerprint) {
        await this.#uninstall(installed, "PROBE REMOVED");
      }
    }

    for (const [id, exhaustedFingerprint] of [...this.#exhausted]) {
      const wanted = next.get(id);
      if (wanted === undefined || fingerprint(wanted) !== exhaustedFingerprint) {
        this.#exhausted.delete(id);
      }
    }

    this.#desired.clear();
    for (const probe of probes) {
      this.#desired.set(probe.id, probe);
    }

    if (!this.#suspended && !this.#inspectorFailed) {
      for (const probe of probes) {
        await this.#ensureArmed(probe);
      }
    }
  }

  async onScriptAvailable(): Promise<void> {
    if (this.#stopped || this.#suspended || this.#inspectorFailed) return;
    for (const probe of this.#desired.values()) {
      if (!this.#installed.has(probe.id)) {
        await this.#ensureArmed(probe);
      }
    }
  }

  handlePaused(paused: PausedEvent): void {
    const candidates = (paused.hitBreakpoints ?? [])
      .map((breakpointId) => this.#byBreakpoint.get(breakpointId))
      .map((probeId) => (probeId === undefined ? undefined : this.#installed.get(probeId)))
      .filter(
        (probe): probe is InstalledProbe =>
          probe !== undefined &&
          probe.active &&
          !this.#suspended &&
          !this.#inspectorFailed &&
          probe.hits + probe.pending < probe.definition.hitLimit,
      );

    if (candidates.length === 0) {
      this.#resumeOnly();
      return;
    }
    // V8 has already paused before delivering this notification. With the
    // deliberately read-only command set, the safest over-budget behavior is
    // an immediate resume; exact hot-path counters would require code injection.
    if (!this.#rateLimiter.tryTake()) {
      this.#droppedHits += 1;
      this.#resumeOnly();
      return;
    }

    for (const probe of candidates) {
      probe.pending += 1;
    }
    const captureEpoch = this.#epoch;

    const needsCapture = candidates.some(
      ({ definition }) =>
        definition.type !== "counter" || definition.condition !== undefined,
    );
    if (!needsCapture) {
      const empty = Object.create(null) as Record<string, unknown>;
      this.#resumeAndProcess(
        candidates,
        captureEpoch,
        null,
        {
          variables: empty,
          frameLocals: [empty],
          stack: [],
        },
      );
      return;
    }

    const requestedPaths = candidates.flatMap(({ definition }) => [
      ...(definition.condition === undefined ? [] : [definition.condition.path]),
      ...(definition.watchPaths ?? []),
      ...(definition.metricPath === undefined ? [] : [definition.metricPath]),
      ...(definition.template === undefined ? [] : templatePaths(definition.template)),
    ]);
    const requestedDepth = requestedPaths.reduce(
      (maximum, path) => Math.max(maximum, path.split(".").length),
      0,
    );

    try {
      capturePaused(
        this.#inspector,
        paused,
        {
          maxArray: this.#serializerConfig.maxArray,
          maxDepth: Math.max(this.#serializerConfig.maxDepth, requestedDepth),
          maxObjects: 200,
          maxProps: this.#serializerConfig.maxProps,
          maxStackFrames: this.#serializerConfig.maxStackFrames,
          redactKeys: this.#serializerConfig.redactKeys,
          scriptPath: (scriptId) => this.#scripts.get(scriptId)?.path ?? scriptId,
        },
        (error, capture) =>
          this.#resumeAndProcess(candidates, captureEpoch, error, capture),
      );
    } catch (error) {
      const captureError = error instanceof Error ? error : new Error(String(error));
      const empty = Object.create(null) as Record<string, unknown>;
      this.#resumeAndProcess(
        candidates,
        captureEpoch,
        captureError,
        {
          variables: empty,
          frameLocals: [empty],
          stack: [],
        },
      );
    }
  }

  async suspendAll(detail: string): Promise<void> {
    if (this.#stopped || this.#suspended) return;
    this.#suspended = true;
    this.#epoch += 1;
    const installed = [...this.#installed.values()];
    this.#installed.clear();
    this.#byBreakpoint.clear();
    for (const probe of installed) {
      probe.active = false;
      probe.pending = 0;
      this.#status(probe.definition.id, "suspended", detail);
      await this.#removeBreakpoint(probe.breakpointId);
    }
  }

  async rearm(): Promise<void> {
    if (this.#stopped || this.#inspectorFailed) return;
    this.#suspended = false;
    for (const probe of this.#desired.values()) {
      await this.#ensureArmed(probe);
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#epoch += 1;
    const installed = [...this.#installed.values()];
    this.#installed.clear();
    this.#byBreakpoint.clear();
    this.#desired.clear();
    for (const probe of installed) {
      probe.active = false;
      probe.pending = 0;
    }
    await Promise.all(installed.map((probe) => this.#removeBreakpoint(probe.breakpointId)));
  }

  async #ensureArmed(probe: ProbeDefinition): Promise<void> {
    const probeFingerprint = fingerprint(probe);
    if (
      this.#installed.has(probe.id) ||
      this.#installing.has(probe.id) ||
      this.#exhausted.get(probe.id) === probeFingerprint ||
      this.#stopped ||
      this.#suspended ||
      this.#inspectorFailed
    ) {
      return;
    }

    const targetFile = probe.runtimeLocation ?? probe.file;
    const targetLine = probe.runtimeLine ?? probe.line;
    const targetColumn = probe.runtimeColumn ?? 0;
    const resolution = this.#scripts.resolveBySuffix(targetFile);
    if (resolution.status === "missing") {
      this.#error(probe, `line-not-found: ${targetFile}:${String(targetLine)}`);
      return;
    }
    if (resolution.status === "ambiguous") {
      const paths = resolution.matches.map((match) => match.path).join(", ");
      this.#error(probe, `ambiguous-script: ${targetFile} matched ${paths}`);
      return;
    }
    const script = resolution.script;

    this.#installing.add(probe.id);
    try {
      const result = await new Promise<
        { breakpointId: string; locations: readonly unknown[] } | undefined
      >((resolve) => {
        this.#inspector.setBreakpointByUrl(
          {
            lineNumber: targetLine - 1,
            columnNumber: targetColumn,
            url: script.url,
          },
          (error, response) => {
            if (error !== null || response === undefined) {
              this.#error(probe, `inspector-arm: ${error?.message ?? "empty response"}`);
              resolve(undefined);
              return;
            }
            resolve(response);
          },
        );
      });
      if (result === undefined) return;

      const current = this.#desired.get(probe.id);
      if (
        current === undefined ||
        fingerprint(current) !== probeFingerprint ||
        this.#stopped ||
        this.#suspended
      ) {
        await this.#removeBreakpoint(result.breakpointId);
        return;
      }
      if (result.locations.length === 0) {
        await this.#removeBreakpoint(result.breakpointId);
        this.#error(probe, `line-not-found: ${probe.file}:${String(probe.line)}`);
        return;
      }

      const installed: InstalledProbe = {
        active: true,
        breakpointId: result.breakpointId,
        definition: probe,
        fingerprint: probeFingerprint,
        hits: 0,
        pending: 0,
        scriptId: script.scriptId,
      };
      this.#installed.set(probe.id, installed);
      this.#byBreakpoint.set(installed.breakpointId, probe.id);
      this.#lastError.delete(probe.id);
      this.#status(probe.id, "armed", `${probe.file}:${String(probe.line)}`);
      this.#audit(
        `[liveprobe] PROBE ARMED ${safeAuditText(probe.file)}:${String(probe.line)} ` +
          `(${probe.type}, by ${safeAuditText(probe.createdBy)})`,
      );
    } finally {
      this.#installing.delete(probe.id);
      const current = this.#desired.get(probe.id);
      if (
        current !== undefined &&
        fingerprint(current) !== probeFingerprint &&
        !this.#installed.has(probe.id) &&
        !this.#suspended &&
        !this.#stopped &&
        !this.#inspectorFailed
      ) {
        void this.#ensureArmed(current);
      }
    }
  }

  #resumeOnly(): void {
    this.#resumeWithFallback([], () => {});
  }

  #resumeAndProcess(
    candidates: readonly InstalledProbe[],
    captureEpoch: number,
    captureError: Error | null,
    capture: RawCapture,
  ): void {
    this.#resumeWithFallback(candidates, () => {
      setImmediate(() => {
        this.#releasePending(candidates);
        if (
          this.#stopped ||
          this.#suspended ||
          this.#inspectorFailed ||
          captureEpoch !== this.#epoch
        ) {
          return;
        }
        for (const probe of candidates) {
          if (
            !probe.active ||
            this.#installed.get(probe.definition.id) !== probe
          ) {
            continue;
          }
          if (captureError !== null) {
            this.#error(probe.definition, `inspector-capture: ${captureError.message}`);
            continue;
          }
          this.#processHit(probe, capture);
        }
      });
    });
  }

  #resumeWithFallback(
    candidates: readonly InstalledProbe[],
    onResumed: () => void,
  ): void {
    if (this.#inspectorFailed) {
      this.#releasePending(candidates);
      return;
    }
    this.#inspector.resume((firstError) => {
      if (firstError === null) {
        onResumed();
        return;
      }
      this.#inspector.resume((retryError) => {
        if (retryError === null) {
          onResumed();
          return;
        }
        this.#handleResumeFailure(candidates, firstError, retryError);
      });
    });
  }

  #handleResumeFailure(
    candidates: readonly InstalledProbe[],
    firstError: Error,
    retryError: Error,
  ): void {
    this.#releasePending(candidates);
    if (this.#inspectorFailed) return;

    this.#inspectorFailed = true;
    this.#suspended = true;
    this.#epoch += 1;
    const installed = [...this.#installed.values()];
    this.#installed.clear();
    this.#byBreakpoint.clear();
    for (const probe of installed) {
      probe.active = false;
      probe.pending = 0;
    }

    let disconnectDetail = "session disconnected";
    try {
      this.#inspector.disconnect();
    } catch (error) {
      const disconnectError = error instanceof Error ? error : new Error(String(error));
      disconnectDetail = `disconnect failed: ${disconnectError.message}`;
    }
    const detail =
      `inspector-resume-failed: ${firstError.message}; retry: ${retryError.message}; ` +
      disconnectDetail;

    setImmediate(() => {
      if (this.#stopped) return;
      if (installed.length === 0) {
        this.#audit(`[liveprobe] PROBE ERROR ${safeAuditText(detail)}`);
        return;
      }
      for (const probe of installed) {
        this.#error(probe.definition, detail);
      }
    });
  }

  #releasePending(candidates: readonly InstalledProbe[]): void {
    for (const probe of candidates) {
      probe.pending = Math.max(0, probe.pending - 1);
    }
  }

  #processHit(installed: InstalledProbe, capture: RawCapture): void {
    const probe = installed.definition;
    if (!matchesCondition(capture.variables, probe.condition)) {
      return;
    }

    const ts = new Date().toISOString();
    if (probe.type === "snapshot") {
      const watches: Record<string, SanitizedNode> = {};
      for (const path of probe.watchPaths ?? []) {
        const resolved = resolveDotPath(capture.variables, path);
        const node = this.#shouldRedact(path, resolved.value)
          ? ({ t: "redacted" } as const)
          : serialize(
              resolved.found || resolved.truncated === true ? resolved.value : undefined,
              this.#serializerConfig,
            );
        setSafe(watches, path, node);
      }
      this.#events.enqueue({
        probeId: probe.id,
        type: "snapshot",
        ts,
        variables: serialize(capture.variables, this.#serializerConfig),
        watches,
        stack: capture.stack,
      });
    } else if (probe.type === "log") {
      const message = renderTemplate(probe.template ?? "", capture.variables, {
        shouldRedact: (path, value) => this.#shouldRedact(path, value),
      });
      this.#events.enqueue({ probeId: probe.id, type: "log", ts, message, level: "info" });
      this.#audit(`[liveprobe] ${safeAuditText(message)}`);
    } else if (probe.type === "counter") {
      this.#aggregates.incrementCounter(probe.id);
    } else {
      const resolved = resolveDotPath(capture.variables, probe.metricPath ?? "");
      if (resolved.truncated === true) {
        this.#error(probe, `capture-truncated: ${probe.metricPath ?? ""}`);
        return;
      }
      if (!resolved.found || typeof resolved.value !== "number" || !Number.isFinite(resolved.value)) {
        this.#error(probe, `invalid-metric: ${probe.metricPath ?? ""}`);
        return;
      }
      this.#aggregates.recordMetric(probe.id, resolved.value);
    }

    installed.hits += 1;
    if (installed.hits >= probe.hitLimit) {
      void this.#retireAtHitLimit(installed);
    }
  }

  #shouldRedact(path: string, value: unknown): boolean {
    return (
      path.split(".").some((segment) => isRedactedKey(segment, this.#serializerConfig)) ||
      (typeof value === "string" && this.#serializerConfig.redactValues.includes(value))
    );
  }

  async #retireAtHitLimit(installed: InstalledProbe): Promise<void> {
    if (this.#installed.get(installed.definition.id) !== installed) return;
    installed.active = false;
    installed.pending = 0;
    this.#installed.delete(installed.definition.id);
    this.#byBreakpoint.delete(installed.breakpointId);
    this.#exhausted.set(installed.definition.id, installed.fingerprint);
    this.#status(installed.definition.id, "hit-limit-reached");
    this.#audit(
      `[liveprobe] PROBE HIT LIMIT ${safeAuditText(installed.definition.file)}:` +
        String(installed.definition.line),
    );
    const error = await this.#removeBreakpoint(installed.breakpointId);
    if (error !== null) {
      this.#error(installed.definition, `inspector-remove: ${error.message}`);
    }
  }

  async #uninstall(installed: InstalledProbe, auditAction: string): Promise<void> {
    installed.active = false;
    installed.pending = 0;
    this.#installed.delete(installed.definition.id);
    this.#byBreakpoint.delete(installed.breakpointId);
    await this.#removeBreakpoint(installed.breakpointId);
    this.#audit(
      `[liveprobe] ${auditAction} ${safeAuditText(installed.definition.file)}:` +
        String(installed.definition.line),
    );
  }

  #removeBreakpoint(breakpointId: string): Promise<Error | null> {
    return new Promise((resolve) => {
      this.#inspector.removeBreakpoint({ breakpointId }, (error) => resolve(error));
    });
  }

  #error(probe: ProbeDefinition, detail: string): void {
    const dedupe = `${fingerprint(probe)}:${detail}`;
    if (this.#lastError.get(probe.id) === dedupe) return;
    this.#lastError.set(probe.id, dedupe);
    this.#status(probe.id, "error", detail);
    this.#audit(
      `[liveprobe] PROBE ERROR ${safeAuditText(probe.file)}:${String(probe.line)} ` +
        safeAuditText(detail),
    );
  }

  #status(probeId: string, status: StatusEvent["status"], detail?: string): void {
    const event: StatusEvent =
      detail === undefined
        ? { probeId, type: "status", ts: new Date().toISOString(), status }
        : { probeId, type: "status", ts: new Date().toISOString(), status, detail };
    this.#events.enqueue(event);
  }
}
