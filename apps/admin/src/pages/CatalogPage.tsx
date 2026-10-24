import {
  Alert,
  Button,
  Empty,
  Flex,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Plus, RotateCcw, Search } from 'lucide-react';
import { useState } from 'react';
import { useSessionQuery } from '../features/auth/use-auth';
import type { CatalogProduct, ProductStatus } from '../features/catalog/api';
import { formatCents } from '../features/catalog/money';
import {
  ProductEditorDrawer,
  type ProductDrawerState,
} from '../features/catalog/ProductEditorDrawer';
import { useProductsQuery } from '../features/catalog/use-catalog';
import { formatDateTime } from '../shared/lib/format-date-time';

const { Title, Paragraph, Text } = Typography;

const PAGE_SIZE_OPTIONS = [10, 20, 50];

interface FilterFormValues {
  keyword?: string;
  status: ProductStatus | 'all';
}

interface AppliedFilters {
  keyword: string;
  status: ProductStatus | 'all';
}

const EMPTY_FILTERS: AppliedFilters = { keyword: '', status: 'all' };

export function CatalogPage() {
  const session = useSessionQuery();
  const isAdmin = session.data?.admin.role === 'admin';

  const [filterForm] = Form.useForm<FilterFormValues>();
  const [filters, setFilters] = useState<AppliedFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [drawer, setDrawer] = useState<ProductDrawerState | null>(null);

  const listQuery = useProductsQuery({
    page,
    pageSize,
    keyword: filters.keyword || undefined,
    status: filters.status === 'all' ? undefined : filters.status,
  });

  const hasFilters = filters.keyword !== '' || filters.status !== 'all';
  const products = listQuery.data?.products ?? [];

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
      width: 180,
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
      width: 100,
      render: (status: ProductStatus) =>
        status === 'active' ? <Tag color="green">已启用</Tag> : <Tag>已停用</Tag>,
    },
    {
      title: '供应商映射',
      dataIndex: 'vendorFulfillmentEnabled',
      key: 'vendorMapping',
      width: 190,
      render: (enabled: CatalogProduct['vendorFulfillmentEnabled']) =>
        enabled ? (
          <Tag color="green">已映射供应商</Tag>
        ) : (
          <Space size={4} wrap>
            <Tag>未映射供应商</Tag>
            <Text type="secondary">不能发放</Text>
          </Space>
        ),
    },
    {
      title: '展示价',
      dataIndex: 'displayPriceCents',
      key: 'displayPriceCents',
      width: 120,
      align: 'right',
      render: (cents: number | null) => (cents === null ? '—' : formatCents(cents)),
    },
    {
      title: '预估成本',
      dataIndex: 'estimatedCostCents',
      key: 'estimatedCostCents',
      width: 120,
      align: 'right',
      render: (cents: number | null) => (cents === null ? '—' : formatCents(cents)),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 190,
      render: (updatedAt: number) => formatDateTime(updatedAt),
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
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

  return (
    <div className="page">
      <Flex className="page-header" justify="space-between" align="flex-start" gap={16} wrap>
        <div>
          <Title level={2}>商品管理</Title>
          <Paragraph type="secondary">
            内部商品由本平台维护名称、展示价与启停；供应商商品与履约映射尚未接入。
          </Paragraph>
        </div>
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
      </Flex>

      <Space orientation="vertical" size={16} className="page-stack">
        {!isAdmin ? (
          <Alert
            type="info"
            showIcon
            title="当前为只读身份"
            description="可以查看商品列表与详情；新建、编辑和启停需要管理员权限，服务端也会独立拒绝越权写入。"
          />
        ) : null}

        <Form<FilterFormValues>
          form={filterForm}
          className="catalog-filters"
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
            <Space>
              <Button type="primary" htmlType="submit" icon={<Search size={14} />}>
                查询
              </Button>
              <Button onClick={resetFilters} icon={<RotateCcw size={14} />}>
                重置
              </Button>
            </Space>
          </Form.Item>
        </Form>

        {listQuery.isError ? (
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
        ) : (
          <Table<CatalogProduct>
            rowKey="id"
            columns={columns}
            dataSource={products}
            loading={listQuery.isPending || listQuery.isFetching}
            locale={{ emptyText }}
            scroll={{ x: 'max-content' }}
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
        )}
      </Space>

      <ProductEditorDrawer
        state={drawer}
        canWrite={Boolean(isAdmin)}
        onClose={() => setDrawer(null)}
      />
    </div>
  );
}
