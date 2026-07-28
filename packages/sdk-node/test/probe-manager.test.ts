import { describe, expect, it, vi } from "vitest";

import { AggregateBuffer, EventBuffer } from "../src/event-buffer.js";
import { ProbeManager } from "../src/probe-manager.js";
import { TokenBucket } from "../src/rate-limiter.js";
import { ScriptRegistry } from "../src/script-registry.js";
import { normalizeSerializerConfig } from "../src/serializer.js";
import type {
  GetPropertiesResult,
  PausedEvent,
  ProbeDefinition,
  SetBreakpointResult,
} from "../src/types.js";

function probe(overrides: Partial<ProbeDefinition> = {}): ProbeDefinition {
  return {
    id: "prb_snapshot",
    serviceId: "payments",
    type: "snapshot",
    file: "src/payments.js",
    line: 10,
    watchPaths: ["user.tier"],
    hitLimit: 1,
    ttlSeconds: 1800,
    version: 1,
    createdBy: "mcp:test",
    ...overrides,
  };
}

function paused(hitBreakpoints: string[]): PausedEvent {
  return {
    hitBreakpoints,
    callFrames: [
      {
        callFrameId: "frame-1",
        functionName: "charge",
        location: { scriptId: "script-1", lineNumber: 9 },
        scopeChain: [
          {
            type: "local",
            object: { type: "object", objectId: "scope-1" },
          },
        ],
      },
    ],
  };
}

function createInspector(
  commands: string[],
  options: {
    disconnectError?: Error;
    propertyError?: boolean;
    resumeCallbacks?: Array<(error: Error | null) => void>;
    resumeErrors?: Error[];
  } = {},
) {
  return {
    disconnect() {
      commands.push("disconnect");
      if (options.disconnectError !== undefined) {
        throw options.disconnectError;
      }
    },
    setBreakpointByUrl(
      params: { lineNumber: number; columnNumber?: number; url: string },
      callback: (error: Error | null, result?: SetBreakpointResult) => void,
    ) {
      commands.push(
        params.columnNumber === undefined || params.columnNumber === 0
          ? `set:${String(params.lineNumber + 1)}`
          : `set:${String(params.lineNumber + 1)}:${String(params.columnNumber)}`,
      );
      callback(null, {
        breakpointId: `bp-${String(params.lineNumber + 1)}`,
        locations: [{ scriptId: "script-1", lineNumber: params.lineNumber }],
      });
    },
    removeBreakpoint(
      params: { breakpointId: string },
      callback: (error: Error | null) => void,
    ) {
      commands.push(`remove:${params.breakpointId}`);
      callback(null);
    },
    resume(callback: (error: Error | null) => void) {
      commands.push("resume");
      if (options.resumeCallbacks !== undefined) {
        options.resumeCallbacks.push(callback);
        return;
      }
      callback(options.resumeErrors?.shift() ?? null);
    },
    getProperties(
      params: { objectId: string },
      callback: (error: Error | null, result?: GetPropertiesResult) => void,
    ) {
      commands.push(`get:${params.objectId}`);
      if (options.propertyError === true) {
        callback(new Error("object expired"));
        return;
      }
      if (params.objectId === "scope-1") {
        callback(null, {
          result: [
            {
              name: "user",
              enumerable: true,
              value: { type: "object", objectId: "user-1" },
            },
            {
              name: "amount",
              enumerable: true,
              value: { type: "number", value: 4 },
            },
          ],
        });
      } else {
        callback(null, {
          result: [
            {
              name: "tier",
              enumerable: true,
              value: { type: "string", value: "free" },
            },
            {
              name: "token",
              enumerable: true,
              value: { type: "string", value: "must-not-escape" },
            },
          ],
        });
      }
    },
  };
}

function setup(
  inspector: ReturnType<typeof createInspector>,
  rateLimiter = new TokenBucket(10, () => 0),
) {
  const scripts = new ScriptRegistry();
  scripts.register({ scriptId: "script-1", url: "file:///app/src/payments.js" });
  const events = new EventBuffer(100_000);
  const aggregates = new AggregateBuffer();
  const audit: string[] = [];
  const manager = new ProbeManager({
    inspector: inspector as never,
    scripts,
    serializerConfig: normalizeSerializerConfig(),
    rateLimiter,
    events,
    aggregates,
    audit: (line) => audit.push(line),
  });
  return { manager, events, aggregates, audit };
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("ProbeManager paused ordering", () => {
  it("captures synchronously, resumes, then serializes and enforces hit limits", async () => {
    const commands: string[] = [];
    const inspector = createInspector(commands);
    const { manager, events } = setup(inspector);
    await manager.reconcile([probe()]);
    events.takeBatch(100_000);
    commands.length = 0;
    const enqueue = vi.spyOn(events, "enqueue").mockImplementation(() => {
      commands.push("enqueue");
      return true;
    });

    manager.handlePaused(paused(["bp-10"]));
    expect(commands).toEqual(["get:scope-1", "get:user-1", "resume"]);

    await nextImmediate();
    expect(commands[0]).toBe("get:scope-1");
    expect(commands.indexOf("resume")).toBeLessThan(commands.indexOf("enqueue"));
    expect(commands).toContain("remove:bp-10");
    expect(enqueue.mock.calls.map(([event]) => event.type)).toEqual([
      "snapshot",
      "status",
    ]);
  });

  it("resumes after property errors and reports them after the paused window", async () => {
    const commands: string[] = [];
    const inspector = createInspector(commands, { propertyError: true });
    const { manager, events } = setup(inspector);
    await manager.reconcile([probe()]);
    events.takeBatch(100_000);
    commands.length = 0;

    manager.handlePaused(paused(["bp-10"]));
    expect(commands).toEqual(["get:scope-1", "resume"]);
    await nextImmediate();

    expect(events.takeBatch(100_000)).toEqual([
      expect.objectContaining({
        probeId: "prb_snapshot",
        type: "status",
        status: "error",
        detail: "inspector-capture: object expired",
      }),
    ]);
  });

  it("disconnects after two resume failures and never processes the hit", async () => {
    const commands: string[] = [];
    const inspector = createInspector(commands, {
      resumeErrors: [new Error("resume failed"), new Error("retry failed")],
    });
    const { manager, events } = setup(inspector);
    await manager.reconcile([probe()]);
    events.takeBatch(100_000);
    commands.length = 0;

    manager.handlePaused(paused(["bp-10"]));
    expect(commands).toEqual([
      "get:scope-1",
      "get:user-1",
      "resume",
      "resume",
      "disconnect",
    ]);
    await nextImmediate();

    expect(events.takeBatch(100_000)).toEqual([
      expect.objectContaining({
        probeId: "prb_snapshot",
        type: "status",
        status: "error",
        detail:
          "inspector-resume-failed: resume failed; retry: retry failed; session disconnected",
      }),
    ]);
    expect(manager.armedCount).toBe(0);
    expect(commands).not.toContain("remove:bp-10");
  });

  it("surfaces a failed disconnect fallback without processing the hit", async () => {
    const commands: string[] = [];
    const inspector = createInspector(commands, {
      resumeErrors: [new Error("first"), new Error("second")],
      disconnectError: new Error("disconnect broke"),
    });
    const { manager, events } = setup(inspector);
    await manager.reconcile([probe()]);
    events.takeBatch(100_000);

    manager.handlePaused(paused(["bp-10"]));
    await nextImmediate();

    expect(commands).toContain("disconnect");
    expect(events.takeBatch(100_000)).toEqual([
      expect.objectContaining({
        type: "status",
        status: "error",
        detail:
          "inspector-resume-failed: first; retry: second; disconnect failed: disconnect broke",
      }),
    ]);
  });

  it("checks the local rate limit before requesting any properties", async () => {
    const commands: string[] = [];
    const limiter = new TokenBucket(1, () => 0);
    expect(limiter.tryTake()).toBe(true);
    const { manager, events } = setup(createInspector(commands), limiter);
    await manager.reconcile([probe()]);
    events.takeBatch(100_000);
    commands.length = 0;

    manager.handlePaused(paused(["bp-10"]));

    expect(commands).toEqual(["resume"]);
    expect(manager.droppedHits).toBe(1);
  });
});

describe("ProbeManager pipelines", () => {
  it("renders logs and aggregates counters and metrics", async () => {
    const commands: string[] = [];
    const { manager, events, aggregates, audit } = setup(createInspector(commands));
    await manager.reconcile([
      probe({
        id: "log",
        type: "log",
        line: 10,
        template: "tier=${user.tier} token=${user.token}",
        logLevel: "warn",
        hitLimit: 2,
      }),
      probe({ id: "counter", type: "counter", line: 11, hitLimit: 2 }),
      probe({
        id: "metric",
        type: "metric",
        line: 12,
        metricPath: "amount",
        hitLimit: 2,
      }),
    ]);
    events.takeBatch(100_000);

    manager.handlePaused(paused(["bp-10", "bp-11", "bp-12"]));
    await nextImmediate();

    expect(events.takeBatch(100_000)).toEqual([
      expect.objectContaining({
        probeId: "log",
        type: "log",
        message: "tier=free token=[REDACTED]",
        level: "warn",
      }),
    ]);
    expect(aggregates.flush(new Date("2026-07-19T18:30:02.000Z"))).toEqual([
      expect.objectContaining({ probeId: "counter", type: "counter", delta: 1 }),
      expect.objectContaining({
        probeId: "metric",
        type: "metric",
        count: 1,
        sum: 4,
        min: 4,
        max: 4,
        last: 4,
      }),
    ]);
    expect(audit).toContain("[liveprobe] tier=free token=[REDACTED]");
  });

  it("evaluates safe conditions, watches, logs, and metrics", async () => {
    const commands: string[] = [];
    const { manager, events, aggregates } = setup(createInspector(commands));
    const doubled = {
      source: "amount * 2",
      ast: {
        type: "binary" as const,
        operator: "multiply" as const,
        left: { type: "reference" as const, path: ["amount"] },
        right: { type: "literal" as const, value: 2 },
      },
    };
    const positive = {
      source: "amount > 0",
      ast: {
        type: "binary" as const,
        operator: "gt" as const,
        left: { type: "reference" as const, path: ["amount"] },
        right: { type: "literal" as const, value: 0 },
      },
    };
    await manager.reconcile([
      probe({
        id: "snapshot-expression",
        conditionExpression: positive,
        watchExpressions: [doubled],
        includeStackLocals: true,
        stackFrameLimit: 1,
        hitLimit: 2,
      }),
      probe({
        id: "log-expression",
        type: "log",
        line: 11,
        template: "double=${amount * 2}",
        templateSegments: [
          { type: "text", value: "double=" },
          { type: "expression", expression: doubled },
        ],
        hitLimit: 2,
      }),
      probe({
        id: "metric-expression",
        type: "metric",
        line: 12,
        metricExpression: doubled,
        hitLimit: 2,
      }),
    ]);
    events.takeBatch(100_000);

    manager.handlePaused(paused(["bp-10", "bp-11", "bp-12"]));
    await nextImmediate();

    expect(events.takeBatch(100_000)).toEqual([
      expect.objectContaining({
        probeId: "snapshot-expression",
        watches: expect.objectContaining({
          "amount * 2": { t: "num", v: 8 },
        }),
        stack: [
          expect.objectContaining({
            variables: expect.objectContaining({
              t: "obj",
            }),
          }),
        ],
      }),
      expect.objectContaining({
        probeId: "log-expression",
        message: "double=8",
      }),
    ]);
    expect(aggregates.flush()).toEqual([
      expect.objectContaining({
        probeId: "metric-expression",
        count: 1,
        sum: 8,
      }),
    ]);
  });

  it("filters false post-capture conditions without consuming the hit limit", async () => {
    const commands: string[] = [];
    const { manager, events } = setup(createInspector(commands));
    await manager.reconcile([
      probe({
        condition: { path: "user.tier", op: "eq", value: "pro" },
      }),
    ]);
    events.takeBatch(100_000);

    manager.handlePaused(paused(["bp-10"]));
    await nextImmediate();

    expect(events.takeBatch(100_000)).toEqual([]);
    expect(commands).not.toContain("remove:bp-10");
  });
});

describe("ProbeManager in-flight invalidation", () => {
  it("drops emit, log, and aggregate work captured before suspension", async () => {
    const commands: string[] = [];
    const resumeCallbacks: Array<(error: Error | null) => void> = [];
    const { manager, events, aggregates, audit } = setup(
      createInspector(commands, { resumeCallbacks }),
    );
    await manager.reconcile([
      probe({ id: "log", type: "log", line: 10, template: "tier=${user.tier}", hitLimit: 2 }),
      probe({ id: "counter", type: "counter", line: 11, hitLimit: 2 }),
      probe({
        id: "metric",
        type: "metric",
        line: 12,
        metricPath: "amount",
        hitLimit: 2,
      }),
    ]);
    events.takeBatch(100_000);
    const auditCount = audit.length;

    manager.handlePaused(paused(["bp-10", "bp-11", "bp-12"]));
    expect(resumeCallbacks).toHaveLength(1);
    await manager.suspendAll("safety-red");
    events.takeBatch(100_000);
    resumeCallbacks.shift()?.(null);
    await nextImmediate();

    expect(events.takeBatch(100_000)).toEqual([]);
    expect(aggregates.flush()).toEqual([]);
    expect(audit).toHaveLength(auditCount);
  });

  it("drops a captured hit when stop wins before resume completes", async () => {
    const commands: string[] = [];
    const resumeCallbacks: Array<(error: Error | null) => void> = [];
    const { manager, events, aggregates, audit } = setup(
      createInspector(commands, { resumeCallbacks }),
    );
    await manager.reconcile([
      probe({ id: "counter", type: "counter", hitLimit: 2 }),
    ]);
    events.takeBatch(100_000);
    const auditCount = audit.length;

    manager.handlePaused(paused(["bp-10"]));
    expect(resumeCallbacks).toHaveLength(1);
    await manager.stop();
    resumeCallbacks.shift()?.(null);
    await nextImmediate();

    expect(events.takeBatch(100_000)).toEqual([]);
    expect(aggregates.flush()).toEqual([]);
    expect(audit).toHaveLength(auditCount);
  });

  it("drops a captured hit when broker reconciliation removes its probe", async () => {
    const commands: string[] = [];
    const resumeCallbacks: Array<(error: Error | null) => void> = [];
    const { manager, events } = setup(
      createInspector(commands, { resumeCallbacks }),
    );
    await manager.reconcile([probe({ hitLimit: 2 })]);
    events.takeBatch(100_000);

    manager.handlePaused(paused(["bp-10"]));
    expect(resumeCallbacks).toHaveLength(1);
    await manager.reconcile([]);
    resumeCallbacks.shift()?.(null);
    await nextImmediate();

    expect(events.takeBatch(100_000)).toEqual([]);
  });
});

describe("ProbeManager reconciliation", () => {
  it("installs broker-resolved generated line and column coordinates", async () => {
    const commands: string[] = [];
    const scripts = new ScriptRegistry();
    scripts.register({
      scriptId: "generated",
      url: "file:///app/dist/payments.js",
    });
    const events = new EventBuffer(100_000);
    const manager = new ProbeManager({
      inspector: createInspector(commands) as never,
      scripts,
      serializerConfig: normalizeSerializerConfig(),
      rateLimiter: new TokenBucket(10, () => 0),
      events,
      aggregates: new AggregateBuffer(),
      audit: () => {},
    });

    await manager.reconcile([
      probe({
        file: "src/payments.ts",
        line: 10,
        runtimeLocation: "dist/payments.js",
        runtimeLine: 71,
        runtimeColumn: 4,
      }),
    ]);

    expect(commands).toContain("set:71:4");
    expect(events.takeBatch(100_000)).toEqual([
      expect.objectContaining({ type: "status", status: "armed" }),
    ]);
  });

  it("removes breakpoints absent from the broker's full snapshot", async () => {
    const commands: string[] = [];
    const { manager, events } = setup(createInspector(commands));
    await manager.reconcile([probe()]);
    events.takeBatch(100_000);

    await manager.reconcile([]);

    expect(manager.armedCount).toBe(0);
    expect(commands).toContain("remove:bp-10");
  });

  it("reports unresolved scripts and arms when the script later appears", async () => {
    const commands: string[] = [];
    const scripts = new ScriptRegistry();
    const events = new EventBuffer(100_000);
    const manager = new ProbeManager({
      inspector: createInspector(commands) as never,
      scripts,
      serializerConfig: normalizeSerializerConfig(),
      rateLimiter: new TokenBucket(10, () => 0),
      events,
      aggregates: new AggregateBuffer(),
      audit: () => {},
    });

    await manager.reconcile([probe()]);
    expect(events.takeBatch(100_000)).toEqual([
      expect.objectContaining({
        type: "status",
        status: "error",
        detail: "line-not-found: src/payments.js:10",
      }),
    ]);

    scripts.register({ scriptId: "script-1", url: "file:///app/src/payments.js" });
    await manager.onScriptAvailable();

    expect(manager.armedCount).toBe(1);
    expect(events.takeBatch(100_000)).toEqual([
      expect.objectContaining({ type: "status", status: "armed" }),
    ]);
  });

  it("reports equally specific script suffixes as ambiguous", async () => {
    const commands: string[] = [];
    const scripts = new ScriptRegistry();
    scripts.register({ scriptId: "one", url: "file:///srv/a/src/payments.js" });
    scripts.register({ scriptId: "two", url: "file:///srv/b/src/payments.js" });
    const events = new EventBuffer(100_000);
    const manager = new ProbeManager({
      inspector: createInspector(commands) as never,
      scripts,
      serializerConfig: normalizeSerializerConfig(),
      rateLimiter: new TokenBucket(10, () => 0),
      events,
      aggregates: new AggregateBuffer(),
      audit: () => {},
    });

    await manager.reconcile([probe()]);

    expect(commands.some((command) => command.startsWith("set:"))).toBe(false);
    expect(events.takeBatch(100_000)).toEqual([
      expect.objectContaining({
        type: "status",
        status: "error",
        detail:
          "ambiguous-script: src/payments.js matched /srv/a/src/payments.js, /srv/b/src/payments.js",
      }),
    ]);
  });
});

describe("ProbeManager counters under rate limiting", () => {
  function counterProbe(overrides: Partial<ProbeDefinition> = {}): ProbeDefinition {
    return probe({
      id: "prb_counter",
      type: "counter",
      watchPaths: undefined,
      hitLimit: 10_000,
      ...overrides,
    });
  }

  it("counts every hit even when the capture budget is exhausted", async () => {
    const commands: string[] = [];
    const inspector = createInspector(commands);
    // A bucket that never yields a token: every hit takes the rate-limited path.
    const { manager, aggregates } = setup(inspector, new TokenBucket(1, () => 0));
    await manager.reconcile([counterProbe()]);
    // Drain the token the bucket starts full with.
    manager.handlePaused(paused(["bp-10"]));

    for (let index = 0; index < 500; index += 1) {
      manager.handlePaused(paused(["bp-10"]));
    }
    await nextImmediate();

    expect(aggregates.flush()).toEqual([
      expect.objectContaining({ probeId: "prb_counter", delta: 501 }),
    ]);
    // Counting is not capture, so nothing was dropped.
    expect(manager.droppedHits).toBe(0);
  });

  it("retires a rate-limited counter at its hit limit", async () => {
    const commands: string[] = [];
    const inspector = createInspector(commands);
    const { manager, events, aggregates } = setup(
      inspector,
      new TokenBucket(1, () => 0),
    );
    await manager.reconcile([counterProbe({ hitLimit: 3 })]);
    events.takeBatch(100_000);

    for (let index = 0; index < 20; index += 1) {
      manager.handlePaused(paused(["bp-10"]));
    }
    await nextImmediate();

    expect(aggregates.flush()).toEqual([
      expect.objectContaining({ probeId: "prb_counter", delta: 3 }),
    ]);
    expect(events.takeBatch(100_000)).toEqual([
      expect.objectContaining({ status: "hit-limit-reached" }),
    ]);
  });

  it("still drops captures for a conditional counter", async () => {
    const commands: string[] = [];
    const inspector = createInspector(commands);
    const { manager, aggregates } = setup(inspector, new TokenBucket(1, () => 0));
    await manager.reconcile([
      counterProbe({ condition: { path: "amount", op: "gt", value: 0 } }),
    ]);
    manager.handlePaused(paused(["bp-10"]));

    manager.handlePaused(paused(["bp-10"]));
    await nextImmediate();

    expect(aggregates.flush()).toEqual([
      expect.objectContaining({ probeId: "prb_counter", delta: 1 }),
    ]);
    expect(manager.droppedHits).toBe(1);
  });
});

describe("ProbeManager counter and metric reporting", () => {
  // Reproductions for two QA reports that no code change was made for. They
  // exist so a regression would surface as a failure rather than a rumour.
  it("reports a small hit count in full rather than as zero", async () => {
    const commands: string[] = [];
    const inspector = createInspector(commands);
    // The default budget: five hits sit well inside it, so nothing is dropped.
    const { manager, aggregates } = setup(inspector);
    await manager.reconcile([
      probe({ id: "prb_counter", type: "counter", watchPaths: undefined, hitLimit: 10_000 }),
    ]);

    for (let index = 0; index < 5; index += 1) {
      manager.handlePaused(paused(["bp-10"]));
    }
    await nextImmediate();

    expect(aggregates.flush()).toEqual([
      expect.objectContaining({ probeId: "prb_counter", delta: 5 }),
    ]);
  });

  it("explains why a metric expression failed instead of erroring blankly", async () => {
    const commands: string[] = [];
    const inspector = createInspector(commands);
    const { manager, events } = setup(inspector);
    await manager.reconcile([
      probe({
        id: "prb_metric",
        type: "metric",
        watchPaths: undefined,
        // `missing` is not in scope at the probe's line.
        metricExpression: {
          source: "missing * 2",
          ast: {
            type: "binary" as const,
            operator: "multiply" as const,
            left: { type: "reference" as const, path: ["missing"] },
            right: { type: "literal" as const, value: 2 },
          },
        },
        hitLimit: 10,
      }),
    ]);
    events.takeBatch(100_000);

    manager.handlePaused(paused(["bp-10"]));
    await nextImmediate();

    const [status] = events.takeBatch(100_000);
    expect(status).toEqual(
      expect.objectContaining({ probeId: "prb_metric", status: "error" }),
    );
    expect((status as { detail?: string }).detail).toMatch(/^invalid-metric: missing \* 2/u);
  });
});

/**
 * An inspector that enforces V8's real constraint: one breakpoint per resolved
 * location, and an error on any attempt to add a second. Without this the
 * sharing under test is invisible, because a permissive fake accepts the
 * duplicate request the agent is supposed to avoid making.
 */
function createSharedLineInspector(commands: string[]) {
  const base = createInspector(commands);
  const live = new Map<string, string>();
  let sequence = 0;
  return {
    ...base,
    setBreakpointByUrl(
      params: { lineNumber: number; columnNumber?: number; url: string },
      callback: (error: Error | null, result?: SetBreakpointResult) => void,
    ) {
      const column = params.columnNumber ?? 0;
      const key = `${String(params.lineNumber)}:${String(column)}`;
      commands.push(`set:${String(params.lineNumber + 1)}`);
      if (live.has(key)) {
        callback(new Error("Breakpoint at specified location already exists."));
        return;
      }
      sequence += 1;
      const breakpointId = `bp-${String(sequence)}`;
      live.set(key, breakpointId);
      callback(null, {
        breakpointId,
        locations: [
          {
            scriptId: "script-1",
            lineNumber: params.lineNumber,
            columnNumber: column,
          },
        ],
      });
    },
    removeBreakpoint(
      params: { breakpointId: string },
      callback: (error: Error | null) => void,
    ) {
      commands.push(`remove:${params.breakpointId}`);
      for (const [key, id] of [...live]) {
        if (id === params.breakpointId) live.delete(key);
      }
      callback(null);
    },
  };
}

function counterProbe(id: string, overrides: Partial<ProbeDefinition> = {}) {
  return probe({
    id,
    type: "counter",
    hitLimit: 100,
    watchPaths: undefined,
    ...overrides,
  });
}

/**
 * Drains the aggregates into a lookup. Flushing is destructive, so every probe
 * of interest has to be read from one flush rather than one flush each.
 */
function counterDeltas(aggregates: AggregateBuffer): Record<string, number> {
  const deltas: Record<string, number> = {};
  for (const event of aggregates.flush()) {
    if (event.type === "counter") deltas[event.probeId] = event.delta;
  }
  return deltas;
}

describe("ProbeManager breakpoint sharing", () => {
  it("arms several probes on one line from a single breakpoint", async () => {
    const commands: string[] = [];
    const { manager, audit } = setup(createSharedLineInspector(commands) as never);

    await manager.reconcile([counterProbe("prb_a"), counterProbe("prb_b")]);

    expect(commands.filter((command) => command === "set:10")).toHaveLength(1);
    expect(audit.filter((line) => line.includes("PROBE ARMED"))).toHaveLength(2);
    expect(audit.some((line) => line.includes("inspector-arm"))).toBe(false);
  });

  it("delivers one pause to every probe sharing the breakpoint", async () => {
    const commands: string[] = [];
    const { manager, aggregates } = setup(
      createSharedLineInspector(commands) as never,
    );
    await manager.reconcile([counterProbe("prb_a"), counterProbe("prb_b")]);

    manager.handlePaused(paused(["bp-1"]));
    await nextImmediate();

    expect(counterDeltas(aggregates)).toEqual({ prb_a: 1, prb_b: 1 });
  });

  it("charges the hit budget once per pause, not once per probe", async () => {
    const commands: string[] = [];
    // A single token: two probes on the line must not need two of them.
    const { manager, aggregates } = setup(
      createSharedLineInspector(commands) as never,
      new TokenBucket(1, () => 0),
    );
    await manager.reconcile([
      counterProbe("prb_a", { type: "log", template: "hit" }),
      counterProbe("prb_b", { type: "log", template: "hit" }),
    ]);

    manager.handlePaused(paused(["bp-1"]));
    await nextImmediate();

    expect(commands.filter((command) => command === "resume")).toHaveLength(1);
  });

  it("keeps the breakpoint while another probe still needs it", async () => {
    const commands: string[] = [];
    const { manager } = setup(createSharedLineInspector(commands) as never);
    await manager.reconcile([counterProbe("prb_a"), counterProbe("prb_b")]);
    commands.length = 0;

    await manager.reconcile([counterProbe("prb_a")]);
    expect(commands.some((command) => command.startsWith("remove:"))).toBe(false);

    await manager.reconcile([]);
    expect(commands.filter((command) => command === "remove:bp-1")).toHaveLength(1);
  });

  it("does not disarm a line when one of its probes hits its limit", async () => {
    const commands: string[] = [];
    const { manager, aggregates } = setup(
      createSharedLineInspector(commands) as never,
    );
    await manager.reconcile([
      counterProbe("prb_short", { hitLimit: 1 }),
      counterProbe("prb_long"),
    ]);
    commands.length = 0;

    manager.handlePaused(paused(["bp-1"]));
    await nextImmediate();
    expect(counterDeltas(aggregates)).toEqual({ prb_short: 1, prb_long: 1 });
    expect(commands.some((command) => command.startsWith("remove:"))).toBe(false);

    // The surviving probe still fires: retiring its neighbour left the shared
    // breakpoint in place.
    manager.handlePaused(paused(["bp-1"]));
    await nextImmediate();
    expect(counterDeltas(aggregates)).toEqual({ prb_long: 1 });
  });

  it("gives probes on different lines their own breakpoints", async () => {
    const commands: string[] = [];
    const { manager, aggregates } = setup(
      createSharedLineInspector(commands) as never,
    );

    await manager.reconcile([
      counterProbe("prb_a"),
      counterProbe("prb_b", { line: 20 }),
    ]);

    expect(commands.filter((command) => command.startsWith("set:"))).toEqual([
      "set:10",
      "set:20",
    ]);
    manager.handlePaused(paused(["bp-2"]));
    await nextImmediate();
    expect(counterDeltas(aggregates)).toEqual({ prb_b: 1 });
  });
});
