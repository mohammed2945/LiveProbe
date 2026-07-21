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
