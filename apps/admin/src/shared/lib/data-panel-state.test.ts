import { describe, expect, it } from 'vitest';
import {
  moveColumn,
  resolvePanelPreference,
  sanitizePanelPreference,
  sanitizePanelPreferences,
} from './data-panel-state';

describe('DataPanel display preference boundaries', () => {
  it('drops unknown view/density and untrusted keys without touching query state', () => {
    expect(sanitizePanelPreference({
      view: 'developer-mode', density: 'xxl', visibleKeys: ['name', 'name', 42],
      columnOrder: ['price', 'price', null], filters: { status: 'active' },
    })).toEqual({ visibleKeys: ['name'], columnOrder: ['price'] });
    expect(sanitizePanelPreferences({
      catalog: { view: 'card', density: 'small' },
      'invalid id!': { view: 'card' },
    })).toEqual({ catalog: { view: 'card', density: 'small' } });
  });

  it('recovers retired keys and a broken hide-all view', () => {
    expect(resolvePanelPreference({
      view: 'card', density: 'large', visibleKeys: ['deleted'],
      columnOrder: ['deleted', 'price', 'price'],
    }, ['name', 'price'], false)).toEqual({
      view: 'table', density: 'large', visibleKeys: ['name', 'price'],
      columnOrder: ['price', 'name'],
    });
  });

  it('keeps visible columns in a known order and moves them immutably', () => {
    const prefs = resolvePanelPreference({
      visibleKeys: ['name'], columnOrder: ['price', 'name'],
    }, ['name', 'price', 'status'], true);
    expect(prefs.visibleKeys).toEqual(['name']);
    expect(prefs.columnOrder).toEqual(['price', 'name', 'status']);
    expect(moveColumn(prefs.columnOrder, 'price', 1)).toEqual(['name', 'price', 'status']);
    expect(moveColumn(prefs.columnOrder, 'price', -1)).toEqual(prefs.columnOrder);
  });

  it('shows newly added columns after an existing preference was saved', () => {
    const prefs = resolvePanelPreference({
      visibleKeys: ['name'], columnOrder: ['name', 'price'],
    }, ['name', 'price', 'status'], true);
    expect(prefs.visibleKeys).toEqual(['name', 'status']);
    expect(prefs.columnOrder).toEqual(['name', 'price', 'status']);
  });

  it('never restores more than a bounded number of panel ids or column keys', () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [
      'panel-' + i, { columnOrder: Array.from({ length: 200 }, (_, x) => 'field-' + x) },
    ]));
    const safe = sanitizePanelPreferences(many);
    expect(Object.keys(safe)).toHaveLength(30);
    expect(safe['panel-0']?.columnOrder).toHaveLength(60);
  });
});
