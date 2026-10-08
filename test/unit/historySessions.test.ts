import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HEAD_BYTES,
  HistoricalSessionScanner,
  HistoryFs,
  TAIL_BYTES,
  nodeHistoryFs,
  toArchivedSession,
} from '../../src/backend/HistoricalSessions';
import { HISTORY_RESCAN_MS, HistoryImporter, HistoryScannerLike } from '../../src/backend/HistoryImporter';
import { parseTranscriptChunks, promptText, sanitizeTitle, TITLE_MAX } from '../../src/backend/transcriptParser';
import { mapLimit } from '../../src/util/concurrency';
import { FakeTimers, MemoryMemento, settle } from './helpers';

// ------------------------------------------------------------------ synthetic fixtures (never real transcripts)
const SID = '11111111-2222-4333-8444-555555555555';
const CWD = 'C:\\work\\alpha';
const j = (o: unknown) => JSON.stringify(o);
const base = (extra: Record<string, unknown> = {}) => ({
  cwd: CWD,
  sessionId: SID,
  timestamp: '2026-09-01T10:00:00.000Z',
  gitBranch: 'main',
  version: '9.9.9',
  isSidechain: false,
  userType: 'external',
  ...extra,
});
const userLine = (content: unknown, extra: Record<string, unknown> = {}) =>
  j({ type: 'user', ...base(extra), message: { role: 'user', content } });
const assistantLine = (text: string, extra: Record<string, unknown> = {}) =>
  j({ type: 'assistant', ...base(extra), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const queueLine = () => j({ type: 'queue-operation', operation: 'enqueue', sessionId: SID, timestamp: '2026-09-01T09:59:59.000Z' });

const whole = (lines: string[]) => parseTranscriptChunks({ head: lines.join('\n') + '\n', headIsWholeFile: true });

describe('transcriptParser', () => {
  it('extracts cwd, timestamps, branch and version', () => {
    const m = whole([
      queueLine(),
      userLine('Fix the login bug'),
      assistantLine('ok', { timestamp: '2026-09-01T10:05:00.000Z', gitBranch: 'feature/x' }),
    ]);
    expect(m.cwd).toBe(CWD);
    expect(m.startedAt).toBe(Date.parse('2026-09-01T09:59:59.000Z'));
    expect(m.lastActivityAt).toBe(Date.parse('2026-09-01T10:05:00.000Z'));
    expect(m.gitBranch).toBe('feature/x');
    expect(m.version).toBe('9.9.9');
    expect(m.title).toBe('Fix the login bug');
    expect(m.titleSource).toBe('prompt');
  });

  it('title priority: custom > ai > summary > agent > first prompt > last prompt', () => {
    const lines = [
      userLine('first prompt'),
      j({ type: 'last-prompt', lastPrompt: 'last prompt', sessionId: SID }),
      j({ type: 'agent-name', agentName: 'agent name', sessionId: SID }),
      j({ type: 'summary', summary: 'summary title', leafUuid: 'x' }),
      j({ type: 'ai-title', aiTitle: 'ai title', sessionId: SID }),
      j({ type: 'custom-title', customTitle: 'custom title', sessionId: SID }),
    ];
    const expected = ['custom title', 'ai title', 'summary title', 'agent name', 'first prompt'];
    for (let i = 0; i < expected.length; i++) {
      // drop the higher-priority entries one by one (they are at the end of `lines`)
      const m = whole(lines.slice(0, lines.length - i));
      expect(m.title).toBe(expected[i]);
    }
    expect(whole([lines[1], userLine('<command-name>/x</command-name>')]).title).toBe('last prompt');
    expect(whole([j({ type: 'ai-title', aiTitle: 'old', sessionId: SID }), j({ type: 'ai-title', aiTitle: 'new', sessionId: SID })]).title).toBe('new');
  });

  it('first-prompt fallback skips meta, command, tool_result, sidechain and injected messages', () => {
    const m = whole([
      userLine('<local-command-caveat>Caveat: ...</local-command-caveat>', { isMeta: true }),
      userLine('meta text', { isMeta: true }),
      userLine('<command-name>/clear</command-name>'),
      userLine('<local-command-stdout></local-command-stdout>'),
      userLine([{ type: 'tool_result', tool_use_id: 't', content: 'result' }], { toolUseResult: {} }),
      userLine('sidechain prompt', { isSidechain: true }),
      userLine('   '),
      userLine([{ type: 'text', text: '<ide_opened_file>x</ide_opened_file>' }, { type: 'text', text: 'Real\n  prompt\ttext' }]),
      userLine('second prompt'),
    ]);
    expect(m.title).toBe('Real prompt text');
    expect(promptText({ type: 'assistant', message: { role: 'assistant', content: 'x' } })).toBeUndefined();
    expect(promptText({ type: 'user', message: { role: 'user', content: [{ type: 'image' }] } })).toBeUndefined();
  });

  it('tolerates missing cwd, malformed lines and unknown entry types', () => {
    const m = whole([
      'not json',
      '{"broken":',
      '[1,2,3]',
      j({ type: 'mode', mode: 'x', sessionId: SID }),
      j({ type: 'user', sessionId: SID, timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'hello' } }),
    ]);
    expect(m.cwd).toBeUndefined();
    expect(m.malformed).toBe(3);
    expect(m.entries).toBe(2);
    expect(m.title).toBe('hello');
    expect(parseTranscriptChunks({ head: '', headIsWholeFile: true })).toMatchObject({ entries: 0, malformed: 0 });
  });

  it('ignores cwd/branch of sidechain entries', () => {
    const m = whole([userLine('x', { isSidechain: true, cwd: 'C:\\elsewhere', gitBranch: 'side' }), assistantLine('y')]);
    expect(m.cwd).toBe(CWD);
    expect(m.gitBranch).toBe('main');
  });

  it('drops lines cut at the head/tail boundaries (mid-JSON)', () => {
    const full = userLine('head prompt');
    const cut = assistantLine('this line is cut', { gitBranch: 'cut-branch' });
    const head = `${full}\n${cut.slice(0, 40)}`; // last line truncated mid-JSON
    const tail = `${cut.slice(40)}\n${j({ type: 'ai-title', aiTitle: 'tail title', sessionId: SID })}\n`;
    const m = parseTranscriptChunks({ head, headIsWholeFile: false, tail });
    expect(m.malformed).toBe(0);
    expect(m.entries).toBe(2);
    expect(m.gitBranch).toBe('main');
    expect(m.title).toBe('tail title');
  });

  it('accepts timestamp variants (ISO, epoch ms, epoch s, numeric string) and ignores junk', () => {
    const m = whole([
      j({ type: 'x', timestamp: 1_788_000_000 }), // seconds
      j({ type: 'x', timestamp: 1_788_000_100_000 }), // ms
      j({ type: 'x', timestamp: '1788000200000' }),
      j({ type: 'x', timestamp: '2026-08-30T00:00:00+02:00' }),
      j({ type: 'x', timestamp: 'yesterday' }),
      j({ type: 'x', timestamp: -5 }),
    ]);
    expect(m.startedAt).toBe(Math.min(1_788_000_000_000, Date.parse('2026-08-30T00:00:00+02:00')));
    expect(m.lastActivityAt).toBe(Math.max(1_788_000_200_000, Date.parse('2026-08-30T00:00:00+02:00')));
  });

  it('sanitizes titles: single line, no controls / bidi overrides, max length', () => {
    expect(sanitizeTitle('a\n\tb\u202Ec\u0007d')).toBe('a b c d');
    expect(sanitizeTitle('   ')).toBeUndefined();
    expect(sanitizeTitle(5)).toBeUndefined();
    const long = sanitizeTitle('x'.repeat(500))!;
    expect(long.length).toBe(TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(whole([j({ type: 'custom-title', customTitle: '<b>html</b>', sessionId: SID })]).title).toBe('<b>html</b>'); // plain text, rendered via React
  });
});

// ------------------------------------------------------------------ scanner (temp dirs)
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-01T12:00:00.000Z');

function sid(n: number): string {
  return `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;
}

class CountingFs implements HistoryFs {
  reads: { file: string; position: number; length: number; got: number }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly delayMs = 0) {}
  private async track<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      return await fn();
    } finally {
      this.inFlight--;
    }
  }
  readdir = (dir: string) => this.track(() => nodeHistoryFs.readdir(dir));
  stat = (file: string) => this.track(() => nodeHistoryFs.stat(file));
  readRange = (file: string, position: number, length: number) =>
    this.track(async () => {
      const buf = await nodeHistoryFs.readRange(file, position, length);
      this.reads.push({ file, position, length, got: buf.length });
      return buf;
    });
  get bytesRead(): number {
    return this.reads.reduce((a, r) => a + r.got, 0);
  }
}

describe('HistoricalSessionScanner', () => {
  let home: string;
  let projects: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-history-'));
    projects = path.join(home, 'projects');
    fs.mkdirSync(projects);
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function write(project: string, name: string, lines: string[], mtime = NOW - DAY): string {
    const dir = path.join(projects, project);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
    return file;
  }
  const session = (id: string, cwd = CWD, title = 'prompt') => [
    queueLine(),
    userLine(title, { cwd, sessionId: id }),
    assistantLine('answer', { cwd, sessionId: id, timestamp: '2026-09-30T08:00:00.000Z' }),
  ];
  const scanner = (fsImpl: HistoryFs = nodeHistoryFs, memento?: MemoryMemento) =>
    new HistoricalSessionScanner({ claudeHome: home, fs: fsImpl, now: () => NOW, memento });

  it('imports top-level transcripts with valid session-id names only', async () => {
    write('c--work-alpha', `${sid(1)}.jsonl`, session(sid(1)));
    write('c--work-alpha', 'not a session id.jsonl', session(sid(2)));
    write('c--work-alpha', 'notes.txt', ['x']);
    write(path.join('c--work-alpha', sid(1), 'subagents'), 'agent-a.jsonl', session(sid(3)));
    write(path.join('c--work-alpha', sid(1), 'subagents'), 'agent-b.jsonl', session(sid(4)));
    write(path.join('c--work-alpha', 'memory'), `${sid(5)}.jsonl`, session(sid(5)));
    const { sessions, stats } = await scanner().scan({ maxAgeDays: 90 });
    expect(sessions.map((s) => s.sessionId)).toEqual([sid(1)]);
    expect(sessions[0]).toMatchObject({ cwd: CWD, title: 'prompt', gitBranch: 'main', subagentCount: 2 });
    expect(sessions[0].lastActivityAt).toBe(Date.parse('2026-09-30T08:00:00.000Z'));
    expect(stats).toMatchObject({ projectDirs: 1, candidates: 1, scanned: 1, parsed: 1, imported: 1, failures: 0 });
  });

  it('reads only head and tail of a huge transcript', async () => {
    const filler = assistantLine('x'.repeat(900));
    const lines = [...session(sid(1)).slice(0, 2), ...Array.from({ length: 1200 }, () => filler)];
    lines.push(j({ type: 'ai-title', aiTitle: 'Title from the tail', sessionId: sid(1) }));
    const file = write('p', `${sid(1)}.jsonl`, lines);
    const size = fs.statSync(file).size;
    expect(size).toBeGreaterThan(1_000_000);
    const cfs = new CountingFs();
    const { sessions, stats } = await scanner(cfs).scan({ maxAgeDays: 90 });
    expect(sessions[0]).toMatchObject({ cwd: CWD, title: 'Title from the tail' });
    expect(cfs.reads.map((r) => [r.position, r.length])).toEqual([
      [0, HEAD_BYTES],
      [size - TAIL_BYTES, TAIL_BYTES],
    ]);
    expect(cfs.bytesRead).toBe(HEAD_BYTES + TAIL_BYTES);
    expect(stats.bytesRead).toBe(HEAD_BYTES + TAIL_BYTES);
  });

  it('skips files older than maxAgeDays before reading them', async () => {
    write('p', `${sid(1)}.jsonl`, session(sid(1)), NOW - 2 * DAY);
    write('p', `${sid(2)}.jsonl`, session(sid(2)), NOW - 40 * DAY);
    const cfs = new CountingFs();
    const { sessions, stats } = await scanner(cfs).scan({ maxAgeDays: 30 });
    expect(sessions.map((s) => s.sessionId)).toEqual([sid(1)]);
    expect(stats).toMatchObject({ candidates: 2, scanned: 1 });
    expect(cfs.reads.every((r) => r.file.includes(sid(1)))).toBe(true);
  });

  it('applies the file cap (newest by mtime) and the session cap (newest activity)', async () => {
    for (let i = 1; i <= 5; i++) write('p', `${sid(i)}.jsonl`, session(sid(i)), NOW - i * 1000);
    const files = await scanner().scan({ maxAgeDays: 90, maxFiles: 3 });
    expect(files.stats.scanned).toBe(3);
    expect(files.sessions.map((s) => s.sessionId).sort()).toEqual([sid(1), sid(2), sid(3)]);
    const capped = await scanner().scan({ maxAgeDays: 90, maxSessions: 2 });
    expect(capped.sessions).toHaveLength(2);
    expect(capped.stats.imported).toBe(2);
  });

  it('counts failures and sessions without cwd, never throws', async () => {
    write('p', `${sid(1)}.jsonl`, ['garbage', '{"also":']);
    write('p', `${sid(2)}.jsonl`, [j({ type: 'user', sessionId: sid(2), message: { role: 'user', content: 'x' } })]);
    write('p', `${sid(3)}.jsonl`, session(sid(3)));
    const { sessions, stats } = await scanner().scan({ maxAgeDays: 90 });
    expect(sessions.map((s) => s.sessionId)).toEqual([sid(3)]);
    expect(stats).toMatchObject({ failures: 1, skippedNoCwd: 1, imported: 1 });
    const missing = new HistoricalSessionScanner({ claudeHome: path.join(home, 'nope'), now: () => NOW });
    expect((await missing.scan({ maxAgeDays: 90 })).sessions).toEqual([]);
  });

  it('uses the cache for unchanged files (mtime + size) and persists it', async () => {
    const f1 = write('p', `${sid(1)}.jsonl`, session(sid(1)));
    write('p', `${sid(2)}.jsonl`, session(sid(2)));
    const memento = new MemoryMemento();
    const cfs = new CountingFs();
    const sc = scanner(cfs, memento);
    expect((await sc.scan({ maxAgeDays: 90 })).stats).toMatchObject({ parsed: 2, cacheHits: 0 });
    const readsAfterFirst = cfs.reads.length;
    expect((await sc.scan({ maxAgeDays: 90 })).stats).toMatchObject({ parsed: 0, cacheHits: 2 });
    expect(cfs.reads.length).toBe(readsAfterFirst);

    fs.appendFileSync(f1, j({ type: 'custom-title', customTitle: 'renamed', sessionId: sid(1) }) + '\n');
    fs.utimesSync(f1, new Date(NOW - 500), new Date(NOW - 500));
    const third = await sc.scan({ maxAgeDays: 90 });
    expect(third.stats).toMatchObject({ parsed: 1, cacheHits: 1 });
    expect(third.sessions.find((s) => s.sessionId === sid(1))?.title).toBe('renamed');

    await sc.persist();
    const stored = memento.get<unknown[]>('claudeCity.historyCache.v1')!;
    expect(stored).toHaveLength(2);
    const restarted = scanner(new CountingFs(), memento);
    expect((await restarted.scan({ maxAgeDays: 90 })).stats).toMatchObject({ parsed: 0, cacheHits: 2 });

    await restarted.clear();
    expect(memento.get('claudeCity.historyCache.v1')).toEqual([]);
    expect(restarted.cacheSize).toBe(0);
  });

  it('ignores invalid persisted cache entries', async () => {
    write('p', `${sid(1)}.jsonl`, session(sid(1)));
    const memento = new MemoryMemento();
    await memento.update('claudeCity.historyCache.v1', [
      ['x', 1, 2, { sessionId: 'bad id', cwd: 'C:\\x', lastActivityAt: 1 }],
      'junk',
      [path.join(projects, 'p', `${sid(1)}.jsonl`), 'no', 1, null],
    ]);
    const sc = scanner(nodeHistoryFs, memento);
    expect(sc.cacheSize).toBe(0);
    expect((await sc.scan({ maxAgeDays: 90 })).sessions).toHaveLength(1);
  });

  it('respects the concurrency limit', async () => {
    for (let i = 1; i <= 12; i++) write(`p${i % 3}`, `${sid(i)}.jsonl`, session(sid(i)));
    const cfs = new CountingFs(2);
    const { sessions } = await scanner(cfs).scan({ maxAgeDays: 90, concurrency: 3 });
    expect(sessions).toHaveLength(12);
    expect(cfs.maxInFlight).toBeLessThanOrEqual(3);
    expect(cfs.maxInFlight).toBeGreaterThan(1);
  });

  it('dedupes a session id found in two project folders (newest wins)', async () => {
    write('a', `${sid(1)}.jsonl`, session(sid(1), 'C:\\work\\a'));
    write('b', `${sid(1)}.jsonl`, [
      userLine('x', { cwd: 'C:\\work\\b', sessionId: sid(1), timestamp: '2026-09-30T09:00:00.000Z' }),
    ]);
    const { sessions } = await scanner().scan({ maxAgeDays: 90 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe('C:\\work\\b');
  });

  it('converts to an archived session', () => {
    const s = toArchivedSession({ sessionId: sid(1), cwd: CWD, lastActivityAt: 5, title: 't', gitBranch: 'b', startedAt: 1, subagentCount: 2 });
    expect(s).toMatchObject({ id: sid(1), sessionId: sid(1), origin: 'history', name: 't', gitBranch: 'b', lastActivityAt: 5, subagentCount: 2 });
  });
});

describe('mapLimit', () => {
  it('keeps order and limits concurrency', async () => {
    let active = 0;
    let max = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 2;
    });
    expect(out).toEqual([10, 2, 8, 4, 6, 0]);
    expect(max).toBe(2);
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});

// ------------------------------------------------------------------ importer scheduling
describe('HistoryImporter', () => {
  function setup(enabled = true) {
    const timers = new FakeTimers();
    const logs: string[] = [];
    const received: number[] = [];
    let scans = 0;
    let cleared = 0;
    const scanner: HistoryScannerLike = {
      scan: async () => {
        scans++;
        return {
          sessions: [{ sessionId: sid(1), cwd: CWD, lastActivityAt: 1, title: 'SECRET TITLE' }],
          stats: {
            projectDirs: 1, candidates: 1, scanned: 1, parsed: 1, cacheHits: 0,
            failures: 0, skippedNoCwd: 0, imported: 1, bytesRead: 10, durationMs: 3,
          },
        };
      },
      persist: async () => undefined,
      clear: async () => {
        cleared++;
      },
    };
    const cfg = { enabled, maxAgeDays: 90, recentDays: 7, useClaudeArchive: false };
    const imp = new HistoryImporter({
      scanner,
      getConfig: () => cfg,
      onSessions: (s) => received.push(s.length),
      log: (m) => logs.push(m),
      timers,
    });
    return { imp, timers, logs, received, cfg, scans: () => scans, cleared: () => cleared };
  }

  it('waits for the first poll, then rescans every 120 s; logs counts only', async () => {
    const t = setup();
    let release!: () => void;
    t.imp.start(new Promise<void>((r) => (release = r)));
    await settle();
    expect(t.scans()).toBe(0);
    release();
    await settle();
    expect(t.scans()).toBe(1);
    expect(t.received).toEqual([1]);
    expect(t.timers.delays()).toEqual([HISTORY_RESCAN_MS]);
    t.timers.flush();
    await settle();
    expect(t.scans()).toBe(2);
    expect(t.logs.length).toBeGreaterThan(0);
    expect(t.logs.join('\n')).not.toContain('SECRET');
    expect(t.logs[0]).toMatch(/1 session\(s\) imported/);
  });

  it('coalesces refreshes and stops on dispose', async () => {
    const t = setup();
    const a = t.imp.refresh();
    void t.imp.refresh();
    await a;
    await settle();
    expect(t.scans()).toBe(2); // one run + one coalesced rerun
    expect(t.imp.isScheduled).toBe(true);
    t.imp.dispose();
    expect(t.imp.isScheduled).toBe(false);
    expect(t.timers.pending.size).toBe(0);
    await t.imp.refresh();
    expect(t.scans()).toBe(2);
  });

  it('clears sessions and cache when disabled', async () => {
    const t = setup(false);
    await t.imp.refresh();
    expect(t.scans()).toBe(0);
    expect(t.received).toEqual([0]);
    expect(t.cleared()).toBe(1);
  });
});
