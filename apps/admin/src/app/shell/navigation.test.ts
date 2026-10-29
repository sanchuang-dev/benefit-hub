import { describe, expect, it } from 'vitest';
import { activeMenuKey, filterNavigation, NAV_GROUPS } from './navigation';

describe('filterNavigation', () => {
  it('returns the untouched model for an empty or whitespace query', () => {
    expect(filterNavigation('')).toEqual({ showHome: true, groups: NAV_GROUPS });
    expect(filterNavigation('   ')).toEqual({ showHome: true, groups: NAV_GROUPS });
  });

  it('keeps only matching pages and their group', () => {
    const { showHome, groups } = filterNavigation('订单');

    expect(showHome).toBe(false);
    expect(groups.map((group) => group.key)).toEqual(['delivery']);
    expect(groups[0]?.pages.map((page) => page.label)).toEqual(['业务订单']);
  });

  it('keeps every page when the group label itself matches', () => {
    const { groups } = filterNavigation('供给中心');

    expect(groups.map((group) => group.key)).toEqual(['supply']);
    expect(groups[0]?.pages.map((page) => page.label)).toEqual(['供应商管理', '供货目录']);
  });

  it('matches the top-level overview item separately', () => {
    const { showHome, groups } = filterNavigation('总览');

    expect(showHome).toBe(true);
    expect(groups).toEqual([]);
  });

  it('trims the query and matches a label fragment', () => {
    const { groups } = filterNavigation('  价值  ');

    expect(groups.map((group) => group.key)).toEqual(['rights']);
    expect(groups[0]?.pages.map((page) => page.label)).toEqual(['价值换算']);
  });

  it('returns no items when nothing matches', () => {
    expect(filterNavigation('不存在的菜单')).toEqual({ showHome: false, groups: [] });
  });
});

describe('activeMenuKey', () => {
  it('distinguishes the owned and supplier catalogue workspaces', () => {
    expect(activeMenuKey('/catalog', '')).toBe('/catalog');
    expect(activeMenuKey('/catalog', '?tab=supplier')).toBe('/catalog?tab=supplier');
  });

  it('keeps nested supplier detail routes on the supplier entry', () => {
    expect(activeMenuKey('/suppliers/yangmao', '')).toBe('/suppliers');
  });

  it('falls back to the overview for unknown routes', () => {
    expect(activeMenuKey('/removed-route', '')).toBe('/');
  });
});
