import type { AgentEvent, CounterEvent, MetricEvent } from "./types.js";

interface BufferedEvent {
  event: AgentEvent;
  bytes: number;
}

export class EventBuffer {
  readonly #maxBytes: number;
  #events: BufferedEvent[] = [];
  #bytes = 0;
  #dropped = 0;

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
    this.#maxBytes = maxBytes;
  }

  get droppedEvents(): number {
    return this.#dropped;
  }

  get length(): number {
    return this.#events.length;
  }

  enqueue(event: AgentEvent): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > this.#maxBytes) {
      this.#dropped += 1;
      return false;
    }
    while (this.#bytes + bytes > this.#maxBytes && this.#events.length > 0) {
      const removed = this.#events.shift();
      if (removed !== undefined) {
        this.#bytes -= removed.bytes;
        this.#dropped += 1;
      }
    }
    this.#events.push({ event, bytes });
    this.#bytes += bytes;
    return true;
  }

  takeBatch(maxBytes: number): AgentEvent[] {
    if (this.#events.length === 0 || maxBytes <= 0) {
      return [];
    }
    const batch: AgentEvent[] = [];
    let bytes = 0;
    while (this.#events.length > 0) {
      const next = this.#events[0];
      if (next === undefined) break;
      if (batch.length > 0 && bytes + next.bytes > maxBytes) break;
      this.#events.shift();
      this.#bytes -= next.bytes;
      bytes += next.bytes;
      batch.push(next.event);
      if (bytes >= maxBytes) break;
    }
    return batch;
  }

  requeueFront(events: readonly AgentEvent[]): void {
    const restored = events.map((event) => ({
      event,
      bytes: Buffer.byteLength(JSON.stringify(event)),
    }));
    this.#events = [...restored, ...this.#events];
    this.#bytes = this.#events.reduce((total, item) => total + item.bytes, 0);
    while (this.#bytes > this.#maxBytes && this.#events.length > 0) {
      const removed = this.#events.pop();
      if (removed !== undefined) {
        this.#bytes -= removed.bytes;
        this.#dropped += 1;
      }
    }
  }

  recordRejected(events: readonly AgentEvent[]): void {
    this.#dropped += events.length;
  }
}

interface MetricAggregate {
  count: number;
  sum: number;
  min: number;
  max: number;
  last: number;
}

export class AggregateBuffer {
  readonly #counters = new Map<string, number>();
  readonly #metrics = new Map<string, MetricAggregate>();

  incrementCounter(probeId: string): void {
    this.#counters.set(probeId, (this.#counters.get(probeId) ?? 0) + 1);
  }

  recordMetric(probeId: string, value: number): void {
    if (!Number.isFinite(value)) return;
    const aggregate = this.#metrics.get(probeId);
    if (aggregate === undefined) {
      this.#metrics.set(probeId, {
        count: 1,
        sum: value,
        min: value,
        max: value,
        last: value,
      });
      return;
    }
    aggregate.count += 1;
    aggregate.sum += value;
    aggregate.min = Math.min(aggregate.min, value);
    aggregate.max = Math.max(aggregate.max, value);
    aggregate.last = value;
  }

  flush(now: Date = new Date()): Array<CounterEvent | MetricEvent> {
    const ts = now.toISOString();
    const events: Array<CounterEvent | MetricEvent> = [];
    for (const [probeId, delta] of this.#counters) {
      if (delta > 0) {
        events.push({ probeId, type: "counter", ts, delta });
      }
    }
    for (const [probeId, aggregate] of this.#metrics) {
      events.push({ probeId, type: "metric", ts, ...aggregate });
    }
    this.#counters.clear();
    this.#metrics.clear();
    return events;
  }
}
