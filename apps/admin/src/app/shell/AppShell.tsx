import { App as AntdApp, Button, Drawer, Dropdown, Layout, Tabs, Tag, Typography } from 'antd';
import { LogOut, Menu as MenuIcon, MoreHorizontal, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import type { AdminIdentity } from '../../features/auth/api';
import { useLogoutMutation } from '../../features/auth/use-auth';
import { DEFAULT_SETTINGS_PATH } from '../../features/settings/sections';
import { useUiPrefs, useUiPrefsHydrated } from '../../shared/lib/ui-prefs';
import { COMPACT_NAV_MEDIA_QUERY, useMediaQuery } from '../../shared/lib/use-media-query';
import { AppSidebar } from './AppSidebar';
import { activeMenuKey, NAV_KEYS, NAV_PAGES } from './navigation';
import './shell.css';

const { Header, Content } = Layout;

/**
 * The tab strip collapses overflow behind a dropdown button. antd's default icon
 * only exposes the English "ellipsis" glyph label, so supply a named icon to the
 * button, which antd renders as the trigger's only content.
 */
const TABS_MORE_ICON = (
  <span role="img" aria-label="更多页面">
    <MoreHorizontal size={16} aria-hidden="true" />
  </span>
);

interface AppShellProps {
  admin: AdminIdentity;
}

export function AppShell({ admin }: AppShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const logoutMutation = useLogoutMutation();
  const { message } = AntdApp.useApp();
  const activeKey = activeMenuKey(location.pathname, location.search);
  const persistedTabKeys = useUiPrefs((state) => state.openTabs);
  const addTab = useUiPrefs((state) => state.addTab);
  const removeTab = useUiPrefs((state) => state.closeTab);
  const hydrated = useUiPrefsHydrated();
  // Design §9: below 768px the persistent sidebar would eat a third of a phone
  // viewport, so navigation moves into a drawer opened from the shell header.
  const compactNav = useMediaQuery(COMPACT_NAV_MEDIA_QUERY);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    // A viewport change back to desktop must not leave an orphaned drawer open.
    if (!compactNav) setNavOpen(false);
  }, [compactNav]);

  useEffect(() => {
    // Hydration boundary: an async storage backend must finish restoring before
    // the current route is appended, otherwise a default tab list could be
    // written over the persisted one. With sessionStorage hydration is already
    // complete on the first render, so this is true immediately.
    if (!hydrated) return;
    addTab(activeKey);
  }, [activeKey, addTab, hydrated]);

  /**
   * The route stays the source of truth for the current page; stored keys only
   * restore the tab strip. Unknown routes from an older build are dropped and
   * the 总览 tab is always kept, so a direct refresh on /catalog does not lose it.
   */
  const openTabKeys = useMemo(() => {
    const restored = persistedTabKeys.filter((key) => NAV_KEYS.has(key));
    const withHome = restored.includes('/') ? restored : ['/', ...restored];
    return withHome.includes(activeKey) ? withHome : [...withHome, activeKey];
  }, [activeKey, persistedTabKeys]);

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        navigate('/login', { replace: true, state: { reason: 'LOGGED_OUT' } });
      },
      onError: () => {
        message.error('退出登录失败，请重试');
      },
    });
  };

  const closeTab = (key: string) => {
    if (key === '/') return;

    const currentIndex = openTabKeys.indexOf(key);
    const nextKeys = openTabKeys.filter((item) => item !== key);
    removeTab(key);

    if (key === activeKey) {
      navigate(nextKeys[Math.max(0, currentIndex - 1)] ?? '/');
    }
  };

  const userMenuItems = [
    { key: 'settings', label: '系统设置' },
    { key: 'logout', label: '退出登录', icon: <LogOut size={14} /> },
  ];

  const tabItems = openTabKeys.flatMap((key) => {
    const page = NAV_PAGES.find((item) => item.key === key);
    return page ? [{ key, label: page.label, closable: key !== '/' }] : [];
  });

  return (
    <Layout className="app-shell" hasSider={!compactNav}>
      {compactNav ? null : (
        <AppSidebar activeKey={activeKey} onNavigate={(key) => navigate(key)} />
      )}

      <Layout className="app-main">
        <Header className="app-header">
          {compactNav ? (
            <Button
              className="app-nav-trigger"
              type="text"
              aria-label="打开导航菜单"
              aria-expanded={navOpen}
              icon={<MenuIcon size={18} aria-hidden="true" />}
              onClick={() => setNavOpen(true)}
            />
          ) : null}
          <div className="app-header-actions">
            <Tag color={admin.role === 'admin' ? 'blue' : 'default'}>
              {admin.role === 'admin' ? '管理员' : '只读'}
            </Tag>
            <Dropdown
              trigger={['click']}
              menu={{
                items: userMenuItems,
                onClick: ({ key }) => {
                  if (key === 'settings') navigate(DEFAULT_SETTINGS_PATH);
                  if (key === 'logout') handleLogout();
                },
              }}
            >
              <Button type="text" icon={<UserRound size={16} />}>
                <Typography.Text>{admin.displayName}</Typography.Text>
              </Button>
            </Dropdown>
          </div>
        </Header>

        <nav className="app-tabs-bar" aria-label="已打开页面">
          <Tabs
            className="app-tabs"
            type="editable-card"
            size="small"
            hideAdd
            activeKey={activeKey}
            items={tabItems}
            moreIcon={TABS_MORE_ICON}
            onChange={(key) => navigate(key)}
            onEdit={(targetKey, action) => {
              if (action === 'remove' && typeof targetKey === 'string') closeTab(targetKey);
            }}
          />
        </nav>

        <Content className="app-content">
          <Outlet />
        </Content>
      </Layout>

      {compactNav ? (
        <Drawer
          className="app-nav-drawer"
          title="导航菜单"
          placement="left"
          size={280}
          open={navOpen}
          onClose={() => setNavOpen(false)}
          styles={{ body: { padding: 0 } }}
        >
          <AppSidebar
            variant="drawer"
            activeKey={activeKey}
            onNavigate={(key) => {
              navigate(key);
              setNavOpen(false);
            }}
          />
        </Drawer>
      ) : null}
    </Layout>
  );
}
