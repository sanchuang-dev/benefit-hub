import { Alert, Button, Card, Descriptions, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useAccountsQuery, useSessionQuery } from '../features/auth/use-auth';
import type { AccountSummary } from '../features/auth/api';
import { formatDateTime } from '../shared/lib/format-date-time';

const { Title, Paragraph } = Typography;

const columns: ColumnsType<AccountSummary> = [
  { title: '账号', dataIndex: 'username', key: 'username' },
  { title: '显示名', dataIndex: 'displayName', key: 'displayName' },
  {
    title: '角色',
    dataIndex: 'role',
    key: 'role',
    render: (role: AccountSummary['role']) =>
      role === 'admin' ? <Tag color="blue">管理员</Tag> : <Tag>只读</Tag>,
  },
  {
    title: '状态',
    dataIndex: 'disabled',
    key: 'disabled',
    render: (disabled: boolean) =>
      disabled ? <Tag color="red">已停用</Tag> : <Tag color="green">正常</Tag>,
  },
  {
    title: '创建时间',
    dataIndex: 'createdAt',
    key: 'createdAt',
    render: (createdAt: number) => formatDateTime(createdAt),
  },
];

export function SettingsPage() {
  const session = useSessionQuery();
  const admin = session.data?.admin;
  const isAdmin = admin?.role === 'admin';
  const accounts = useAccountsQuery(isAdmin);

  return (
    <div className="page">
      <header className="page-header">
        <Title level={2}>系统设置</Title>
        <Paragraph type="secondary">当前账号权限与管理员账户概览。</Paragraph>
      </header>

      <Space orientation="vertical" size={16} className="page-stack">
        <Card title="当前账号">
          <Descriptions
            column={1}
            size="small"
            items={[
              { key: 'username', label: '账号', children: admin?.username ?? '—' },
              { key: 'displayName', label: '显示名', children: admin?.displayName ?? '—' },
              {
                key: 'role',
                label: '权限',
                children: isAdmin ? <Tag color="blue">管理员</Tag> : <Tag>只读</Tag>,
              },
              {
                key: 'expiresAt',
                label: '会话有效期至',
                children: session.data ? formatDateTime(session.data.session.expiresAt) : '—',
              },
            ]}
          />
        </Card>

        <Card title="管理员账户">
          {!isAdmin ? (
            <Alert
              type="info"
              showIcon
              title="当前为只读身份"
              description="只读身份不能查看管理员账户列表，也不能执行任何管理操作。账号与密码重置由运维管理员通过服务器端工具完成。"
            />
          ) : accounts.isError ? (
            <Alert
              type="error"
              showIcon
              title="无法加载管理员账户"
              description={accounts.error.message}
              action={
                <Button size="small" onClick={() => accounts.refetch()}>
                  重试
                </Button>
              }
            />
          ) : (
            <Table<AccountSummary>
              rowKey="id"
              size="middle"
              columns={columns}
              dataSource={accounts.data?.accounts ?? []}
              loading={accounts.isPending}
              pagination={false}
              scroll={{ x: 'max-content' }}
            />
          )}
        </Card>
      </Space>
    </div>
  );
}
