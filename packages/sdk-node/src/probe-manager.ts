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
import {
  evaluateExpression,
  expressionPaths,
  renderExpressionTemplate,
} from "./safe-expression.js";
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

/**
 * One V8 breakpoint and every probe relying on it.
 *
 * V8 permits a single breakpoint per resolved location, so probes are not one
 * to one with breakpoints: several probes on the same line share one, and the
 * breakpoint is removed only when the last of them goes away. `keys` records
 * every location key routed here — both the location a probe asked for and the
 * location V8 resolved it to — so the registry can be cleaned up completely.
 */
interface BreakpointHolder {
  breakpointId: string;
  keys: Set<string>;
  probeIds: Set<string>;
}

interface ResolvedLocation {
  scriptId?: string;
  lineNumber?: number;
  columnNumber?: number;
}

/**
 * Location key in V8's own coordinates: script id, zero-based line, column.
 *
 * Requested and resolved locations have to produce comparable keys, and V8
 * reports resolved lines zero-based while probe definitions are one-based.
 */
function locationKey(
  scriptId: string,
  zeroBasedLine: number,
  column: number,
): string {
  return `${scriptId}:${String(zeroBasedLine)}:${String(column)}`;
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
  readonly #byBreakpoint = new Map<string, BreakpointHolder>();
  readonly #byLocation = new Map<string, BreakpointHolder>();
  readonly #arming = new Map<string, Promise<BreakpointHolder | null>>();
  readonly #exhausted = new Map<string, string>();
  readonly #installing = new Set<string>();
  readonly #lastError = new Map<string, string>();
  #suspended = false;
  #stopped = false;
  #inspectorFailed = false;
  #epoch = 0;
  #droppedHits = 0;

  #expressionPolicy(): {
    isRedactedKey: (key: string) => boolean;
    isRedactedValue: (value: unknown) => boolean;
  } {
    return {
      isRedactedKey: (key) =>
        isRedactedKey(key, this.#serializerConfig),
      isRedactedValue: (value) =>
        typeof value === "string" &&
        this.#serializerConfig.redactValues.includes(value),
    };
  }

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
    // One breakpoint can serve several probes, and one pause can report several
    // breakpoints, so a probe is deduplicated by id rather than by position.
    const seen = new Set<string>();
    const candidates: InstalledProbe[] = [];
    for (const breakpointId of paused.hitBreakpoints ?? []) {
      const holder = this.#byBreakpoint.get(breakpointId);
      if (holder === undefined) continue;
      for (const probeId of holder.probeIds) {
        if (seen.has(probeId)) continue;
        seen.add(probeId);
        const probe = this.#installed.get(probeId);
        if (
          probe !== undefined &&
          probe.active &&
          !this.#suspended &&
          !this.#inspectorFailed &&
          probe.hits + probe.pending < probe.definition.hitLimit
        ) {
          candidates.push(probe);
        }
      }
    }

    if (candidates.length === 0) {
      this.#resumeOnly();
      return;
    }
    // V8 has already paused before delivering this notification. With the
    // deliberately read-only command set, the safest over-budget behavior is
    // an immediate resume.
    if (!this.#rateLimiter.tryTake()) {
      // The rate limit bounds capture cost, not counting. An unconditional
      // counter needs no capture, so it stays exact on hot paths instead of
      // sampling at maxProbeHitsPerSecond.
      const counted = candidates.filter(
        ({ definition }) =>
          definition.type === "counter" &&
          definition.condition === undefined &&
          definition.conditionExpression === undefined,
      );
      for (const probe of counted) {
        this.#aggregates.incrementCounter(probe.definition.id);
        probe.hits += 1;
      }
      if (counted.length < candidates.length) {
        this.#droppedHits += 1;
      }
      this.#resumeOnly();
      for (const probe of counted) {
        if (probe.hits >= probe.definition.hitLimit) {
          void this.#retireAtHitLimit(probe);
        }
      }
      return;
    }

    for (const probe of candidates) {
      probe.pending += 1;
    }
    const captureEpoch = this.#epoch;

    const needsCapture = candidates.some(
      ({ definition }) =>
        definition.type !== "counter" ||
        definition.condition !== undefined ||
        definition.conditionExpression !== undefined,
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
      ...[
        definition.conditionExpression,
        ...(definition.watchExpressions ?? []),
        definition.metricExpression,
        ...(definition.templateSegments ?? []).flatMap((segment) =>
          segment.type === "expression" ? [segment.expression] : [],
        ),
      ]
        .filter((expression) => expression !== undefined)
        .flatMap((expression) =>
          expressionPaths(expression).map((path) => path.map(String).join(".")),
        ),
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
    const holders = this.#clearBreakpointRegistry();
    this.#installed.clear();
    for (const probe of installed) {
      probe.active = false;
      probe.pending = 0;
      this.#status(probe.definition.id, "suspended", detail);
    }
    // Removed per breakpoint, not per probe: probes sharing a line share one.
    for (const holder of holders) {
      await this.#removeBreakpoint(holder.breakpointId);
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
    const holders = this.#clearBreakpointRegistry();
    this.#installed.clear();
    this.#desired.clear();
    for (const probe of installed) {
      probe.active = false;
      probe.pending = 0;
    }
    await Promise.all(
      [...holders].map((holder) => this.#removeBreakpoint(holder.breakpointId)),
    );
  }

  /** Empties the breakpoint registry and returns the breakpoints it held. */
  #clearBreakpointRegistry(): Set<BreakpointHolder> {
    const holders = new Set(this.#byBreakpoint.values());
    this.#byBreakpoint.clear();
    this.#byLocation.clear();
    for (const holder of holders) {
      holder.probeIds.clear();
    }
    return holders;
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
      const holder = await this.#acquireBreakpoint(
        probe,
        script,
        targetLine,
        targetColumn,
      );
      if (holder === null) return;

      const current = this.#desired.get(probe.id);
      if (
        current === undefined ||
        fingerprint(current) !== probeFingerprint ||
        this.#stopped ||
        this.#suspended
      ) {
        holder.probeIds.delete(probe.id);
        await this.#releaseHolder(holder);
        return;
      }

      const installed: InstalledProbe = {
        active: true,
        breakpointId: holder.breakpointId,
        definition: probe,
        fingerprint: probeFingerprint,
        hits: 0,
        pending: 0,
        scriptId: script.scriptId,
      };
      this.#installed.set(probe.id, installed);
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

  /**
   * Claims the breakpoint for a location, creating it only if nothing has it.
   *
   * V8 refuses a second breakpoint at a location that already has one, so a
   * probe joining a line another probe already covers must reuse that
   * breakpoint rather than ask for its own. The returned holder already counts
   * this probe: claiming has to be synchronous with the lookup, or a probe that
   * aborts between the two could remove a breakpoint another probe just took.
   *
   * Returns null when the location could not be armed; the error has been
   * reported by then.
   */
  async #acquireBreakpoint(
    probe: ProbeDefinition,
    script: { scriptId: string; url: string },
    line: number,
    column: number,
  ): Promise<BreakpointHolder | null> {
    const requested = locationKey(script.scriptId, line - 1, column);
    const existing = this.#byLocation.get(requested);
    if (existing !== undefined) {
      existing.probeIds.add(probe.id);
      return existing;
    }

    // Two probes arming the same new location concurrently would both miss the
    // lookup above and both ask V8, and the loser would get the duplicate-
    // location error. The second waits for the first instead.
    const inFlight = this.#arming.get(requested);
    if (inFlight !== undefined) {
      await inFlight;
      const settled = this.#byLocation.get(requested);
      if (settled !== undefined) {
        settled.probeIds.add(probe.id);
        return settled;
      }
      // The arm that was in flight failed. Fall through and try for ourselves.
    }

    const attempt = this.#installBreakpoint(probe, script, line, column, requested);
    this.#arming.set(requested, attempt);
    try {
      const holder = await attempt;
      if (holder !== null) holder.probeIds.add(probe.id);
      return holder;
    } finally {
      if (this.#arming.get(requested) === attempt) this.#arming.delete(requested);
    }
  }

  async #installBreakpoint(
    probe: ProbeDefinition,
    script: { scriptId: string; url: string },
    line: number,
    column: number,
    requested: string,
  ): Promise<BreakpointHolder | null> {
    const result = await new Promise<
      { breakpointId: string; locations: readonly unknown[] } | undefined
    >((resolve) => {
      this.#inspector.setBreakpointByUrl(
        {
          lineNumber: line - 1,
          columnNumber: column,
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
    if (result === undefined) return null;
    if (result.locations.length === 0) {
      await this.#removeBreakpoint(result.breakpointId);
      this.#error(probe, `line-not-found: ${probe.file}:${String(probe.line)}`);
      return null;
    }

    const holder: BreakpointHolder = {
      breakpointId: result.breakpointId,
      keys: new Set([requested]),
      probeIds: new Set(),
    };
    this.#byBreakpoint.set(holder.breakpointId, holder);
    this.#byLocation.set(requested, holder);
    // V8 snaps a request onto the nearest executable position, so the location
    // that ends up armed is not always the one asked for. Registering it too
    // lets a later probe that names the resolved position directly share this
    // breakpoint instead of colliding with it. Two requests that resolve to one
    // position from different columns still collide, exactly as they do today.
    const resolved = this.#resolvedKey(script.scriptId, result.locations[0]);
    if (resolved !== null && !this.#byLocation.has(resolved)) {
      holder.keys.add(resolved);
      this.#byLocation.set(resolved, holder);
    }
    return holder;
  }

  #resolvedKey(fallbackScriptId: string, location: unknown): string | null {
    if (location === null || typeof location !== "object") return null;
    const { scriptId, lineNumber, columnNumber } = location as ResolvedLocation;
    if (typeof lineNumber !== "number") return null;
    return locationKey(
      typeof scriptId === "string" ? scriptId : fallbackScriptId,
      lineNumber,
      typeof columnNumber === "number" ? columnNumber : 0,
    );
  }

  /** Drops a probe's claim, removing the breakpoint once nothing holds it. */
  async #releaseBreakpointFor(installed: InstalledProbe): Promise<Error | null> {
    const holder = this.#byBreakpoint.get(installed.breakpointId);
    if (holder === undefined) return null;
    holder.probeIds.delete(installed.definition.id);
    return this.#releaseHolder(holder);
  }

  async #releaseHolder(holder: BreakpointHolder): Promise<Error | null> {
    if (holder.probeIds.size > 0) return null;
    if (this.#byBreakpoint.get(holder.breakpointId) !== holder) return null;
    this.#byBreakpoint.delete(holder.breakpointId);
    for (const key of holder.keys) {
      if (this.#byLocation.get(key) === holder) this.#byLocation.delete(key);
    }
    return this.#removeBreakpoint(holder.breakpointId);
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
    // The session is about to be abandoned, so nothing is removed — but the
    // location index has to go with it, or a later arm would hand out a
    // breakpoint id belonging to a disconnected session.
    this.#clearBreakpointRegistry();
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
    if (probe.conditionExpression !== undefined) {
      const condition = evaluateExpression(
        probe.conditionExpression,
        capture.variables,
        this.#expressionPolicy(),
      );
      if (!condition.ok || condition.value !== true) {
        return;
      }
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
      for (const expression of probe.watchExpressions ?? []) {
        const result = evaluateExpression(
          expression,
          capture.variables,
          this.#expressionPolicy(),
        );
        setSafe(
          watches,
          expression.source,
          result.ok
            ? serialize(result.value, this.#serializerConfig)
            : { t: "truncated", v: "unsupported" },
        );
      }
      this.#events.enqueue({
        probeId: probe.id,
        type: "snapshot",
        ts,
        variables: serialize(capture.variables, this.#serializerConfig),
        watches,
        stack:
          probe.includeStackLocals === true
            ? capture.stack
                .slice(0, probe.stackFrameLimit ?? 3)
                .map((frame, index) => ({
                  ...frame,
                  variables: serialize(
                    capture.frameLocals[index],
                    this.#serializerConfig,
                  ),
                }))
            : capture.stack,
      });
    } else if (probe.type === "log") {
      const message =
        probe.templateSegments === undefined
          ? renderTemplate(probe.template ?? "", capture.variables, {
              shouldRedact: (path, value) => this.#shouldRedact(path, value),
            })
          : renderExpressionTemplate(
              probe.templateSegments,
              capture.variables,
              4_096,
              this.#expressionPolicy(),
            );
      this.#events.enqueue({
        probeId: probe.id,
        type: "log",
        ts,
        message,
        level: probe.logLevel ?? "info",
      });
      this.#audit(`[liveprobe] ${safeAuditText(message)}`);
    } else if (probe.type === "counter") {
      this.#aggregates.incrementCounter(probe.id);
    } else {
      const pathResult =
        probe.metricExpression === undefined
          ? resolveDotPath(capture.variables, probe.metricPath ?? "")
          : undefined;
      const expressionResult =
        probe.metricExpression === undefined
          ? undefined
          : evaluateExpression(
              probe.metricExpression,
              capture.variables,
              this.#expressionPolicy(),
            );
      if (pathResult?.truncated === true) {
        this.#error(probe, `capture-truncated: ${probe.metricPath ?? ""}`);
        return;
      }
      const found = pathResult?.found ?? expressionResult?.ok ?? false;
      const value =
        pathResult?.value ??
        (expressionResult?.ok === true ? expressionResult.value : undefined);
      if (
        !found ||
        typeof value !== "number" ||
        !Number.isFinite(value)
      ) {
        this.#error(
          probe,
          `invalid-metric: ${
            probe.metricExpression?.source ?? probe.metricPath ?? ""
          }`,
        );
        return;
      }
      this.#aggregates.recordMetric(probe.id, value);
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
    this.#exhausted.set(installed.definition.id, installed.fingerprint);
    this.#status(installed.definition.id, "hit-limit-reached");
    this.#audit(
      `[liveprobe] PROBE HIT LIMIT ${safeAuditText(installed.definition.file)}:` +
        String(installed.definition.line),
    );
    // Retiring this probe must not disarm another probe still sharing the line.
    const error = await this.#releaseBreakpointFor(installed);
    if (error !== null) {
      this.#error(installed.definition, `inspector-remove: ${error.message}`);
    }
  }

  async #uninstall(installed: InstalledProbe, auditAction: string): Promise<void> {
    installed.active = false;
    installed.pending = 0;
    this.#installed.delete(installed.definition.id);
    await this.#releaseBreakpointFor(installed);
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
