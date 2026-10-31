import { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Grid,
  Input,
  Modal,
  message,
  Skeleton,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type {
  OperationsOrderAttemptDto,
  OrderStatus,
} from '@sanchuang-dev/benefit-contracts';
import { ApiError } from '../../shared/lib/api-client';
import { formatDateTime } from '../../shared/lib/format-date-time';
import {
  ATTEMPT_OPERATION_LABELS,
  ATTEMPT_RESULT_COLORS,
  ATTEMPT_RESULT_LABELS,
  GIFT_VOUCHER_STATE_COLORS,
  GIFT_VOUCHER_STATE_LABELS,
  ORDER_STATUS_COLORS,
  ORDER_STATUS_LABELS,
  PREPAID_GRANT_STATE_COLORS,
  PREPAID_GRANT_STATE_LABELS,
  providerLabel,
} from './labels';
import { useOrderDetailQuery } from './use-orders';
import { useSessionQuery } from '../auth/use-auth';
import {
  dispatchDOrder,
  grantAPrepaidOrder,
  recoverAPrepaidOrder,
  recoverDOrder,
  reissueDirectTopup,
} from './api';

const { Text, Title } = Typography;

const TIMELINE_COLORS: Record<OrderStatus, string> = {
  pending: 'gray',
  processing: 'blue',
  awaiting_claim: 'orange',
  partially_completed: 'orange',
  completed: 'green',
  failed: 'red',
  unknown: 'magenta',
};

function detailErrorCopy(error: Error): { title: string; description: string } {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return {
        title: '登录状态已失效',
        description: '请刷新页面并重新登录后再查看订单详情。',
      };
    }
    if (error.status === 404) {
      return {
        title: '订单不存在',
        description: '没有找到该平台订单，可能已被移除或链接不正确。',
      };
    }
    return { title: '订单详情加载失败', description: error.message };
  }
  return { title: '订单详情加载失败', description: '请求失败，请稍后重试。' };
}

function AttemptsTable({ attempts }: { attempts: OperationsOrderAttemptDto[] }) {
  const columns: ColumnsType<OperationsOrderAttemptDto> = [
    {
      title: '操作类别',
      dataIndex: 'operation',
      key: 'operation',
      width: 100,
      render: (operation: OperationsOrderAttemptDto['operation']) =>
        ATTEMPT_OPERATION_LABELS[operation],
    },
    {
      title: '本地结果',
      dataIndex: 'result',
      key: 'result',
      width: 124,
      render: (result: OperationsOrderAttemptDto['result']) => (
        <Tag color={ATTEMPT_RESULT_COLORS[result]}>{ATTEMPT_RESULT_LABELS[result]}</Tag>
      ),
    },
    {
      title: '观察到的平台状态',
      dataIndex: 'observedStatus',
      key: 'observedStatus',
      width: 132,
      render: (status: OrderStatus | null) =>
        status === null ? (
          <Text type="secondary">未记录</Text>
        ) : (
          <Tag color={ORDER_STATUS_COLORS[status]}>{ORDER_STATUS_LABELS[status]}</Tag>
        ),
    },
    {
      title: '发生时间',
      dataIndex: 'occurredAt',
      key: 'occurredAt',
      width: 196,
      render: (occurredAt: number) => <Text type="secondary">{formatDateTime(occurredAt)}</Text>,
    },
    {
      title: '最近核实时间',
      dataIndex: 'lastVerifiedAt',
      key: 'lastVerifiedAt',
      width: 196,
      render: (lastVerifiedAt: number | null) =>
        lastVerifiedAt === null ? (
          <Text type="secondary">未核实</Text>
        ) : (
          <Text type="secondary">{formatDateTime(lastVerifiedAt)}</Text>
        ),
    },
    {
      title: '上游请求号',
      dataIndex: 'upstreamRequestNo',
      key: 'upstreamRequestNo',
      width: 180,
      ellipsis: true,
      render: (value: string | null) =>
        value === null ? <Text type="secondary">—</Text> : <Text code>{value}</Text>,
    },
    {
      title: '上游订单号',
      dataIndex: 'upstreamOrderNo',
      key: 'upstreamOrderNo',
      width: 180,
      ellipsis: true,
      render: (value: string | null) =>
        value === null ? <Text type="secondary">—</Text> : <Text code>{value}</Text>,
    },
  ];

  return (
    <Table<OperationsOrderAttemptDto>
      rowKey="id"
      size="small"
      bordered
      columns={columns}
      dataSource={attempts}
      pagination={false}
      scroll={{ x: 1100 }}
    />
  );
}

/**
 * Read-only order detail. The three groups keep facts separate: what the
 * platform stored, which immutable supplier mapping was frozen at creation, and
 * which local status/attempt rows exist. Nothing here invents a provider-native
 * status, a deduction, or a delivery result.
 */
export function OrderDetailDrawer({
  orderId,
  onClose,
}: {
  orderId: string | null;
  onClose: () => void;
}) {
  const screens = Grid.useBreakpoint();
  const session = useSessionQuery();
  const [form] = Form.useForm<{
    phone: string;
    refCode: string;
    paymentReference: string;
  }>();
  const [aForm] = Form.useForm<{
    phone: string;
    refCode: string;
    paymentReference: string;
    confirmPackDebit: boolean;
  }>();
  const [dForm] = Form.useForm<{
    mobile: string;
    paymentReference: string;
    confirmDebit: boolean;
  }>();
  const [messageApi, contextHolder] = message.useMessage();
  const [reissueOpen, setReissueOpen] = useState(false);
  const [reissuePending, setReissuePending] = useState(false);
  const [aGrantOpen, setAGrantOpen] = useState(false);
  const [aGrantPending, setAGrantPending] = useState(false);
  const [aRecoverPending, setARecoverPending] = useState(false);
  const [aClaimUrl, setAClaimUrl] = useState<string | null>(null);
  const [dDispatchOpen, setDDispatchOpen] = useState(false);
  const [dDispatchPending, setDDispatchPending] = useState(false);
  const [dRecoverPending, setDRecoverPending] = useState(false);
  const detailQuery = useOrderDetailQuery(orderId);
  const errorCopy = detailQuery.isError ? detailErrorCopy(detailQuery.error) : null;
  const detail = detailQuery.data;

  async function handleReissue() {
    if (!orderId) return;
    let fields: { phone: string; refCode: string; paymentReference: string };
    try {
      fields = await form.validateFields();
    } catch {
      return;
    }
    setReissuePending(true);
    try {
      await reissueDirectTopup(orderId, fields);
      messageApi.success('上力 B 原单补发已收到可验证结果');
      form.resetFields();
      setReissueOpen(false);
      void detailQuery.refetch();
    } catch (error) {
      messageApi.error(error instanceof ApiError
        ? error.message
        : '补发结果未能确认，请检查订单最新状态，切勿再次盲目发券');
      void detailQuery.refetch();
    } finally {
      setReissuePending(false);
    }
  }


  async function handleAGrant() {
    if (!orderId) return;
    let fields: {
      phone: string;
      refCode: string;
      paymentReference: string;
      confirmPackDebit: boolean;
    };
    try {
      fields = await aForm.validateFields();
    } catch {
      return;
    }

    setAGrantPending(true);
    try {
      const result = await grantAPrepaidOrder(orderId, {
        phone: fields.phone,
        refCode: fields.refCode,
        paymentReference: fields.paymentReference,
      });
      setAClaimUrl(result.claimUrl ?? null);
      messageApi.success(
        result.claimUrl
          ? 'A 真实下单已受理，并返回领取链接'
          : 'A 下单已返回结果，请继续按原 requestId 核实领取链接',
      );
      aForm.resetFields();
      setAGrantOpen(false);
      void detailQuery.refetch();
    } catch (error) {
      messageApi.error(
        error instanceof ApiError
          ? error.message
          : 'A 下单结果未能确认。请刷新订单并按原 requestId 恢复，切勿再次下单。',
      );
      void detailQuery.refetch();
    } finally {
      setAGrantPending(false);
    }
  }

  async function handleARecover() {
    if (!orderId) return;
    setARecoverPending(true);
    try {
      const result = await recoverAPrepaidOrder(orderId);
      setAClaimUrl(result.claimUrl ?? null);
      messageApi.success(
        result.claimUrl ? '已按原 requestId 恢复领取链接' : '已按原 requestId 查询上力',
      );
    } catch (error) {
      messageApi.error(
        error instanceof ApiError ? error.message : 'A 原单恢复失败，请稍后重试',
      );
    } finally {
      setARecoverPending(false);
      void detailQuery.refetch();
    }
  }

  async function handleDDispatch() {
    if (!orderId) return;
    let fields: { mobile: string; paymentReference: string; confirmDebit: boolean };
    try {
      fields = await dForm.validateFields();
    } catch {
      return;
    }
    setDDispatchPending(true);
    try {
      await dispatchDOrder(orderId, {
        mobile: fields.mobile,
        paymentReference: fields.paymentReference,
      });
      messageApi.success('D 真实派发已发起；请继续使用“查原单”核实供应商状态');
      dForm.resetFields();
      setDDispatchOpen(false);
      void detailQuery.refetch();
    } catch (error) {
      messageApi.error(
        error instanceof ApiError
          ? error.message
          : 'D 派发结果未能确认。请刷新订单并查原单，切勿再次派发。',
      );
      void detailQuery.refetch();
    } finally {
      setDDispatchPending(false);
    }
  }

  async function handleDRecover() {
    if (!orderId) return;
    setDRecoverPending(true);
    try {
      await recoverDOrder(orderId);
      messageApi.success('已按原 partnerOrderNo 查询上力');
    } catch (error) {
      messageApi.error(
        error instanceof ApiError ? error.message : '原单查单失败，请稍后重试',
      );
    } finally {
      setDRecoverPending(false);
      void detailQuery.refetch();
    }
  }

  return (
    <>
      {contextHolder}
      <Drawer
      open={Boolean(orderId)}
      onClose={onClose}
      title="平台订单详情"
      size={screens.md ? 680 : '100%'}
      destroyOnHidden
      className="fulfillment-detail-drawer"
    >
      {!orderId ? null : detailQuery.isPending ? (
        <Skeleton active title={{ width: '50%' }} paragraph={{ rows: 8 }} />
      ) : errorCopy ? (
        <Alert
          type="error"
          showIcon
          title={errorCopy.title}
          description={errorCopy.description}
          action={
            <Button
              size="small"
              loading={detailQuery.isFetching}
              onClick={() => void detailQuery.refetch()}
            >
              重试
            </Button>
          }
        />
      ) : detail ? (
        <Space orientation="vertical" size={20} className="fulfillment-detail">
          <Alert
            type="info"
            showIcon
            title="订单记录说明"
            description="订单状态来自本平台持久化记录；供应商受理、扣额或到账应以对应的上游核实结果为准。"
          />

          <Descriptions
            title="平台订单"
            size="small"
            column={1}
            bordered
            items={[
              {
                key: 'id',
                label: '平台订单 ID',
                children: <Text code copyable>{detail.id}</Text>,
              },
              {
                key: 'businessSource',
                label: '业务来源',
                children: <Tag>{detail.businessSource}</Tag>,
              },
              {
                key: 'businessOrderNo',
                label: '业务订单号',
                children: (
                  <Space size={8} wrap>
                    <Text code copyable>
                      {detail.businessOrderNo}
                    </Text>
                    <Text type="secondary">业务方提供，大小写保留</Text>
                  </Space>
                ),
              },
              {
                key: 'product',
                label: '内部商品',
                children: (
                  <Space orientation="vertical" size={2}>
                    <Text strong>{detail.product.name}</Text>
                    <Text type="secondary">
                      当前名称，不是下单时的历史快照；商品编码 {detail.product.code}
                    </Text>
                    <Text type="secondary">
                      {`商品 ID：${detail.productId}（当前状态：${
                        detail.product.status === 'active' ? '已启用' : '已停用'
                      }）`}
                    </Text>
                  </Space>
                ),
              },
              {
                key: 'status',
                label: '平台状态',
                children: (
                  <Space orientation="vertical" size={2}>
                    <Tag color={ORDER_STATUS_COLORS[detail.status]}>
                      {ORDER_STATUS_LABELS[detail.status]}
                    </Tag>
                    <Text type="secondary">
                      平台统一状态，不代表供应商已受理或权益已到账
                    </Text>
                  </Space>
                ),
              },
              { key: 'version', label: '订单版本', children: `v${detail.version}` },
              {
                key: 'createdAt',
                label: '创建时间',
                children: formatDateTime(detail.createdAt),
              },
              {
                key: 'updatedAt',
                label: '更新时间',
                children: formatDateTime(detail.updatedAt),
              },
            ]}
          />

          <section aria-label="履约来源">
            <Title level={5}>履约来源</Title>
            {detail.frozenMapping ? (
              <Space orientation="vertical" size={8} className="fulfillment-detail">
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
                          <Tag color="blue">{providerLabel(detail.frozenMapping.provider)}</Tag>
                          <Text type="secondary">
                            {`Provider: ${detail.frozenMapping.provider}`}
                          </Text>
                        </Space>
                      ),
                    },
                    {
                      key: 'productCode',
                      label: '上游商品编码',
                      children: <Text code copyable>{detail.frozenMapping.productCode}</Text>,
                    },
                    {
                      key: 'mode',
                      label: '履约模式（冻结）',
                      children: `${providerLabel(detail.frozenMapping.provider)}模式 ${
                        detail.frozenMapping.fulfillmentMode
                      }`,
                    },
                    {
                      key: 'deductionUnit',
                      label: '扣减单位（冻结）',
                      children:
                        detail.frozenMapping.deductionUnit === 'pack'
                          ? 'pack（礼包 / 次数）'
                          : 'amount（金额）',
                    },
                    {
                      key: 'version',
                      label: '冻结映射版本',
                      children: (
                        <Space orientation="vertical" size={2}>
                          <Text>{`v${detail.frozenMapping.versionNumber}`}</Text>
                          <Text type="secondary">{`映射 ID：${detail.frozenMapping.id}`}</Text>
                        </Space>
                      ),
                    },
                    {
                      key: 'activatedAt',
                      label: '映射激活时间',
                      children: formatDateTime(detail.frozenMapping.activatedAt),
                    },
                  ]}
                />
                <Text type="secondary">
                  以上来自下单时冻结的不可变映射快照；商品当前映射变化不会改写本订单的履约来源。
                </Text>
              </Space>
            ) : (
              <Alert
                type="warning"
                showIcon
                title="无冻结映射（历史订单）"
                description="该订单创建于映射版本机制启用之前，平台没有可核实的历史供应商或上游商品，也不会用当前映射猜测补齐。"
              />
            )}
          </section>

          {detail.fulfillmentMode === 'A' ? (
            <section aria-label="上力 A 预充值下单">
              <Title level={5}>上力 A 预充值下单</Title>
              {detail.grant ? (
                <Space orientation="vertical" size={8} className="fulfillment-detail">
                  <Descriptions
                    size="small"
                    column={1}
                    bordered
                    items={[
                      {
                        key: 'grantState',
                        label: '上力下单记录',
                        children: (
                          <Space orientation="vertical" size={2}>
                            <Tag color={PREPAID_GRANT_STATE_COLORS[detail.grant.state]}>
                              {PREPAID_GRANT_STATE_LABELS[detail.grant.state]}
                            </Tag>
                            <Text type="secondary">
                              「已受理」表示上力创建了 H5 订单并扣减礼包额度，不代表用户已领取到账。
                            </Text>
                          </Space>
                        ),
                      },
                      {
                        key: 'requestId',
                        label: '上游请求号（幂等键）',
                        children: <Text code copyable>{detail.grant.requestId}</Text>,
                      },
                      {
                        key: 'upstreamOrderNo',
                        label: '上游订单号',
                        children:
                          detail.grant.upstreamOrderNo === null ? (
                            <Text type="secondary">—</Text>
                          ) : (
                            <Text code copyable>{detail.grant.upstreamOrderNo}</Text>
                          ),
                      },
                      {
                        key: 'attemptedAt',
                        label: '发起时间',
                        children: formatDateTime(detail.grant.attemptedAt),
                      },
                      {
                        key: 'grantUpdatedAt',
                        label: '最近结果时间',
                        children: formatDateTime(detail.grant.updatedAt),
                      },
                    ]}
                  />
                  {aClaimUrl ? (
                    <Alert
                      type="success"
                      showIcon
                      title="本次调用拿到了领取链接"
                      description={
                        <Space orientation="vertical" size={4}>
                          <Text code copyable={{ text: aClaimUrl }}>{aClaimUrl}</Text>
                          <Button type="link" href={aClaimUrl} target="_blank" rel="noreferrer">
                            打开领取链接
                          </Button>
                        </Space>
                      }
                    />
                  ) : null}
                  {session.data?.admin.role === 'admin' &&
                  detail.grant.state !== 'rejected' ? (
                    <Button
                      onClick={() => void handleARecover()}
                      loading={aRecoverPending}
                    >
                      恢复原领取链接（同一 requestId）
                    </Button>
                  ) : null}
                  <Alert
                    type="info"
                    showIcon
                    title="领取链接不落库"
                    description="平台不持久化 claimUrl，也不会自动重发下单。后续只能使用同一个 requestId 查原单恢复链接；生成链接不等于用户已领取到账。"
                  />
                </Space>
              ) : (
                <Space orientation="vertical" size={8} className="fulfillment-detail">
                  <Alert
                    type="info"
                    showIcon
                    title="尚未发起上力下单"
                    description="平台只记录本地业务意图，不会自动扣减礼包额度。真实下单必须由维护者临时开启 A 写权限，并使用平台生成的唯一 requestId。"
                  />
                  {session.data?.admin.role === 'admin' ? (
                    <Button
                      type="primary"
                      danger
                      onClick={() => setAGrantOpen(true)}
                    >
                      管理员真实下单一次
                    </Button>
                  ) : null}
                </Space>
              )}
            </section>
          ) : null}

          {detail.fulfillmentMode === 'B' && detail.frozenMapping ? (
            <section aria-label="上力 B 直充履约">
              <Title level={5}>上力 B · 纯腾讯出行礼包直充</Title>
              {detail.directTopup ? (
                <Space orientation="vertical" size={8} className="fulfillment-detail">
                  <Descriptions size="small" column={1} bordered items={[
                    {
                      key: 'topupState', label: '实际直充状态',
                      children: (
                        <Space size={8} wrap>
                          <Tag color={
                            detail.directTopup.state === 'completed' ? 'success' :
                            detail.directTopup.state === 'partial' ? 'warning' :
                            detail.directTopup.state === 'rejected' ? 'error' : 'default'
                          }>
                            {({
                              reserved: '已预留，供应商结果待核实',
                              retrying: '原单补发正在执行',
                              unknown: '供应商结果未知',
                              partial: '部分券已发放',
                              completed: '供应商报告全部发放',
                              rejected: '供应商已拒绝',
                            } as const)[detail.directTopup.state]}
                          </Tag>
                          <Text type="secondary">B 模式没有 H5 领取链接</Text>
                        </Space>
                      ),
                    },
                    {
                      key: 'topupRequestId', label: '原始请求号（幂等键）',
                      children: <Text code copyable>{detail.directTopup.requestId}</Text>,
                    },
                    {
                      key: 'topupOrderNo', label: '上游订单号',
                      children: detail.directTopup.upstreamOrderNo === null
                        ? <Text type="secondary">待核实</Text>
                        : <Text code copyable>{detail.directTopup.upstreamOrderNo}</Text>,
                    },
                    {
                      key: 'topupCounts', label: '发券成功数 / 总数',
                      children: detail.directTopup.successCount === null ||
                        detail.directTopup.totalCount === null
                        ? <Text type="secondary">尚无可信结果</Text>
                        : <Text>{detail.directTopup.successCount} / {detail.directTopup.totalCount}</Text>,
                    },
                    {
                      key: 'topupVerifiedAt', label: '最近供应商结果时间',
                      children: detail.directTopup.lastVerifiedAt === null
                        ? <Text type="secondary">尚未核实</Text>
                        : formatDateTime(detail.directTopup.lastVerifiedAt),
                    },
                    {
                      key: 'topupUpdatedAt', label: '平台最近更新',
                      children: formatDateTime(detail.directTopup.updatedAt),
                    },
                  ]} />
                  {detail.directTopup.observations.length > 0 ? (
                    <section aria-label="原单逐次供应商观察记录">
                      <Title level={5}>原单逐次观察记录</Title>
                      <Text type="secondary">
                        每次供应商答复均独立保存。后次补发只返回部分条目时，
                        不覆盖以前确认成功的证据；缺少稳定券项 ID，不能按表格行序号拼接同一张券。
                      </Text>
                      <Table
                        rowKey={(_, index) => String(index)}
                        size="small"
                        pagination={false}
                        dataSource={detail.directTopup.observations}
                        columns={[
                          { title: '核实时间', dataIndex: 'observedAt', key: 'time',
                            render: (value: number) => formatDateTime(value) },
                          { title: '动作', dataIndex: 'operation', key: 'operation',
                            render: (value: string) => value === 'reissue' ? '原单补发' : '首次直充' },
                          { title: '成功 / 总数', key: 'counts',
                            render: (_value, item) => item.successCount + ' / ' + item.totalCount },
                          { title: '本次返回条目', key: 'items',
                            render: (_value, item) => item.items.length + ' 条（仅本次观察）' },
                        ]}
                      />
                    </section>
                  ) : null}
                  {detail.directTopup.items.length > 0 ? (
                    <Table
                      size="small"
                      rowKey={(_, index) => String(index)}
                      pagination={false}
                      dataSource={detail.directTopup.items}
                      columns={[
                        { title: '返回条目', key: 'seq', render: (_value, _row, index) => index + 1 },
                        {
                          title: '发券结果', key: 'claimed',
                          render: (_value, item) => item.claimed === true
                            ? <Tag color="success">确认成功</Tag>
                            : item.claimed === false
                              ? <Tag color="error">确认失败</Tag>
                              : <Tag>未明确</Tag>,
                        },
                        {
                          title: '供应商状态（安全摘要）', dataIndex: 'status',
                          key: 'status', render: (status: string | undefined) => status ?? '未知',
                        },
                      ]}
                    />
                  ) : null}
                  {detail.directTopup.state === 'partial' && session.data?.admin.role === 'admin' ? (
                    <Button
                      danger
                      onClick={() => setReissueOpen(true)}
                    >
                      管理员受控补发（原 requestId）
                    </Button>
                  ) : null}
                  <Alert
                    type={detail.directTopup.state === 'partial' ||
                      detail.directTopup.state === 'unknown' ? 'warning' : 'info'}
                    showIcon
                    title={detail.directTopup.state === 'partial'
                      ? '存在部分失败，可按原单受控补发'
                      : detail.directTopup.state === 'unknown'
                        ? '结果未知，禁止盲目补发'
                        : '平台记录的供应商观察结果'}
                    description="以上是经过校验的供应商摘要。items 可能只包含部分返回条目，不能按条数推断总数。补发必须沿用原 requestId、核对收件手机号与支付凭据，并且需要维护者明确开启扣额写权限；本页面不会自动执行。"
                  />
                </Space>
              ) : (
                <Alert
                  type="info"
                  showIcon
                  title="尚无 B 模式直充记录"
                  description="本地订单并不等于已扣礼包或已到账。已授权业务方仍须完成服务端资格检查及独立的真实扣额授权。"
                />
              )}
            </section>
          ) : null}

          {detail.fulfillmentMode === 'C' ? (
            <section aria-label="上力 C 公众号礼包券">
              <Title level={5}>上力 C 公众号礼包券</Title>
              {detail.giftVoucher ? (
                <Space orientation="vertical" size={8} className="fulfillment-detail">
                  <Descriptions
                    size="small"
                    column={1}
                    bordered
                    items={[
                      {
                        key: 'giftVoucherState',
                        label: '上力发券记录',
                        children: (
                          <Space orientation="vertical" size={2}>
                            <Tag color={GIFT_VOUCHER_STATE_COLORS[detail.giftVoucher.state]}>
                              {GIFT_VOUCHER_STATE_LABELS[detail.giftVoucher.state]}
                            </Tag>
                            <Text type="secondary">
                              「已签发」表示上力已生成礼包券并在签发时预扣礼包额度，不代表领取人已兑换或领取。
                            </Text>
                          </Space>
                        ),
                      },
                      {
                        key: 'giftVoucherRequestId',
                        label: '上游请求号（幂等键）',
                        children: <Text code copyable>{detail.giftVoucher.requestId}</Text>,
                      },
                      {
                        key: 'packCount',
                        label: '本券礼包个数（签发预扣）',
                        children: `${detail.giftVoucher.packCount} 个`,
                      },
                      {
                        key: 'packTotal',
                        label: '供应商报告礼包总数',
                        children:
                          detail.giftVoucher.packTotal === null ? (
                            <Text type="secondary">—</Text>
                          ) : (
                            `${detail.giftVoucher.packTotal} 个`
                          ),
                      },
                      {
                        key: 'packRemaining',
                        label: '供应商报告剩余礼包',
                        children:
                          detail.giftVoucher.packRemaining === null ? (
                            <Text type="secondary">—</Text>
                          ) : (
                            `${detail.giftVoucher.packRemaining} 个`
                          ),
                      },
                      {
                        key: 'lastObservedAt',
                        label: '供应商最近观察时间',
                        children:
                          detail.giftVoucher.lastObservedAt === null ? (
                            <Text type="secondary">—</Text>
                          ) : (
                            formatDateTime(detail.giftVoucher.lastObservedAt)
                          ),
                      },
                      {
                        key: 'giftVoucherAttemptedAt',
                        label: '发起时间',
                        children: formatDateTime(detail.giftVoucher.attemptedAt),
                      },
                      {
                        key: 'giftVoucherUpdatedAt',
                        label: '最近结果时间',
                        children: formatDateTime(detail.giftVoucher.updatedAt),
                      },
                    ]}
                  />
                  <Alert
                    type="info"
                    showIcon
                    title="券码与领取链接受保护存储"
                    description="券码和 claimUrl 可能包含个人化参数，只加密保存在服务端，并由持有该业务凭证的调用方通过 C 发券或恢复接口取回；运营详情、日志与普通列表都不展示。剩余礼包数只反映供应商最近一次观察，平台不因券码查询不到或到期而推断额度退回。"
                  />
                </Space>
              ) : (
                <Alert
                  type="info"
                  showIcon
                  title="尚未发起上力发券"
                  description="平台只记录本地业务意图，不会自动签发礼包券或预扣额度。C 面向领取人免费，但供应商在签发时即预扣 packCount 个礼包额度，因此必须由业务方显式授权后调用 C 发券接口。"
                />
              )}
            </section>
          ) : null}

          {detail.fulfillmentMode === 'D' ? (
            <section aria-label="上力 D 权益派发">
              <Title level={5}>上力 D · 权益商品派发</Title>
              {detail.dispatch ? (
                <Space orientation="vertical" size={8} className="fulfillment-detail">
                  <Descriptions
                    size="small"
                    column={1}
                    bordered
                    items={[
                      {
                        key: 'dispatchState',
                        label: 'D 派发记录',
                        children: (
                          <Space orientation="vertical" size={2}>
                            <Tag color={
                              detail.dispatch.state === 'rejected'
                                ? 'error'
                                : detail.dispatch.state === 'unknown'
                                  ? 'warning'
                                  : detail.dispatch.state === 'accepted'
                                    ? 'processing'
                                    : 'default'
                            }>
                              {({
                                reserved: '已预留，供应商结果待核实',
                                accepted: '供应商已受理，继续核实履约状态',
                                unknown: '供应商结果未知，禁止重新派发',
                                rejected: '供应商已明确拒绝',
                              } as const)[detail.dispatch.state]}
                            </Tag>
                            <Text type="secondary">
                              D 模式 code=0 只表示上力受理，不代表权益已到账或订单已完成。
                            </Text>
                          </Space>
                        ),
                      },
                      {
                        key: 'partnerOrderNo',
                        label: '平台派发单号（幂等键）',
                        children: <Text code copyable>{detail.dispatch.partnerOrderNo}</Text>,
                      },
                      {
                        key: 'dispatchUpstreamOrderNo',
                        label: '上游订单号',
                        children: detail.dispatch.upstreamOrderNo === null
                          ? <Text type="secondary">尚未观察到</Text>
                          : <Text code copyable>{detail.dispatch.upstreamOrderNo}</Text>,
                      },
                      {
                        key: 'providerStatus',
                        label: '供应商原始状态',
                        children: detail.dispatch.providerStatus === null
                          ? <Text type="secondary">尚未核实</Text>
                          : <Tag>{detail.dispatch.providerStatus}</Tag>,
                      },
                      {
                        key: 'dispatchLastVerifiedAt',
                        label: '最近查单核实时间',
                        children: detail.dispatch.lastVerifiedAt === null
                          ? <Text type="secondary">尚未核实</Text>
                          : formatDateTime(detail.dispatch.lastVerifiedAt),
                      },
                      {
                        key: 'dispatchAttemptedAt',
                        label: '首次派发时间',
                        children: formatDateTime(detail.dispatch.attemptedAt),
                      },
                      {
                        key: 'dispatchUpdatedAt',
                        label: '平台最近更新',
                        children: formatDateTime(detail.dispatch.updatedAt),
                      },
                    ]}
                  />
                  {session.data?.admin.role === 'admin' &&
                  detail.dispatch.state !== 'rejected' ? (
                    <Button
                      onClick={() => void handleDRecover()}
                      loading={dRecoverPending}
                    >
                      查原单（同一 partnerOrderNo）
                    </Button>
                  ) : null}
                  <Alert
                    type={detail.dispatch.state === 'unknown' ? 'warning' : 'info'}
                    showIcon
                    title={
                      detail.dispatch.state === 'unknown'
                        ? '结果未知，只能查原单，禁止换单号重发'
                        : '这里只展示可安全核实的 D 履约摘要'
                    }
                    description="平台不在运营详情展示手机号、支付凭据、卡密或 fulfillmentSummary。当前尚未核定 D 完整终态集合，因此 RECEIVE 等供应商状态只按原值展示，不自动映射为“已完成”。"
                  />
                </Space>
              ) : (
                <Space orientation="vertical" size={8} className="fulfillment-detail">
                  <Alert
                    type="info"
                    showIcon
                    title="尚未发起 D 模式权益派发"
                    description="平台只有本地业务订单，不代表已扣上力权益金额。真实 D 派发必须由服务端明确开启写权限并沿用平台生成的唯一幂等单号。"
                  />
                  {session.data?.admin.role === 'admin' ? (
                    <Button
                      type="primary"
                      danger
                      onClick={() => setDDispatchOpen(true)}
                    >
                      管理员真实派发一次
                    </Button>
                  ) : null}
                </Space>
              )}
            </section>
          ) : null}

          <section aria-label="本地状态与尝试记录">
            <Title level={5}>本地状态与尝试记录</Title>
            <Timeline
              items={detail.statusEvents.map((event) => ({
                key: event.id,
                color: TIMELINE_COLORS[event.status],
                content: (
                  <Space orientation="vertical" size={2}>
                    <Space size={8} wrap>
                      <Tag color={ORDER_STATUS_COLORS[event.status]}>
                        {ORDER_STATUS_LABELS[event.status]}
                      </Tag>
                      <Text type="secondary">{`v${event.version}`}</Text>
                    </Space>
                    <Text type="secondary">{formatDateTime(event.createdAt)}</Text>
                  </Space>
                ),
              }))}
            />

            {detail.attempts.length === 0 ? (
              <Alert
                type="info"
                showIcon
                title="平台暂无供应商调用记录"
                description="这只是平台本地没有调用记录，不代表供应商一定未处理；请以供应商可核实结果为准。"
              />
            ) : (
              <Space orientation="vertical" size={8} className="fulfillment-detail">
                <AttemptsTable attempts={detail.attempts} />
                <Text type="secondary">
                  「供应商已受理」仅表示供应商确认收到请求，不代表权益已发放到账；未知结果不会自动判定为成功或失败。
                </Text>
              </Space>
            )}
          </section>
        </Space>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可显示的订单详情" />
      )}
      </Drawer>
      <Modal
        open={aGrantOpen}
        title="确认上力 A 真实下单"
        okText="确认真实下单一次"
        okButtonProps={{ danger: true }}
        confirmLoading={aGrantPending}
        onOk={() => void handleAGrant()}
        onCancel={() => {
          if (aGrantPending) return;
          aForm.resetFields();
          setAGrantOpen(false);
        }}
      >
        <Alert
          type="warning"
          showIcon
          title="这会真实创建上力 A 预充值订单，并可能扣除 1 份礼包额度"
          description="系统使用订单冻结的 A 商品和平台生成的唯一 requestId。提交后无论成功、失败还是未知，都不要再次下单；后续只恢复原 requestId。"
        />
        <Form form={aForm} layout="vertical" autoComplete="off" style={{ marginTop: 16 }}>
          <Form.Item
            name="phone"
            label="测试收件手机号"
            rules={[{ required: true, pattern: /^1\d{10}$/, message: '请输入 11 位手机号' }]}
          >
            <Input type="tel" autoComplete="off" placeholder="请输入本次真实验收收件手机号" />
          </Form.Item>
          <Form.Item
            name="refCode"
            label="推广编码"
            rules={[{ required: true, pattern: /^[!-~]{1,64}$/, message: '请输入推广编码' }]}
          >
            <Input autoComplete="off" placeholder="例如 SLD" />
          </Form.Item>
          <Form.Item
            name="paymentReference"
            label="业务支付或授权凭据号"
            rules={[{ required: true, pattern: /^[!-~]{1,128}$/, message: '请输入可见 ASCII 凭据号' }]}
          >
            <Input autoComplete="off" placeholder="例如 A-LIVE-ACCEPT-20261031" />
          </Form.Item>
          <Form.Item
            name="confirmPackDebit"
            valuePropName="checked"
            rules={[
              {
                validator: (_rule, value) =>
                  value === true
                    ? Promise.resolve()
                    : Promise.reject(new Error('请确认这是真实供应商写操作')),
              },
            ]}
          >
            <Checkbox>
              我确认这是真实供应商写操作，可能扣除 1 份上力礼包额度；提交后不重复下单。
            </Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={dDispatchOpen}
        title="确认上力 D 真实派发"
        okText="确认真实派发一次"
        okButtonProps={{ danger: true }}
        confirmLoading={dDispatchPending}
        onOk={() => void handleDDispatch()}
        onCancel={() => {
          if (dDispatchPending) return;
          dForm.resetFields();
          setDDispatchOpen(false);
        }}
      >
        <Alert
          type="warning"
          showIcon
          title="这会真实调用上力 D 派发，并可能扣除权益余额"
          description="系统使用订单创建时冻结的上游商品和平台生成的唯一 partnerOrderNo。提交后无论结果成功、失败或未知，都不要再次派发；后续只使用“查原单”核实同一订单。"
        />
        <Form form={dForm} layout="vertical" autoComplete="off" style={{ marginTop: 16 }}>
          <Form.Item
            name="mobile"
            label="测试收件手机号"
            rules={[{ required: true, pattern: /^1[3-9]\d{9}$/, message: '请输入 11 位手机号' }]}
          >
            <Input type="tel" autoComplete="off" placeholder="请输入本次真实验收收件手机号" />
          </Form.Item>
          <Form.Item
            name="paymentReference"
            label="业务支付或授权凭据号"
            rules={[{ required: true, pattern: /^[!-~]{1,128}$/, message: '请输入可见 ASCII 凭据号' }]}
          >
            <Input autoComplete="off" placeholder="例如 D-LIVE-ACCEPT-20261031" />
          </Form.Item>
          <Form.Item
            name="confirmDebit"
            valuePropName="checked"
            rules={[
              {
                validator: (_rule, value) =>
                  value === true
                    ? Promise.resolve()
                    : Promise.reject(new Error('请确认这是真实供应商写操作')),
              },
            ]}
          >
            <Checkbox>
              我确认这是真实供应商写操作，可能扣除上力权益余额；提交后不重复派发。
            </Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={reissueOpen}
        title="确认 B 模式原单受控补发"
        okText="确认按原 requestId 补发"
        okButtonProps={{ danger: true }}
        confirmLoading={reissuePending}
        onOk={() => void handleReissue()}
        onCancel={() => {
          if (reissuePending) return;
          form.resetFields();
          setReissueOpen(false);
        }}
      >
        <Alert
          type="warning"
          showIcon
          title="这是真实供应商写操作，可能涉及已经扣除的礼包份额"
          description="仅对部分成功且已核实的原订单开放。系统强制沿用原始 requestId，并验证原收件人与支付凭据；必须由管理员操作且维护者单独开启 B 扣额开关。结果未知时系统拒绝再次补发。"
        />
        <Form form={form} layout="vertical" autoComplete="off" style={{ marginTop: 16 }}>
          <Form.Item
            name="phone"
            label="原收件人手机号"
            rules={[{ required: true, pattern: /^1[3-9]\d{9}$/, message: '请输入原订单的 11 位手机号' }]}
          >
            <Input type="tel" autoComplete="off" placeholder="需与原订单完全一致" />
          </Form.Item>
          <Form.Item
            name="refCode"
            label="原推广编码"
            rules={[{ required: true, pattern: /^[!-~]{1,64}$/, message: '请填写原推广编码' }]}
          >
            <Input autoComplete="off" placeholder="原推广编码" />
          </Form.Item>
          <Form.Item
            name="paymentReference"
            label="原业务支付或授权凭据号"
            rules={[{ required: true, pattern: /^[!-~]{1,128}$/, message: '请填写原业务凭据' }]}
          >
            <Input autoComplete="off" placeholder="原支付或授权凭据号" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
