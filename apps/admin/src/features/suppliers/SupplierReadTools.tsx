import { Alert, Button, Card, Descriptions, Input, Space, Tabs, Tag, Typography } from 'antd';
import { useState } from 'react';
import { apiRequest, type ApiError } from '../../shared/lib/api-client';

type Kind = 'eligibility' | 'order' | 'voucher';
type ReadResult = Record<string, unknown> & { provider: string; observedAt: string };

const options: Record<Kind, { title: string; path: string; field: string; label: string; help: string }> = {
  eligibility: {
    title: 'A/B 购买资格检查',
    path: '/api/v1/suppliers/yangmao/purchase-check',
    field: 'phone',
    label: '获授权测试手机号',
    help: '只读业务查询；上力 7 天限领的实际范围仍待确认。不保存手机号。',
  },
  order: {
    title: 'A 领取链接找回',
    path: '/api/v1/suppliers/yangmao/prepaid/orders/query',
    field: 'requestId',
    label: '已存在订单的 requestId',
    help: '只查询已有订单，不创建订单或扣礼包额度。需要真实有效的既有业务单号。',
  },
  voucher: {
    title: 'C 礼包券查询',
    path: '/api/v1/suppliers/yangmao/gift-vouchers/query',
    field: 'code',
    label: '已签发礼包券码',
    help: '只查询已有券，不创建或扣除礼包。未知字段不推定为已核销或已退款。',
  },
};
const labels: Record<string, string> = {
  purchaseRestricted: '限领中',
  giftUnclaimed: '仍有非彩票权益待领',
  lotteryUnbet: '彩票尚未下注',
  message: '上力说明',
  claimUrl: '领取链接（供应商原值）',
  claimable: '仍可领取',
  orderNo: '供应商订单号',
  packTotal: '签发礼包份数',
  packRemaining: '剩余礼包份数',
  expiresAt: '到期信息（原值，格式待核定）',
};
const displayedFields: Record<Kind, string[]> = {
  eligibility: ['purchaseRestricted', 'giftUnclaimed', 'lotteryUnbet', 'message', 'claimUrl'],
  order: ['claimable', 'claimUrl', 'orderNo'],
  voucher: ['packTotal', 'packRemaining', 'expiresAt', 'claimUrl'],
};
function resultText(value: unknown): string {
  if (value === true) return '是';
  if (value === false) return '否';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '未提供';
}

export function SupplierReadTools() {
  const [kind, setKind] = useState<Kind>('eligibility');
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<ReadResult | null>(null);
  const config = options[kind];

  async function runRead() {
    if (!value || pending) return;
    setPending(true);
    setFailure(null);
    setResult(null);
    try {
      const payload = await apiRequest<Record<string, ReadResult>>(config.path, {
        method: 'POST',
        body: { [config.field]: value },
      });
      setResult(payload[kind] ?? null);
    } catch (error) {
      const e = error as ApiError;
      setFailure(e.message || '查询失败；不能据此推断供应商没有记录');
    } finally {
      setPending(false);
      setValue('');
    }
  }

  return (
    <Card title="上力真实只读查询">
      <Space orientation="vertical" size={16} className="page-stack">
        <Alert type="info" showIcon title="只读查询，不产生权益发放"
          description="这里使用服务器已保存的上力凭证和真实签名请求；未做请求即不能声称接口可用。供应商未确认的字段不作推断。" />
        <Tabs activeKey={kind} onChange={(key) => {
          setKind(key as Kind);
          setValue('');
          setFailure(null);
          setResult(null);
        }} items={[
          { key: 'eligibility', label: 'A/B 资格检查' },
          { key: 'order', label: 'A 订单查询' },
          { key: 'voucher', label: 'C 券码查询' },
        ]} />
        <Typography.Text type="secondary">{config.help}</Typography.Text>
        <Space.Compact style={{ width: '100%', maxWidth: 620 }}>
          <Input
            aria-label={config.label}
            placeholder={config.label}
            type={kind === 'voucher' ? 'password' : 'text'}
            maxLength={kind === 'eligibility' ? 11 : kind === 'order' ? 64 : 128}
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onPressEnter={() => void runRead()}
          />
          <Button type="primary" loading={pending} disabled={!value} onClick={() => void runRead()}>
            真实查询
          </Button>
        </Space.Compact>
        {failure ? <Alert type="error" showIcon title="查询未成功" description={failure} /> : null}
        {result ? (
          <Card size="small" title={<Space><Tag color="green">上力本次响应已解析</Tag><Typography.Text type="secondary">{result.observedAt}</Typography.Text></Space>}>
            <Descriptions column={1} size="small" items={displayedFields[kind].map((key) => ({
                key,
                label: labels[key] ?? key,
                children: resultText(result[key]),
              }))} />
            <Typography.Text type="secondary">这里只显示已解析字段；响应成功不等于已扣额、发券或到账。</Typography.Text>
          </Card>
        ) : null}
      </Space>
    </Card>
  );
}
