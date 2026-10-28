import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useSessionQuery, useSystemStatusQuery } from '../features/auth/use-auth';
import { SupplierConnectionDrawer } from '../features/suppliers/SupplierConnectionDrawer';
import { SupplierProductsPanel } from '../features/catalog/SupplierProductsPanel';
import { useSupplierProductsQuery } from '../features/catalog/use-catalog';
import { useSupplierQuery, useSuppliersQuery, type SupplierSummary } from '../features/suppliers/use-suppliers';
import { formatDateTime } from '../shared/lib/format-date-time';

const { Title, Paragraph, Text } = Typography;

function formatObservedAt(iso: string): string {
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? iso : formatDateTime(timestamp);
}

function supplierConfigLabel(supplier: SupplierSummary) {
  return supplier.catalogRead.configured ? (
    <Tag color="blue">只读凭证已配置（未验证）</Tag>
  ) : (
    <Tag>只读凭证未配置</Tag>
  );
}

/**
 * The registry response is a server-owned integration fact, not a client-side
 * fictitious supplier or an online connectivity claim.
 */
export function SuppliersPage() {
  const navigate = useNavigate();
  const suppliers = useSuppliersQuery();

  const columns: ColumnsType<SupplierSummary> = [
    {
      title: '供货方',
      key: 'supplier',
      render: (_, supplier) => (
        <Space size={8} wrap>
          <Text strong>{supplier.name}</Text>
          <Text type="secondary">{supplier.key}</Text>
        </Space>
      ),
    },
    {
      title: '商品读取配置',
      key: 'read',
      render: (_, supplier) => supplierConfigLabel(supplier),
    },
    {
      title: '真实发放',
      key: 'fulfillment',
      render: (_, supplier) =>
        supplier.fulfillmentEnabled ? <Tag color="green">已启用（仍需核实履约）</Tag> : <Tag>未启用</Tag>,
    },
    {
      title: '操作',
      key: 'action',
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
          查看真实供货方、接入配置与供货商品。连接是否可用需要单独执行只读验证。
        </Paragraph>
      </header>

      <Space orientation="vertical" size={16} className="page-stack">
        <Card
          title="已登记供应商"
          extra={
            <Button
              icon={<RefreshCw size={14} />}
              loading={suppliers.isFetching}
              onClick={() => void suppliers.refetch()}
            >
              刷新
            </Button>
          }
        >
          {suppliers.isError ? (
            <Alert
              type="error"
              showIcon
              title="无法加载供应商档案"
              description={suppliers.error.message}
              action={<Button size="small" onClick={() => void suppliers.refetch()}>重试</Button>}
            />
          ) : (
            <Table<SupplierSummary>
              size="middle"
              rowKey="key"
              columns={columns}
              dataSource={suppliers.data?.suppliers ?? []}
              loading={suppliers.isPending}
              locale={{ emptyText: <Empty description="尚无已登记供应商" /> }}
              pagination={false}
              scroll={{ x: 720 }}
            />
          )}
        </Card>
        <Alert
          type="info"
          showIcon
          title="已配置不等于连接成功"
          description="供应商列表只读取本平台的接入登记与服务器配置状态，不会自动轮询上力；进入供应商详情后可按需验证目录查询。"
        />
      </Space>
    </div>
  );
}

export function SupplierDetailPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [probeRequested, setProbeRequested] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const session = useSessionQuery();
  const supplier = useSupplierQuery('yangmao');
  const catalog = useSupplierProductsQuery({ enabled: probeRequested || tab === 'catalog' });
  const system = useSystemStatusQuery();

  const supplierInfo = supplier.data?.supplier;
  const hasReadResult = probeRequested || catalog.isSuccess || catalog.isError;
  const readConfigured = supplierInfo?.catalogRead.configured ?? false;
  const probeStatus = catalog.isSuccess ? (
    <Tag color="green">本次目录读取成功</Tag>
  ) : catalog.isError ? (
    <Tag color="orange">目录读取失败</Tag>
  ) : probeRequested || tab === 'catalog' ? (
    <Tag>正在读取目录</Tag>
  ) : (
    <Tag>尚未执行目录验证</Tag>
  );

  const overview = (
    <Space orientation="vertical" size={16} className="page-stack">
      <Card title="接入与供货概览">
        <Descriptions
          size="small"
          bordered
          column={{ xs: 1, sm: 1, md: 2 }}
          items={[
            { key: 'provider', label: '供货方', children: supplierInfo?.name ?? '—' },
            { key: 'providerKey', label: 'Provider 标识', children: <Text code>yangmao</Text> },
            {
              key: 'config',
              label: 'D 商品读取凭证',
              children: supplierInfo ? supplierConfigLabel(supplierInfo) : '待核实',
            },
            { key: 'connection', label: '目录读取结果', children: probeStatus },
            {
              key: 'fulfillment',
              label: '真实派发',
              children: system.isSuccess && system.data.vendorFulfillmentEnabled
                ? <Tag color="green">开关已启用，履约仍需核实</Tag>
                : <Tag>未启用或状态待核实</Tag>,
            },
            { key: 'abc', label: 'A/B/C 业务履约', children: <Tag>未联调验收</Tag> },
            { key: 'orders', label: 'D 查单完整状态合同', children: <Tag>待核实</Tag> },
            { key: 'balance', label: '上游额度余额', children: '商户只读余额接口尚无实证' },
            { key: 'cost', label: '实际扣额和手续费', children: '缺有效订单/账本实证，不以商品售价推断' },
          ]}
        />
      </Card>

      <Card
        title="D 模式目录读取验证"
        extra={
          <Button
            icon={<RefreshCw size={14} />}
            loading={catalog.isFetching}
            disabled={!readConfigured}
            onClick={() => {
              if (!hasReadResult) setProbeRequested(true);
              else void catalog.refetch();
            }}
          >
            {hasReadResult ? '重新验证' : '验证目录读取'}
          </Button>
        }
      >
        {!readConfigured && supplier.isSuccess ? (
          <Alert
            type="warning"
            showIcon
            title="服务器未配置上力只读凭证"
            description="上力 D 商品读取尚未配置。管理员可在「接入与规则」中保存接口地址和测试凭证，保存后由服务器从数据库读取。"
          />
        ) : !hasReadResult ? (
          <Alert
            type="info"
            showIcon
            title="尚未执行连接验证"
            description="凭证是否配置与接口是否可用是两件事。点击“验证目录读取”才会向本平台发起有鉴权的 GET，由服务器执行上力签名只读查询。"
          />
        ) : catalog.isError ? (
          <Alert
            type="error"
            showIcon
            title="上力目录读取失败"
            description={catalog.error.message}
          />
        ) : catalog.isSuccess ? (
          <Space orientation="vertical" size={8}>
            <Space wrap>
              <Tag color="green">查询成功</Tag>
              <Text>返回商品数：{catalog.data.products.length}</Text>
              <Text type="secondary">获取于 {formatObservedAt(catalog.data.observedAt)}</Text>
            </Space>
            <Button type="primary" onClick={() => setTab('catalog')}>浏览供货商品</Button>
          </Space>
        ) : (
          <Text type="secondary">正在向服务器查询上力目录…</Text>
        )}
      </Card>
    </Space>
  );

  const connection = (
    <Space orientation="vertical" size={16} className="page-stack">
      <Card
        title="接入方式与已知限制"
        extra={session.data?.admin.role === 'admin' ? <Button type="primary" onClick={() => setEditorOpen(true)}>编辑接入配置</Button> : null}
      >
        <Descriptions
          column={1}
          size="small"
          items={[
            { key: 'read', label: '读取实现', children: '服务器端签名 D 模式 Open API，浏览器通过同源登录态接口读取' },
            { key: 'list', label: '商品列表', children: <Text code>GET /api/v1/catalog/supplier-products</Text> },
            { key: 'detail', label: '商品详情', children: <Text code>GET /api/v1/catalog/supplier-products/:productCode</Text> },
            { key: 'credentials', label: '测试凭证状态', children: supplierInfo ? supplierConfigLabel(supplierInfo) : '待核实' },
            { key: 'secrets', label: '凭证处理', children: '管理员可修改配置；凭证加密保存于平台数据库，客户端不会读取或回显旧密钥' },
            { key: 'quota', label: '额度分类', children: '礼包份数、权益余额（人民币）分别管理；暂无已证实的商户余额读取合同' },
          ]}
        />
      </Card>
      <Alert
        type="warning"
        showIcon
        title="真实履约未开放"
        description="读取商品目录不等于可发券；本页面不执行充值、派发、补发、退款和上力后台管理 API。"
      />
    </Space>
  );

  return (
    <div className="page">
      <header className="page-header">
        <Space size={12} align="center">
          <Button
            type="text"
            aria-label="返回供应商列表"
            icon={<ArrowLeft size={18} />}
            onClick={() => navigate('/suppliers')}
          />
          <div>
            <Title level={2}>上力</Title>
            <Paragraph type="secondary">接入状态、商品目录和供应商履约边界。</Paragraph>
          </div>
        </Space>
      </header>

      <Space orientation="vertical" size={16} className="page-stack">
        {supplier.isError ? (
          <Alert
            type="error"
            showIcon
            title="无法读取供应商档案"
            description={supplier.error.message}
            action={<Button size="small" onClick={() => void supplier.refetch()}>重试</Button>}
          />
        ) : null}
        <Space size={8} wrap>
          <Tag>Provider: yangmao</Tag>
          {supplierInfo ? supplierConfigLabel(supplierInfo) : <Tag>档案加载中</Tag>}
          {probeStatus}
        </Space>
        <SupplierConnectionDrawer open={editorOpen} onClose={() => setEditorOpen(false)} />
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
