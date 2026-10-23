import { Card, Result, Typography } from 'antd';

const { Title, Paragraph } = Typography;

/** No order or fulfillment data exists in this slice, so none is displayed. */
export function FulfillmentPage() {
  return (
    <div className="page">
      <header className="page-header">
        <Title level={2}>发放记录</Title>
        <Paragraph type="secondary">业务订单、供应商受理与最终履约状态。</Paragraph>
      </header>
      <Card>
        <Result
          status="info"
          title="发放记录尚未接入"
          subTitle="订单持久化与供应商履约属于后续实施范围。本版本不会调用羊毛接口，也不会产生真实发放记录。"
        />
      </Card>
    </div>
  );
}
