import { Card, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import { useSessionQuery, useSystemStatusQuery } from '../features/auth/use-auth';
import { useSuppliersQuery } from '../features/suppliers/use-suppliers';
import { formatDateTime } from '../shared/lib/format-date-time';

const { Title, Paragraph } = Typography;

export function OverviewPage() {
  const session = useSessionQuery();
  const status = useSystemStatusQuery();
  const suppliers = useSuppliersQuery();

  const admin = session.data?.admin;
  const expiresAt = session.data?.session.expiresAt;
  const yangmao = suppliers.data?.suppliers.find((supplier) => supplier.key === 'yangmao');

  return (
    <div className="page">
      <header className="page-header">
        <Title level={2}>总览</Title>
        <Paragraph type="secondary">
          欢迎，{admin?.displayName ?? '运营人员'}。在这里查看账户与供应商接入概况。
        </Paragraph>
      </header>

      <Space orientation="vertical" size={16} className="page-stack">
        <Card title="平台概况">
          <Descriptions
            column={1}
            size="small"
            items={[
              {
                key: 'auth',
                label: '管理登录',
                children: status.data?.adminEnabled ? <Tag color="green">正常</Tag> : '状态待核实',
              },
              {
                key: 'supplier',
                label: '上力目录接入',
                children: suppliers.isError
                  ? '状态读取失败'
                  : !yangmao
                    ? '加载中'
                    : yangmao.catalogRead.configured
                      ? <Tag color="blue">凭证已配置</Tag>
                      : <Tag>待配置</Tag>,
              },
            ]}
          />
        </Card>

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

        <Card title="运营数据">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="汇总统计待接入；商品、供应商和订单可在对应业务页面查看。"
          />
        </Card>
      </Space>
    </div>
  );
}
