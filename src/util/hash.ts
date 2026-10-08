/**
 * Pure hashing helpers usable in both the extension host and the webview bundle
 * (no node:crypto dependency).
 */

/** 32-bit FNV-1a hash rendered as 8 hex chars. Deterministic, not cryptographic. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Two FNV variants concatenated -> 16 hex chars, lower collision risk for ids. */
export function stableId(input: string): string {
  return fnv1a(input) + fnv1a('#' + input + '#' + input.length);
}

/** JSON.stringify with sorted object keys, so structurally equal values produce equal strings. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'undefined';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
