import { Empty, Input, Layout, Menu } from 'antd';
import type { MenuProps } from 'antd';
import { LayoutDashboard, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
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
  const isCollapsed = !isDrawer && collapsed;

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
    <>
      <div className={`app-brand${isCollapsed ? ' app-brand-collapsed' : ''}`}>
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
        {!isDrawer ? (
          <button type="button" className="app-sidebar-toggle" onClick={() => { setCollapsed((value) => !value); setQuery(''); }} aria-label={isCollapsed ? '展开侧边栏' : '收起侧边栏'} aria-expanded={!isCollapsed}>
            {isCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        ) : null}
      </div>

      {!isCollapsed ? (
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
      )}

      <nav aria-label="主导航">
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
          openKeys={isCollapsed ? undefined : openKeys}
          onOpenChange={(keys) => {
            if (!searching) setExpandedGroups(keys);
          }}
          inlineCollapsed={isCollapsed}
          onClick={({ key }) => onNavigate(key)}
        />
      )}
      </nav>
    </>
  );

  if (isDrawer) return <div className="app-sidebar-drawer">{navigation}</div>;

  return (
    <Sider className="app-sider" theme="light" width={248} collapsedWidth={68}
      collapsed={collapsed} trigger={null} breakpoint="lg" onBreakpoint={setCollapsed}>
      {navigation}
    </Sider>
  );
}
