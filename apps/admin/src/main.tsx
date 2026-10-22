import React from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, Card, ConfigProvider, Layout, Space, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import './style.css';

const { Title, Paragraph, Text } = Typography;

function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <Layout className="page">
        <main className="shell">
          <Space direction="vertical" size="large" className="content">
            <div className="heading">
              <Text type="secondary">SAN CHUANG · BENEFIT HUB</Text>
              <Title level={1}>权益服务平台</Title>
              <Paragraph type="secondary">统一权益适配与轻量运营后台</Paragraph>
            </div>
            <Card>
              <Alert
                type="info"
                showIcon
                message="系统基础服务已启动"
                description="当前为基础设施验收页面。供应商发券、管理登录和业务订单尚未启用，不提供真实业务操作。"
              />
              <Paragraph className="footnote">
                <Text type="secondary">服务状态：基础设施阶段 · 后续功能按已确认的设计逐项上线</Text>
              </Paragraph>
            </Card>
          </Space>
        </main>
      </Layout>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
