import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Pagination,
  Row,
  Segmented,
  Skeleton,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Eye, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { formatCents } from './money';
import type { SupplierCatalogProduct } from './api';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  parseKeyword,
  parsePage,
  parsePageSize,
  setOptionalParam,
} from './url-state';
import { useSupplierProductQuery, useSupplierProductsQuery } from './use-catalog';
import { ApiError } from '../../shared/lib/api-client';
import { formatDateTime } from '../../shared/lib/format-date-time';
import { useUiPrefs, type CatalogViewMode } from '../../shared/lib/ui-prefs';

const { Text } = Typography;

const SUPPLIER_DISPLAY_NAME = '上力';
const SUPPLIER_PROVIDER_KEY = 'yangmao';

interface FilterFormValues {
  supplierKeyword?: string;
}

function formatObservedAt(iso: string): string {
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? iso : formatDateTime(timestamp);
}

function supplierErrorCopy(error: Error): {
  type: 'warning' | 'error';
  title: string;
  description: string;
} {
  if (error instanceof ApiError) {
    if (error.code === 'SUPPLIER_NOT_CONFIGURED' || error.status === 503) {
      return {
        type: 'warning',
        title: '尚未配置上力只读凭证',
        description:
          '服务器尚未配置上力供应商商品只读凭证，因此无法读取真实目录。这不代表供应商目录为空；请由管理员在服务器侧完成安全配置后重试。',
      };
    }
    if (error.status === 401) {
      return {
        type: 'error',
        title: '登录状态已失效',
        description: '请刷新页面并重新登录后再读取供应商商品。',
      };
    }
    if (error.code === 'SUPPLIER_AUTH_FAILED' || error.code === 'SUPPLIER_FORBIDDEN') {
      return {
        type: 'error',
        title: '上力供应商鉴权失败',
        description: `${error.message}。这不是空目录，请联系管理员检查服务器侧只读凭证。`,
      };
    }
    if (error.code === 'SUPPLIER_TIMEOUT') {
      return {
        type: 'error',
        title: '上力供应商响应超时',
        description: '本次读取没有拿到供应商结果；页面不会把超时显示成空列表，请稍后重试。',
      };
    }
    return {
      type: 'error',
      title: '供应商商品读取失败',
      description: `${error.message}。本次没有可确认的供应商目录，页面不会显示成空列表。`,
    };
  }

  return {
    type: 'error',
    title: '供应商商品读取失败',
    description: '请求失败，请稍后重试。',
  };
}

function SupplierProductDrawer({
  productCode,
  onClose,
}: {
  productCode: string | null;
  onClose: () => void;
}) {
  const detailQuery = useSupplierProductQuery(productCode);
  const errorCopy = detailQuery.isError ? supplierErrorCopy(detailQuery.error) : null;

  return (
    <Drawer
      open={Boolean(productCode)}
      onClose={onClose}
      title="供应商商品详情"
      size={640}
      destroyOnHidden
      className="catalog-supplier-drawer"
    >
      {detailQuery.isPending ? (
        <Skeleton active title={{ width: '50%' }} paragraph={{ rows: 4 }} />
      ) : errorCopy ? (
        <Alert
          type={errorCopy.type}
          showIcon
          title={errorCopy.title}
          description={errorCopy.description}
          action={
            <Button size="small" loading={detailQuery.isFetching} onClick={() => void detailQuery.refetch()}>
              重试
            </Button>
          }
        />
      ) : detailQuery.data ? (
        <Space orientation="vertical" size={16} className="catalog-supplier-detail">
          <Alert
            type="info"
            showIcon
            title="只读来源快照"
            description="名称来自本次上力详情查询；库存、余额与可售状态以实际供应商数据为准。"
          />
          <Descriptions
            size="small"
            column={1}
            bordered
            items={[
              {
                key: 'provider',
                label: '供货方',
                children: (
                  <Space size={8} wrap>
                    <Tag color="blue">{SUPPLIER_DISPLAY_NAME}</Tag>
                    <Text type="secondary">{`Provider: ${detailQuery.data.provider}`}</Text>
                  </Space>
                ),
              },
              {
                key: 'productCode',
                label: '上游商品编码',
                children: <Text code>{detailQuery.data.productCode}</Text>,
              },
              { key: 'name', label: '商品名称', children: detailQuery.data.name },
              {
                key: 'sellPrice',
                label: '供应商报价',
                children: formatCents(detailQuery.data.sellPriceCents),
              },
              {
                key: 'status',
                label: '可用状态',
                children: (
                  <Tooltip title="上游详情未提供已核实的可售状态；不从 goodsStatus 猜测">
                    <Tag>待核实</Tag>
                  </Tooltip>
                ),
              },
              {
                key: 'observedAt',
                label: '获取时间',
                children: formatObservedAt(detailQuery.data.observedAt),
              },
            ]}
          />
          <Text type="secondary">
            供应商商品保持只读；后台修改的始终是内部商品与映射，不会写入上游目录。
          </Text>
        </Space>
      ) : null}
    </Drawer>
  );
}

/**
 * Read-only supplier products tab. It consumes one real server snapshot through
 * the same-origin authenticated endpoint; keyword filtering and pagination are
 * applied to that result instead of issuing per-row supplier requests. Every
 * non-success or unconfigured state stays visibly distinct from a real empty
 * catalogue, and no availability, stock, balance or sync time is invented.
 */
export function SupplierProductsPanel() {
  const listQuery = useSupplierProductsQuery();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filterForm] = Form.useForm<FilterFormValues>();
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  // Tab-scoped URL keys keep the supplier snapshot's own filter and paging, so
  // switching to 内部商品 and back (or refreshing) does not reset them.
  const appliedKeyword = parseKeyword(searchParams.get('supplierQ'));
  const page = parsePage(searchParams.get('supplierPage'));
  const pageSize = parsePageSize(searchParams.get('supplierPageSize'));

  const supplierView = useUiPrefs((state) => state.supplierView);
  const setSupplierView = useUiPrefs((state) => state.setSupplierView);

  useEffect(() => {
    filterForm.setFieldsValue({ supplierKeyword: appliedKeyword });
  }, [filterForm, appliedKeyword]);

  const products = listQuery.data?.products ?? [];
  const normalizedKeyword = appliedKeyword.toLowerCase();
  const filteredProducts = normalizedKeyword
    ? products.filter((product) => product.productCode.toLowerCase().includes(normalizedKeyword))
    : products;
  const sourceIsEmpty = products.length === 0;
  const filterHasNoResults = !sourceIsEmpty && filteredProducts.length === 0;
  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / pageSize));
  const currentPage = Math.min(page, totalPages);

  const updateSearch = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    setSearchParams(next, { replace: true });
  };

  const applyFilters = (values: FilterFormValues) => {
    const nextKeyword = values.supplierKeyword?.trim() ?? '';
    updateSearch((next) => {
      setOptionalParam(next, 'supplierQ', nextKeyword || null);
      next.delete('supplierPage');
    });
  };

  const resetFilters = () => {
    filterForm.resetFields();
    updateSearch((next) => {
      next.delete('supplierQ');
      next.delete('supplierPage');
    });
  };

  const changePage = (nextPage: number, nextPageSize: number) => {
    updateSearch((next) => {
      if (nextPageSize !== pageSize) {
        setOptionalParam(
          next,
          'supplierPageSize',
          nextPageSize === DEFAULT_PAGE_SIZE ? null : String(nextPageSize),
        );
        next.delete('supplierPage');
        return;
      }
      setOptionalParam(next, 'supplierPage', nextPage === 1 ? null : String(nextPage));
    });
  };

  const refresh = () => {
    void listQuery.refetch();
  };

  const emptyText = sourceIsEmpty ? (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未获取到供应商商品">
      <Button onClick={refresh} icon={<RefreshCw size={14} />}>
        重新读取
      </Button>
    </Empty>
  ) : filterHasNoResults ? (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的供应商商品">
      <Button onClick={resetFilters}>清除筛选</Button>
    </Empty>
  ) : null;

  const columns: ColumnsType<SupplierCatalogProduct> = [
    {
      title: '供货方',
      key: 'provider',
      width: 104,
      render: () => <Tag color="blue">{SUPPLIER_DISPLAY_NAME}</Tag>,
    },
    {
      title: '上游商品编码',
      dataIndex: 'productCode',
      key: 'productCode',
      width: 190,
      render: (productCode: string) => <Text code>{productCode}</Text>,
    },
    {
      title: '商品名称',
      key: 'name',
      width: 180,
      render: () => (
        <Tooltip title="列表接口未提供可靠名称；选中商品后通过只读详情读取">
          <Text type="secondary">尚未获取</Text>
        </Tooltip>
      ),
    },
    {
      title: '可用状态',
      key: 'availability',
      width: 112,
      render: () => (
        <Tooltip title="上游列表未提供已核实的可售状态；不从 goodsStatus 猜测">
          <Tag>待核实</Tag>
        </Tooltip>
      ),
    },
    {
      title: '供应商报价',
      dataIndex: 'sellPriceCents',
      key: 'sellPriceCents',
      width: 132,
      align: 'right',
      className: 'catalog-amount',
      render: (cents: number) => formatCents(cents),
    },
    {
      title: '获取时间',
      key: 'observedAt',
      width: 210,
      render: () => (
        <Text type="secondary">
          {listQuery.data ? formatObservedAt(listQuery.data.observedAt) : '—'}
        </Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 116,
      fixed: 'right',
      render: (_, product) => (
        <Button
          type="link"
          size="small"
          icon={<Eye size={14} />}
          onClick={() => setSelectedCode(product.productCode)}
        >
          查看详情
        </Button>
      ),
    },
  ];

  const errorCopy = listQuery.isError ? supplierErrorCopy(listQuery.error) : null;

  return (
    <section className="catalog-surface" aria-label="供应商商品列表">
      <div className="catalog-supplier-banner">
        <Space size={8} wrap>
          <Tag color="blue">{`供货方：${SUPPLIER_DISPLAY_NAME}`}</Tag>
          <Text type="secondary">{`Provider: ${SUPPLIER_PROVIDER_KEY}`}</Text>
          <Tag>只读来源目录</Tag>
        </Space>
        <Text type="secondary">
          目录展示上力返回的商品编码与报价；选中单品后可查询名称等详情。
        </Text>
      </div>

      <Form<FilterFormValues>
        form={filterForm}
        className="catalog-toolbar"
        layout="inline"
        initialValues={{ supplierKeyword: appliedKeyword }}
        onFinish={applyFilters}
      >
        <Form.Item name="supplierKeyword" label="上游商品编码">
          <Input allowClear placeholder="输入上游 productCode" style={{ width: 240 }} />
        </Form.Item>
        <Form.Item>
          <Space size={8} wrap>
            <Button type="primary" htmlType="submit" icon={<Search size={14} />}>
              查询
            </Button>
            <Button onClick={resetFilters} icon={<RotateCcw size={14} />}>
              重置
            </Button>
            <Button
              onClick={refresh}
              icon={<RefreshCw size={14} />}
              loading={listQuery.isFetching}
            >
              刷新目录
            </Button>
          </Space>
        </Form.Item>
        <Form.Item label="视图">
          <Segmented
            value={supplierView}
            onChange={(value) => setSupplierView(value as CatalogViewMode)}
            options={[
              { label: '表格', value: 'table' },
              { label: '卡片', value: 'card' },
            ]}
          />
        </Form.Item>
      </Form>

      {errorCopy ? (
        <div className="catalog-feedback">
          <Alert
            type={errorCopy.type}
            showIcon
            title={errorCopy.title}
            description={errorCopy.description}
            action={
              <Button size="small" loading={listQuery.isFetching} onClick={refresh}>
                重试
              </Button>
            }
          />
        </div>
      ) : supplierView === 'table' ? (
        <Table<SupplierCatalogProduct>
          rowKey="productCode"
          size="middle"
          columns={columns}
          dataSource={filteredProducts}
          loading={listQuery.isPending || listQuery.isFetching}
          locale={{ emptyText: listQuery.isPending ? null : emptyText }}
          scroll={{ x: 1080 }}
          pagination={{
            current: currentPage,
            pageSize,
            total: filteredProducts.length,
            pageSizeOptions: PAGE_SIZE_OPTIONS,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条`,
            onChange: changePage,
          }}
        />
      ) : (
        <Spin spinning={listQuery.isFetching && !listQuery.isPending}>
          {listQuery.isPending ? (
            <div className="catalog-feedback">
              <Spin />
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="catalog-feedback">{emptyText}</div>
          ) : (
            <>
              <Row gutter={[16, 16]} className="catalog-card-grid">
                {filteredProducts
                  .slice((currentPage - 1) * pageSize, currentPage * pageSize)
                  .map((product) => (
                    <Col key={product.productCode} xs={24} sm={12} xl={8} xxl={6}>
                      <Card
                        size="small"
                        title={<Text code>{product.productCode}</Text>}
                        extra={<Tag color="blue">{SUPPLIER_DISPLAY_NAME}</Tag>}
                        actions={[
                          <Button
                            key="view"
                            type="link"
                            size="small"
                            onClick={() => setSelectedCode(product.productCode)}
                          >
                            查看详情
                          </Button>,
                        ]}
                      >
                        <Space orientation="vertical" size={6}>
                          <Text type="secondary">商品名称：尚未获取（选中后读取）</Text>
                          <Space size={6} wrap>
                            <Text type="secondary">可用状态：</Text>
                            <Tag>待核实</Tag>
                          </Space>
                          <Text strong>{formatCents(product.sellPriceCents)}</Text>
                          <Text type="secondary">
                            获取时间：
                            {listQuery.data ? formatObservedAt(listQuery.data.observedAt) : '—'}
                          </Text>
                        </Space>
                      </Card>
                    </Col>
                  ))}
              </Row>
              <div className="catalog-card-pagination">
                <Pagination
                  current={currentPage}
                  pageSize={pageSize}
                  total={filteredProducts.length}
                  pageSizeOptions={PAGE_SIZE_OPTIONS}
                  showSizeChanger
                  showTotal={(total) => `共 ${total} 条`}
                  onChange={changePage}
                />
              </div>
            </>
          )}
        </Spin>
      )}

      <SupplierProductDrawer productCode={selectedCode} onClose={() => setSelectedCode(null)} />
    </section>
  );
}
