import { Card, Result, Typography } from 'antd';

const { Title, Paragraph } = Typography;

/** Honest not-yet-connected state: this slice ships no catalog data or actions. */
export function CatalogPage() {
  return (
    <div className="page">
      <header className="page-header">
        <Title level={2}>商品管理</Title>
        <Paragraph type="secondary">内部商品、供应商商品与履约映射。</Paragraph>
      </header>
      <Card>
        <Result
          status="info"
          title="商品管理尚未接入"
          subTitle="本版本只交付登录与最小权限管理，商品查询、映射草稿与激活将在后续实施卡中提供；当前页面没有可编辑或可发布的数据。"
        />
      </Card>
    </div>
  );
}
