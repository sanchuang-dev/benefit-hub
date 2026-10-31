import type { MappingProvider } from '@sanchuang-dev/benefit-contracts';
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
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Plus, RotateCcw, Search } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useSessionQuery } from '../features/auth/use-auth';
import type {
  CatalogProductListItem,
  ProductMappingSummary,
  ProductStatus,
  SupplierFilterOption,
} from '../features/catalog/api';
import { formatCents } from '../features/catalog/money';
import {
  ProductEditorDrawer,
  type ProductDrawerState,
} from '../features/catalog/ProductEditorDrawer';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  parseKeyword,
  parsePage,
  parsePageSize,
  setOptionalParam,
} from '../shared/lib/url-state';
import { parseSupplier } from '../features/catalog/url-state';
import { useProductsQuery } from '../features/catalog/use-catalog';
import { formatDateTime } from '../shared/lib/format-date-time';
import { useUiPrefs, type CatalogViewMode } from '../shared/lib/ui-prefs';
import './CatalogPage.css';
import { PageHeader } from '../shared/components/PageHeader';

const { Text } = Typography;

/**
 * The supplier catalogue is a read-only reference owned by the supplier detail
 * page. Old links still point at `/catalog?tab=supplier`, so they are redirected
 * to the supplier page's catalogue tab instead of silently losing the context.
 */
export const SUPPLIER_CATALOG_REDIRECT_PATH = '/suppliers/yangmao?tab=catalog';

/**
 * `tab=supplier` is the only legacy state this page still understands. The
 * redirect is kept in an outer component so the inner page always calls the
 * same hooks and never hits a conditional-hook path.
 */
export function CatalogPage() {
  const [searchParams] = useSearchParams();
  if (searchParams.get('tab') === 'supplier') {
    return <Navigate to={SUPPLIER_CATALOG_REDIRECT_PATH} replace />;
  }
  return <CatalogPageContent />;
}

interface FilterFormValues {
  keyword?: string;
  status: ProductStatus | 'all';
  supplier: MappingProvider | 'all';
}

function ProductStatusTag({ status }: { status: ProductStatus }) {
  return status === 'active' ? <Tag color="green">已启用</Tag> : <Tag>已停用</Tag>;
}

/**
 * Supplier name comes from the server facet, never from a hard-coded vendor
 * list. A key the facet does not know is still shown as-is so the row keeps
 * its real provider instead of pretending the mapping has none.
 */
function SupplierCell({
  provider,
  suppliers,
}: {
  provider: string | null;
  suppliers: SupplierFilterOption[];
}) {
  if (!provider) {
    return <Text type="secondary">—</Text>;
  }
  const option = suppliers.find((supplier) => supplier.key === provider);
  return (
    <Space size={4} wrap>
      <Text>{option?.name ?? provider}</Text>
      {option && !option.configured ? <Text type="secondary">未配置</Text> : null}
    </Space>
  );
}

/**
 * The list contract always carries a mapping summary, but a stale payload must
 * render as unknown rather than crash the catalogue or claim "未配置".
 */
function mappingOf(product: CatalogProductListItem): ProductMappingSummary | undefined {
  return product.mapping;
}

/** `draft` must never read as effective; only `active` shows the version. */
function ProductMappingCell({ mapping }: { mapping: ProductMappingSummary | undefined }) {
  // An older list response without the mapping projection is unknown, not
  // "unmapped": showing "未配置" would be a claim the payload does not support.
  if (!mapping) {
    return <Text type="secondary">—</Text>;
  }
  if (mapping.state === 'active') {
    return (
      <Space size={4} wrap>
        <Tag color="green">已生效</Tag>
        {mapping.versionNumber === null ? null : (
          <Text type="secondary">v{mapping.versionNumber}</Text>
        )}
      </Space>
    );
  }
  if (mapping.state === 'draft') {
    return <Tag color="orange">草稿未生效</Tag>;
  }
  return <Tag>未配置</Tag>;
}

function InternalProductCards({
  products,
  suppliers,
  isAdmin,
  loading,
  emptyText,
  onView,
  onEdit,
}: {
  products: CatalogProductListItem[];
  suppliers: SupplierFilterOption[];
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
      {products.map((product) => {
        const mapping = mappingOf(product);
        return (
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
                  <Space size={4}>
                    <Text type="secondary">供货方：</Text>
                    <SupplierCell provider={mapping?.provider ?? null} suppliers={suppliers} />
                  </Space>
                  <Space size={4}>
                    <Text type="secondary">映射：</Text>
                    <ProductMappingCell mapping={mapping} />
                  </Space>
                </Space>
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
              </Space>
            </Card>
          </Col>
        );
      })}
    </Row>
  );
}

function CatalogPageContent() {
  const session = useSessionQuery();
  const isAdmin = session.data?.admin.role === 'admin';

  const [searchParams, setSearchParams] = useSearchParams();

  // Listing state is URL-owned so refresh, back/forward and shared links all
  // reproduce the same filtered request instead of resetting to page 1.
  const keyword = parseKeyword(searchParams.get('q'));
  const rawStatus = searchParams.get('status');
  const status: ProductStatus | 'all' =
    rawStatus === 'active' || rawStatus === 'disabled' ? rawStatus : 'all';
  // The supplier filter is a provider key from the shared contract whitelist;
  // an edited URL value that is not a real provider simply means "all".
  const supplier = parseSupplier(searchParams.get('supplier'));
  const page = parsePage(searchParams.get('page'));
  const pageSize = parsePageSize(searchParams.get('pageSize'));

  const [filterForm] = Form.useForm<FilterFormValues>();
  const catalogView = useUiPrefs((state) => state.catalogView);
  const setCatalogView = useUiPrefs((state) => state.setCatalogView);
  const [drawer, setDrawer] = useState<ProductDrawerState | null>(null);

  // Keep the visible form in sync when the URL changes through back/forward or
  // a shared link, not only through the submit button.
  useEffect(() => {
    filterForm.setFieldsValue({
      keyword,
      status,
      supplier: supplier ?? 'all',
    });
  }, [filterForm, keyword, status, supplier]);

  const listQuery = useProductsQuery({
    page,
    pageSize,
    keyword: keyword || undefined,
    status: status === 'all' ? undefined : status,
    supplier,
  });

  const hasFilters = keyword !== '' || status !== 'all' || supplier !== undefined;
  const products = listQuery.data?.products ?? [];
  const suppliers = listQuery.data?.suppliers ?? [];

  const supplierOptions = [
    { value: 'all' as const, label: '全部供货方' },
    ...suppliers.map((option) => ({
      value: option.key,
      label: option.configured ? option.name : `${option.name}（未配置）`,
    })),
  ];

  const updateSearch = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    setSearchParams(next, { replace: true });
  };

  const openCreate = () => setDrawer({ mode: 'create' });

  const applyFilters = (values: FilterFormValues) => {
    const nextKeyword = values.keyword?.trim() ?? '';
    const nextStatus = values.status ?? 'all';
    const nextSupplier = values.supplier ?? 'all';
    updateSearch((next) => {
      setOptionalParam(next, 'q', nextKeyword || null);
      setOptionalParam(next, 'status', nextStatus === 'all' ? null : nextStatus);
      setOptionalParam(next, 'supplier', nextSupplier === 'all' ? null : nextSupplier);
      next.delete('page');
    });
  };

  const resetFilters = () => {
    filterForm.resetFields();
    updateSearch((next) => {
      next.delete('q');
      next.delete('status');
      next.delete('supplier');
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

  const columns: ColumnsType<CatalogProductListItem> = [
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
      width: 96,
      render: (status: ProductStatus) => <ProductStatusTag status={status} />,
    },
    {
      title: '供货方',
      key: 'supplier',
      width: 140,
      render: (_, product) => (
        <SupplierCell provider={mappingOf(product)?.provider ?? null} suppliers={suppliers} />
      ),
    },
    {
      title: '映射状态',
      key: 'mappingState',
      width: 150,
      render: (_, product) => <ProductMappingCell mapping={mappingOf(product)} />,
    },
    {
      title: '上游编码',
      key: 'productCode',
      width: 150,
      render: (_, product) => {
        const productCode = mappingOf(product)?.productCode;
        return productCode ? (
          <Text code>{productCode}</Text>
        ) : (
          <Text type="secondary">—</Text>
        );
      },
    },
    {
      title: '模式',
      key: 'fulfillmentMode',
      width: 80,
      render: (_, product) => {
        const fulfillmentMode = mappingOf(product)?.fulfillmentMode;
        return fulfillmentMode ? (
          <Text code>{fulfillmentMode}</Text>
        ) : (
          <Text type="secondary">—</Text>
        );
      },
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

  return (
    <div className="page">
      <PageHeader
        title="权益商品"
        description="管理三创自有权益商品、运营价格与供应商映射。"
      />

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
          <div className="catalog-toolbar-row">
            <Form<FilterFormValues>
              form={filterForm}
              className="catalog-toolbar"
              layout="inline"
              initialValues={{ keyword, status, supplier: supplier ?? 'all' }}
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
              <Form.Item name="supplier" label="供货方">
                <Select style={{ width: 160 }} options={supplierOptions} />
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

            <div className="catalog-create">
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
          </div>

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
            <Table<CatalogProductListItem>
              rowKey="id"
              size="middle"
              columns={columns}
              dataSource={products}
              loading={listQuery.isPending || listQuery.isFetching}
              locale={{ emptyText }}
              scroll={{ x: 1500 }}
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
                suppliers={suppliers}
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

      <ProductEditorDrawer
        state={drawer}
        canWrite={Boolean(isAdmin)}
        onClose={() => setDrawer(null)}
      />
    </div>
  );
}
