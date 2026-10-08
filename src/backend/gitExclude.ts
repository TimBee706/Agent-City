/**
 * Keeps a workspace's `.claude/settings.local.json` (which contains the hook token) out of git by
 * listing it in the repository's `info/exclude` - a local, never-committed ignore file. vscode-free;
 * best effort: never throws.
 */
import { promises as fsp } from 'fs';
import * as path from 'path';

export interface GitRepoInfo {
  /** Working tree root (the directory containing `.git`). */
  workTree: string;
  /** The (possibly worktree-specific) git dir. */
  gitDir: string;
  /** Shared git dir (`commondir` of a linked worktree, else equal to gitDir); holds `info/exclude`. */
  commonDir: string;
}

export type GitExcludeResult =
  | { kind: 'no-repo' }
  | { kind: 'present'; excludeFile: string }
  | { kind: 'added'; excludeFile: string; pattern: string }
  | { kind: 'error'; error: string };

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walks up from `start` looking for `.git` - a directory (normal repo) or a file `gitdir: <path>`
 * (linked worktree / submodule). Returns undefined outside a repository.
 */
export async function findGitRepo(start: string): Promise<GitRepoInfo | undefined> {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st;
    try {
      st = await fsp.stat(dotGit);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory()) return { workTree: dir, gitDir: dotGit, commonDir: dotGit };
    if (st?.isFile()) {
      const text = await fsp.readFile(dotGit, 'utf8');
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (!m) return undefined;
      const gitDir = path.resolve(dir, m[1]);
      let commonDir = gitDir;
      try {
        const rel = (await fsp.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
        if (rel) commonDir = path.resolve(gitDir, rel);
      } catch {
        /* not a linked worktree (e.g. submodule) */
      }
      if (!(await isDir(commonDir))) return undefined;
      return { workTree: dir, gitDir, commonDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Anchored gitignore pattern for `file` relative to the work tree (forward slashes). */
export function excludePatternFor(workTree: string, file: string): string {
  return '/' + path.relative(workTree, file).split(path.sep).join('/');
}

/** Ensures `file` is listed in `<commonDir>/info/exclude` if it lies inside a git work tree. */
export async function ensureGitExcluded(file: string): Promise<GitExcludeResult> {
  try {
    const repo = await findGitRepo(path.dirname(file));
    if (!repo) return { kind: 'no-repo' };
    const pattern = excludePatternFor(repo.workTree, file);
    const unanchored = pattern.slice(1);
    const accepted = new Set([pattern, unanchored, `**/${path.basename(path.dirname(file))}/${path.basename(file)}`]);
    const excludeFile = path.join(repo.commonDir, 'info', 'exclude');
    let existing = '';
    try {
      existing = await fsp.readFile(excludeFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
    if (existing.split(/\r?\n/).some((l) => accepted.has(l.trim()))) return { kind: 'present', excludeFile };
    await fsp.mkdir(path.dirname(excludeFile), { recursive: true });
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    await fsp.appendFile(excludeFile, `${sep}# Claude City: local Claude settings (contain a hook token)\n${pattern}\n`, 'utf8');
    return { kind: 'added', excludeFile, pattern };
  } catch (err) {
    return { kind: 'error', error: (err as Error)?.message ?? String(err) };
  }
}
