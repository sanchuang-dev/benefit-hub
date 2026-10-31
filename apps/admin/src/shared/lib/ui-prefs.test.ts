// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  UI_PREFS_STORAGE_KEY,
  UI_PREFS_VERSION,
  mergePersistedUiPrefs,
  sanitizePersistedUiPrefs,
  useUiPrefs,
} from './ui-prefs';

afterEach(() => {
  useUiPrefs.getState().reset();
  // Persist API rather than sessionStorage: keeps this suite backend-agnostic.
  void useUiPrefs.persist.clearStorage();
});

describe('ui prefs store', () => {
  it('keeps the work tab list unique and home-anchored', () => {
    useUiPrefs.getState().addTab('/catalog');
    useUiPrefs.getState().addTab('/catalog');

    expect(useUiPrefs.getState().openTabs).toEqual(['/', '/catalog']);

    useUiPrefs.getState().closeTab('/catalog');
    expect(useUiPrefs.getState().openTabs).toEqual(['/']);
  });

  it('persists only UI preferences to the configured storage', () => {
    useUiPrefs.getState().addTab('/settings/audit');
    useUiPrefs
      .getState()
      .setDataPanelPreference('catalog-products', { view: 'card', visibleKeys: ['name'] });
    useUiPrefs.getState().setSupplierView('card');
    useUiPrefs.getState().setMappingTab('history');

    // This assertion intentionally reads sessionStorage: it is the current
    // backend chosen by createUiPrefsStorage(), not a store-level contract.
    const raw = sessionStorage.getItem(UI_PREFS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw ?? '{}') as {
      state: Record<string, unknown>;
      version: number;
    };

    expect(stored.version).toBe(UI_PREFS_VERSION);
    expect(stored.state.openTabs).toEqual(['/', '/settings/audit']);
    expect(stored.state.dataPanels).toEqual({
      'catalog-products': { view: 'card', visibleKeys: ['name'] },
    });
    expect(stored.state.supplierView).toBe('card');
    expect(stored.state.mappingTab).toBe('history');
    // Actions and any server data must never be written to browser storage.
    expect(stored.state.addTab).toBeUndefined();
    expect(stored.state.reset).toBeUndefined();
  });

  it('is already hydrated on the first render with the synchronous backend', () => {
    // Documents the current assumption. An async backend would flip this to a
    // hydration-boundary test that awaits persist.rehydrate() instead.
    expect(useUiPrefs.persist.hasHydrated()).toBe(true);
  });

  it('resets back to a single 总览 tab on demand', () => {
    useUiPrefs.getState().addTab('/catalog');
    useUiPrefs.getState().setSupplierView('card');

    useUiPrefs.getState().reset();

    expect(useUiPrefs.getState().openTabs).toEqual(['/']);
    expect(useUiPrefs.getState().supplierView).toBe('table');
  });
});

describe('persisted prefs validation', () => {
  it('drops unknown types and duplicate routes instead of trusting storage', () => {
    const sanitized = sanitizePersistedUiPrefs({
      openTabs: ['/catalog', 42, '/catalog', '', '/suppliers'],
      catalogView: 'grid',
      supplierView: 'card',
      mappingTab: 'weird',
    });

    expect(sanitized).toEqual({
      openTabs: ['/catalog', '/suppliers'],
      supplierView: 'card',
    });
  });

  it('ignores non-object payloads', () => {
    expect(sanitizePersistedUiPrefs(null)).toEqual({});
    expect(sanitizePersistedUiPrefs('nope')).toEqual({});
  });

  it('merges restored tabs with tabs opened in this session and keeps actions', () => {
    useUiPrefs.getState().addTab('/suppliers');
    const current = useUiPrefs.getState();

    const merged = mergePersistedUiPrefs(
      { openTabs: ['/', '/catalog', '/suppliers'] },
      current,
    );

    // Persisted order first, session-only tabs appended, no duplicates.
    expect(merged.openTabs).toEqual(['/', '/catalog', '/suppliers']);
    expect(typeof merged.addTab).toBe('function');
    expect(merged.supplierView).toBe('table');
  });

  it('keeps current preferences when storage has no valid values', () => {
    useUiPrefs.getState().setSupplierView('card');
    const current = useUiPrefs.getState();

    const merged = mergePersistedUiPrefs({}, current);

    expect(merged.supplierView).toBe('card');
    expect(merged.openTabs).toEqual(['/']);
  });
});
