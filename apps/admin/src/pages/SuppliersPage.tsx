import {
  Alert,
  Button,
  Card,
  Descriptions,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useSystemStatusQuery } from '../features/auth/use-auth';
import { SupplierProductsPanel } from '../features/catalog/SupplierProductsPanel';
import { useSupplierProductsQuery } from '../features/catalog/use-catalog';
import { ApiError } from '../shared/lib/api-client';
import { formatDateTime } from '../shared/lib/format-date-time';

const { Title, Paragraph, Text } = Typography;

type Supplier = {
  key: 'yangmao';
  name: '上力';
};

const suppliers: Supplier[] = [{ key: 'yangmao', name: '上力' }];

function observedAtLabel(iso: string): string {
  const stamp = Date.parse(iso);
  return Number.isNaN(stamp) ? iso : formatDateTime(stamp);
}

function readStatus(query: ReturnType<typeof useSupplierProductsQuery>) {
  if (query.isPending) return <Tag>正在核实</Tag>;
  if (query.isSuccess) return <Tag color="green">只读目录可访问</Tag>;
  if (query.error instanceof ApiError && query.error.code === 'SUPPLIER_NOT_CONFIGURED') {
    return <Tag>服务器未配置</Tag>;
  }
  return <Tag color="orange">读取失败</Tag>;
}

function ReadResult({ compact = false }: { compact?: boolean }) {
  const query = useSupplierProductsQuery();
  if (query.isPending) return <Spin aria-label="正在读取上力目录" />;
  if (query.isError) {
    const error = query.error;
    const configMissing =
      error instanceof ApiError && error.code === 'SUPPLIER_NOT_CONFIGURED';
    return (
      <Alert
        type={configMissing ? 'warning' : 'error'}
        showIcon
        title={configMissing ? '上力只读接口尚未配置' : '上力目录读取失败'}
        description={error.message}
        action={
          <Button size="small" loading={query.isFetching} onClick={() => void query.refetch()}>
            重试读取
          </Button>
        }
      />
    );
  }

  return (
    <Space orientation="vertical" size={compact ? 4 : 12}>
      <Space wrap>
        <Tag color="green">本次只读查询成功</Tag>
        <Text>商品数：{query.data.products.length}</Text>
      </Space>
      <Text type="secondary">最近获取：{observedAtLabel(query.data.observedAt)}</Text>
      {!compact ? (
        <Alert
          type="info"
          showIcon
          title="查询成功不等于可以发券"
          description="目录商品的供应商报价不是实际扣额；可售状态、手续费、资金余额及履约终态仍须分别核实。"
        />
      ) : null}
    </Space>
  );
}

/**
 * A genuine supplier-management entry. The provider list is the one real
 * registered integration, but every connection observation is sourced from
 * the existing authenticated, server-side signed catalogue API.
 */
export function SuppliersPage() {
  const navigate = useNavigate();
  const query = useSupplierProductsQuery();

  const columns: ColumnsType<Supplier> = [
    {
      title: '供货方',
      key: 'name',
      render: (_, supplier) => (
        <Space size={8} wrap>
          <Text strong>{supplier.name}</Text>
          <Text type="secondary">({supplier.key})</Text>
        </Space>
      ),
    },
    { title: '接入状态', key: 'status', render: () => readStatus(query) },
    {
      title: '供货商品',
      key: 'products',
      render: () =>
        query.isSuccess ? query.data.products.length : <Text type="secondary">未确认</Text>,
    },
    { title: '真实发放', key: 'fulfillment', render: () => <Tag>未启用</Tag> },
    {
      title: '操作',
      key: 'actions',
      render: (_, supplier) => (
        <Button type="link" onClick={() => navigate('/suppliers/' + supplier.key)}>
          查看供应商
        </Button>
      ),
    },
  ];

  return (
    <div className="page">
      <header className="page-header">
        <Title level={2}>供应商管理</Title>
        <Paragraph type="secondary">
          管理三创真实供货方及其商品来源、接入能力与成本事实；当前已登记上力。
        </Paragraph>
      </header>
      <Space orientation="vertical" size={16} className="page-stack">
        <Card title="供应商" extra={<Button icon={<RefreshCw size={14} />} loading={query.isFetching} onClick={() => void query.refetch()}>刷新状态</Button>}>
          <Table<Supplier>
            size="middle"
            rowKey="key"
            columns={columns}
            dataSource={suppliers}
            pagination={false}
            scroll={{ x: 620 }}
          />
        </Card>
        <Card title="上力接口读取">
          <ReadResult compact />
        </Card>
      </Space>
    </div>
  );
}

export function SupplierDetailPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('catalog');
  const query = useSupplierProductsQuery();
  const system = useSystemStatusQuery();

  const fulfillment = system.isSuccess
    ? system.data.vendorFulfillmentEnabled
      ? <Tag color="green">平台开关已启用（仍需实际履约核验）</Tag>
      : <Tag>平台履约未启用</Tag>
    : <Tag>平台开关状态待核实</Tag>;

  const overview = (
    <Space orientation="vertical" size={16} className="page-stack">
      <Card title="连接观察">
        <Descriptions
          size="small"
          bordered
          column={{ xs: 1, sm: 1, md: 2 }}
          items={[
            { key: 'provider', label: '供货方', children: '上力 (yangmao)' },
            { key: 'read', label: 'D 模式商品读取', children: readStatus(query) },
            { key: 'write', label: '真实派发', children: fulfillment },
            { key: 'abc', label: 'A/B/C 真实联调', children: <Tag>未核实</Tag> },
            { key: 'orders', label: 'D 查单完整协议', children: <Tag>待核实</Tag> },
            { key: 'balance', label: '供应商余额', children: <Text type="secondary">没有已核实的商户只读余额接口</Text> },
            { key: 'cost', label: '实际成本与手续费', children: <Text type="secondary">待以合法履约订单核对，不以 sellPrice 代替</Text> },
          ]}
        />
      </Card>
      <Card title="商品接口实际读取" extra={<Button icon={<RefreshCw size={14} />} loading={query.isFetching} onClick={() => void query.refetch()}>重新读取</Button>}>
        <ReadResult />
        <Button type="primary" style={{ marginTop: 12 }} onClick={() => setTab('catalog')}>
          浏览供货目录
        </Button>
      </Card>
    </Space>
  );

  const connection = (
    <Space orientation="vertical" size={16} className="page-stack">
      <Card title="接入边界">
        <Descriptions
          column={1}
          size="small"
          items={[
            { key: 'method', label: '读取方式', children: '服务器端签名 D 模式 Open API；浏览器仅访问 Benefit Hub 已鉴权的同源接口' },
            { key: 'list', label: '目录接口', children: <Text code>GET /api/v1/catalog/supplier-products</Text> },
            { key: 'detail', label: '商品详情', children: <Text code>GET /api/v1/catalog/supplier-products/:productCode</Text> },
            { key: 'credential', label: '凭证', children: '仅配置于服务器，页面不显示或编辑 AppKey / AppSecret' },
            { key: 'unit', label: '账本单位', children: '礼包额度（份）与权益余额（元）分开；当前无可直接显示的商户余额快照' },
          ]}
        />
      </Card>
      <Alert type="warning" showIcon title="仅供只读核实" description="本页不会向上力发起派发、充值、补发、退款或调整余额请求。上力后台 /admin 接口不被当作商户 Open API 使用。" />
    </Space>
  );

  return (
    <div className="page">
      <header className="page-header">
        <Space align="center" size={12}>
          <Button type="text" aria-label="返回供应商列表" icon={<ArrowLeft size={18} />} onClick={() => navigate('/suppliers')} />
          <div>
            <Title level={2}>上力</Title>
            <Paragraph type="secondary">供货方资料、实时只读商品目录与接入限制。</Paragraph>
          </div>
        </Space>
      </header>
      <Space orientation="vertical" size={16} className="page-stack">
        <Space wrap size={8}>
          <Tag>Provider: yangmao</Tag>
          {readStatus(query)}
          {fulfillment}
        </Space>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: 'overview', label: '供应商概览', children: overview },
            { key: 'catalog', label: '供货商品', children: <SupplierProductsPanel /> },
            { key: 'connection', label: '接入与规则', children: connection },
          ]}
        />
      </Space>
    </div>
  );
}
