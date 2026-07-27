import { describe, expect, it } from "vitest";

import { CAPTURE_TRUNCATED_VALUE } from "../src/capture-marker.js";
import { capturePaused, type RawCapture } from "../src/capture.js";
import {
  matchesCondition,
  renderTemplate,
  resolveDotPath,
} from "../src/safe-values.js";
import { serialize } from "../src/serializer.js";
import type { PausedEvent } from "../src/types.js";

const paused: PausedEvent = {
  hitBreakpoints: ["bp-1"],
  callFrames: [
    {
      callFrameId: "frame-1",
      functionName: "work",
      location: { scriptId: "script-1", lineNumber: 4 },
      scopeChain: [
        {
          type: "local",
          object: { type: "object", objectId: "scope-1" },
        },
      ],
    },
  ],
};

describe("capture object budget", () => {
  it("materializes an explicit truncation marker without reading over budget", () => {
    const requested: string[] = [];
    let captured: RawCapture | undefined;
    capturePaused(
      {
        getProperties({ objectId }, callback) {
          requested.push(objectId);
          callback(null, {
            result: [
              {
                name: "child",
                enumerable: true,
                value: { type: "object", objectId: "child-1" },
              },
            ],
          });
        },
      } as never,
      paused,
      {
        maxArray: 3,
        maxDepth: 5,
        maxObjects: 1,
        maxProps: 50,
        maxStackFrames: 8,
        redactKeys: [],
        scriptPath: () => "/app/work.js",
      },
      (error, result) => {
        expect(error).toBeNull();
        captured = result;
      },
    );

    expect(requested).toEqual(["scope-1"]);
    expect(captured?.variables["child"]).toBe(CAPTURE_TRUNCATED_VALUE);
    expect(serialize(captured?.variables)).toEqual({
      t: "obj",
      c: {
        child: { t: "truncated", v: "props" },
      },
    });

    const nested = resolveDotPath(captured?.variables, "child.value");
    expect(nested.found).toBe(false);
    expect(nested.truncated).toBe(true);
    expect(nested.value).toBe(CAPTURE_TRUNCATED_VALUE);
    expect(serialize(nested.value)).toEqual({ t: "truncated", v: "props" });
    expect(
      matchesCondition(captured?.variables, {
        path: "child.value",
        op: "eq",
        value: "anything",
      }),
    ).toBe(false);
    expect(renderTemplate("value=${child.value}", captured?.variables)).toBe(
      "value=[truncated]",
    );
  });
});

describe("capture block scopes", () => {
  const OPTIONS = {
    maxArray: 3,
    maxDepth: 5,
    maxObjects: 200,
    maxProps: 50,
    maxStackFrames: 8,
    redactKeys: [],
    scriptPath: () => "/app/work.js",
  };

  /** A pause inside `for (let i …)`: V8 keeps `i` out of the local scope. */
  function pausedInLoop(): PausedEvent {
    return {
      hitBreakpoints: ["bp-1"],
      callFrames: [
        {
          callFrameId: "frame-1",
          functionName: "work",
          location: { scriptId: "script-1", lineNumber: 4 },
          scopeChain: [
            { type: "block", object: { type: "object", objectId: "block-1" } },
            { type: "local", object: { type: "object", objectId: "scope-1" } },
            { type: "closure", object: { type: "object", objectId: "closure-1" } },
            { type: "global", object: { type: "object", objectId: "global-1" } },
          ],
        },
      ],
    };
  }

  function scopeProperties(objectId: string) {
    const byScope: Record<string, Array<[string, unknown]>> = {
      "block-1": [
        ["i", 7],
        ["shadowed", "inner"],
      ],
      "scope-1": [
        ["acc", 3],
        ["shadowed", "outer"],
      ],
      "closure-1": [["closedOver", "leaked"]],
      "global-1": [["process", "leaked"]],
    };
    return {
      result: (byScope[objectId] ?? []).map(([name, value]) => ({
        name,
        enumerable: true,
        value: { type: typeof value, value } as never,
      })),
    };
  }

  function capture(event: PausedEvent): RawCapture {
    let result: RawCapture | undefined;
    capturePaused(
      {
        getProperties({ objectId }, callback) {
          callback(null, scopeProperties(objectId) as never);
        },
      } as never,
      event,
      OPTIONS,
      (_error, value) => {
        result = value;
      },
    );
    if (result === undefined) throw new Error("capture did not complete");
    return result;
  }

  it("captures block-scoped loop variables alongside frame locals", () => {
    const { variables } = capture(pausedInLoop());

    expect(variables["i"]).toBe(7);
    expect(variables["acc"]).toBe(3);
  });

  it("lets an inner binding shadow the enclosing one of the same name", () => {
    const { variables } = capture(pausedInLoop());

    expect(variables["shadowed"]).toBe("inner");
  });

  it("does not merge closure or global scopes into frame variables", () => {
    const { variables } = capture(pausedInLoop());

    expect(variables).not.toHaveProperty("closedOver");
    expect(variables).not.toHaveProperty("process");
  });
});
