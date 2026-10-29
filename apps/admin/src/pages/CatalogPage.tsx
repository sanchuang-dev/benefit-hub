import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  Pagination,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Plus, RotateCcw, Search } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useSessionQuery } from '../features/auth/use-auth';
import type { CatalogProduct, ProductStatus } from '../features/catalog/api';
import { formatCents } from '../features/catalog/money';
import {
  ProductEditorDrawer,
  type ProductDrawerState,
} from '../features/catalog/ProductEditorDrawer';
import { SupplierProductsPanel } from '../features/catalog/SupplierProductsPanel';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  parseKeyword,
  parsePage,
  parsePageSize,
  setOptionalParam,
} from '../features/catalog/url-state';
import { useProductsQuery } from '../features/catalog/use-catalog';
import { formatDateTime } from '../shared/lib/format-date-time';
import { useUiPrefs, type CatalogViewMode } from '../shared/lib/ui-prefs';
import './CatalogPage.css';

const { Title, Paragraph, Text } = Typography;

type CatalogTabKey = 'internal' | 'supplier';

interface FilterFormValues {
  keyword?: string;
  status: ProductStatus | 'all';
}

function ProductStatusTag({ status }: { status: ProductStatus }) {
  return status === 'active' ? <Tag color="green">已启用</Tag> : <Tag>已停用</Tag>;
}

function InternalProductCards({
  products,
  isAdmin,
  loading,
  emptyText,
  onView,
  onEdit,
}: {
  products: CatalogProduct[];
  isAdmin: boolean;
  loading: boolean;
  emptyText: ReactNode;
  onView: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="catalog-feedback">
        <Spin />
      </div>
    );
  }

  if (products.length === 0) {
    return <div className="catalog-feedback">{emptyText}</div>;
  }

  return (
    <Row gutter={[16, 16]} className="catalog-card-grid">
      {products.map((product) => (
        <Col key={product.id} xs={24} sm={12} xl={8} xxl={6}>
          <Card
            size="small"
            title={<Text code>{product.code}</Text>}
            extra={<ProductStatusTag status={product.status} />}
            actions={[
              <Button key="view" type="link" size="small" onClick={() => onView(product.id)}>
                查看
              </Button>,
              ...(isAdmin
                ? [
                    <Button
                      key="edit"
                      type="link"
                      size="small"
                      onClick={() => onEdit(product.id)}
                    >
                      编辑
                    </Button>,
                  ]
                : []),
            ]}
          >
            <Space orientation="vertical" size={6}>
              <Text strong>{product.name}</Text>
              <Space size={12} wrap>
                <Text type="secondary">
                  展示价：
                  {product.displayPriceCents === null
                    ? '—'
                    : formatCents(product.displayPriceCents)}
                </Text>
                <Text type="secondary">
                  预估成本：
                  {product.estimatedCostCents === null
                    ? '—'
                    : formatCents(product.estimatedCostCents)}
                </Text>
              </Space>
              <Text type="secondary">更新时间：{formatDateTime(product.updatedAt)}</Text>
              <Space size={6} wrap>
                <Tag>真实发放未启用</Tag>
                <Text type="secondary">映射见详情</Text>
              </Space>
            </Space>
          </Card>
        </Col>
      ))}
    </Row>
  );
}

export function CatalogPage() {
  const session = useSessionQuery();
  const isAdmin = session.data?.admin.role === 'admin';

  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab: CatalogTabKey =
    searchParams.get('tab') === 'supplier' ? 'supplier' : 'internal';

  // Listing state is URL-owned so refresh, back/forward and shared links all
  // reproduce the same filtered request instead of resetting to page 1.
  const keyword = parseKeyword(searchParams.get('q'));
  const rawStatus = searchParams.get('status');
  const status: ProductStatus | 'all' =
    rawStatus === 'active' || rawStatus === 'disabled' ? rawStatus : 'all';
  const page = parsePage(searchParams.get('page'));
  const pageSize = parsePageSize(searchParams.get('pageSize'));

  const [filterForm] = Form.useForm<FilterFormValues>();
  const catalogView = useUiPrefs((state) => state.catalogView);
  const setCatalogView = useUiPrefs((state) => state.setCatalogView);
  const [drawer, setDrawer] = useState<ProductDrawerState | null>(null);

  // Keep the visible form in sync when the URL changes through back/forward or
  // a shared link, not only through the submit button.
  useEffect(() => {
    filterForm.setFieldsValue({ keyword, status });
  }, [filterForm, keyword, status]);

  const listQuery = useProductsQuery({
    page,
    pageSize,
    keyword: keyword || undefined,
    status: status === 'all' ? undefined : status,
  });

  const hasFilters = keyword !== '' || status !== 'all';
  const products = listQuery.data?.products ?? [];

  const updateSearch = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    setSearchParams(next, { replace: true });
  };

  const changeTab = (key: string) => {
    updateSearch((next) => {
      if (key === 'supplier') next.set('tab', 'supplier');
      else next.delete('tab');
    });
  };

  const openCreate = () => setDrawer({ mode: 'create' });

  const applyFilters = (values: FilterFormValues) => {
    const nextKeyword = values.keyword?.trim() ?? '';
    const nextStatus = values.status ?? 'all';
    updateSearch((next) => {
      setOptionalParam(next, 'q', nextKeyword || null);
      setOptionalParam(next, 'status', nextStatus === 'all' ? null : nextStatus);
      next.delete('page');
    });
  };

  const resetFilters = () => {
    filterForm.resetFields();
    updateSearch((next) => {
      next.delete('q');
      next.delete('status');
      next.delete('page');
    });
  };

  const changePage = (nextPage: number, nextPageSize: number) => {
    updateSearch((next) => {
      if (nextPageSize !== pageSize) {
        setOptionalParam(
          next,
          'pageSize',
          nextPageSize === DEFAULT_PAGE_SIZE ? null : String(nextPageSize),
        );
        next.delete('page');
        return;
      }
      setOptionalParam(next, 'page', nextPage === 1 ? null : String(nextPage));
    });
  };

  const columns: ColumnsType<CatalogProduct> = [
    {
      title: '商品编码',
      dataIndex: 'code',
      key: 'code',
      width: 150,
      render: (code: string) => <Text code>{code}</Text>,
    },
    {
      title: '商品名称',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 88,
      render: (status: ProductStatus) => <ProductStatusTag status={status} />,
    },
    {
      title: '真实发放',
      dataIndex: 'vendorFulfillmentEnabled',
      key: 'vendorFulfillmentEnabled',
      width: 188,
      // This field is the real fulfillment switch and is fixed false in this
      // slice. It never means "no supplier mapping"; mapping is read per
      // product in the detail drawer, so the list must not guess or N+1 fetch.
      render: (enabled: CatalogProduct['vendorFulfillmentEnabled']) =>
        enabled ? (
          <Tag color="green">已启用</Tag>
        ) : (
          <Space size={6} wrap={false}>
            <Tag>未启用</Tag>
            <Text type="secondary">映射见详情</Text>
          </Space>
        ),
    },
    {
      title: '展示价',
      dataIndex: 'displayPriceCents',
      key: 'displayPriceCents',
      width: 108,
      align: 'right',
      className: 'catalog-amount',
      render: (cents: number | null) =>
        cents === null ? <Text type="secondary">—</Text> : formatCents(cents),
    },
    {
      title: '预估成本',
      dataIndex: 'estimatedCostCents',
      key: 'estimatedCostCents',
      width: 108,
      align: 'right',
      className: 'catalog-amount',
      render: (cents: number | null) =>
        cents === null ? <Text type="secondary">—</Text> : formatCents(cents),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 216,
      render: (updatedAt: number) => <Text type="secondary">{formatDateTime(updatedAt)}</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 108,
      fixed: 'right',
      render: (_, product) => (
        <Space size={0}>
          <Button
            type="link"
            size="small"
            onClick={() => setDrawer({ mode: 'view', productId: product.id })}
          >
            查看
          </Button>
          {isAdmin ? (
            <Button
              type="link"
              size="small"
              onClick={() => setDrawer({ mode: 'edit', productId: product.id })}
            >
              编辑
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  const emptyText = hasFilters ? (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的商品">
      <Button onClick={resetFilters}>清除筛选</Button>
    </Empty>
  ) : (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={isAdmin ? '还没有内部商品' : '还没有内部商品，请联系管理员创建'}
    />
  );

  const viewSwitcher = (
    <Form.Item label="视图">
      <Segmented
        value={catalogView}
        onChange={(value) => setCatalogView(value as CatalogViewMode)}
        options={[
          { label: '表格', value: 'table' },
          { label: '卡片', value: 'card' },
        ]}
      />
    </Form.Item>
  );

  const internalProducts = (
    <Space orientation="vertical" size={12} className="page-stack">
      {!isAdmin ? (
        <Alert
          type="info"
          showIcon
          title="当前为只读身份"
          description="可以查看商品列表与详情；新建、编辑和启停需要管理员权限，服务端也会独立拒绝越权写入。"
        />
      ) : null}

      <section className="catalog-surface" aria-label="内部商品列表">
        <Form<FilterFormValues>
          form={filterForm}
          className="catalog-toolbar"
          layout="inline"
          initialValues={{ keyword, status }}
          onFinish={applyFilters}
        >
          <Form.Item name="keyword" label="关键词">
            <Input allowClear placeholder="商品编码、名称或描述" style={{ width: 240 }} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select
              style={{ width: 140 }}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'active', label: '已启用' },
                { value: 'disabled', label: '已停用' },
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
          {viewSwitcher}
        </Form>

        {listQuery.isError ? (
          <div className="catalog-feedback">
            <Alert
              type="error"
              showIcon
              title="商品加载失败"
              description={listQuery.error.message}
              action={
                <Button size="small" onClick={() => listQuery.refetch()}>
                  重试
                </Button>
              }
            />
          </div>
        ) : catalogView === 'table' ? (
          <Table<CatalogProduct>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={products}
            loading={listQuery.isPending || listQuery.isFetching}
            locale={{ emptyText }}
            scroll={{ x: 1060 }}
            pagination={{
              current: page,
              pageSize,
              total: listQuery.data?.total ?? 0,
              pageSizeOptions: PAGE_SIZE_OPTIONS,
              showSizeChanger: true,
              showTotal: (total) => `共 ${total} 条`,
              onChange: changePage,
            }}
          />
        ) : (
          <>
            <InternalProductCards
              products={products}
              isAdmin={Boolean(isAdmin)}
              loading={listQuery.isPending || listQuery.isFetching}
              emptyText={emptyText}
              onView={(id) => setDrawer({ mode: 'view', productId: id })}
              onEdit={(id) => setDrawer({ mode: 'edit', productId: id })}
            />
            {(listQuery.data?.total ?? 0) > 0 ? (
              <div className="catalog-card-pagination">
                <Pagination
                  current={page}
                  pageSize={pageSize}
                  total={listQuery.data?.total ?? 0}
                  pageSizeOptions={PAGE_SIZE_OPTIONS}
                  showSizeChanger
                  showTotal={(total) => `共 ${total} 条`}
                  onChange={changePage}
                />
              </div>
            ) : null}
          </>
        )}
      </section>
    </Space>
  );

  return (
    <div className="page">
      <header className="page-header catalog-header">
        <div className="catalog-header-text">
          <Title level={2}>商品管理</Title>
          <Paragraph type="secondary">
            内部商品由本平台维护名称、展示价与启停；供应商商品是只读来源目录，当前供货方为上力。供应商映射只在内部商品详情中只读查看，真实发放尚未启用。
          </Paragraph>
        </div>
        {activeTab === 'internal' ? (
          <div className="catalog-header-actions">
            {isAdmin ? (
              <Button type="primary" icon={<Plus size={16} />} onClick={openCreate}>
                新建商品
              </Button>
            ) : (
              <Tooltip title="只读身份不能新建商品">
                <span>
                  <Button type="primary" icon={<Plus size={16} />} disabled>
                    新建商品
                  </Button>
                </span>
              </Tooltip>
            )}
          </div>
        ) : null}
      </header>

      <Tabs
        className="catalog-tabs"
        activeKey={activeTab}
        onChange={changeTab}
        items={[
          { key: 'internal', label: '内部商品', children: internalProducts },
          {
            key: 'supplier',
            label: '供应商商品',
            children: <SupplierProductsPanel />,
          },
        ]}
      />

      <ProductEditorDrawer
        state={drawer}
        canWrite={Boolean(isAdmin)}
        onClose={() => setDrawer(null)}
      />
    </div>
  );
}
