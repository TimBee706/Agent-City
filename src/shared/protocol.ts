/**
 * Typed message protocol between extension host and webviews.
 * Shared by both bundles; must stay free of node/vscode/DOM imports.
 */
import type { AgentEvent } from '../models/AgentEvent';
import type { CityState } from '../models/CityState';
import { isValidSessionId } from './sessionLinks';

export type ViewKind = 'panel' | 'sidebar';

// ---------------------------------------------------------------- extension -> webview
export interface StateMessage {
  type: 'state';
  state: CityState;
}
export interface EventsMessage {
  type: 'events';
  events: AgentEvent[];
}
/** Asks the city panel to zoom to fit the whole city (e.g. after an import). */
export interface FitCityMessage {
  type: 'fitCity';
}
export type ExtensionToWebviewMessage = StateMessage | EventsMessage | FitCityMessage;

// ---------------------------------------------------------------- webview -> extension
export interface ReadyMessage {
  type: 'ready';
  view: ViewKind;
}
export interface OpenCityMessage {
  type: 'openCity';
}
export interface RefreshMessage {
  type: 'refresh';
}
export interface ToggleDemoMessage {
  type: 'toggleDemo';
}
export interface OpenFolderMessage {
  type: 'openFolder';
  workspaceId: string;
}
/** Opens a workspace from the registry (by id - never a path from the webview). */
export interface OpenWorkspaceMessage {
  type: 'openWorkspace';
  workspaceId: string;
  newWindow: boolean;
}
/** Opens a session in the Claude Code extension (session id is validated). */
export interface OpenSessionMessage {
  type: 'openSession';
  sessionId: string;
}
export interface CopySessionIdMessage {
  type: 'copySessionId';
  sessionId: string;
}
export interface InstallHooksMessage {
  type: 'installHooks';
}
export interface UninstallHooksMessage {
  type: 'uninstallHooks';
}
/** Runs "Import Workspaces from Folder…" (the folder dialog runs in the extension; no path in the message). */
export interface ImportWorkspacesMessage {
  type: 'importWorkspaces';
}
/** "Remove from City" for a registry workspace (by id only; the extension asks for confirmation). */
export interface RemoveWorkspaceMessage {
  type: 'removeWorkspace';
  workspaceId: string;
}
/** Pin / unpin a registry workspace (pinned workspaces are never pruned). */
export interface SetWorkspacePinnedMessage {
  type: 'setWorkspacePinned';
  workspaceId: string;
  pinned: boolean;
}
export type WebviewToExtensionMessage =
  | ReadyMessage
  | OpenCityMessage
  | RefreshMessage
  | ToggleDemoMessage
  | OpenFolderMessage
  | OpenWorkspaceMessage
  | OpenSessionMessage
  | CopySessionIdMessage
  | InstallHooksMessage
  | UninstallHooksMessage
  | ImportWorkspacesMessage
  | RemoveWorkspaceMessage
  | SetWorkspacePinnedMessage;

const MAX_ID_LENGTH = 200;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;
}

/**
 * Validates an untrusted message coming from a webview.
 * Returns the typed message or undefined (unknown type / bad shape -> rejected).
 * Only whitelisted properties are copied, extra properties are dropped.
 */
export function parseWebviewMessage(raw: unknown): WebviewToExtensionMessage | undefined {
  if (!isPlainObject(raw) || typeof raw.type !== 'string') return undefined;
  switch (raw.type) {
    case 'ready':
      return raw.view === 'panel' || raw.view === 'sidebar' ? { type: 'ready', view: raw.view } : undefined;
    case 'openCity':
      return { type: 'openCity' };
    case 'refresh':
      return { type: 'refresh' };
    case 'toggleDemo':
      return { type: 'toggleDemo' };
    case 'openFolder':
      return typeof raw.workspaceId === 'string' &&
        raw.workspaceId.length > 0 &&
        raw.workspaceId.length <= MAX_ID_LENGTH
        ? { type: 'openFolder', workspaceId: raw.workspaceId }
        : undefined;
    case 'openWorkspace':
      return isId(raw.workspaceId)
        ? { type: 'openWorkspace', workspaceId: raw.workspaceId, newWindow: raw.newWindow === true }
        : undefined;
    case 'openSession':
      return isValidSessionId(raw.sessionId) ? { type: 'openSession', sessionId: raw.sessionId } : undefined;
    case 'copySessionId':
      return isValidSessionId(raw.sessionId) ? { type: 'copySessionId', sessionId: raw.sessionId } : undefined;
    case 'installHooks':
      return { type: 'installHooks' };
    case 'uninstallHooks':
      return { type: 'uninstallHooks' };
    case 'importWorkspaces':
      return { type: 'importWorkspaces' };
    case 'removeWorkspace':
      return isId(raw.workspaceId) ? { type: 'removeWorkspace', workspaceId: raw.workspaceId } : undefined;
    case 'setWorkspacePinned':
      return isId(raw.workspaceId) && typeof raw.pinned === 'boolean'
        ? { type: 'setWorkspacePinned', workspaceId: raw.workspaceId, pinned: raw.pinned }
        : undefined;
    default:
      return undefined;
  }
}

/** Light validation on the webview side (data comes from our own extension, but stay defensive). */
export function parseExtensionMessage(raw: unknown): ExtensionToWebviewMessage | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (raw.type === 'state' && isPlainObject(raw.state) && Array.isArray(raw.state.sessions)) {
    return raw as unknown as StateMessage;
  }
  if (raw.type === 'events' && Array.isArray(raw.events)) {
    return raw as unknown as EventsMessage;
  }
  if (raw.type === 'fitCity') return { type: 'fitCity' };
  return undefined;
}
