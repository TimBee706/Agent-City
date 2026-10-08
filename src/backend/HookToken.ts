/**
 * Shared hook token: random 256-bit, persisted in VS Code SecretStorage (fallback: user-only file in
 * the extension's global storage). vscode-free so the race handling can be unit tested.
 *
 * Several VS Code windows share one SecretStorage. To converge on a single token:
 *  - concurrent callers in one window share one load (memoized promise),
 *  - after storing a fresh token we re-read the store and adopt whatever is there (another window may
 *    have stored its token in between),
 *  - the fallback file is created exclusively (`wx`); on EEXIST the other window's token is adopted,
 *  - the owner subscribes to SecretStorage changes and calls `invalidate()` (see HookService).
 */
import { randomBytes } from 'crypto';
import { promises as fsp } from 'fs';
import * as path from 'path';

export const HOOK_TOKEN_SECRET_KEY = 'claudeCity.hookToken.v1';

/** Subset of vscode.SecretStorage. */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}

export interface HookTokenStoreDeps {
  secrets: SecretStore;
  /** Absolute path of the fallback token file. */
  fallbackFile: string;
  log?: (msg: string) => void;
  generate?: () => string;
}

export function isValidToken(t: unknown): t is string {
  return typeof t === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(t);
}

export class HookTokenStore {
  private pending: Promise<string> | undefined;
  private readonly log: (msg: string) => void;
  private readonly generate: () => string;

  constructor(private readonly deps: HookTokenStoreDeps) {
    this.log = deps.log ?? (() => undefined);
    this.generate = deps.generate ?? (() => randomBytes(32).toString('base64url'));
  }

  /** The current token; concurrent calls share one load. A failed load is retried next time. */
  get(): Promise<string> {
    if (!this.pending) {
      const p = this.load();
      this.pending = p;
      p.catch(() => {
        if (this.pending === p) this.pending = undefined;
      });
    }
    return this.pending;
  }

  /** Forget the cached token (e.g. SecretStorage changed in another window). */
  invalidate(): void {
    this.pending = undefined;
  }

  private async readSecret(): Promise<string | undefined | null> {
    try {
      const v = await this.deps.secrets.get(HOOK_TOKEN_SECRET_KEY);
      return isValidToken(v) ? v : undefined;
    } catch (err) {
      this.log(`SecretStorage unavailable: ${(err as Error)?.message ?? String(err)}`);
      return null; // unavailable
    }
  }

  private async readFile(): Promise<string | undefined> {
    try {
      const t = (await fsp.readFile(this.deps.fallbackFile, 'utf8')).trim();
      return isValidToken(t) ? t : undefined;
    } catch {
      return undefined;
    }
  }

  private async load(): Promise<string> {
    const stored = await this.readSecret();
    if (stored) return stored;
    const fromFile = await this.readFile();
    if (fromFile) return fromFile;

    const token = this.generate();
    if (stored !== null) {
      try {
        await this.deps.secrets.store(HOOK_TOKEN_SECRET_KEY, token);
        // Another window may have stored its own token concurrently: the stored value wins.
        const after = await this.readSecret();
        return after || token;
      } catch (err) {
        this.log(`storing hook token in SecretStorage failed: ${(err as Error)?.message ?? String(err)}`);
      }
    }
    await fsp.mkdir(path.dirname(this.deps.fallbackFile), { recursive: true });
    try {
      await fsp.writeFile(this.deps.fallbackFile, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      const other = await this.readFile();
      if (other) return other;
      // Existing file holds garbage: replace it.
      await fsp.writeFile(this.deps.fallbackFile, token, { encoding: 'utf8', mode: 0o600 });
      return token;
    }
  }
}
