import { Alert, Card, Layout, Space, Typography } from 'antd';

const { Title, Paragraph, Text } = Typography;

/** Bootstrap-only admin surface. Do not display vendor fulfillment as operational. */
export function App() {
  return (
    <Layout className="page">
      <main className="shell">
        <Space orientation="vertical" size="large" className="content">
          <div className="heading">
            <Text type="secondary">SAN CHUANG · BENEFIT HUB</Text>
            <Title level={1}>权益服务平台</Title>
            <Paragraph type="secondary">统一权益适配与轻量运营后台</Paragraph>
          </div>
          <Card>
            <Alert
              type="info"
              showIcon
              title="系统基础服务已启动"
              description="当前为基础设施验收页面。供应商发券、管理登录和业务订单尚未启用，不提供真实业务操作。"
            />
            <Paragraph className="footnote">
              <Text type="secondary">服务状态：基础设施阶段 · 后续功能按已确认的设计逐项上线</Text>
            </Paragraph>
          </Card>
        </Space>
      </main>
    </Layout>
  );
}
