import { BrokerIngestError } from "./broker-client.js";
import type { AgentEvent } from "./types.js";

/**
 * How many times one flush may halve a rejected batch. Isolating a single bad
 * event out of a batch of N costs about log2(N) splits; the cap keeps a 400
 * that no subset can satisfy from turning every flush into a request storm.
 */
export const MAX_INGEST_SPLITS = 8;

export interface IngestIsolation {
  /** Events the broker refused. Retrying them would fail identically. */
  rejected: AgentEvent[];
  /** Events undelivered for a transient reason, in their original order. */
  deferred: AgentEvent[];
}

/**
 * Sends a batch, narrowing a rejection down to the events that caused it.
 *
 * A 400 says the payload failed validation but not which event was at fault,
 * and the batch is a single request — so discarding it discards every valid
 * event alongside the bad one. Halving and retrying isolates the offender
 * instead. A 400 caused by a field outside `events` (service id, agent status)
 * fails every subset equally, which is what the split budget bounds.
 *
 * `send` resolves on delivery and rejects on failure; anything other than a
 * 400 is treated as transient and its events are deferred rather than dropped.
 */
export async function ingestIsolating(
  events: AgentEvent[],
  send: (batch: AgentEvent[]) => Promise<void>,
  budget: { splits: number } = { splits: MAX_INGEST_SPLITS },
): Promise<IngestIsolation> {
  try {
    await send(events);
    return { rejected: [], deferred: [] };
  } catch (error) {
    if (!(error instanceof BrokerIngestError) || error.statusCode !== 400) {
      return { rejected: [], deferred: events };
    }
    if (events.length <= 1 || budget.splits <= 0) {
      return { rejected: events, deferred: [] };
    }
  }
  budget.splits -= 1;
  const middle = Math.ceil(events.length / 2);
  const first = await ingestIsolating(events.slice(0, middle), send, budget);
  const second = await ingestIsolating(events.slice(middle), send, budget);
  return {
    rejected: [...first.rejected, ...second.rejected],
    deferred: [...first.deferred, ...second.deferred],
  };
}
