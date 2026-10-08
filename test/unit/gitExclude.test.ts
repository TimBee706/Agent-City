import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureGitExcluded, excludePatternFor, findGitRepo } from '../../src/backend/gitExclude';

describe('ensureGitExcluded (temp dir with fake .git)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-city-git-')));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const settingsIn = (folder: string) => path.join(folder, '.claude', 'settings.local.json');

  it('returns no-repo outside a git repository and writes nothing', async () => {
    const ws = path.join(dir, 'plain');
    await fsp.mkdir(ws);
    const r = await ensureGitExcluded(settingsIn(ws));
    // the temp dir itself may live inside a repo on a dev machine; only assert when it does not
    if (!(await findGitRepo(dir))) expect(r).toEqual({ kind: 'no-repo' });
    expect(await fsp.readdir(ws)).toEqual([]);
  });

  it('appends an anchored pattern to .git/info/exclude once (repo root workspace)', async () => {
    const repo = path.join(dir, 'repo');
    await fsp.mkdir(path.join(repo, '.git'), { recursive: true });
    const r = await ensureGitExcluded(settingsIn(repo));
    const exclude = path.join(repo, '.git', 'info', 'exclude');
    expect(r).toEqual({ kind: 'added', excludeFile: exclude, pattern: '/.claude/settings.local.json' });
    expect(await fsp.readFile(exclude, 'utf8')).toContain('\n/.claude/settings.local.json\n');
    expect(await ensureGitExcluded(settingsIn(repo))).toEqual({ kind: 'present', excludeFile: exclude });
    const lines = (await fsp.readFile(exclude, 'utf8')).split('\n').filter((l) => l === '/.claude/settings.local.json');
    expect(lines).toHaveLength(1);
  });

  it('keeps existing exclude content and respects equivalent existing entries', async () => {
    const repo = path.join(dir, 'repo');
    await fsp.mkdir(path.join(repo, '.git', 'info'), { recursive: true });
    const exclude = path.join(repo, '.git', 'info', 'exclude');
    await fsp.writeFile(exclude, '# git ls-files --others\n*.log');
    expect((await ensureGitExcluded(settingsIn(repo))).kind).toBe('added');
    const text = await fsp.readFile(exclude, 'utf8');
    expect(text.startsWith('# git ls-files --others\n*.log\n')).toBe(true);

    await fsp.writeFile(exclude, '.claude/settings.local.json\r\n');
    expect((await ensureGitExcluded(settingsIn(repo))).kind).toBe('present');
    await fsp.writeFile(exclude, '**/.claude/settings.local.json\n');
    expect((await ensureGitExcluded(settingsIn(repo))).kind).toBe('present');
  });

  it('uses the path relative to the work tree for a sub-folder workspace', async () => {
    const repo = path.join(dir, 'repo');
    const ws = path.join(repo, 'packages', 'app');
    await fsp.mkdir(path.join(repo, '.git'), { recursive: true });
    await fsp.mkdir(ws, { recursive: true });
    const r = await ensureGitExcluded(settingsIn(ws));
    expect(r).toMatchObject({ kind: 'added', pattern: '/packages/app/.claude/settings.local.json' });
  });

  it('follows a worktree .git file to the common dir', async () => {
    const main = path.join(dir, 'main');
    const wtGitDir = path.join(main, '.git', 'worktrees', 'feature');
    await fsp.mkdir(wtGitDir, { recursive: true });
    await fsp.writeFile(path.join(wtGitDir, 'commondir'), '../..\n');
    const wt = path.join(dir, 'feature');
    await fsp.mkdir(wt);
    await fsp.writeFile(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`);

    const repo = await findGitRepo(wt);
    expect(repo).toEqual({ workTree: wt, gitDir: wtGitDir, commonDir: path.join(main, '.git') });
    const r = await ensureGitExcluded(settingsIn(wt));
    expect(r).toMatchObject({ kind: 'added', excludeFile: path.join(main, '.git', 'info', 'exclude') });
  });

  it('resolves a relative gitdir (submodule style, no commondir)', async () => {
    const sm = path.join(dir, 'super', 'sub');
    const smGit = path.join(dir, 'super', '.git', 'modules', 'sub');
    await fsp.mkdir(smGit, { recursive: true });
    await fsp.mkdir(sm, { recursive: true });
    await fsp.writeFile(path.join(sm, '.git'), 'gitdir: ../.git/modules/sub');
    const r = await ensureGitExcluded(settingsIn(sm));
    expect(r).toMatchObject({ kind: 'added', excludeFile: path.join(smGit, 'info', 'exclude') });
  });

  it('never throws: broken .git file -> no-repo, unwritable exclude -> error', async () => {
    const a = path.join(dir, 'a');
    await fsp.mkdir(a);
    await fsp.writeFile(path.join(a, '.git'), 'garbage');
    expect(await ensureGitExcluded(settingsIn(a))).toEqual({ kind: 'no-repo' });

    const b = path.join(dir, 'b');
    await fsp.mkdir(path.join(b, '.git', 'info', 'exclude'), { recursive: true }); // a directory -> read fails
    expect((await ensureGitExcluded(settingsIn(b))).kind).toBe('error');
  });

  it('excludePatternFor uses forward slashes', () => {
    expect(excludePatternFor(path.join(dir, 'r'), path.join(dir, 'r', 'x', '.claude', 'settings.local.json'))).toBe(
      '/x/.claude/settings.local.json',
    );
  });
});
