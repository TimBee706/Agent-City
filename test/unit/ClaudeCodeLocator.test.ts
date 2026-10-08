import { describe, expect, it } from 'vitest';
import { LocatorEnv, isSafeForShell, locateClaude } from '../../src/backend/ClaudeCodeLocator';

function env(files: string[], overrides: Partial<LocatorEnv> = {}): LocatorEnv {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    platform: 'win32',
    env: { PATH: 'C:\\tools;relative\\dir;C:\\npm' },
    homedir: 'C:\\Users\\me',
    isFile: (p) => set.has(p.toLowerCase()),
    ...overrides,
  };
}

describe('locateClaude', () => {
  it('finds claude.exe on PATH without shell', () => {
    const r = locateClaude(undefined, env(['C:\\tools\\claude.exe']));
    expect(r).toEqual({ kind: 'found', exe: { path: 'C:\\tools\\claude.exe', needsShell: false } });
  });

  it('prefers .exe over .cmd in the same directory and marks .cmd as needing a shell', () => {
    expect(locateClaude(undefined, env(['C:\\npm\\claude.cmd', 'C:\\npm\\claude.exe']))).toMatchObject({
      exe: { path: 'C:\\npm\\claude.exe', needsShell: false },
    });
    expect(locateClaude(undefined, env(['C:\\npm\\claude.cmd']))).toMatchObject({ exe: { path: 'C:\\npm\\claude.cmd', needsShell: true } });
  });

  it('falls back to ~/.local/bin', () => {
    const r = locateClaude(undefined, env(['C:\\Users\\me\\.local\\bin\\claude.exe'], { env: { PATH: '' } }));
    expect(r).toMatchObject({ kind: 'found', exe: { path: 'C:\\Users\\me\\.local\\bin\\claude.exe' } });
  });

  it('ignores relative PATH entries', () => {
    const r = locateClaude(undefined, env(['relative\\dir\\claude.exe']));
    expect(r.kind).toBe('notFound');
  });

  it('honours an absolute override and rejects relative / missing / unsafe ones', () => {
    expect(locateClaude('D:\\x\\claude.exe', env(['D:\\x\\claude.exe']))).toMatchObject({ kind: 'found' });
    expect(locateClaude('claude.exe', env([]))).toMatchObject({ kind: 'notFound' });
    expect(locateClaude('D:\\missing\\claude.exe', env([]))).toMatchObject({ kind: 'notFound' });
    expect(locateClaude('D:\\a&calc\\claude.cmd', env(['D:\\a&calc\\claude.cmd']))).toMatchObject({ kind: 'notFound' });
  });

  it('works on posix', () => {
    const r = locateClaude(undefined, {
      platform: 'linux',
      env: { PATH: '/usr/bin:/opt/claude' },
      homedir: '/home/me',
      isFile: (p) => p === '/opt/claude/claude',
    });
    expect(r).toEqual({ kind: 'found', exe: { path: '/opt/claude/claude', needsShell: false } });
  });

  it('isSafeForShell rejects cmd metacharacters', () => {
    expect(isSafeForShell('C:\\Program Files\\nodejs\\claude.cmd')).toBe(true);
    for (const bad of ['a"b', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a%PATH%', 'a!b', 'a\nb']) expect(isSafeForShell(bad)).toBe(false);
  });
});
