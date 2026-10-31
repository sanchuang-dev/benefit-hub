import { AppWindow, Building2, Package, ReceiptText, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SETTINGS_SECTIONS } from '../../features/settings/sections';

export interface NavPage {
  readonly key: string;
  readonly label: string;
}

export interface NavGroup {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly pages: readonly NavPage[];
}

/**
 * Navigation expresses platform domains, not the current upstream provider's API
 * layout. Each destination is an existing page; 供货目录 points at the 供货商品
 * sub-tab of the supplier detail page instead of duplicating a second catalogue
 * page, so the supplier's own products stay in the supplier workspace.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'rights',
    label: '权益中心',
    icon: Package,
    pages: [
      { key: '/catalog', label: '权益商品' },
      { key: '/value-rules', label: '价值换算' },
    ],
  },
  {
    key: 'supply',
    label: '供给中心',
    icon: Building2,
    pages: [
      { key: '/suppliers', label: '供应商管理' },
      // Full destination key (path + query): the supplier detail page renders
      // the URL-backed 供货商品 sub-tab for it.
      { key: '/suppliers/yangmao?tab=catalog', label: '供货目录' },
    ],
  },
  {
    key: 'open-platform',
    label: '开放平台',
    icon: AppWindow,
    pages: [
      { key: '/applications', label: '下游应用' },
      { key: '/interfaces', label: '接口管理' },
    ],
  },
  {
    key: 'delivery',
    label: '订单履约',
    icon: ReceiptText,
    pages: [{ key: '/fulfillment', label: '业务订单' }],
  },
  {
    key: 'governance',
    label: '平台治理',
    icon: Settings,
    // 系统设置 split into four independent workspaces; one key per page keeps
    // deep links, the selected menu entry and the work-tab strip in agreement.
    pages: SETTINGS_SECTIONS.map((section) => ({ key: section.path, label: section.label })),
  },
];

export const HOME_PAGE: NavPage = { key: '/', label: '总览' };

export const NAV_PAGES: readonly NavPage[] = [
  HOME_PAGE,
  ...NAV_GROUPS.flatMap((group) => group.pages),
];

// Restored work tabs are validated against real pages only: the supplier
// catalogue is the supplier detail workspace keyed by its URL-backed sub-tab.
export const NAV_KEYS: ReadonlySet<string> = new Set(NAV_PAGES.map((page) => page.key));

/**
 * Whether a destination key's query requirements are present in the location.
 * Extraneous parameters are allowed, because the supplier products panel writes
 * its own supplierQ/paging keys into the same URL.
 */
function queryEntryMatches(key: string, pathname: string, search: string): boolean {
  const [keyPath, keyQuery] = key.split('?');
  if (!keyQuery || keyPath !== pathname) return false;

  const expected = new URLSearchParams(keyQuery);
  const actual = new URLSearchParams(search);
  let matches = true;
  expected.forEach((value, name) => {
    if (actual.get(name) !== value) matches = false;
  });
  return matches;
}

/**
 * Resolves the selected menu key for the current location. A destination may be
 * a full key (path + query) such as 供货目录 → /suppliers/yangmao?tab=catalog;
 * those are matched before the pathname fallback. The fallback deliberately
 * ignores keys that carry a query string, so 供应商概览 under /suppliers/yangmao
 * still resolves to 供应商管理.
 */
export function activeMenuKey(pathname: string, search: string): string {
  const full = pathname + search;
  const exact = NAV_PAGES.find((page) => page.key === full);
  if (exact) return exact.key;

  // Keep 供货目录 selected while its panel rewrites the URL with filters;
  // otherwise the first query would move the work tab to 供应商管理.
  const queryEntry = NAV_PAGES.find((page) => queryEntryMatches(page.key, pathname, search));
  if (queryEntry) return queryEntry.key;

  const match = NAV_PAGES.find(
    (page) =>
      page.key !== '/' &&
      !page.key.includes('?') &&
      (pathname === page.key || pathname.startsWith(page.key + '/')),
  );
  return match?.key ?? '/';
}

export interface NavigationFilter {
  /** 总览 is a top-level item rather than a group, so it is matched separately. */
  readonly showHome: boolean;
  readonly groups: readonly NavGroup[];
}

/**
 * Filters the navigation to matching pages. A group-label hit keeps every page
 * in that group; an empty query returns the untouched navigation model.
 */
export function filterNavigation(query: string): NavigationFilter {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return { showHome: true, groups: NAV_GROUPS };

  return {
    showHome: HOME_PAGE.label.toLowerCase().includes(normalized),
    groups: NAV_GROUPS.flatMap((group) => {
      if (group.label.toLowerCase().includes(normalized)) return [group];
      const pages = group.pages.filter((page) => page.label.toLowerCase().includes(normalized));
      return pages.length > 0 ? [{ ...group, pages }] : [];
    }),
  };
}
