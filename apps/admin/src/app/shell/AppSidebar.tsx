import { Empty, Input, Layout, Menu } from 'antd';
import type { MenuProps } from 'antd';
import { LayoutDashboard, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { filterNavigation, HOME_PAGE, NAV_GROUPS } from './navigation';
import type { NavGroup } from './navigation';
import './sidebar.css';

const { Sider } = Layout;

type MenuItems = NonNullable<MenuProps['items']>;

interface AppSidebarProps {
  /** Menu key of the current route, resolved by `activeMenuKey()`. */
  activeKey: string;
  onNavigate: (key: string) => void;
  /**
   * `sider` is the persistent desktop rail (collapsible at the `lg` breakpoint).
   * `drawer` is the same navigation rendered inside the compact-screen drawer,
   * where an icon rail would waste width; it is always expanded and keeps the
   * search input available.
   */
  variant?: 'sider' | 'drawer';
}

function buildMenuItems(groups: readonly NavGroup[]): MenuItems {
  return groups.map((group) => {
    const Icon = group.icon;
    return {
      key: group.key,
      icon: <Icon size={16} aria-hidden="true" />,
      label: group.label,
      children: group.pages.map((page) => ({ key: page.key, label: page.label })),
    };
  });
}

/**
 * Sidebar shell: brand, menu search and the Ant Design Menu. The search only
 * narrows what is visible; routes, work tabs and page data stay untouched.
 */
export function AppSidebar({ activeKey, onNavigate, variant = 'sider' }: AppSidebarProps) {
  const [query, setQuery] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<string[]>(() =>
    NAV_GROUPS.map((group) => group.key),
  );
  const [collapsed, setCollapsed] = useState(false);
  const isDrawer = variant === 'drawer';

  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length > 0;
  const { showHome, groups: visibleGroups } = useMemo(
    () => filterNavigation(trimmedQuery),
    [trimmedQuery],
  );

  const items = useMemo<MenuItems>(() => {
    const menuItems: MenuItems = showHome
      ? [
          {
            key: HOME_PAGE.key,
            icon: <LayoutDashboard size={16} aria-hidden="true" />,
            label: HOME_PAGE.label,
          },
        ]
      : [];
    return [...menuItems, ...buildMenuItems(visibleGroups)];
  }, [showHome, visibleGroups]);

  // Deep links and browser history must reveal the selected group, even if it
  // was previously collapsed by the operator.
  useEffect(() => {
    const parent = NAV_GROUPS.find((group) =>
      group.pages.some((page) => page.key === activeKey),
    );
    if (!parent) return;
    setExpandedGroups((current) =>
      current.includes(parent.key) ? current : [...current, parent.key],
    );
  }, [activeKey]);

  // While searching, every group that still has a hit is expanded; otherwise the
  // operator's own expansion state is restored as soon as the query clears.
  const openKeys = searching ? visibleGroups.map((group) => group.key) : expandedGroups;

  const navigation = (
    <nav className="app-nav-region" aria-label="主导航">
      {items.length === 0 ? (
        <Empty
          className="app-sidebar-empty"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="未找到匹配的菜单"
        />
      ) : (
        <Menu
          className="app-nav"
          mode="inline"
          theme="light"
          selectedKeys={[activeKey]}
          items={items}
          openKeys={openKeys}
          onOpenChange={(keys) => {
            if (!searching) setExpandedGroups(keys);
          }}
          onClick={({ key }) => onNavigate(key)}
        />
      )}
    </nav>
  );

  // The drawer is rendered by AppShell with its own title bar, so the brand
  // lockup would repeat the dialog header there.
  const brand = isDrawer ? null : (
    <div className="app-brand">
      {/* Brand mark from public/brand. Decorative: the wordmark next to it and
          the document title carry the accessible name. */}
      <img
        className="app-brand-mark"
        src="/brand/logo-icon-512.png"
        alt=""
        aria-hidden="true"
        width={26}
        height={26}
      />
      <span className="app-brand-text">
        <span className="app-brand-abbr">3C</span>{' '}
        <span className="app-brand-name">Benefit Hub</span>
      </span>
    </div>
  );

  const search = isDrawer || !collapsed ? (
    <div className="app-sidebar-search">
      <Input
        allowClear
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索菜单"
        aria-label="搜索菜单"
        autoComplete="off"
        prefix={<Search size={14} aria-hidden="true" />}
      />
    </div>
  ) : null;

  if (isDrawer) {
    return (
      <div className="app-sidebar-drawer">
        {search}
        {navigation}
      </div>
    );
  }

  return (
    <Sider
      className="app-sider"
      theme="light"
      width={216}
      collapsedWidth={56}
      breakpoint="lg"
      onCollapse={(nextCollapsed) => {
        setCollapsed(nextCollapsed);
        // The collapsed rail cannot show the input; clear the filter so the
        // icon-only menu is never silently narrowed by an invisible query.
        if (nextCollapsed) setQuery('');
      }}
    >
      {brand}
      {search}
      {navigation}
    </Sider>
  );
}
