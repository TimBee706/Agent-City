/**
 * Pure helpers for opening a Claude Code session in the official VS Code extension.
 *
 * Evidence (https://code.claude.com/docs/en/vs-code, verified 2026-10-08): the Claude Code extension
 * (id `anthropic.claude-code`) registers a URI handler
 *   vscode://anthropic.claude-code/open[?prompt=<urlencoded>][&session=<session id>]
 * `session` resumes that session in a new tab; `prompt` only pre-fills (we never send one).
 */

export const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';
export const OPEN_SESSION_PATH = '/open';
export const SESSION_QUERY_PARAM = 'session';

/** Session ids are UUID-like: letters, digits, '-' and '_' only, 1..128 chars. */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** URI scheme of the running editor (vscode, vscode-insiders, cursor, ...). */
export function isValidUriScheme(scheme: unknown): scheme is string {
  return typeof scheme === 'string' && /^[a-z][a-z0-9+.-]{0,31}$/.test(scheme);
}

/** Returns the URI string, or undefined if the id / scheme is not acceptable. */
export function buildOpenSessionUri(sessionId: unknown, scheme: unknown = 'vscode'): string | undefined {
  if (!isValidSessionId(sessionId) || !isValidUriScheme(scheme)) return undefined;
  return `${scheme}://${CLAUDE_CODE_EXTENSION_ID}${OPEN_SESSION_PATH}?${SESSION_QUERY_PARAM}=${encodeURIComponent(sessionId)}`;
}
