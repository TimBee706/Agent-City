import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ClaudeExecutable {
  /** Absolute path to the executable. */
  path: string;
  /** True for .cmd/.bat shims on Windows, which can only be launched through cmd.exe. */
  needsShell: boolean;
}

export type LocateResult = { kind: 'found'; exe: ClaudeExecutable } | { kind: 'notFound'; reason: string };

export interface LocatorEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
  isFile(p: string): boolean;
  /** Directory entries; optional so callers/tests without file system access can omit it. */
  listDir?(p: string): string[];
}

export const defaultLocatorEnv = (): LocatorEnv => ({
  platform: process.platform,
  env: process.env,
  homedir: os.homedir(),
  isFile: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  listDir: (p) => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  },
});

/** Compares dotted version suffixes numerically, newest first (2.1.296 before 2.1.288). */
function compareVersionsDesc(a: string, b: string): number {
  const na = a.match(/\d+/g)?.map(Number) ?? [];
  const nb = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (nb[i] ?? 0) - (na[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Native binaries bundled with the Claude Code VS Code extension, newest version first. */
function vscodeExtensionBinaries(p: typeof path.posix, envIn: LocatorEnv): string[] {
  const { platform, homedir, listDir } = envIn;
  if (!listDir) return [];
  const exeName = platform === 'win32' ? 'claude.exe' : 'claude';
  const out: string[] = [];
  for (const root of ['.vscode', '.vscode-insiders', '.vscode-server', '.cursor', '.windsurf']) {
    const extDir = p.join(homedir, root, 'extensions');
    const matches = listDir(extDir)
      .filter((n) => /^anthropic\.claude-code-/i.test(n))
      .sort(compareVersionsDesc);
    for (const m of matches) out.push(p.join(extDir, m, 'resources', 'native-binary', exeName));
  }
  return out;
}

/** Characters that would be interpreted by cmd.exe; such paths are refused in shell mode. */
const CMD_META = /["&|<>^%!\r\n]/;

export function isSafeForShell(p: string): boolean {
  return !CMD_META.test(p);
}

function needsShell(p: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(p);
}

/**
 * Finds the `claude` executable.
 * 1. `claudeCity.claudePath` setting (must be an existing file)
 * 2. PATH (on Windows: claude.exe, claude.cmd, claude.bat per directory)
 * 3. Well-known install locations (~/.local/bin, %APPDATA%/npm, ~/.claude/local)
 * 4. Binary bundled with the Claude Code VS Code extension (newest version)
 */
export function locateClaude(override: string | undefined, envIn: LocatorEnv = defaultLocatorEnv()): LocateResult {
  const { platform, env, homedir, isFile } = envIn;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const accept = (candidate: string): LocateResult | undefined => {
    if (!isFile(candidate)) return undefined;
    const shell = needsShell(candidate, platform);
    if (shell && !isSafeForShell(candidate)) return undefined;
    return { kind: 'found', exe: { path: candidate, needsShell: shell } };
  };

  const configured = override?.trim();
  if (configured) {
    if (!p.isAbsolute(configured)) {
      return { kind: 'notFound', reason: `claudeCity.claudePath must be an absolute path: ${configured}` };
    }
    if (needsShell(configured, platform) && !isSafeForShell(configured)) {
      return { kind: 'notFound', reason: 'claudeCity.claudePath contains characters that are not allowed for .cmd/.bat files' };
    }
    return accept(configured) ?? { kind: 'notFound', reason: `claudeCity.claudePath does not exist: ${configured}` };
  }

  const names =
    platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
  const dirs = pathVar.split(p.delimiter).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);

  const extra: string[] = [p.join(homedir, '.local', 'bin'), p.join(homedir, '.claude', 'local')];
  if (platform === 'win32' && env.APPDATA) extra.push(p.join(env.APPDATA, 'npm'));
  if (platform !== 'win32') extra.push('/usr/local/bin', '/opt/homebrew/bin');

  for (const dir of [...dirs, ...extra]) {
    if (!p.isAbsolute(dir)) continue; // never resolve relative PATH entries (cwd hijacking)
    for (const name of names) {
      const found = accept(p.join(dir, name));
      if (found) return found;
    }
  }
  for (const candidate of vscodeExtensionBinaries(p, envIn)) {
    const found = accept(candidate);
    if (found) return found;
  }
  return { kind: 'notFound', reason: 'claude executable not found on PATH (set claudeCity.claudePath)' };
}
