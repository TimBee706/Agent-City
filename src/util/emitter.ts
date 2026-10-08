/** Minimal, vscode-independent event emitter so backend logic stays unit-testable. */
export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (value: T) => void;

export class Emitter<T> implements Disposable {
  private listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(value);
      } catch (err) {
        // A faulty listener must never break the producer.
        console.error('[claude-city] listener error', err);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
