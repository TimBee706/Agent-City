import type { Timers } from '../../src/backend/SessionManager';
import type { MementoLike } from '../../src/backend/WorkspaceRegistry';

export class MemoryMemento implements MementoLike {
  readonly data = new Map<string, unknown>();
  updates = 0;
  get<T>(key: string): T | undefined {
    // Simulate VS Code's JSON round trip.
    const v = this.data.get(key);
    return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as T);
  }
  async update(key: string, value: unknown): Promise<void> {
    this.updates++;
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

/** Manually driven timers. */
export class FakeTimers implements Timers {
  private nextId = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Delays of currently scheduled timers. */
  delays(): number[] {
    return [...this.pending.values()].map((p) => p.ms);
  }
  /** Runs all currently pending timers once. */
  flush(): void {
    const items = [...this.pending.entries()];
    this.pending.clear();
    for (const [, p] of items) p.fn();
  }
}

/** Waits for queued promise callbacks. */
export async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}
