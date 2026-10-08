import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAX_PROJECT_DIRS = 100;
const HEAD_BYTES = 64 * 1024;

/** Extracts the first `"cwd":"..."` value from a JSONL transcript head. Pure, exported for tests. */
export function extractCwd(head: string): string | undefined {
  for (const line of head.split(/\r?\n/)) {
    if (!line.includes('"cwd"')) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.cwd === 'string' && obj.cwd.trim()) return obj.cwd.trim();
    } catch {
      // partial / malformed line - try regex fallback
      const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m) {
        try {
          return JSON.parse(`"${m[1]}"`) as string;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return undefined;
}

async function readHead(file: string): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * Best-effort discovery of historical project paths from ~/.claude/projects (opt-in setting).
 * The folder names are a lossy encoding of the path, so the real cwd is read from the newest
 * transcript instead. Never throws; returns [] on any problem. Not the primary data source.
 */
export async function discoverHistoricalProjects(claudeHome = path.join(os.homedir(), '.claude')): Promise<string[]> {
  const root = path.join(claudeHome, 'projects');
  const result = new Set<string>();
  try {
    const dirs = (await fs.promises.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).slice(0, MAX_PROJECT_DIRS);
    for (const d of dirs) {
      try {
        const dir = path.join(root, d.name);
        const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
        let newest: { file: string; mtime: number } | undefined;
        for (const f of files) {
          const st = await fs.promises.stat(path.join(dir, f));
          if (!newest || st.mtimeMs > newest.mtime) newest = { file: path.join(dir, f), mtime: st.mtimeMs };
        }
        if (!newest) continue;
        const cwd = extractCwd(await readHead(newest.file));
        if (cwd) result.add(cwd);
      } catch {
        /* skip this project */
      }
    }
  } catch {
    return [];
  }
  return [...result];
}
