import { Alert, Card, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import { useSessionQuery, useSystemStatusQuery } from '../features/auth/use-auth';
import { formatDateTime } from '../shared/lib/format-date-time';

const { Title, Paragraph } = Typography;

export function OverviewPage() {
  const session = useSessionQuery();
  const status = useSystemStatusQuery();

  const admin = session.data?.admin;
  const expiresAt = session.data?.session.expiresAt;

  return (
    <div className="page">
      <header className="page-header">
        <Title level={2}>总览</Title>
        <Paragraph type="secondary">
          欢迎，{admin?.displayName ?? '运营人员'}。当前版本仅提供真实登录与最小权限管理，运营数据尚未接入。
        </Paragraph>
      </header>

      <Space orientation="vertical" size={16} className="page-stack">
        <Alert
          type="warning"
          showIcon
          title="供应商履约保持禁用"
          description="当前构建不会调用羊毛供应商接口，也不会发放真实权益；后续启用需要单独授权与验收。"
        />

        <Card title="当前登录会话">
          <Descriptions
            column={1}
            size="small"
            items={[
              { key: 'username', label: '账号', children: admin?.username ?? '—' },
              { key: 'displayName', label: '显示名', children: admin?.displayName ?? '—' },
              {
                key: 'role',
                label: '权限',
                children:
                  admin?.role === 'admin' ? <Tag color="blue">管理员</Tag> : <Tag>只读</Tag>,
              },
              {
                key: 'expiresAt',
                label: '会话有效期至',
                children: expiresAt ? formatDateTime(expiresAt) : '—',
              },
            ]}
          />
        </Card>

        <Card title="系统状态">
          <Descriptions
            column={1}
            size="small"
            items={[
              {
                key: 'auth',
                label: '管理登录',
                children: status.data?.adminEnabled ? <Tag color="green">已启用</Tag> : <Tag>未启用</Tag>,
              },
              {
                key: 'fulfillment',
                label: '供应商履约',
                children: status.data?.vendorFulfillmentEnabled ? (
                  <Tag color="green">已启用</Tag>
                ) : (
                  <Tag>已禁用</Tag>
                ),
              },
              {
                key: 'credentials',
                label: '供应商凭证',
                children: '尚未配置（本版本不发起真实发放）',
              },
            ]}
          />
        </Card>

        <Card title="运营数据">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="商品、订单与履约统计尚未接入，本页不展示占位或模拟数据。"
          />
        </Card>
      </Space>
    </div>
  );
}
