import type { KeyboardEvent, MouseEvent } from 'react';

export type Selection =
  | { kind: 'workspace'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'agent'; id: string }
  /** An archived / recent session known only from the history index (a box in the basement). */
  | { kind: 'history'; id: string; workspaceId: string }
  | undefined;

export interface SelectOptions {
  /** Keep keyboard focus where it is (e.g. arrow-key navigation) instead of moving it to the panel. */
  keepFocus?: boolean;
}

export type Select = (sel: Selection, opts?: SelectOptions) => void;

/** Props making an SVG/HTML element an accessible button (click + Enter/Space). */
export function activatable(onActivate: () => void, label: string) {
  return {
    tabIndex: 0,
    role: 'button',
    'aria-label': label,
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      onActivate();
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        onActivate();
      }
    },
  } as const;
}
