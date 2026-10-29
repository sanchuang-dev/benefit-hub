import { AppWindow, Building2, Package, ReceiptText, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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
 * layout. Each destination is an existing page; the supplier catalogue deep-link
 * reuses the established URL-backed CatalogPage tab instead of creating a
 * placeholder.
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
      { key: '/catalog?tab=supplier', label: '供货目录' },
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
    pages: [{ key: '/settings', label: '系统设置' }],
  },
];

export const HOME_PAGE: NavPage = { key: '/', label: '总览' };

export const NAV_PAGES: readonly NavPage[] = [
  HOME_PAGE,
  ...NAV_GROUPS.flatMap((group) => group.pages),
];

// Restored work tabs are validated against real pages only: the supplier
// catalog is a distinct workspace keyed by its URL-backed tab.
export const NAV_KEYS: ReadonlySet<string> = new Set(NAV_PAGES.map((page) => page.key));

/**
 * Resolves the selected menu key for the current location. Supply and internal
 * product tabs share one route but are distinct workspaces.
 */
export function activeMenuKey(pathname: string, search: string): string {
  if (pathname === '/catalog') {
    return new URLSearchParams(search).get('tab') === 'supplier'
      ? '/catalog?tab=supplier'
      : '/catalog';
  }

  const match = NAV_PAGES.find(
    (page) => page.key !== '/' && (pathname === page.key || pathname.startsWith(page.key + '/')),
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
