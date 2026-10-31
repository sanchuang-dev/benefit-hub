import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { sanitizePanelPreferences, type DataPanelPreference } from './data-panel-state';
import { UI_PREFS_STORAGE_KEY, createUiPrefsStorage } from './ui-prefs-storage';

/**
 * Session-scoped UI preferences (work tabs, list view mode, mapping sub-tab).
 *
 * Only browser-local UI state belongs here: server data stays in TanStack Query
 * and is deliberately never persisted, because the admin API answers with
 * `cache-control: no-store` and catalogue rows carry optimistic-lock versions
 * that would be dangerous to replay from a stale on-disk snapshot.
 *
 * The persisted shape is versioned JSON (`UI_PREFS_VERSION`). The backend is
 * swappable through `createUiPrefsStorage()`, and hydration is observable via
 * `useUiPrefsHydrated()` so an async backend can be added without touching the
 * store actions or their consumers.
 */
export { UI_PREFS_STORAGE_KEY };

export const UI_PREFS_VERSION = 2;

/** Bounds restored tabs so a corrupted/hand-edited store cannot grow forever. */
const MAX_RESTORED_TABS = 20;

export type CatalogViewMode = 'table' | 'card';
export type MappingTabKey = 'current' | 'history';

export interface UiPrefs {
  /** Route keys of the open work tabs; the shell always keeps '/' (总览). */
  openTabs: string[];
  catalogView: CatalogViewMode;
  supplierView: CatalogViewMode;
  mappingTab: MappingTabKey;
  dataPanels: Record<string, DataPanelPreference>;
}

export interface UiPrefsActions {
  addTab: (key: string) => void;
  closeTab: (key: string) => void;
  setCatalogView: (view: CatalogViewMode) => void;
  setSupplierView: (view: CatalogViewMode) => void;
  setMappingTab: (tab: MappingTabKey) => void;
  setDataPanelPreference: (id: string, value: DataPanelPreference) => void;
  reset: () => void;
}

export type UiPrefsState = UiPrefs & UiPrefsActions;

const INITIAL_PREFS: UiPrefs = {
  openTabs: ['/'],
  catalogView: 'table',
  supplierView: 'table',
  mappingTab: 'current',
  dataPanels: {},
};

const VIEW_MODES: readonly CatalogViewMode[] = ['table', 'card'];
const MAPPING_TABS: readonly MappingTabKey[] = ['current', 'history'];

function isViewMode(value: unknown): value is CatalogViewMode {
  return VIEW_MODES.includes(value as CatalogViewMode);
}

function isMappingTab(value: unknown): value is MappingTabKey {
  return MAPPING_TABS.includes(value as MappingTabKey);
}

/**
 * Validates whatever sits in browser storage before it reaches the store.
 * Route whitelisting stays in the shell: only the shell knows which routes
 * exist. Here we only reject the wrong types/shapes.
 */
export function sanitizePersistedUiPrefs(value: unknown): Partial<UiPrefs> {
  if (typeof value !== 'object' || value === null) return {};

  const candidate = value as Record<string, unknown>;
  const sanitized: Partial<UiPrefs> = {};

  if (Array.isArray(candidate.openTabs)) {
    const tabs = candidate.openTabs.filter(
      (key): key is string => typeof key === 'string' && key.trim() !== '',
    );
    sanitized.openTabs = [...new Set(tabs)].slice(0, MAX_RESTORED_TABS);
  }
  if (isViewMode(candidate.catalogView)) sanitized.catalogView = candidate.catalogView;
  if (isViewMode(candidate.supplierView)) sanitized.supplierView = candidate.supplierView;
  if (isMappingTab(candidate.mappingTab)) sanitized.mappingTab = candidate.mappingTab;
  if ('dataPanels' in candidate) sanitized.dataPanels = sanitizePanelPreferences(candidate.dataPanels);

  return sanitized;
}

/**
 * Merge used by the persist middleware, including async hydration: persisted
 * preferences win over defaults, and any tab opened in this session is kept
 * (the default zustand merge would silently drop tabs added before an async
 * storage finished hydrating).
 */
export function mergePersistedUiPrefs(
  persistedState: unknown,
  currentState: UiPrefsState,
): UiPrefsState {
  const persisted = sanitizePersistedUiPrefs(persistedState);
  const seen = new Set<string>();
  const openTabs: string[] = [];
  for (const key of [...(persisted.openTabs ?? []), ...currentState.openTabs]) {
    if (seen.has(key)) continue;
    seen.add(key);
    openTabs.push(key);
  }

  return {
    ...currentState,
    openTabs: openTabs.slice(0, MAX_RESTORED_TABS),
    catalogView: persisted.catalogView ?? currentState.catalogView,
    supplierView: persisted.supplierView ?? currentState.supplierView,
    mappingTab: persisted.mappingTab ?? currentState.mappingTab,
    dataPanels: { ...(persisted.dataPanels ?? {}), ...currentState.dataPanels },
  };
}

export const useUiPrefs = create<UiPrefsState>()(
  persist(
    (set) => ({
      ...INITIAL_PREFS,
      addTab: (key) =>
        set((state) =>
          state.openTabs.includes(key) ? state : { openTabs: [...state.openTabs, key] },
        ),
      closeTab: (key) =>
        set((state) => ({ openTabs: state.openTabs.filter((item) => item !== key) })),
      setCatalogView: (catalogView) => set({ catalogView }),
      setSupplierView: (supplierView) => set({ supplierView }),
      setMappingTab: (mappingTab) => set({ mappingTab }),
      setDataPanelPreference: (id, value) =>
        set((state) => ({
          dataPanels: sanitizePanelPreferences({ ...state.dataPanels, [id]: value }),
        })),
      // Used on logout so the next operator never inherits this session's tabs.
      reset: () => set({ ...INITIAL_PREFS }),
    }),
    {
      name: UI_PREFS_STORAGE_KEY,
      version: UI_PREFS_VERSION,
      storage: createUiPrefsStorage(),
      partialize: (state): UiPrefs => ({
        openTabs: state.openTabs,
        catalogView: state.catalogView,
        supplierView: state.supplierView,
        mappingTab: state.mappingTab,
        dataPanels: state.dataPanels,
      }),
      merge: (persistedState, currentState) =>
        mergePersistedUiPrefs(persistedState, currentState),
      // Old shapes (or future versions) are sanitized instead of trusted.
      migrate: (persistedState) => ({
        ...INITIAL_PREFS,
        ...sanitizePersistedUiPrefs(persistedState),
      }),
    },
  ),
);

/**
 * True once persisted preferences have been read.
 *
 * With the current synchronous sessionStorage backend this is true on the first
 * render (hydration completes while the store is created). It exists so an
 * async backend (IndexedDB) can gate side effects on hydration instead of
 * writing a "default" state over the stored one; consumers need no change.
 */
export function useUiPrefsHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useUiPrefs.persist.hasHydrated());

  useEffect(() => {
    if (useUiPrefs.persist.hasHydrated()) {
      setHydrated(true);
      return undefined;
    }
    return useUiPrefs.persist.onFinishHydration(() => setHydrated(true));
  }, []);

  return hydrated;
}
