import { App as AntdApp, Button, Dropdown, Layout, Menu, Tag, Typography } from 'antd';
import {
  LayoutDashboard,
  LogOut,
  Package,
  ReceiptText,
  Settings,
  UserRound,
} from 'lucide-react';
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

  const userMenuItems = [
    { key: 'settings', label: '系统设置' },
    { key: 'logout', label: '退出登录', icon: <LogOut size={14} /> },
  ];

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div className="app-brand">
          <span className="app-brand-mark" aria-hidden="true">
            BH
          </span>
          <span className="app-brand-text">Benefit Hub · 权益运营台</span>
        </div>
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
      <Layout>
        <Sider
          className="app-sider"
          theme="light"
          width={200}
          collapsedWidth={56}
          breakpoint="lg"
        >
          <Menu
            mode="inline"
            theme="light"
            selectedKeys={[activeMenuKey(location.pathname)]}
            items={NAV_ITEMS}
            onClick={({ key }) => navigate(key)}
          />
        </Sider>
        <Content className="app-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
