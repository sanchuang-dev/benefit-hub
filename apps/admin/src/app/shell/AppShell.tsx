import { App as AntdApp, Button, Dropdown, Layout, Menu, Tabs, Tag, Typography } from 'antd';
import {
  LayoutDashboard,
  LogOut,
  Package,
  ReceiptText,
  Settings,
  UserRound,
} from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import type { AdminIdentity } from '../../features/auth/api';
import { useLogoutMutation } from '../../features/auth/use-auth';
import { useUiPrefs } from '../../shared/lib/ui-prefs';
import './shell.css';

const { Header, Sider, Content } = Layout;

const NAV_ITEMS = [
  { key: '/', icon: <LayoutDashboard size={16} />, label: '总览' },
  { key: '/catalog', icon: <Package size={16} />, label: '商品管理' },
  { key: '/fulfillment', icon: <ReceiptText size={16} />, label: '发放记录' },
  { key: '/settings', icon: <Settings size={16} />, label: '系统设置' },
];

const NAV_KEYS = new Set(NAV_ITEMS.map((item) => item.key));

function activeMenuKey(pathname: string): string {
  const match = NAV_ITEMS.filter((item) => item.key !== '/').find((item) =>
    pathname.startsWith(item.key),
  );
  return match?.key ?? '/';
}

interface AppShellProps {
  admin: AdminIdentity;
}

export function AppShell({ admin }: AppShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const logoutMutation = useLogoutMutation();
  const { message } = AntdApp.useApp();
  const activeKey = activeMenuKey(location.pathname);
  const persistedTabKeys = useUiPrefs((state) => state.openTabs);
  const addTab = useUiPrefs((state) => state.addTab);
  const removeTab = useUiPrefs((state) => state.closeTab);

  useEffect(() => {
    addTab(activeKey);
  }, [activeKey, addTab]);

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

  const tabItems = openTabKeys
    .map((key) => NAV_ITEMS.find((item) => item.key === key))
    .filter((item): item is (typeof NAV_ITEMS)[number] => Boolean(item))
    .map((item) => ({
      key: item.key,
      label: item.label,
      closable: item.key !== '/',
    }));

  return (
    <Layout className="app-shell" hasSider>
      <Sider
        className="app-sider"
        theme="light"
        width={184}
        collapsedWidth={56}
        breakpoint="lg"
      >
        <div className="app-brand">
          <span className="app-brand-mark" aria-hidden="true">
            BH
          </span>
          <span className="app-brand-text">Benefit Hub</span>
        </div>
        <Menu
          className="app-nav"
          mode="inline"
          theme="light"
          selectedKeys={[activeKey]}
          items={NAV_ITEMS}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>

      <Layout className="app-main">
        <Header className="app-header">
          <div className="app-header-actions">
            <Tag color={admin.role === 'admin' ? 'blue' : 'default'}>
              {admin.role === 'admin' ? '管理员' : '只读'}
            </Tag>
            <Dropdown
              trigger={['click']}
              menu={{
                items: userMenuItems,
                onClick: ({ key }) => {
                  if (key === 'settings') navigate('/settings');
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

        <div className="app-tabs-bar" aria-label="已打开页面">
          <Tabs
            className="app-tabs"
            type="editable-card"
            size="small"
            hideAdd
            activeKey={activeKey}
            items={tabItems}
            onChange={(key) => navigate(key)}
            onEdit={(targetKey, action) => {
              if (action === 'remove' && typeof targetKey === 'string') closeTab(targetKey);
            }}
          />
        </div>

        <Content className="app-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
