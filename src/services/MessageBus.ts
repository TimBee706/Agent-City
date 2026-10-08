import {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  parseWebviewMessage,
} from '../shared/protocol';
import { Disposable } from '../util/emitter';

/** Subset of vscode.Webview used here (keeps the bus unit-testable without vscode). */
export interface WebviewLike {
  postMessage(message: unknown): PromiseLike<boolean>;
  onDidReceiveMessage(listener: (message: unknown) => void): Disposable;
}

export type MessageHandler = (message: WebviewToExtensionMessage) => void;

/**
 * Typed, validating message channel to one webview.
 * Incoming messages are validated against the protocol; unknown/malformed ones are dropped.
 */
export class MessageBus implements Disposable {
  private readonly subscription: Disposable;
  private disposed = false;
  rejectedCount = 0;

  constructor(
    private readonly webview: WebviewLike,
    handler: MessageHandler,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    this.subscription = webview.onDidReceiveMessage((raw) => {
      const msg = parseWebviewMessage(raw);
      if (!msg) {
        this.rejectedCount++;
        this.log(`rejected webview message: ${safeType(raw)}`);
        return;
      }
      try {
        handler(msg);
      } catch (err) {
        this.log(`webview message handler failed: ${(err as Error)?.message ?? String(err)}`);
      }
    });
  }

  /** Posts a message; resolves false (never rejects) if the webview is gone. */
  async post(message: ExtensionToWebviewMessage): Promise<boolean> {
    if (this.disposed) return false;
    try {
      return await this.webview.postMessage(message);
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.subscription.dispose();
  }
}

function safeType(raw: unknown): string {
  if (raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string') {
    return String((raw as { type: string }).type).slice(0, 40);
  }
  return typeof raw;
}
