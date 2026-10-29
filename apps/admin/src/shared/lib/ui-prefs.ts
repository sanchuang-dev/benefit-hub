import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Session-scoped UI preferences (work tabs, list view mode, mapping sub-tab).
 *
 * Only browser-local UI state belongs here: server data stays in TanStack Query
 * and is deliberately never persisted, because the admin API answers with
 * `cache-control: no-store` and catalogue rows carry optimistic-lock versions
 * that would be dangerous to replay from a stale on-disk snapshot.
 */
export const UI_PREFS_STORAGE_KEY = 'bh:ui-prefs';

export type CatalogViewMode = 'table' | 'card';
export type MappingTabKey = 'current' | 'history';

export interface UiPrefs {
  /** Route keys of the open work tabs; the shell always keeps '/' (总览). */
  openTabs: string[];
  catalogView: CatalogViewMode;
  supplierView: CatalogViewMode;
  mappingTab: MappingTabKey;
}

export interface UiPrefsActions {
  addTab: (key: string) => void;
  closeTab: (key: string) => void;
  setCatalogView: (view: CatalogViewMode) => void;
  setSupplierView: (view: CatalogViewMode) => void;
  setMappingTab: (tab: MappingTabKey) => void;
  reset: () => void;
}

export type UiPrefsState = UiPrefs & UiPrefsActions;

const INITIAL_PREFS: UiPrefs = {
  openTabs: ['/'],
  catalogView: 'table',
  supplierView: 'table',
  mappingTab: 'current',
};

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
      // Used on logout so the next operator never inherits this session's tabs.
      reset: () => set({ ...INITIAL_PREFS }),
    }),
    {
      name: UI_PREFS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state): UiPrefs => ({
        openTabs: state.openTabs,
        catalogView: state.catalogView,
        supplierView: state.supplierView,
        mappingTab: state.mappingTab,
      }),
    },
  ),
);
