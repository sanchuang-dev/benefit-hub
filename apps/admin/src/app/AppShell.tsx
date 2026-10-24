import { App as AntdApp, Button, Dropdown, Layout, Menu, Tabs, Tag, Typography } from 'antd';
import {
  LayoutDashboard,
  LogOut,
  Package,
  ReceiptText,
  Settings,
  UserRound,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import type { AdminIdentity } from '../features/auth/api';
import { useLogoutMutation } from '../features/auth/use-auth';

const { Header, Sider, Content } = Layout;

const NAV_ITEMS = [
  { key: '/', icon: <LayoutDashboard size={16} />, label: '总览' },
  { key: '/catalog', icon: <Package size={16} />, label: '商品管理' },
  { key: '/fulfillment', icon: <ReceiptText size={16} />, label: '发放记录' },
  { key: '/settings', icon: <Settings size={16} />, label: '系统设置' },
];

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
  const activeItem = NAV_ITEMS.find((item) => item.key === activeKey) ?? NAV_ITEMS[0];
  const [openTabKeys, setOpenTabKeys] = useState<string[]>(() => [activeKey]);

  useEffect(() => {
    setOpenTabKeys((current) =>
      current.includes(activeKey) ? current : [...current, activeKey],
    );
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
    setOpenTabKeys(nextKeys);

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
          <Typography.Text className="app-section-name">{activeItem.label}</Typography.Text>
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
