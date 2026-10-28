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
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useSessionQuery } from '../features/auth/use-auth';
import type { CatalogProduct, ProductStatus } from '../features/catalog/api';
import { formatCents } from '../features/catalog/money';
import {
  ProductEditorDrawer,
  type ProductDrawerState,
} from '../features/catalog/ProductEditorDrawer';
import { SupplierProductsPanel } from '../features/catalog/SupplierProductsPanel';
import { useProductsQuery } from '../features/catalog/use-catalog';
import { formatDateTime } from '../shared/lib/format-date-time';
import './CatalogPage.css';

const { Title, Paragraph, Text } = Typography;

const PAGE_SIZE_OPTIONS = [10, 20, 50];

type CatalogTabKey = 'internal' | 'supplier';
type CatalogViewMode = 'table' | 'card';

interface FilterFormValues {
  keyword?: string;
  status: ProductStatus | 'all';
}

interface AppliedFilters {
  keyword: string;
  status: ProductStatus | 'all';
}

const EMPTY_FILTERS: AppliedFilters = { keyword: '', status: 'all' };

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
              <Text type="secondary">映射见详情</Text>
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

  const [filterForm] = Form.useForm<FilterFormValues>();
  const [filters, setFilters] = useState<AppliedFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [view, setView] = useState<CatalogViewMode>('table');
  const [drawer, setDrawer] = useState<ProductDrawerState | null>(null);

  const listQuery = useProductsQuery({
    page,
    pageSize,
    keyword: filters.keyword || undefined,
    status: filters.status === 'all' ? undefined : filters.status,
  });

  const hasFilters = filters.keyword !== '' || filters.status !== 'all';
  const products = listQuery.data?.products ?? [];

  const changeTab = (key: string) => {
    const next = new URLSearchParams(searchParams);
    if (key === 'supplier') next.set('tab', 'supplier');
    else next.delete('tab');
    setSearchParams(next, { replace: true });
  };

  const openCreate = () => setDrawer({ mode: 'create' });

  const applyFilters = (values: FilterFormValues) => {
    setFilters({
      keyword: values.keyword?.trim() ?? '',
      status: values.status ?? 'all',
    });
    setPage(1);
  };

  const resetFilters = () => {
    filterForm.resetFields();
    setFilters(EMPTY_FILTERS);
    setPage(1);
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
        value={view}
        onChange={(value) => setView(value as CatalogViewMode)}
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
          initialValues={{ keyword: '', status: 'all' }}
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
        ) : view === 'table' ? (
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
              onChange: (nextPage, nextPageSize) => {
                setPage(nextPage);
                setPageSize(nextPageSize);
              },
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
                  onChange={(nextPage, nextPageSize) => {
                    setPage(nextPage);
                    setPageSize(nextPageSize);
                  }}
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
          <Title level={2}>{activeTab === 'internal' ? '权益商品' : '供货目录'}</Title>
          <Paragraph type="secondary">
            {activeTab === 'internal'
              ? '管理三创自有权益商品、运营价格与供应商映射。'
              : '查看供应商提供的商品、来源报价及已获得的商品详情。'}
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
