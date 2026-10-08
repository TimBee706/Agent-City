import { AgentEvent, eventDedupeKey } from '../models/AgentEvent';

/**
 * Fixed-size ring buffer of AgentEvents with dedupe by id and by
 * (type + sessionId + agentId + 1s timestamp bucket).
 */
export class EventStore {
  private readonly buffer: (AgentEvent | undefined)[];
  private start = 0;
  private size = 0;
  private readonly ids = new Set<string>();
  private readonly keys = new Set<string>();

  constructor(readonly capacity = 500) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer');
    this.buffer = new Array(capacity);
  }

  /** Adds events, returns only those actually inserted (not duplicates), in insertion order. */
  add(events: readonly AgentEvent[]): AgentEvent[] {
    const added: AgentEvent[] = [];
    for (const e of events) {
      const key = eventDedupeKey(e);
      if (this.ids.has(e.id) || this.keys.has(key)) continue;
      if (this.size === this.capacity) this.evictOldest();
      this.buffer[(this.start + this.size) % this.capacity] = e;
      this.size++;
      this.ids.add(e.id);
      this.keys.add(key);
      added.push(e);
    }
    return added;
  }

  private evictOldest(): void {
    const old = this.buffer[this.start];
    if (old) {
      this.ids.delete(old.id);
      this.keys.delete(eventDedupeKey(old));
    }
    this.buffer[this.start] = undefined;
    this.start = (this.start + 1) % this.capacity;
    this.size--;
  }

  /** Oldest -> newest. Optional limit returns the newest `limit` events. */
  list(limit?: number): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (let i = 0; i < this.size; i++) out.push(this.buffer[(this.start + i) % this.capacity]!);
    return limit !== undefined && limit < out.length ? out.slice(out.length - limit) : out;
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.start = 0;
    this.size = 0;
    this.ids.clear();
    this.keys.clear();
  }
}
