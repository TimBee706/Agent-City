/**
 * Persisted webview UI state (vscode.setState) with a version, pure + unit-tested.
 */
import { CityFilters, sanitizeFilters } from './filters';
import { CITY_NAV, NavState, sanitizeNav } from './navigation';
import type { Selection } from './selection';
import { ViewTransform, isValidTransform } from './zoom';

/**
 * v2: workspaces are always visible. Older states may have "Hide inactive" / "Only with sessions"
 * switched on (which would hide most imported buildings) and a zoom for a much smaller city, so
 * both filters are reset once and the city is fitted again.
 * v3: the "Show archived" toggle became the Live / Recent / Archived tier filter
 * (`showArchived: false` -> tiers live + recent, see sanitizeFilters); zoom and selection are kept.
 * v4: isometric city + building level. Navigation state (`nav`) and a camera for the building view
 * (`buildingZoom`) are new; the city camera of v3 (flat map coordinates) does not fit the isometric
 * map and is dropped once (the city is fitted again). Filters and selection are kept.
 */
export const UI_STATE_VERSION = 4;

export interface BuildingCamera {
  workspaceId: string;
  t: ViewTransform;
}

export interface UiState {
  v?: number;
  selection?: Selection;
  filters?: CityFilters;
  /** Camera of the city level. */
  zoom?: ViewTransform;
  /** Level + building shown. */
  nav?: NavState;
  /** Camera of the building level (for the building it was saved for). */
  buildingZoom?: BuildingCamera;
}

function sanitizeBuildingCamera(v: unknown): BuildingCamera | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.workspaceId !== 'string' || !o.workspaceId || o.workspaceId.length > 300 || !isValidTransform(o.t)) return undefined;
  return { workspaceId: o.workspaceId, t: o.t };
}

export function sanitizeSelection(v: unknown): Selection {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if ((o.kind === 'workspace' || o.kind === 'session' || o.kind === 'agent') && typeof o.id === 'string' && o.id.length <= 300) {
    return { kind: o.kind, id: o.id };
  }
  if (o.kind === 'history' && typeof o.id === 'string' && o.id.length <= 300 && typeof o.workspaceId === 'string' && o.workspaceId.length <= 300) {
    return { kind: 'history', id: o.id, workspaceId: o.workspaceId };
  }
  return undefined;
}

/** Sanitizes a persisted state and migrates older versions. Always returns the current version. */
export function migrateUiState(raw: unknown): UiState {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const version = typeof o.v === 'number' && Number.isFinite(o.v) ? o.v : 0;
  const filters = sanitizeFilters(o.filters);
  const ui: UiState = { v: UI_STATE_VERSION, filters, selection: sanitizeSelection(o.selection), nav: CITY_NAV };
  if (version < 2) {
    filters.hideInactive = false;
    filters.onlyWithSessions = false;
    return ui; // no zoom: fit the (now larger) city once
  }
  if (version < 4) return ui; // flat-map camera does not fit the isometric city: fit once
  if (version > UI_STATE_VERSION) return ui; // unknown (newer) shape: no zoom
  if (isValidTransform(o.zoom)) ui.zoom = o.zoom;
  ui.nav = sanitizeNav(o.nav);
  const bz = sanitizeBuildingCamera(o.buildingZoom);
  if (bz) ui.buildingZoom = bz;
  return ui;
}
