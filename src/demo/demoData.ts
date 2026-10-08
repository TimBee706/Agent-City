import { RawSession, Session, normalizeSession } from '../models/Session';

interface DemoSpec {
  company: string;
  name: string;
  kind: string;
  /** Sequence of [state, status] the session cycles through, one step per demo tick group. */
  cycle: [string | undefined, string | undefined][];
  waitingFor?: string;
  ageMin: number;
}

const ROOT = 'C:\\demo';

const SPECS: DemoSpec[] = [
  { company: 'aurora-api', name: 'refactor-auth', kind: 'interactive', ageMin: 42, cycle: [[undefined, 'busy'], [undefined, 'busy'], [undefined, 'idle']] },
  { company: 'aurora-api', name: 'fix-flaky-tests', kind: 'background', ageMin: 18, cycle: [['working', 'busy'], ['working', 'busy'], ['done', 'idle']] },
  { company: 'aurora-api', name: 'db-migration', kind: 'background', ageMin: 7, waitingFor: 'permission: Bash', cycle: [['blocked', 'waiting']] },
  { company: 'nebula-web', name: 'landing-page', kind: 'interactive', ageMin: 65, cycle: [[undefined, 'idle'], [undefined, 'busy'], [undefined, 'busy']] },
  { company: 'nebula-web', name: 'a11y-audit', kind: 'background', ageMin: 120, cycle: [['done', 'idle']] },
  { company: 'nebula-web', name: 'bundle-size', kind: 'background', ageMin: 33, cycle: [['failed', 'idle']] },
  { company: 'nebula-web', name: 'storybook', kind: 'background', ageMin: 12, cycle: [['working', 'busy'], ['working', undefined]] },
  { company: 'quasar-ml', name: 'train-eval', kind: 'background', ageMin: 240, cycle: [['working', 'busy']] },
  { company: 'quasar-ml', name: 'notebook-cleanup', kind: 'interactive', ageMin: 3, waitingFor: 'user input', cycle: [[undefined, 'waiting'], [undefined, 'busy']] },
  { company: 'quasar-ml', name: 'old-experiment', kind: 'background', ageMin: 600, cycle: [['stopped', undefined]] },
  { company: 'orbit-docs', name: 'docs-sync', kind: 'interactive', ageMin: 25, cycle: [[undefined, 'idle']] },
];

/** Number of companies in the demo city (exported for tests/docs). */
export const DEMO_COMPANY_COUNT = new Set(SPECS.map((s) => s.company)).size;

/**
 * Deterministic demo sessions. `tick` advances the cycles so the demo city feels alive and the
 * diff -> event pipeline is exercised. Every 3 ticks one cycle step advances.
 */
export function demoSessions(tick: number, now: number): Session[] {
  const step = Math.floor(Math.max(0, tick) / 3);
  const base = demoEpoch(now);
  const out: Session[] = [];
  SPECS.forEach((spec, i) => {
    const [state, status] = spec.cycle[(step + i) % spec.cycle.length];
    const raw: RawSession = {
      sessionId: `demo-${String(i).padStart(2, '0')}-${spec.name}`,
      name: spec.name,
      cwd: `${ROOT}\\${spec.company}`,
      kind: spec.kind,
      pid: 40000 + i * 17,
      startedAt: base - spec.ageMin * 60_000,
      state,
      status,
      waitingFor: status === 'waiting' || state === 'blocked' ? spec.waitingFor : undefined,
    };
    const s = normalizeSession(raw);
    if (s) out.push(s);
  });
  return out;
}

/** Stable demo "start" reference so startedAt does not change every tick. */
export function demoEpoch(now: number): number {
  return Math.floor(now / 3_600_000) * 3_600_000;
}
