import { Alert, Button, Card, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import type { AuditEventCategory, AuditEventDto } from '@sanchuang-dev/benefit-contracts';
import { useSessionQuery } from '../auth/use-auth';
import { formatDateTime } from '../../shared/lib/format-date-time';
import {
  AUDIT_CATEGORY_COLORS,
  AUDIT_CATEGORY_LABELS,
  auditDetailText,
  auditEventLabel,
} from './labels';
import { useAuditEventsQuery } from './use-settings';

const { Paragraph } = Typography;

const PAGE_SIZE = 20;

type CategoryFilter = AuditEventCategory | 'all';

const columns: ColumnsType<AuditEventDto> = [
  {
    title: '时间',
    dataIndex: 'createdAt',
    key: 'createdAt',
    render: (createdAt: number) => formatDateTime(createdAt),
  },
  {
    title: '类别',
    dataIndex: 'category',
    key: 'category',
    render: (category: AuditEventCategory) => (
      <Tag color={AUDIT_CATEGORY_COLORS[category]}>{AUDIT_CATEGORY_LABELS[category]}</Tag>
    ),
  },
  {
    title: '事件',
    dataIndex: 'event',
    key: 'event',
    render: (event: string) => auditEventLabel(event),
  },
  {
    title: '操作人',
    key: 'account',
    render: (_, row) =>
      row.account ? `${row.account.displayName}（${row.account.username}）` : '未识别账号',
  },
  {
    title: '详情',
    key: 'detail',
    render: (_, row) => auditDetailText(row.event, row.detail),
  },
];

/**
 * Admin-only audit trail. Only facts the server actually stores are shown; the
 * page never invents IP addresses, user agents or explanations. Viewers get an
 * explanatory card instead of a request the API would reject.
 */
export function AuditEventsPanel() {
  const session = useSessionQuery();
  const isAdmin = session.data?.admin.role === 'admin';
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [page, setPage] = useState(1);

  const query = useAuditEventsQuery(
    {
      page,
      pageSize: PAGE_SIZE,
      category: category === 'all' ? undefined : category,
    },
    isAdmin,
  );

  if (!session.data) return <Card loading />;

  if (!isAdmin) {
    return (
      <Alert
        type="info"
        showIcon
        title="当前为只读身份"
        description="操作审计包含登录、会话与账号变更事实，仅管理员可以查看。"
      />
    );
  }

  const changeCategory = (value: CategoryFilter) => {
    setCategory(value);
    setPage(1);
  };

  return (
    <Card
      title="操作审计"
      extra={
        <Space size={8}>
          <Select<CategoryFilter>
            size="small"
            value={category}
            style={{ width: 132 }}
            onChange={changeCategory}
            options={[
              { value: 'all', label: '全部类别' },
              { value: 'authentication', label: AUDIT_CATEGORY_LABELS.authentication },
              { value: 'account', label: AUDIT_CATEGORY_LABELS.account },
            ]}
          />
          <Button size="small" onClick={() => void query.refetch()} loading={query.isFetching}>
            刷新
          </Button>
        </Space>
      }
    >
      <Paragraph type="secondary">
        当前覆盖登录、会话与账号事件；商品、应用与供应商写审计将按同一时间线逐步接入。审计记录不包含密码、令牌或完整请求内容。
      </Paragraph>
      {query.isError ? (
        <Alert
          type="error"
          showIcon
          title="无法加载操作审计"
          description={query.error.message}
          action={
            <Button size="small" onClick={() => void query.refetch()}>
              重试
            </Button>
          }
        />
      ) : (
        <Table<AuditEventDto>
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={query.data?.events ?? []}
          loading={query.isPending}
          locale={{ emptyText: '当前筛选没有审计事件' }}
          scroll={{ x: 'max-content' }}
          pagination={{
            current: query.data?.page ?? page,
            pageSize: PAGE_SIZE,
            total: query.data?.total ?? 0,
            showSizeChanger: false,
            showTotal: (total) => `共 ${total} 条`,
            onChange: (nextPage) => setPage(nextPage),
          }}
        />
      )}
    </Card>
  );
}
