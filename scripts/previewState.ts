/**
 * Builds a rich, deterministic CityState for visual previews / README screenshots
 * (see scripts/screenshot.mjs). Not part of the extension bundle.
 */
import { buildCityState } from '../src/backend/cityStateBuilder';
import { WorkspaceRegistry } from '../src/backend/WorkspaceRegistry';
import type { AgentEvent } from '../src/models/AgentEvent';
import type { CityState } from '../src/models/CityState';
import { Session, normalizeSession } from '../src/models/Session';

const COMPANIES = [
  'aurora-api', 'nebula-web', 'quasar-ml', 'orbit-docs', 'pulsar-cli', 'sirius-maps', 'eclipse-ops', 'cosmos-data',
  'meteor-shop', 'solar-pay', 'lunar-bot', 'comet-mobile', 'vega-search', 'stellar-ui', 'galaxy-auth', 'zenith-infra',
  'photon-cache', 'nova-queue',
];
const TASKS = ['refactor-auth', 'fix-flaky-tests', 'db-migration', 'landing-page', 'a11y-audit', 'bundle-size', 'storybook', 'train-eval'];
const LIVE: [string | undefined, string | undefined, string?][] = [
  [undefined, 'busy'],
  ['working', 'busy'],
  ['blocked', 'waiting', 'permission: Bash'],
  [undefined, 'idle'],
  ['done', 'idle'],
  ['failed', 'idle'],
  [undefined, 'busy'],
  ['stopped', undefined],
];

class Memento {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

export function previewState(now: number, count = COMPANIES.length): CityState {
  const registry = new WorkspaceRegistry(new Memento(), { homeDir: '/home/demo' });
  const sessions: Session[] = [];
  let n = 0;
  Array.from({ length: count }, (_, i) => (i < COMPANIES.length ? COMPANIES[i] : `${COMPANIES[i % COMPANIES.length]}-${Math.floor(i / COMPANIES.length) + 1}`)).forEach((company, c) => {
    const cwd = `/work/${company}`;
    registry.register(cwd, 'session');
    const live = c % 5 === 4 ? 0 : (c * 7) % 5; // some quiet houses, some office blocks
    for (let i = 0; i < live; i++) {
      const [state, status, waitingFor] = LIVE[(c * 3 + i) % LIVE.length];
      const s = normalizeSession({
        sessionId: `00000000-aaaa-4bbb-8ccc-${String(n++).padStart(12, '0')}`,
        name: TASKS[(c + i) % TASKS.length],
        cwd,
        kind: i % 2 ? 'background' : 'interactive',
        pid: 40000 + n,
        startedAt: now - (5 + n * 7) * 60_000,
        state,
        status,
        waitingFor,
      });
      if (s) sessions.push(s);
    }
    const past = (c * 5) % 9;
    for (let i = 0; i < past; i++) {
      sessions.push({
        id: `00000000-dddd-4bbb-8ccc-${String(n++).padStart(12, '0')}`,
        sessionId: `00000000-dddd-4bbb-8ccc-${String(n).padStart(12, '0')}`,
        name: `old task ${i}`,
        cwd,
        kind: 'interactive',
        state: 'unknown',
        status: 'unknown',
        origin: 'history',
        tier: i < 2 ? 'recent' : 'archived',
        gitBranch: 'main',
        lastActivityAt: now - (i + 1) * 3 * 86_400_000,
      });
    }
  });
  const grouped = registry.groupSessions(sessions);
  const events: AgentEvent[] = [];
  return buildCityState({
    workspaces: registry.buildCityWorkspaces(grouped),
    sessions: grouped,
    events,
    source: 'demo',
    now,
    hooks: { bridge: 'running', install: 'current' } as CityState['hooks'],
    stats: { tasksCompletedToday: 3 },
    config: { dayNight: true },
  });
}
