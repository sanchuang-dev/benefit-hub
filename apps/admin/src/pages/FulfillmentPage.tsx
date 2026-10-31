import {
  Alert,
  Button,
  DatePicker,
  Empty,
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
import { Eye, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  OPERATIONS_ORDER_PAGE_SIZES,
  ORDER_STATUSES,
  type OperationsOrderListItemDto,
  type OrderStatus,
} from '@sanchuang-dev/benefit-contracts';
import { ApiError } from '../shared/lib/api-client';
import { formatDateTime } from '../shared/lib/format-date-time';
import { beijingDayRange, type CalendarDay } from '../features/fulfillment/date-range';
import { ORDER_STATUS_COLORS, ORDER_STATUS_LABELS } from '../features/fulfillment/labels';
import { OrderDetailDrawer } from '../features/fulfillment/OrderDetailDrawer';
import { useOrdersQuery } from '../features/fulfillment/use-orders';
import './FulfillmentPage.css';

const { Title, Paragraph, Text } = Typography;

type StatusFilter = OrderStatus | 'all';

interface FilterFormValues {
  businessSource?: string;
  businessOrderNo?: string;
  status: StatusFilter;
  createdRange?: [CalendarDay | null, CalendarDay | null] | null;
}

interface AppliedFilters {
  businessSource: string;
  businessOrderNo: string;
  status: StatusFilter;
  createdFrom: number | null;
  createdTo: number | null;
}

const EMPTY_FILTERS: AppliedFilters = {
  businessSource: '',
  businessOrderNo: '',
  status: 'all',
  createdFrom: null,
  createdTo: null,
};

/**
 * The cockpit deep-links here with a single platform status. Only a known
 * status value is honoured; anything else falls back to the unfiltered list
 * instead of a filter the operator cannot see.
 */
function readStatusParam(raw: string | null): StatusFilter {
  return raw !== null && (ORDER_STATUSES as readonly string[]).includes(raw)
    ? (raw as OrderStatus)
    : 'all';
}

function statusTag(status: OrderStatus) {
  const tag = <Tag color={ORDER_STATUS_COLORS[status]}>{ORDER_STATUS_LABELS[status]}</Tag>;
  if (status === 'pending') {
    return <Tooltip title="平台本地待处理，不代表供应商已受理或权益已到账">{tag}</Tooltip>;
  }
  if (status === 'unknown') {
    return <Tooltip title="上游结果尚未核实，不能判定为成功或失败">{tag}</Tooltip>;
  }
  return tag;
}

function listErrorCopy(error: Error): { type: 'error' | 'warning'; title: string; description: string } {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return {
        type: 'error',
        title: '登录状态已失效',
        description: '请刷新页面并重新登录后再加载订单记录。',
      };
    }
    return {
      type: 'error',
      title: '平台订单加载失败',
      description: error.message,
    };
  }
  return {
    type: 'error',
    title: '平台订单加载失败',
    description: '请求失败，请稍后重试。',
  };
}

/**
 * Platform-local order operations view (BHB-013-B1).
 *
 * The list is entirely server-paged and server-filtered across every business
 * source. It shows only what SQLite actually stored: the platform status, the
 * frozen fulfillment mode, and the current internal product name. It never
 * implies that a `pending` intent reached, was accepted by, or was paid out by
 * any supplier.
 */
export function FulfillmentPage() {
  // The overview page deep-links into one status bucket. The URL is only an
  // entry hint: applying the form still owns the applied filters afterwards.
  const [searchParams] = useSearchParams();
  const statusParam = searchParams.get('status');
  const initialStatus = readStatusParam(statusParam);
  const [filterForm] = Form.useForm<FilterFormValues>();
  const [filters, setFilters] = useState<AppliedFilters>(() => ({
    ...EMPTY_FILTERS,
    status: initialStatus,
  }));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  const listQuery = useOrdersQuery({
    page,
    pageSize,
    businessSource: filters.businessSource || undefined,
    businessOrderNo: filters.businessOrderNo || undefined,
    status: filters.status === 'all' ? undefined : filters.status,
    createdFrom: filters.createdFrom ?? undefined,
    createdTo: filters.createdTo ?? undefined,
  });

  const orders = listQuery.data?.orders ?? [];
  const total = listQuery.data?.total ?? 0;
  const hasFilters =
    filters.businessSource !== '' ||
    filters.businessOrderNo !== '' ||
    filters.status !== 'all' ||
    filters.createdFrom !== null ||
    filters.createdTo !== null;

  // Keep the visible filter form in sync when the cockpit link changes the
  // status while this page is already mounted under a work tab.
  useEffect(() => {
    const nextStatus = readStatusParam(statusParam);
    setFilters((current) =>
      current.status === nextStatus ? current : { ...current, status: nextStatus },
    );
    filterForm.setFieldValue('status', nextStatus);
    setPage(1);
  }, [filterForm, statusParam]);

  const applyFilters = (values: FilterFormValues) => {
    const [startDay, endDay] = values.createdRange ?? [];
    setFilters({
      businessSource: values.businessSource?.trim().toLowerCase() ?? '',
      businessOrderNo: values.businessOrderNo?.trim() ?? '',
      status: values.status ?? 'all',
      createdFrom: startDay ? beijingDayRange(startDay).start : null,
      createdTo: endDay ? beijingDayRange(endDay).end : null,
    });
    setPage(1);
  };

  const resetFilters = () => {
    filterForm.resetFields();
    setFilters(EMPTY_FILTERS);
    setPage(1);
  };

  const refresh = () => {
    void listQuery.refetch();
  };

  const columns: ColumnsType<OperationsOrderListItemDto> = [
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 196,
      render: (createdAt: number) => <Text type="secondary">{formatDateTime(createdAt)}</Text>,
    },
    {
      title: '业务来源',
      dataIndex: 'businessSource',
      key: 'businessSource',
      width: 108,
      render: (businessSource: string) => <Tag>{businessSource}</Tag>,
    },
    {
      title: '业务订单号',
      dataIndex: 'businessOrderNo',
      key: 'businessOrderNo',
      width: 190,
      ellipsis: true,
      render: (businessOrderNo: string) => <Text code>{businessOrderNo}</Text>,
    },
    {
      title: (
        <Tooltip title="内部商品当前名称，不是下单时的历史快照">
          <span>当前商品</span>
        </Tooltip>
      ),
      dataIndex: 'productName',
      key: 'productName',
      width: 198,
      render: (productName: string, order) => (
        <Space orientation="vertical" size={0}>
          <Text ellipsis={{ tooltip: productName }}>{productName}</Text>
          <Tooltip title={order.productId}>
            <Text type="secondary">{`ID ${order.productId.slice(0, 8)}…`}</Text>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: '平台状态',
      dataIndex: 'status',
      key: 'status',
      width: 128,
      render: (status: OrderStatus) => statusTag(status),
    },
    {
      title: (
        <Tooltip title="订单创建时冻结的履约模式；历史订单无冻结映射时供应商归属未知">
          <span>履约模式</span>
        </Tooltip>
      ),
      dataIndex: 'fulfillmentMode',
      key: 'fulfillmentMode',
      width: 138,
      render: (mode: OperationsOrderListItemDto['fulfillmentMode'], order) => (
        <Space size={6} wrap={false}>
          <Tag>{mode}</Tag>
          {order.mappingVersionId === null ? (
            <Text type="secondary">无冻结映射</Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      width: 64,
      render: (version: number) => <Text type="secondary">{`v${version}`}</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 88,
      fixed: 'right',
      render: (_, order) => (
        <Button
          type="link"
          size="small"
          icon={<Eye size={14} />}
          onClick={() => setSelectedOrderId(order.id)}
        >
          查看
        </Button>
      ),
    },
  ];

  const emptyText = hasFilters ? (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的订单">
      <Button onClick={resetFilters}>清除筛选</Button>
    </Empty>
  ) : (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description="平台还没有订单。下游业务系统通过订单受理接口创建后，会在这里以「待处理」出现。"
    />
  );

  const errorCopy = listQuery.isError ? listErrorCopy(listQuery.error) : null;

  return (
    <div className="page">
      <header className="page-header fulfillment-header">
        <div>
          <Title level={2}>业务订单</Title>
          <Paragraph type="secondary">
            查看平台订单、冻结履约来源和状态记录。
          </Paragraph>
        </div>
        <Tag color="blue">只读</Tag>
      </header>

      <Space orientation="vertical" size={12} className="page-stack">
        <Alert
          type="info"
          showIcon
          title="订单记录说明"
          description="「待处理」表示订单已记录，供应商是否受理、扣额和到账以对应的履约记录为准。"
        />

        <section className="fulfillment-surface" aria-label="平台订单列表">
          <Form<FilterFormValues>
            form={filterForm}
            className="fulfillment-toolbar"
            layout="inline"
            initialValues={{
              businessSource: '',
              businessOrderNo: '',
              status: initialStatus,
              createdRange: null,
            }}
            onFinish={applyFilters}
          >
            <Form.Item name="businessSource" label="业务来源">
              <Input allowClear placeholder="精确来源，如 local-life" style={{ width: 190 }} />
            </Form.Item>
            <Form.Item name="businessOrderNo" label="业务订单号">
              <Input allowClear placeholder="精确单号" style={{ width: 200 }} />
            </Form.Item>
            <Form.Item name="status" label="平台状态">
              <Select
                style={{ width: 168 }}
                options={[
                  { value: 'all', label: '全部状态' },
                  ...ORDER_STATUSES.map((status) => ({
                    value: status,
                    label: ORDER_STATUS_LABELS[status],
                  })),
                ]}
              />
            </Form.Item>
            <Form.Item name="createdRange" label="创建时间（北京时间）" className="fulfillment-date-range">
              <DatePicker.RangePicker
                allowEmpty={[true, true]}
                placeholder={['开始日期', '结束日期']}
              />
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
                  刷新
                </Button>
              </Space>
            </Form.Item>
          </Form>

          {errorCopy ? (
            <div className="fulfillment-feedback">
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
          ) : (
            <Table<OperationsOrderListItemDto>
              rowKey="id"
              size="middle"
              columns={columns}
              dataSource={orders}
              loading={listQuery.isPending || listQuery.isFetching}
              locale={{ emptyText: listQuery.isPending ? null : emptyText }}
              scroll={{ x: 1110 }}
              pagination={{
                current: page,
                pageSize,
                total,
                pageSizeOptions: [...OPERATIONS_ORDER_PAGE_SIZES],
                showSizeChanger: true,
                showTotal: (value) => `共 ${value} 条`,
                onChange: (nextPage, nextPageSize) => {
                  setPage(nextPage);
                  setPageSize(nextPageSize);
                },
              }}
            />
          )}
        </section>
      </Space>

      <OrderDetailDrawer orderId={selectedOrderId} onClose={() => setSelectedOrderId(null)} />
    </div>
  );
}
