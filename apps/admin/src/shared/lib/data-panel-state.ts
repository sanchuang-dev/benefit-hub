/**
 * Display-only preferences. Never store query results, form drafts, permissions,
 * or server filter state here. Query state is owned by the calling page/URL.
 */
export type PanelView = 'table' | 'card';
export type PanelDensity = 'small' | 'middle' | 'large';
export interface DataPanelPreference {
  view?: PanelView;
  density?: PanelDensity;
  visibleKeys?: string[];
  columnOrder?: string[];
}

const MAX_PANELS = 30;
const MAX_COLUMNS = 60;
const VALID_PANEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function safeKeys(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 80,
  ))].slice(0, MAX_COLUMNS);
}

/** Reject damaged, obsolete and unbounded values before writing/hydrating UI prefs. */
export function sanitizePanelPreference(value: unknown): DataPanelPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const result: DataPanelPreference = {};
  if (raw.view === 'table' || raw.view === 'card') result.view = raw.view;
  if (raw.density === 'small' || raw.density === 'middle' || raw.density === 'large') {
    result.density = raw.density;
  }
  const visibleKeys = safeKeys(raw.visibleKeys);
  const columnOrder = safeKeys(raw.columnOrder);
  if (visibleKeys) result.visibleKeys = visibleKeys;
  if (columnOrder) result.columnOrder = columnOrder;
  return result;
}

export function sanitizePanelPreferences(value: unknown): Record<string, DataPanelPreference> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([id]) => VALID_PANEL_ID.test(id))
      .slice(0, MAX_PANELS)
      .map(([id, preference]) => [id, sanitizePanelPreference(preference)]),
  );
}

/**
 * Match persisted display preferences to today's columns: retired keys cannot
 * hide new columns; a corrupt "hide all" selection cannot make data disappear.
 */
export function resolvePanelPreference(
  raw: DataPanelPreference | undefined,
  keys: readonly string[],
  allowCard: boolean,
): Required<DataPanelPreference> {
  const clean = sanitizePanelPreference(raw);
  const unique = [...new Set(keys)];
  const known = new Set(unique);
  const order = [...(clean.columnOrder ?? []).filter((key) => known.has(key))];
  for (const key of unique) if (!order.includes(key)) order.push(key);
  const visible = clean.visibleKeys?.filter((key) => known.has(key)) ?? unique;
  return {
    view: allowCard && clean.view === 'card' ? 'card' : 'table',
    density: clean.density ?? 'middle',
    columnOrder: order,
    visibleKeys: visible.length > 0 ? visible : unique,
  };
}

/** Pure state transition, easy to test without a browser or Zustand. */
export function moveColumn(keys: readonly string[], key: string, offset: -1 | 1): string[] {
  const from = keys.indexOf(key);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= keys.length) return [...keys];
  const result = [...keys];
  [result[from], result[to]] = [result[to], result[from]];
  return result;
}
