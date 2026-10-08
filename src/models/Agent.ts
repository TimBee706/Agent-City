import { Session, SessionPhase, sessionLabel, sessionPhase } from './Session';

/** Visual animation state of a character. Mapped to CSS classes `char--<state>` in the webview. */
export type CharacterState = 'working' | 'busy' | 'idle' | 'blocked' | 'done' | 'failed' | 'stopped';

export type AgentRole = 'main' | 'subagent';

export interface Agent {
  /** Unique within the city: `${parentSessionId}:main` or `${parentSessionId}:${hookAgentId}`. */
  agentId: string;
  /** `main` for the session's main agent; subagent type name (e.g. "Explore") in phase 3. */
  agentType: string;
  role: AgentRole;
  parentSessionId: string;
  /** For nested subagents (phase 3). */
  parentAgentId?: string;
  workspaceId?: string;
  name: string;
  characterState: CharacterState;
  /** Current work assignment (phase 3: from Task/Agent tool hook payloads). */
  task?: string;
  /** Short description of the latest event that touched this agent. */
  lastEvent?: string;
  lastEventAt?: number;
  /** Subagents: when the SubagentStart hook arrived (drives the walk-in animation). */
  spawnedAt?: number;
  /** Subagent stopped and is walking out (removed after a short grace period). */
  leaving?: boolean;
  /** Main agent: hook Notification asked for user attention (cleared by later activity/poll). */
  attention?: string;
  /** Last TaskCompleted for this agent (success sparkle). */
  completedAt?: number;
}

/** Maps a session phase (+ status for intensity) to the character animation state. */
export function characterStateFor(phase: SessionPhase, status: Session['status']): CharacterState {
  switch (phase) {
    case 'working':
      return status === 'busy' ? 'busy' : 'working';
    case 'waiting':
      return 'blocked';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    case 'idle':
    case 'unknown':
    default:
      return 'idle';
  }
}

/** Phase 2: exactly one main agent per session, derived from session state. */
export function mainAgentForSession(s: Session): Agent {
  const agent: Agent = {
    agentId: `${s.id}:main`,
    agentType: 'main',
    role: 'main',
    parentSessionId: s.id,
    name: sessionLabel(s),
    characterState: characterStateFor(sessionPhase(s), s.status),
  };
  if (s.workspaceId) agent.workspaceId = s.workspaceId;
  if (s.waitingFor) agent.task = `waiting for ${s.waitingFor}`;
  return agent;
}

export const CHARACTER_STATE_LABEL: Record<CharacterState, string> = {
  working: 'working',
  busy: 'busy',
  idle: 'idle',
  blocked: 'waiting for input',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};
