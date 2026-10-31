import {
  Alert,
  App as AntdApp,
  Button,
  Empty,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { Plus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useSessionQuery } from '../features/auth/use-auth';
import type {
  CatalogProductListItem,
  ProductMappingSummary,
  ProductSortField,
  ProductStatus,
  SupplierFilterOption,
} from '../features/catalog/api';
import { formatCents } from '../features/catalog/money';
import {
  ProductEditorDrawer,
  type ProductDrawerState,
} from '../features/catalog/ProductEditorDrawer';
import {
  CATALOG_PANEL_ID,
  EMPTY_CATALOG_FILTERS,
  hasActiveCatalogFilters,
  priceToCents,
  readCatalogState,
  writeCatalogState,
  type CatalogFilters,
} from '../features/catalog/url-state';
import { useProductsQuery } from '../features/catalog/use-catalog';
import {
  DataPanel,
  type PanelAction,
  type PanelColumn,
  type PanelFilter,
  type PanelQuery,
} from '../shared/components/DataPanel';
import { formatDateTime } from '../shared/lib/format-date-time';
import { PAGE_SIZE_OPTIONS } from '../shared/lib/url-state';
import './CatalogPage.css';

const { Title, Paragraph, Text } = Typography;

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

/**
 * Card content only; the shared DataPanel owns the card surface, the list of
 * cards and the row actions so table and card mode cannot drift apart.
 */
function ProductCardBody({
  product,
  suppliers,
}: {
  product: CatalogProductListItem;
  suppliers: SupplierFilterOption[];
}) {
  const mapping = mappingOf(product);
  return (
    <div className="catalog-card-body">
      <div className="catalog-card-title">
        <Text code>{product.code}</Text>
        <ProductStatusTag status={product.status} />
      </div>
      <Text strong>{product.name}</Text>
      <div className="catalog-card-meta">
        <Space size={4}>
          <Text type="secondary">供货方：</Text>
          <SupplierCell provider={mapping?.provider ?? null} suppliers={suppliers} />
        </Space>
        <Space size={4}>
          <Text type="secondary">映射：</Text>
          <ProductMappingCell mapping={mapping} />
        </Space>
      </div>
      <div className="catalog-card-meta">
        <Text type="secondary">
          展示价：
          {product.displayPriceCents === null ? '—' : formatCents(product.displayPriceCents)}
        </Text>
        <Text type="secondary">
          预估成本：
          {product.estimatedCostCents === null ? '—' : formatCents(product.estimatedCostCents)}
        </Text>
      </div>
      <Text type="secondary">更新时间：{formatDateTime(product.updatedAt)}</Text>
    </div>
  );
}

function CatalogPageContent() {
  const session = useSessionQuery();
  const isAdmin = session.data?.admin.role === 'admin';
  const { message } = AntdApp.useApp();

  const [searchParams, setSearchParams] = useSearchParams();
  // URL is the single owner of list state. The memo keeps the filters object
  // stable between renders so the panel form is only resynced on navigation,
  // not while an operator is still typing a query.
  const panelQuery = useMemo(() => readCatalogState(searchParams), [searchParams]);
  const { filters, page, pageSize, sort } = panelQuery;
  const [drawer, setDrawer] = useState<ProductDrawerState | null>(null);

  const listQuery = useProductsQuery(
    useMemo(
      () => ({
        page,
        pageSize,
        keyword: filters.keyword || undefined,
        status: filters.status === 'all' ? undefined : filters.status,
        supplier: filters.supplier === 'all' ? undefined : filters.supplier,
        mappingState: filters.mappingState === 'all' ? undefined : filters.mappingState,
        displayPriceMinCents: priceToCents(filters.displayPrice.min),
        displayPriceMaxCents: priceToCents(filters.displayPrice.max),
        sortBy: sort?.key,
        sortOrder: sort?.order,
      }),
      [page, pageSize, filters, sort],
    ),
  );

  const products = listQuery.data?.products ?? [];
  const suppliers = listQuery.data?.suppliers ?? [];
  const hasFilters = hasActiveCatalogFilters(filters);

  const supplierOptions = useMemo(
    () => [
      { value: 'all' as const, label: '全部供货方' },
      ...suppliers.map((option) => ({
        value: option.key,
        label: option.configured ? option.name : `${option.name}（未配置）`,
      })),
    ],
    [suppliers],
  );

  const updateSearch = (next: PanelQuery<CatalogFilters, ProductSortField>) => {
    const nextParams = writeCatalogState(searchParams, next);
    // Re-submitting the same filters must not push a duplicate history entry.
    if (nextParams.toString() === searchParams.toString()) return;
    // Filter, paging and sort changes are their own history entries so the
    // browser back/forward buttons replay exactly the previous request.
    setSearchParams(nextParams);
  };

  const applyPanelQuery = (next: PanelQuery<CatalogFilters, ProductSortField>) => {
    const minCents = priceToCents(next.filters.displayPrice.min);
    const maxCents = priceToCents(next.filters.displayPrice.max);
    const { min, max } = next.filters.displayPrice;
    if (
      ((min !== null && min !== undefined) && minCents === undefined) ||
      ((max !== null && max !== undefined) && maxCents === undefined)
    ) {
      void message.error('展示价必须为非负金额，最多保留两位小数');
      return false;
    }
    if (minCents !== undefined && maxCents !== undefined && minCents > maxCents) {
      // The API rejects this pair; ignore the submission instead of showing an
      // error page for an input the operator can still correct in place.
      void message.error('展示价最低值不能高于最高值');
      return false;
    }
    updateSearch(next);
    return true;
  };

  const resetFilters = () => {
    updateSearch({ filters: EMPTY_CATALOG_FILTERS, page: 1, pageSize, sort });
  };

  const openDrawer = (next: ProductDrawerState) => setDrawer(next);

  const columns: PanelColumn<CatalogProductListItem, ProductSortField>[] = [
    {
      title: '商品编码',
      dataIndex: 'code',
      key: 'code',
      width: 150,
      hideable: false,
      sortKey: 'code',
      render: (code: string) => <Text code>{code}</Text>,
    },
    {
      title: '商品名称',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      hideable: false,
      sortKey: 'name',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 96,
      hideable: false,
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
      sortKey: 'displayPriceCents',
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
      sortKey: 'updatedAt',
      render: (updatedAt: number) => <Text type="secondary">{formatDateTime(updatedAt)}</Text>,
    },
  ];

  const filterFields: PanelFilter<CatalogFilters>[] = [
    {
      key: 'keyword',
      kind: 'text',
      label: '关键词',
      placeholder: '商品编码、名称或描述',
      width: 240,
    },
    {
      key: 'status',
      kind: 'select',
      label: '状态',
      width: 140,
      options: [
        { value: 'all', label: '全部状态' },
        { value: 'active', label: '已启用' },
        { value: 'disabled', label: '已停用' },
      ],
    },
    {
      key: 'supplier',
      kind: 'select',
      label: '供货方',
      width: 160,
      options: supplierOptions,
    },
    {
      key: 'mappingState',
      kind: 'select',
      label: '映射状态',
      advanced: true,
      width: 160,
      options: [
        { value: 'all', label: '全部映射' },
        { value: 'none', label: '未配置' },
        { value: 'draft', label: '草稿未生效' },
        { value: 'active', label: '已生效' },
      ],
    },
    {
      key: 'displayPrice',
      kind: 'numberRange',
      label: '展示价（元）',
      advanced: true,
      min: 0,
      width: 260,
    },
  ];

  const rowActions = (
    _product: CatalogProductListItem,
  ): readonly PanelAction<CatalogProductListItem>[] => [
    {
      key: 'view',
      label: '查看',
      onClick: (row) => openDrawer({ mode: 'view', productId: row.id }),
    },
    ...(isAdmin
      ? [
          {
            key: 'edit',
            label: '编辑',
            onClick: (row: CatalogProductListItem) => openDrawer({ mode: 'edit', productId: row.id }),
          },
        ]
      : []),
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

  const createAction = isAdmin ? (
    <Button type="primary" icon={<Plus size={16} />} onClick={() => openDrawer({ mode: 'create' })}>
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
  );

  const renderCard = (product: CatalogProductListItem): ReactNode => (
    <ProductCardBody product={product} suppliers={suppliers} />
  );

  return (
    <div className="page">
      <header className="page-header catalog-header">
        <div className="catalog-header-text">
          <Title level={2}>权益商品</Title>
          <Paragraph type="secondary">
            管理三创自有权益商品、运营价格与供应商映射。
          </Paragraph>
        </div>
      </header>

      <Space orientation="vertical" size={12} className="page-stack">
        {!isAdmin ? (
          <Alert
            type="info"
            showIcon
            title="当前为只读身份"
            description="可以查看商品列表与详情；新建、编辑和启停需要管理员权限，服务端也会独立拒绝越权写入。"
          />
        ) : null}

        <DataPanel<CatalogProductListItem, CatalogFilters, ProductSortField>
          id={CATALOG_PANEL_ID}
          label="内部商品列表"
          rowKey={(product) => product.id}
          query={panelQuery}
          onQueryChange={applyPanelQuery}
          initialFilters={EMPTY_CATALOG_FILTERS}
          data={{
            rows: products,
            total: listQuery.data?.total ?? 0,
            loading: listQuery.isPending || listQuery.isFetching,
            error: listQuery.error ?? undefined,
          }}
          filters={filterFields}
          columns={columns}
          onRefresh={() => {
            void listQuery.refetch();
          }}
          renderCard={renderCard}
          rowActions={rowActions}
          toolbarExtra={createAction}
          emptyText={emptyText}
          errorTitle="商品加载失败"
          pageSizeOptions={PAGE_SIZE_OPTIONS}
        />
      </Space>

      <ProductEditorDrawer
        state={drawer}
        canWrite={Boolean(isAdmin)}
        onClose={() => setDrawer(null)}
      />
    </div>
  );
}
