import { describe, expect, it } from "vitest";

import { AggregateBuffer, EventBuffer } from "../src/event-buffer.js";
import type { AgentEvent } from "../src/types.js";

function status(probeId: string, detail: string): AgentEvent {
  return {
    probeId,
    type: "status",
    ts: "2026-07-19T18:30:00.000Z",
    status: "armed",
    detail,
  };
}

describe("EventBuffer", () => {
  it("caps queued bytes and accounts for dropped events", () => {
    const sample = status("one", "x");
    const eventBytes = Buffer.byteLength(JSON.stringify(sample));
    const buffer = new EventBuffer(eventBytes + 5);

    expect(buffer.enqueue(sample)).toBe(true);
    expect(buffer.enqueue(status("two", "y"))).toBe(true);
    expect(buffer.length).toBe(1);
    expect(buffer.droppedEvents).toBe(1);
    expect(buffer.takeBatch(100_000)[0]?.probeId).toBe("two");
  });

  it("restores failed batches at the front", () => {
    const buffer = new EventBuffer(10_000);
    buffer.enqueue(status("old", "first"));
    const failed = buffer.takeBatch(10_000);
    buffer.enqueue(status("new", "second"));
    buffer.requeueFront(failed);

    expect(buffer.takeBatch(10_000).map((event) => event.probeId)).toEqual(["old", "new"]);
  });

  it("accounts for batches rejected as non-retryable", () => {
    const buffer = new EventBuffer(10_000);
    buffer.enqueue(status("removed", "stale"));
    const rejected = buffer.takeBatch(10_000);

    buffer.recordRejected(rejected);

    expect(buffer.length).toBe(0);
    expect(buffer.droppedEvents).toBe(1);
  });
});

describe("AggregateBuffer", () => {
  it("flushes counters and metric statistics as one event per probe", () => {
    const aggregates = new AggregateBuffer();
    aggregates.incrementCounter("counter");
    aggregates.incrementCounter("counter");
    aggregates.recordMetric("metric", 4);
    aggregates.recordMetric("metric", 2);
    aggregates.recordMetric("metric", 9);

    expect(aggregates.flush(new Date("2026-07-19T18:30:02.000Z"))).toEqual([
      {
        probeId: "counter",
        type: "counter",
        ts: "2026-07-19T18:30:02.000Z",
        delta: 2,
      },
      {
        probeId: "metric",
        type: "metric",
        ts: "2026-07-19T18:30:02.000Z",
        count: 3,
        sum: 15,
        min: 2,
        max: 9,
        last: 9,
      },
    ]);
    expect(aggregates.flush()).toEqual([]);
  });
});
