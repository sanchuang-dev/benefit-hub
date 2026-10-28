import {
  Alert,
  App as AntdApp,
  Button,
  Empty,
  Form,
  Input,
  Popconfirm,
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
import type { ApplicationStatus, BusinessApplication } from '../features/applications/api';
import {
  ApplicationDrawer,
  type ApplicationDrawerState,
} from '../features/applications/ApplicationDrawer';
import {
  useApplicationsQuery,
  useSetApplicationStatusMutation,
} from '../features/applications/use-applications';
import { formatDateTime } from '../shared/lib/format-date-time';
import './ApplicationsPage.css';
import { ApiError } from '../shared/lib/api-client';

const { Title, Paragraph, Text } = Typography;

const PAGE_SIZE_OPTIONS = [10, 20, 50];

interface FilterFormValues {
  keyword?: string;
  status: ApplicationStatus | 'all';
}

interface AppliedFilters {
  keyword: string;
  status: ApplicationStatus | 'all';
}

const EMPTY_FILTERS: AppliedFilters = { keyword: '', status: 'all' };

function ApplicationStatusTag({ status }: { status: ApplicationStatus }) {
  return status === 'enabled' ? <Tag color="green">已启用</Tag> : <Tag>已停用</Tag>;
}

function listErrorCopy(error: Error): { title: string; description: string } {
  if (error instanceof ApiError && error.status === 401) {
    return {
      title: '登录状态已失效',
      description: '请刷新页面并重新登录后再加载应用配置。',
    };
  }
  return {
    title: '应用列表加载失败',
    description: error instanceof Error ? error.message : '请求失败，请稍后重试。',
  };
}

/**
 * Downstream application registration and product-entitlement configuration
 * (BHB-014-A). This page is a real same-origin configuration workflow, but the
 * stored configuration is deliberately not presented as runtime permission.
 */
export function ApplicationsPage() {
  const session = useSessionQuery();
  const isAdmin = session.data?.admin.role === 'admin';
  const { message } = AntdApp.useApp();

  const [filterForm] = Form.useForm<FilterFormValues>();
  const [filters, setFilters] = useState<AppliedFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [drawer, setDrawer] = useState<ApplicationDrawerState | null>(null);

  const listQuery = useApplicationsQuery({
    page,
    pageSize,
    keyword: filters.keyword || undefined,
    status: filters.status === 'all' ? undefined : filters.status,
  });
  const statusMutation = useSetApplicationStatusMutation();

  const hasFilters = filters.keyword !== '' || filters.status !== 'all';
  const listError = listQuery.isError ? listErrorCopy(listQuery.error) : null;
  const applications = listQuery.data?.applications ?? [];

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

  const toggleStatus = async (application: BusinessApplication) => {
    const target: ApplicationStatus = application.status === 'enabled' ? 'disabled' : 'enabled';
    try {
      await statusMutation.mutateAsync({
        id: application.id,
        status: target,
        version: application.version,
      });
      message.success(
        target === 'enabled'
          ? '应用已启用；有效凭证可继续调用业务订单接口'
          : '应用已停用；该来源的机器调用立即被拒绝（订单与配置保留）',
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : '状态更新失败，请稍后重试');
      if (error instanceof ApiError && error.code === 'APPLICATION_VERSION_CONFLICT') {
        void listQuery.refetch();
      }
    }
  };

  const authorizationCell = (application: BusinessApplication) => {
    if (application.status === 'disabled') {
      return <Tag color="orange">已停用 · 机器调用被拒</Tag>;
    }
    if (application.activeCredentialCount > 0) {
      return (
        <Tag color="green">
          已生效 · {application.activeCredentialCount} 个有效凭证
        </Tag>
      );
    }
    return <Tag color="gold">未签发有效凭证</Tag>;
  };

  const columns: ColumnsType<BusinessApplication> = [
    {
      title: '应用来源',
      dataIndex: 'businessSource',
      key: 'businessSource',
      width: 168,
      render: (source: string) => <Text code>{source}</Text>,
    },
    {
      title: '应用名称',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (name: string, application) => (
        <Space orientation="vertical" size={0}>
          <Text strong>{name}</Text>
          {application.note ? (
            <Text type="secondary" ellipsis>
              {application.note}
            </Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '配置商品',
      dataIndex: 'configuredProductCount',
      key: 'configuredProductCount',
      width: 108,
      align: 'right',
      render: (value: number) => `${value} 个`,
    },
    {
      title: '配置状态',
      dataIndex: 'status',
      key: 'status',
      width: 96,
      render: (status: ApplicationStatus) => <ApplicationStatusTag status={status} />,
    },
    {
      title: '机器调用授权',
      dataIndex: 'activeCredentialCount',
      key: 'activeCredentialCount',
      width: 196,
      render: (_: number, application: BusinessApplication) => authorizationCell(application),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 200,
      render: (updatedAt: number) => <Text type="secondary">{formatDateTime(updatedAt)}</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 168,
      fixed: 'right',
      render: (_, application) => (
        <Space size={0} wrap>
          <Button
            type="link"
            size="small"
            onClick={() => setDrawer({ mode: 'view', applicationId: application.id })}
          >
            查看
          </Button>
          {isAdmin ? (
            <>
              <Button
                type="link"
                size="small"
                onClick={() => setDrawer({ mode: 'edit', applicationId: application.id })}
              >
                编辑
              </Button>
              <Popconfirm
                title={application.status === 'enabled' ? '确认停用该应用？' : '确认启用该应用？'}
                description={
                  application.status === 'enabled'
                    ? '停用立即拒绝该来源的机器调用；凭证与商品配置保留，已有订单不受影响。'
                    : '启用后持有有效凭证的调用方可再次调用；仍需商品在授权清单内。'
                }
                okText="确认"
                cancelText="取消"
                onConfirm={() => toggleStatus(application)}
              >
                <Button type="link" size="small" danger={application.status === 'enabled'}>
                  {application.status === 'enabled' ? '停用' : '启用'}
                </Button>
              </Popconfirm>
            </>
          ) : null}
        </Space>
      ),
    },
  ];

  const emptyText = hasFilters ? (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的下游应用">
      <Button onClick={resetFilters}>清除筛选</Button>
    </Empty>
  ) : (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={isAdmin ? '还没有登记的下游应用' : '还没有登记的下游应用，请联系管理员登记'}
    />
  );

  return (
    <div className="page">
      <header className="page-header">
        <Title level={2}>下游应用</Title>
        <Paragraph type="secondary">
          登记调用方应用、配置可下单的三创内部商品并签发机器凭证。服务端在每次调用时校验应用启停、凭证有效性与商品授权。
        </Paragraph>
      </header>

      <Space orientation="vertical" size={16} className="page-stack">
        <Alert
          type="success"
          showIcon
          title="运行时授权已生效：应用启停、凭证状态与商品授权都会约束真实机器调用。"
          description="在应用详情中签发/撤销凭证并维护商品白名单；原始密钥只在签发时显示一次，平台只保存 SHA-256 摘要。已有订单的冻结商品与映射版本不会被后续配置改写。"
        />

        {!isAdmin ? (
          <Alert
            type="info"
            showIcon
            title="当前为只读身份"
            description="可以查看应用、商品授权与凭证状态；登记、编辑、启停、签发/撤销凭证需要管理员权限，服务端也会独立拒绝越权写入。"
          />
        ) : null}

        <section className="applications-surface" aria-label="下游应用列表">
          <Form<FilterFormValues>
            form={filterForm}
            className="applications-toolbar"
            layout="inline"
            initialValues={{ keyword: '', status: 'all' }}
            onFinish={applyFilters}
          >
            <Form.Item name="keyword" label="关键词">
              <Input allowClear placeholder="应用来源或名称" style={{ width: 240 }} />
            </Form.Item>
            <Form.Item name="status" label="配置状态">
              <Select
                style={{ width: 140 }}
                options={[
                  { value: 'all', label: '全部状态' },
                  { value: 'enabled', label: '已启用' },
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
          </Form>

          <div className="applications-actions">
            {isAdmin ? (
              <Button
                type="primary"
                icon={<Plus size={16} />}
                onClick={() => setDrawer({ mode: 'create' })}
              >
                登记应用
              </Button>
            ) : (
              <Tooltip title="只读身份不能登记应用">
                <span>
                  <Button type="primary" icon={<Plus size={16} />} disabled>
                    登记应用
                  </Button>
                </span>
              </Tooltip>
            )}
          </div>

          {listQuery.isError && listError ? (
            <Alert
              type="error"
              showIcon
              title={listError.title}
              description={listError.description}
              action={
                <Button size="small" onClick={() => void listQuery.refetch()}>
                  重试
                </Button>
              }
            />
          ) : (
            <Table<BusinessApplication>
              rowKey="id"
              size="middle"
              columns={columns}
              dataSource={applications}
              loading={listQuery.isPending || listQuery.isFetching}
              locale={{ emptyText }}
              scroll={{ x: 1080 }}
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
        </section>
      </Space>

      <ApplicationDrawer
        state={drawer}
        canWrite={Boolean(isAdmin)}
        onClose={() => setDrawer(null)}
        onCreated={(application) => setDrawer({ mode: 'edit', applicationId: application.id })}
      />
    </div>
  );
}
