import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_TOKEN_SECRET_KEY, HookTokenStore, SecretStore, isValidToken } from '../../src/backend/HookToken';

const T = (c: string) => c.repeat(43);

class FakeSecrets implements SecretStore {
  values = new Map<string, string>();
  gets = 0;
  stores = 0;
  failGet = false;
  failStore = false;
  /** Simulates another window storing its token right after ours. */
  onStore?: () => void;
  async get(key: string) {
    this.gets++;
    if (this.failGet) throw new Error('no keyring');
    return this.values.get(key);
  }
  async store(key: string, value: string) {
    this.stores++;
    if (this.failStore) throw new Error('no keyring');
    this.values.set(key, value);
    this.onStore?.();
  }
}

describe('HookTokenStore', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-city-token-'));
    file = path.join(dir, 'g', 'hook-token');
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('concurrent callers share one load and one generated token', async () => {
    const secrets = new FakeSecrets();
    let generated = 0;
    const store = new HookTokenStore({ secrets, fallbackFile: file, generate: () => T(String(++generated)) });
    const [a, b, c] = await Promise.all([store.get(), store.get(), store.get()]);
    expect(a).toBe(T('1'));
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(generated).toBe(1);
    expect(secrets.stores).toBe(1);
    expect(secrets.values.get(HOOK_TOKEN_SECRET_KEY)).toBe(a);
    expect(await store.get()).toBe(a); // cached
  });

  it('adopts the value found in SecretStorage after storing (another window won the race)', async () => {
    const secrets = new FakeSecrets();
    secrets.onStore = () => secrets.values.set(HOOK_TOKEN_SECRET_KEY, T('w'));
    const store = new HookTokenStore({ secrets, fallbackFile: file, generate: () => T('m') });
    expect(await store.get()).toBe(T('w'));
  });

  it('uses an existing valid secret and ignores invalid ones', async () => {
    const secrets = new FakeSecrets();
    secrets.values.set(HOOK_TOKEN_SECRET_KEY, T('s'));
    expect(await new HookTokenStore({ secrets, fallbackFile: file }).get()).toBe(T('s'));
    secrets.values.set(HOOK_TOKEN_SECRET_KEY, 'short');
    const fresh = await new HookTokenStore({ secrets, fallbackFile: file }).get();
    expect(isValidToken(fresh)).toBe(true);
    expect(fresh).not.toBe('short');
  });

  it('invalidate() re-reads the store (token changed in another window)', async () => {
    const secrets = new FakeSecrets();
    secrets.values.set(HOOK_TOKEN_SECRET_KEY, T('a'));
    const store = new HookTokenStore({ secrets, fallbackFile: file });
    expect(await store.get()).toBe(T('a'));
    secrets.values.set(HOOK_TOKEN_SECRET_KEY, T('b'));
    expect(await store.get()).toBe(T('a'));
    store.invalidate();
    expect(await store.get()).toBe(T('b'));
  });

  it('falls back to an exclusively created file and adopts an existing one', async () => {
    const secrets = new FakeSecrets();
    secrets.failStore = true;
    const s1 = new HookTokenStore({ secrets, fallbackFile: file, generate: () => T('f') });
    expect(await s1.get()).toBe(T('f'));
    expect(await fsp.readFile(file, 'utf8')).toBe(T('f'));
    const s2 = new HookTokenStore({ secrets, fallbackFile: file, generate: () => T('g') });
    expect(await s2.get()).toBe(T('f'));
  });

  it('when SecretStorage is unavailable it uses the file and replaces garbage', async () => {
    const secrets = new FakeSecrets();
    secrets.failGet = true;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, 'garbage');
    const store = new HookTokenStore({ secrets, fallbackFile: file, generate: () => T('x') });
    expect(await store.get()).toBe(T('x'));
    expect(secrets.stores).toBe(0);
    expect(await fsp.readFile(file, 'utf8')).toBe(T('x'));
  });

  it('a failed load is not cached', async () => {
    const secrets = new FakeSecrets();
    secrets.failStore = true;
    // fallback dir cannot be created: parent is a file
    await fsp.writeFile(path.join(dir, 'blocker'), '');
    const store = new HookTokenStore({ secrets, fallbackFile: path.join(dir, 'blocker', 'hook-token'), generate: () => T('z') });
    await expect(store.get()).rejects.toThrow();
    secrets.failStore = false;
    expect(await store.get()).toBe(T('z'));
  });
});
