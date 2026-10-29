// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { UI_PREFS_STORAGE_KEY, useUiPrefs } from './ui-prefs';

afterEach(() => {
  useUiPrefs.getState().reset();
  sessionStorage.clear();
});

describe('ui prefs store', () => {
  it('keeps the work tab list unique and home-anchored', () => {
    useUiPrefs.getState().addTab('/catalog');
    useUiPrefs.getState().addTab('/catalog');

    expect(useUiPrefs.getState().openTabs).toEqual(['/', '/catalog']);

    useUiPrefs.getState().closeTab('/catalog');
    expect(useUiPrefs.getState().openTabs).toEqual(['/']);
  });

  it('persists only UI preferences to sessionStorage', () => {
    useUiPrefs.getState().addTab('/settings');
    useUiPrefs.getState().setCatalogView('card');
    useUiPrefs.getState().setSupplierView('card');
    useUiPrefs.getState().setMappingTab('history');

    const raw = sessionStorage.getItem(UI_PREFS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw ?? '{}') as {
      state: Record<string, unknown>;
      version: number;
    };

    expect(stored.version).toBe(1);
    expect(stored.state.openTabs).toEqual(['/', '/settings']);
    expect(stored.state.catalogView).toBe('card');
    expect(stored.state.supplierView).toBe('card');
    expect(stored.state.mappingTab).toBe('history');
    // Actions and any server data must never be written to browser storage.
    expect(stored.state.addTab).toBeUndefined();
    expect(stored.state.reset).toBeUndefined();
  });

  it('resets back to a single 总览 tab on demand', () => {
    useUiPrefs.getState().addTab('/catalog');
    useUiPrefs.getState().setCatalogView('card');

    useUiPrefs.getState().reset();

    expect(useUiPrefs.getState().openTabs).toEqual(['/']);
    expect(useUiPrefs.getState().catalogView).toBe('table');
  });
});
