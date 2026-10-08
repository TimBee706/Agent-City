/**
 * Pure, platform-independent path helpers (no node:path) so behaviour is identical in tests on
 * any OS. Windows paths are detected by shape (drive letter / UNC) and compared case-insensitively.
 */

export function isWindowsLikePath(p: string): boolean {
  return /^[a-zA-Z]:([\\/]|$)/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

export interface NormalizeOptions {
  /** Force case-insensitive key. Defaults to true for Windows-like paths. */
  caseInsensitive?: boolean;
}

/**
 * Produces a comparison key:
 *  - backslashes -> forward slashes, duplicate separators collapsed (UNC prefix kept)
 *  - `/./` segments removed, trailing separators removed (except for roots)
 *  - lower-cased for Windows-like paths
 */
export function normalizePathKey(input: string, opts: NormalizeOptions = {}): string {
  let p = input.trim().replace(/\\/g, '/');
  const unc = /^\/\/[^/]/.test(p);
  p = p.replace(/\/{2,}/g, '/');
  if (unc) p = '/' + p;
  p = p.replace(/\/\.(?=\/|$)/g, '');
  if (/^[a-zA-Z]:$/.test(p)) p += '/';
  while (p.length > 1 && p.endsWith('/') && !/^[a-zA-Z]:\/$/.test(p) && !(unc && p === '//')) {
    p = p.slice(0, -1);
  }
  const ci = opts.caseInsensitive ?? isWindowsLikePath(input.trim());
  return ci ? p.toLowerCase() : p;
}

/** True if `childKey` equals `parentKey` or lies below it. Both must be normalized keys. */
export function isSameOrChildKey(parentKey: string, childKey: string): boolean {
  if (childKey === parentKey) return true;
  const prefix = parentKey.endsWith('/') ? parentKey : parentKey + '/';
  return childKey.startsWith(prefix);
}

/** Last path segment for display; roots return the root itself (e.g. "C:"). */
export function displayName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter((s) => s.length > 0);
  if (!parts.length) return path || '/';
  return parts[parts.length - 1];
}
