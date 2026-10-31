import { Alert, Button, Card, Descriptions, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { AccountSummary } from '../auth/api';
import { useAccountsQuery, useSessionQuery } from '../auth/use-auth';
import { formatDateTime } from '../../shared/lib/format-date-time';
import { RoleTag } from './RoleTag';

const { Paragraph } = Typography;

const columns: ColumnsType<AccountSummary> = [
  { title: '账号', dataIndex: 'username', key: 'username' },
  { title: '显示名', dataIndex: 'displayName', key: 'displayName' },
  {
    title: '角色',
    dataIndex: 'role',
    key: 'role',
    render: (role: AccountSummary['role']) => <RoleTag role={role} />,
  },
  {
    title: '状态',
    dataIndex: 'disabled',
    key: 'disabled',
    render: (disabled: boolean) => (disabled ? '已停用' : '正常'),
  },
  {
    title: '创建时间',
    dataIndex: 'createdAt',
    key: 'createdAt',
    render: (createdAt: number) => formatDateTime(createdAt),
  },
];

/**
 * Account/role overview. Account lifecycle writes still live in the admin CLI
 * (first-admin bootstrap cannot depend on an existing session), so this panel
 * explains that boundary instead of showing buttons the server cannot honour.
 */
export function AccountsPanel() {
  const session = useSessionQuery();
  const admin = session.data?.admin;
  const isAdmin = admin?.role === 'admin';
  const accounts = useAccountsQuery(isAdmin);

  return (
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
              children: admin ? <RoleTag role={admin.role} /> : '—',
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
          <>
            <Table<AccountSummary>
              rowKey="id"
              size="middle"
              columns={columns}
              dataSource={accounts.data?.accounts ?? []}
              loading={accounts.isPending}
              pagination={false}
              scroll={{ x: 'max-content' }}
            />
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
              账号创建、重置密码与停用目前由服务器端管理员工具执行；页面写操作与操作审计将在后续接入。
            </Paragraph>
          </>
        )}
      </Card>
    </Space>
  );
}
