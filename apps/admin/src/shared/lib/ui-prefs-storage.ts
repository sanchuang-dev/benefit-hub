import { createJSONStorage, type PersistStorage } from 'zustand/middleware';
import type { UiPrefs } from './ui-prefs';

/**
 * Single swap point for the UI-preferences persistence backend.
 *
 * Today this is sessionStorage: synchronous, per-browser-tab, cleared when the
 * tab closes — the semantics the operations console wants for work tabs on a
 * shared machine. Putting it behind a factory means a future backend (for
 * example IndexedDB) only replaces this function; the store, its actions and
 * every consumer stay untouched.
 *
 * Requirements for a future backend:
 * - `getItem` may return a Promise, so hydration becomes async. AppShell gates
 *   its tab side effects on `useUiPrefsHydrated()`; tests must await
 *   `useUiPrefs.persist.rehydrate()` before asserting restored tabs.
 * - IndexedDB/localStorage are shared across tabs and survive restarts, unlike
 *   sessionStorage. That changes product semantics (the next operator could
 *   inherit the previous one's tabs) and needs an explicit decision, plus
 *   cross-tab merge/notification handling if concurrent tabs must agree.
 * - Storage may be unavailable (private mode, quota, blocked upgrade); the
 *   factory should return an in-memory fallback instead of losing writes.
 */
export const UI_PREFS_STORAGE_KEY = 'bh:ui-prefs';

export function createUiPrefsStorage(): PersistStorage<UiPrefs> | undefined {
  // Keep this the only place that names a concrete browser storage API.
  return createJSONStorage<UiPrefs>(() => sessionStorage);
}
