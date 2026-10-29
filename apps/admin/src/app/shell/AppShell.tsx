import { App as AntdApp, Button, Dropdown, Layout, Menu, Tabs, Tag, Typography } from 'antd';
import {
  LayoutDashboard,
  LogOut,
  Package,
  Building2,
  AppWindow,
  ReceiptText,
  Settings,
  UserRound,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import type { AdminIdentity } from '../../features/auth/api';
import { useLogoutMutation } from '../../features/auth/use-auth';
import { useUiPrefs } from '../../shared/lib/ui-prefs';
import './shell.css';

const { Header, Sider, Content } = Layout;

// Navigation expresses platform domains, not the current upstream provider's API layout.
// Each destination is an existing page; the supplier catalog deep-link reuses the
// established URL-backed CatalogPage tab instead of creating a placeholder.
const NAV_GROUPS = [
  {
    key: 'rights',
    label: '权益中心',
    icon: <Package size={16} />,
    pages: [
      { key: '/catalog', label: '权益商品' },
      { key: '/value-rules', label: '价值换算' },
    ],
  },
  {
    key: 'supply',
    label: '供给中心',
    icon: <Building2 size={16} />,
    pages: [
      { key: '/suppliers', label: '供应商管理' },
      { key: '/catalog?tab=supplier', label: '供货目录' },
    ],
  },
  {
    key: 'open-platform',
    label: '开放平台',
    icon: <AppWindow size={16} />,
    pages: [
      { key: '/applications', label: '下游应用' },
      { key: '/interfaces', label: '接口管理' },
    ],
  },
  {
    key: 'delivery',
    label: '订单履约',
    icon: <ReceiptText size={16} />,
    pages: [{ key: '/fulfillment', label: '业务订单' }],
  },
  {
    key: 'governance',
    label: '平台治理',
    icon: <Settings size={16} />,
    pages: [{ key: '/settings', label: '系统设置' }],
  },
];

const NAV_PAGES = [
  { key: '/', label: '总览' },
  ...NAV_GROUPS.flatMap((group) => group.pages),
];

// Restored work tabs are validated against real pages only: the supplier
// catalog is a distinct workspace keyed by its URL-backed tab.
const NAV_KEYS = new Set(NAV_PAGES.map((page) => page.key));

const NAV_ITEMS = [
  { key: '/', icon: <LayoutDashboard size={16} />, label: '总览' },
  ...NAV_GROUPS.map((group) => ({
    key: group.key,
    icon: group.icon,
    label: group.label,
    children: group.pages.map((page) => ({ key: page.key, label: page.label })),
  })),
];

function activeMenuKey(pathname: string, search: string): string {
  // Supply and internal product tabs share one route but are distinct workspaces.
  if (pathname === '/catalog') {
    return new URLSearchParams(search).get('tab') === 'supplier'
      ? '/catalog?tab=supplier'
      : '/catalog';
  }

  const match = NAV_PAGES.find(
    (item) => item.key !== '/' && (pathname === item.key || pathname.startsWith(item.key + '/')),
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
  const activeKey = activeMenuKey(location.pathname, location.search);
  const persistedTabKeys = useUiPrefs((state) => state.openTabs);
  const addTab = useUiPrefs((state) => state.addTab);
  const removeTab = useUiPrefs((state) => state.closeTab);
  const [expandedGroups, setExpandedGroups] = useState<string[]>(() =>
    NAV_GROUPS.map((group) => group.key),
  );

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

  // Deep links and browser history must reveal the selected group, even if it
  // was previously collapsed by the operator.
  useEffect(() => {
    const parent = NAV_GROUPS.find((group) =>
      group.pages.some((page) => page.key === activeKey),
    );
    if (parent) {
      setExpandedGroups((current) =>
        current.includes(parent.key) ? current : [...current, parent.key],
      );
    }
  }, [activeKey]);

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
    <Layout className="app-shell" hasSider>
      <Sider
        className="app-sider"
        theme="light"
        width={216}
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
          openKeys={expandedGroups}
          onOpenChange={setExpandedGroups}
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
