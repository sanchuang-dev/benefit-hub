import {
  Alert,
  Breadcrumb,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { RefreshCw, RotateCcw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useSessionQuery } from '../features/auth/use-auth';
import { SupplierConnectionDrawer } from '../features/suppliers/SupplierConnectionDrawer';
import { SupplierReadTools } from '../features/suppliers/SupplierReadTools';
import { SupplierProductsPanel } from '../features/catalog/SupplierProductsPanel';
import { useSupplierProductsQuery } from '../features/catalog/use-catalog';
import { useSupplierQuery, useSuppliersQuery, type SupplierSummary } from '../features/suppliers/use-suppliers';
import { formatDateTime } from '../shared/lib/format-date-time';
import { parseKeyword, setOptionalParam } from '../shared/lib/url-state';
import '../shared/styles/data-panel.css';

const { Title, Paragraph, Text } = Typography;

function formatObservedAt(iso: string): string {
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? iso : formatDateTime(timestamp);
}

type SupplierConfigStatus = 'all' | 'configured' | 'unconfigured';

interface FilterFormValues {
  keyword?: string;
  status: SupplierConfigStatus;
}

function supplierConfigLabel(supplier: SupplierSummary) {
  return supplier.catalogRead.configured ? (
    <Tag color="blue">目录凭证已配置</Tag>
  ) : (
    <Tag>目录凭证待配置</Tag>
  );
}

/**
 * The registry response is a server-owned integration fact, not a client-side
 * fictitious supplier or an online connectivity claim.
 *
 * The list follows the data-panel layout of the catalogue page (design.md §4E):
 * one white surface, a filter toolbar row on top, and a single table below.
 * There is no create entry because phase one has no supplier-onboarding
 * contract, and no table/card switch because the registry has no cover assets.
 */
export function SuppliersPage() {
  const navigate = useNavigate();
  const suppliers = useSuppliersQuery();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filterForm] = Form.useForm<FilterFormValues>();

  // Listing state is URL-owned so refresh, back/forward and shared links all
  // reproduce the same view instead of resetting to the unfiltered registry.
  const keyword = parseKeyword(searchParams.get('q'));
  const rawStatus = searchParams.get('status');
  const status: SupplierConfigStatus =
    rawStatus === 'configured' || rawStatus === 'unconfigured' ? rawStatus : 'all';

  useEffect(() => {
    filterForm.setFieldsValue({ keyword, status });
  }, [filterForm, keyword, status]);

  // The registry is a small, complete list: the filters narrow the loaded
  // snapshot instead of issuing a second request. An unknown keyword or a
  // status nobody matches is a "no results" empty state, never an error and
  // never an empty registry.
  const allSuppliers = suppliers.data?.suppliers ?? [];
  const normalizedKeyword = keyword.toLowerCase();
  const visibleSuppliers = allSuppliers.filter((supplier) => {
    const matchesKeyword =
      !normalizedKeyword ||
      supplier.name.toLowerCase().includes(normalizedKeyword) ||
      supplier.key.toLowerCase().includes(normalizedKeyword);
    const matchesStatus =
      status === 'all' ||
      (status === 'configured'
        ? supplier.catalogRead.configured
        : !supplier.catalogRead.configured);
    return matchesKeyword && matchesStatus;
  });
  const sourceIsEmpty = allSuppliers.length === 0;

  const updateSearch = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    setSearchParams(next, { replace: true });
  };

  const applyFilters = (values: FilterFormValues) => {
    const nextKeyword = values.keyword?.trim() ?? '';
    const nextStatus = values.status ?? 'all';
    updateSearch((next) => {
      setOptionalParam(next, 'q', nextKeyword || null);
      setOptionalParam(next, 'status', nextStatus === 'all' ? null : nextStatus);
    });
  };

  const resetFilters = () => {
    filterForm.resetFields();
    updateSearch((next) => {
      next.delete('q');
      next.delete('status');
    });
  };

  const columns: ColumnsType<SupplierSummary> = [
    {
      title: '供应商',
      key: 'supplier',
      width: 180,
      render: (_, supplier) => (
        <Space orientation="vertical" size={0}>
          <Text strong>{supplier.name}</Text>
          <Text type="secondary">{supplier.key}</Text>
        </Space>
      ),
    },
    {
      title: '目录读取能力',
      key: 'catalogRead',
      width: 110,
      render: (_, supplier) =>
        supplier.catalogRead.supported ? <Tag color="blue">支持</Tag> : <Tag>不支持</Tag>,
    },
    {
      title: '目录凭证',
      key: 'configured',
      width: 130,
      render: (_, supplier) =>
        supplier.catalogRead.configured ? <Tag color="blue">已配置</Tag> : <Tag>未配置</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 116,
      fixed: 'right',
      render: (_, supplier) => (
        <Button type="link" size="small" onClick={() => navigate('/suppliers/' + supplier.key)}>
          查看供应商
        </Button>
      ),
    },
  ];

  const emptyText = sourceIsEmpty ? (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无已登记供应商" />
  ) : (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的供应商">
      <Button onClick={resetFilters}>清除筛选</Button>
    </Empty>
  );

  return (
    <div className="page">
      <header className="page-header">
        <Title level={2}>供应商管理</Title>
        <Paragraph type="secondary">查看供货方、接入配置与供货商品。</Paragraph>
      </header>

      <Space orientation="vertical" size={16} className="page-stack">
        <section className="panel-surface" aria-label="供应商列表">
          <div className="panel-toolbar-row">
            <Form<FilterFormValues>
              form={filterForm}
              className="panel-toolbar"
              layout="inline"
              initialValues={{ keyword, status }}
              onFinish={applyFilters}
            >
              <Form.Item name="keyword" label="关键词">
                <Input allowClear placeholder="供应商名称或 Provider 标识" style={{ width: 240 }} />
              </Form.Item>
              <Form.Item name="status" label="接入状态">
                <Select
                  style={{ width: 160 }}
                  options={[
                    { value: 'all', label: '全部状态' },
                    { value: 'configured', label: '凭证已配置' },
                    { value: 'unconfigured', label: '凭证待配置' },
                  ]}
                />
              </Form.Item>
              <Form.Item>
                <Space size={8}>
                  <Button type="primary" htmlType="submit" icon={<Search size={14} />}>
                    查询
                  </Button>
                  <Button onClick={resetFilters} icon={<RotateCcw size={14} />}>
                    重置
                  </Button>
                </Space>
              </Form.Item>
            </Form>

            <div className="panel-action">
              <Button
                icon={<RefreshCw size={14} />}
                loading={suppliers.isFetching}
                onClick={() => void suppliers.refetch()}
              >
                刷新
              </Button>
            </div>
          </div>

          {suppliers.isError ? (
            <div className="panel-feedback">
              <Alert
                type="error"
                showIcon
                title="无法加载供应商档案"
                description={suppliers.error.message}
                action={
                  <Button size="small" onClick={() => void suppliers.refetch()}>
                    重试
                  </Button>
                }
              />
            </div>
          ) : (
            <Table<SupplierSummary>
              size="middle"
              rowKey="key"
              columns={columns}
              dataSource={visibleSuppliers}
              loading={suppliers.isPending || suppliers.isFetching}
              // While the first request is still in flight there is no
              // registry fact yet, so the table must not claim "尚无已登记
              //供应商"; the loading overlay carries that state instead.
              locale={{ emptyText: suppliers.isPending ? null : emptyText }}
              pagination={false}
              scroll={{ x: 640 }}
            />
          )}
        </section>
      </Space>
    </div>
  );
}

type SupplierDetailTab = 'overview' | 'catalog' | 'connection' | 'read-tools';

export function SupplierDetailPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [probeRequested, setProbeRequested] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const session = useSessionQuery();
  const supplier = useSupplierQuery('yangmao');

  /**
   * 供货商品 is the only deep-linkable sub-tab because the 供货目录 navigation
   * entry targets it. It is URL-owned: `?tab=catalog` selects it and any other
   * or unknown value falls back to 供应商概览. The remaining sub-tabs are click
   * state only and keep the URL clean (the sidebar must never keep highlighting
   * 供货目录 from a stale query). Switching tabs rewrites only the `tab` key
   * with replace, so the panel's own supplierQ/paging keys survive a round-trip;
   * the functional updater reads the latest params, so a filter written in the
   * same tick as the switch is preserved.
   */
  const catalogRequested = searchParams.get('tab') === 'catalog';
  const [tab, setTab] = useState<SupplierDetailTab>(catalogRequested ? 'catalog' : 'overview');
  const activeTab: SupplierDetailTab = catalogRequested ? 'catalog' : tab;

  const changeTab = (key: string) => {
    const nextTab: SupplierDetailTab =
      key === 'catalog' || key === 'connection' || key === 'read-tools' ? key : 'overview';
    setTab(nextTab);
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (nextTab === 'catalog') next.set('tab', 'catalog');
        else next.delete('tab');
        return next;
      },
      { replace: true },
    );
  };

  const catalog = useSupplierProductsQuery({ enabled: probeRequested || activeTab === 'catalog' });

  const supplierInfo = supplier.data?.supplier;
  const hasReadResult = probeRequested || catalog.isSuccess || catalog.isError;
  const readConfigured = supplierInfo?.catalogRead.configured ?? false;
  const probeStatus = catalog.isSuccess ? (
    <Tag color="green">本次目录读取成功</Tag>
  ) : catalog.isError ? (
    <Tag color="orange">目录读取失败</Tag>
  ) : probeRequested || activeTab === 'catalog' ? (
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
            <Button type="primary" onClick={() => changeTab('catalog')}>浏览供货商品</Button>
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
        title="接入方式"
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
    </Space>
  );

  return (
    <div className="page">
      {/*
       * 上力 is a child page of 供应商管理, not a peer of it: the breadcrumb is
       * the header line here. It owns both the hierarchy and the page heading
       * (the current crumb carries role=heading), so the page does not repeat
       * "上力" as a separate title below the crumb, and the parent crumb is the
       * single back affordance.
       */}
      <header className="page-header">
        <Breadcrumb
          className="page-breadcrumb"
          aria-label="面包屑"
          separator=">"
          items={[
            { key: 'parent', title: '供应商管理' },
            { key: 'current', title: '上力' },
          ]}
          itemRender={(item) =>
            item.key === 'current' ? (
              <span role="heading" aria-level={2} className="page-breadcrumb-current">
                {item.title}
              </span>
            ) : (
              <Link to="/suppliers">{item.title}</Link>
            )
          }
        />
        <Paragraph type="secondary">接入配置、商品目录与供货信息。</Paragraph>
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
          activeKey={activeTab}
          onChange={changeTab}
          items={[
            { key: 'overview', label: '供应商概览', children: overview },
            { key: 'catalog', label: '供货商品', children: <SupplierProductsPanel /> },
            { key: 'connection', label: '接入与规则', children: connection },
            ...(session.data?.admin.role === 'admin' ? [{ key: 'read-tools', label: '只读联调', children: <SupplierReadTools /> }] : []),
          ]}
        />
      </Space>
    </div>
  );
}
