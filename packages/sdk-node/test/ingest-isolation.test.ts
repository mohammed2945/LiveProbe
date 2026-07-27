import { describe, expect, it } from "vitest";

import { BrokerIngestError } from "../src/broker-client.js";
import { MAX_INGEST_SPLITS, ingestIsolating } from "../src/ingest-isolation.js";
import type { AgentEvent } from "../src/types.js";

function counter(probeId: string): AgentEvent {
  return { probeId, type: "counter", ts: "2026-07-27T12:00:00.000Z", delta: 1 };
}

const batch = ["a", "b", "c", "d", "e", "f", "g", "h"].map(counter);

/** Rejects any batch containing `poison`, mimicking whole-body validation. */
function rejectingSender(poison: string, attempts: AgentEvent[][]) {
  return async (events: AgentEvent[]): Promise<void> => {
    attempts.push(events);
    if (events.some((event) => event.probeId === poison)) {
      throw new BrokerIngestError(400);
    }
  };
}

describe("ingestIsolating", () => {
  it("delivers a clean batch in one request", async () => {
    const attempts: AgentEvent[][] = [];
    const result = await ingestIsolating(batch, rejectingSender("none", attempts));

    expect(result).toEqual({ rejected: [], deferred: [] });
    expect(attempts).toHaveLength(1);
  });

  it("drops only the rejected event and delivers the rest", async () => {
    const attempts: AgentEvent[][] = [];
    const result = await ingestIsolating(batch, rejectingSender("f", attempts));

    expect(result.rejected).toEqual([counter("f")]);
    expect(result.deferred).toEqual([]);
    // Every other event reached the broker in some accepted sub-batch.
    const delivered = new Set(
      attempts
        .filter((events) => !events.some((event) => event.probeId === "f"))
        .flatMap((events) => events.map((event) => event.probeId)),
    );
    expect([...delivered].sort()).toEqual(["a", "b", "c", "d", "e", "g", "h"]);
    // Bisecting eight events costs a handful of requests, not one per event.
    expect(attempts.length).toBeLessThanOrEqual(9);
  });

  it("isolates more than one rejected event", async () => {
    const attempts: AgentEvent[][] = [];
    const result = await ingestIsolating(batch, async (events) => {
      attempts.push(events);
      if (events.some((event) => event.probeId === "b" || event.probeId === "g")) {
        throw new BrokerIngestError(400);
      }
    });

    expect(result.rejected.map((event) => event.probeId)).toEqual(["b", "g"]);
    expect(result.deferred).toEqual([]);
  });

  it("defers the whole batch when the failure is transient", async () => {
    const attempts: AgentEvent[][] = [];
    const result = await ingestIsolating(batch, async (events) => {
      attempts.push(events);
      throw new Error("connect ECONNREFUSED");
    });

    expect(result.deferred).toEqual(batch);
    expect(result.rejected).toEqual([]);
    // A transient failure is not worth splitting: one attempt, then retry later.
    expect(attempts).toHaveLength(1);
  });

  it("defers a sub-batch that fails transiently mid-isolation", async () => {
    let seen = 0;
    const result = await ingestIsolating(batch, async (events) => {
      seen += 1;
      if (seen > 1 && events.some((event) => event.probeId === "a")) {
        throw new Error("connect ECONNREFUSED");
      }
      if (events.some((event) => event.probeId === "h")) {
        throw new BrokerIngestError(400);
      }
    });

    // The half that went down is retried; the half that was refused is dropped.
    expect(result.deferred.map((event) => event.probeId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(result.rejected).toEqual([counter("h")]);
  });

  it("gives up splitting when no subset can satisfy the broker", async () => {
    const attempts: AgentEvent[][] = [];
    // A 400 caused by a field outside `events` fails every sub-batch equally,
    // so nothing terminates the recursion except the budget. The batch is far
    // wider than log2 of the budget, which a per-branch depth cap would never
    // bound — the budget has to be spent across the whole retry tree.
    const wide = Array.from({ length: 400 }, (_unused, index) =>
      counter(`prb_${String(index)}`),
    );
    const result = await ingestIsolating(wide, async (events) => {
      attempts.push(events);
      throw new BrokerIngestError(400);
    });

    expect(result.rejected).toEqual(wide);
    expect(result.deferred).toEqual([]);
    expect(attempts.length).toBeLessThanOrEqual(2 * MAX_INGEST_SPLITS + 1);
  });

  it("preserves order when deferring across sub-batches", async () => {
    const result = await ingestIsolating(batch, async (events) => {
      if (events.length === batch.length) throw new BrokerIngestError(400);
      throw new Error("connect ECONNREFUSED");
    });

    expect(result.deferred).toEqual(batch);
  });
});
