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
    // 供货目录 opens the supplier detail's 供货商品 sub-tab rather than a second
    // catalogue page, so the menu entry carries the full destination key.
    expect(groups[0]?.pages.map((page) => page.key)).toEqual([
      '/suppliers',
      '/suppliers/yangmao?tab=catalog',
    ]);
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
  it('resolves the supplier catalogue deep link to its own menu entry', () => {
    expect(activeMenuKey('/suppliers/yangmao', '?tab=catalog')).toBe(
      '/suppliers/yangmao?tab=catalog',
    );
    // The panel writes its filter/paging keys into the same URL; the entry must
    // stay selected so the work tab does not silently switch to 供应商管理.
    expect(activeMenuKey('/suppliers/yangmao', '?tab=catalog&supplierQ=B')).toBe(
      '/suppliers/yangmao?tab=catalog',
    );
  });

  it('keeps nested supplier detail routes on the supplier entry', () => {
    expect(activeMenuKey('/suppliers/yangmao', '')).toBe('/suppliers');
    expect(activeMenuKey('/suppliers/yangmao', '?tab=connection')).toBe('/suppliers');
    expect(activeMenuKey('/suppliers/yangmao', '?supplierQ=B')).toBe('/suppliers');
    expect(activeMenuKey('/suppliers', '')).toBe('/suppliers');
  });

  it('keeps the owned products workspace separate from the supplier entry', () => {
    expect(activeMenuKey('/catalog', '')).toBe('/catalog');
    // The legacy /catalog?tab=supplier link is redirected by CatalogPage; until
    // then it must resolve to a real entry instead of throwing or highlighting
    // a removed workspace.
    expect(activeMenuKey('/catalog', '?tab=supplier')).toBe('/catalog');
    expect(activeMenuKey('/catalog', '?q=COFFEE')).toBe('/catalog');
  });

  it('lists the four governance workspaces as independent pages', () => {
    const governance = NAV_GROUPS.find((group) => group.key === 'governance');
    expect(governance?.pages.map((page) => [page.key, page.label])).toEqual([
      ['/settings/accounts', '账号与权限'],
      ['/settings/security', '安全与会话'],
      ['/settings/audit', '操作审计'],
      ['/settings/runtime', '平台状态'],
    ]);
  });

  it('selects each governance workspace from its own deep link', () => {
    expect(activeMenuKey('/settings/accounts', '')).toBe('/settings/accounts');
    expect(activeMenuKey('/settings/security', '')).toBe('/settings/security');
    expect(activeMenuKey('/settings/audit', '')).toBe('/settings/audit');
    expect(activeMenuKey('/settings/runtime', '')).toBe('/settings/runtime');
    // The retired entry is only a redirect, not a menu destination.
    expect(activeMenuKey('/settings', '')).toBe('/');
  });

  it('matches a governance page inside the 平台治理 group', () => {
    const { groups } = filterNavigation('审计');

    expect(groups.map((group) => group.key)).toEqual(['governance']);
    expect(groups[0]?.pages.map((page) => page.label)).toEqual(['操作审计']);
  });

  it('falls back to the overview for unknown routes', () => {
    expect(activeMenuKey('/removed-route', '')).toBe('/');
  });
});
