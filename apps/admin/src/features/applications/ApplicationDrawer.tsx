import {
  Alert,
  App as AntdApp,
  Button,
  Checkbox,
  Divider,
  Drawer,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { KeyRound, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../shared/lib/api-client';
import { formatDateTime } from '../../shared/lib/format-date-time';
import type { CatalogProduct } from '../catalog/api';
import { useProductsQuery } from '../catalog/use-catalog';
import type {
  ApplicationCredential,
  ApplicationProduct,
  ApplicationStatus,
  BusinessApplication,
} from './api';
import {
  useApplicationQuery,
  useCreateApplicationMutation,
  useIssueApplicationCredentialMutation,
  useRevokeApplicationCredentialMutation,
  useSetApplicationProductsMutation,
  useSetApplicationStatusMutation,
  useUpdateApplicationMutation,
} from './use-applications';
import './ApplicationDrawer.css';

const { Text, Paragraph } = Typography;

const CREDENTIAL_LIMIT_NOTE = '同一应用最多保留 5 个有效凭证；超出前请先撤销不再使用的凭证。';

function CredentialStatusTag({ status }: { status: 'active' | 'revoked' }) {
  return status === 'active' ? <Tag color="green">有效</Tag> : <Tag>已撤销</Tag>;
}

export type ApplicationDrawerState =
  | { mode: 'create' }
  | { mode: 'edit'; applicationId: string }
  | { mode: 'view'; applicationId: string };

interface ApplicationFormValues {
  businessSource: string;
  name: string;
  note?: string;
}

interface SelectedProduct {
  productId: string;
  code: string;
  name: string;
  status: 'active' | 'disabled';
}

interface ApplicationDrawerProps {
  state: ApplicationDrawerState | null;
  canWrite: boolean;
  onClose: () => void;
  /** After a create the page can reopen the same drawer to configure products. */
  onCreated?: (application: BusinessApplication) => void;
}

const BUSINESS_SOURCE_RULE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const SERVER_FIELD_TO_FORM: Record<string, keyof ApplicationFormValues | 'productIds'> = {
  businessSource: 'businessSource',
  name: 'name',
  note: 'note',
  productIds: 'productIds',
};

function toSelectedProduct(product: ApplicationProduct): SelectedProduct {
  return {
    productId: product.productId,
    code: product.code,
    name: product.name,
    status: product.status,
  };
}

function toSelectedFromCatalog(product: CatalogProduct): SelectedProduct {
  return {
    productId: product.id,
    code: product.code,
    name: product.name,
    status: product.status,
  };
}

function ProductStatusTag({ status }: { status: 'active' | 'disabled' }) {
  return status === 'active' ? <Tag color="green">已启用</Tag> : <Tag>已停用</Tag>;
}

/**
 * Server-backed product browsing. Only the current page is loaded, and search
 * and pagination are executed by the existing authenticated catalogue API, so
 * the browser never holds the whole catalogue or silently truncates an
 * application's authorization set.
 */
function ApplicationProductPicker({
  selected,
  onToggle,
}: {
  selected: Map<string, SelectedProduct>;
  onToggle: (product: SelectedProduct, checked: boolean) => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const query = useProductsQuery({
    page,
    pageSize: 10,
    keyword: keyword || undefined,
  });

  const columns: ColumnsType<CatalogProduct> = [
    {
      title: '',
      key: 'select',
      width: 48,
      render: (_, product) => {
        const checked = selected.has(product.id);
        const blocked = !checked && product.status === 'disabled';
        const checkbox = (
          <Checkbox
            aria-label={`选择商品 ${product.code}`}
            checked={checked}
            disabled={blocked}
            onChange={(event) => onToggle(toSelectedFromCatalog(product), event.target.checked)}
          />
        );
        return blocked ? (
          <Tooltip title="已停用的内部商品不能被新增配置">{checkbox}</Tooltip>
        ) : (
          checkbox
        );
      },
    },
    {
      title: '商品编码',
      dataIndex: 'code',
      key: 'code',
      width: 150,
      render: (code: string) => <Text code>{code}</Text>,
    },
    { title: '商品名称', dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 88,
      render: (status: 'active' | 'disabled') => <ProductStatusTag status={status} />,
    },
  ];

  return (
    <Space orientation="vertical" size={8} className="application-product-picker">
      <Space.Compact className="application-product-search">
        <Input
          allowClear
          placeholder="搜索内部商品编码或名称"
          value={keyword}
          onChange={(event) => {
            setKeyword(event.target.value);
            setPage(1);
          }}
          onPressEnter={() => setPage(1)}
        />
        <Button icon={<Search size={14} />} onClick={() => setPage(1)}>
          搜索
        </Button>
      </Space.Compact>

      {query.isError ? (
        <Alert
          type="error"
          showIcon
          title="内部商品加载失败"
          description={query.error.message}
          action={
            <Button size="small" onClick={() => void query.refetch()}>
              重试
            </Button>
          }
        />
      ) : (
        <Table<CatalogProduct>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={query.data?.products ?? []}
          loading={query.isPending || query.isFetching}
          locale={{ emptyText: '没有符合条件的内部商品' }}
          scroll={{ x: 560 }}
          pagination={{
            current: page,
            pageSize: 10,
            total: query.data?.total ?? 0,
            showSizeChanger: false,
            showTotal: (total) => `共 ${total} 个内部商品`,
            onChange: setPage,
          }}
        />
      )}
    </Space>
  );
}

/**
 * One Drawer for register, edit, read-only detail and status changes. Product
 * authorization is edited as a complete set through the real same-origin API;
 * nothing here claims that configuration is an effective machine permission.
 */
export function ApplicationDrawer({ state, canWrite, onClose, onCreated }: ApplicationDrawerProps) {
  const [form] = Form.useForm<ApplicationFormValues>();
  const { message, modal } = AntdApp.useApp();
  const [formError, setFormError] = useState<{ message: string; code: string } | null>(null);
  const [snapshot, setSnapshot] = useState<{
    id: string;
    version: number;
    status: ApplicationStatus;
  } | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [selected, setSelected] = useState<Map<string, SelectedProduct>>(new Map());
  const [baselineProductIds, setBaselineProductIds] = useState<string[]>([]);
  // The raw secret lives only in this component session and is dropped when the
  // one-time modal closes. It is never placed in the query cache or storage.
  const [issuedSecret, setIssuedSecret] = useState<{ credentialId: string; secret: string } | null>(
    null,
  );
  const [credentialError, setCredentialError] = useState<string | null>(null);

  const open = state !== null;
  const mode = state?.mode ?? 'create';
  const applicationId = state !== null && state.mode !== 'create' ? state.applicationId : undefined;
  const isCreate = mode === 'create';
  const readOnly = mode === 'view' || !canWrite;

  const detail = useApplicationQuery(open && !isCreate ? applicationId : undefined);
  const createMutation = useCreateApplicationMutation();
  const updateMutation = useUpdateApplicationMutation();
  const statusMutation = useSetApplicationStatusMutation();
  const productsMutation = useSetApplicationProductsMutation();
  const issueMutation = useIssueApplicationCredentialMutation();
  const revokeMutation = useRevokeApplicationCredentialMutation();
  const saving =
    createMutation.isPending ||
    updateMutation.isPending ||
    statusMutation.isPending ||
    productsMutation.isPending;

  const hydrate = (application: BusinessApplication, products: ApplicationProduct[]) => {
    form.setFieldsValue({
      businessSource: application.businessSource,
      name: application.name,
      note: application.note,
    });
    setSnapshot({
      id: application.id,
      version: application.version,
      status: application.status,
    });
    setSelected(new Map(products.map((product) => [product.productId, toSelectedProduct(product)])));
    setBaselineProductIds(products.map((product) => product.productId).sort());
    setFormDirty(false);
    setConflicted(false);
    setFormError(null);
  };

  useEffect(() => {
    if (!open) {
      setSnapshot(null);
      setConflicted(false);
      setFormDirty(false);
      setFormError(null);
      setSelected(new Map());
      setBaselineProductIds([]);
      setIssuedSecret(null);
      setCredentialError(null);
      return;
    }
    setFormError(null);
    setSnapshot(null);
    setConflicted(false);
    setFormDirty(false);
    setSelected(new Map());
    setBaselineProductIds([]);
    setIssuedSecret(null);
    setCredentialError(null);
    form.resetFields();
    if (isCreate || !applicationId) return;

    // Never hydrate from a stale cached detail on a new drawer session.
    let cancelled = false;
    void detail.refetch().then((result) => {
      if (cancelled || result.isError || !result.data) return;
      hydrate(result.data.application, result.data.products);
    });
    return () => {
      cancelled = true;
    };
    // A drawer session begins when its identity changes; cached query changes
    // must not silently replace the operator's editing snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, applicationId, form, isCreate]);

  const selectedIds = useMemo(() => [...selected.keys()].sort(), [selected]);
  const productsDirty = useMemo(
    () =>
      selectedIds.length !== baselineProductIds.length ||
      selectedIds.some((id, index) => id !== baselineProductIds[index]),
    [selectedIds, baselineProductIds],
  );
  const dirty = formDirty || productsDirty;

  const toggleProduct = (product: SelectedProduct, checked: boolean) => {
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(product.productId, product);
      else next.delete(product.productId);
      return next;
    });
  };

  const reloadLatest = async () => {
    setSnapshot(null);
    const result = await detail.refetch();
    if (result.isError || !result.data) return;
    hydrate(result.data.application, result.data.products);
  };

  const applyApiError = (error: unknown) => {
    if (!(error instanceof ApiError)) {
      setFormError({ message: '操作失败，请稍后重试', code: 'UNKNOWN' });
      return;
    }
    setFormError({ message: error.message, code: error.code });

    const fieldErrors = (error.fields ?? []).flatMap((field) => {
      const name = SERVER_FIELD_TO_FORM[field];
      return name && name !== 'productIds'
        ? [{ name, errors: ['未通过服务端校验'] }]
        : [];
    });
    if (fieldErrors.length > 0) form.setFields(fieldErrors);

    if (error.code === 'APPLICATION_SOURCE_CONFLICT') {
      // The source is immutable once registered, but on create it is still an
      // editable field: point at it instead of locking the drawer.
      if (isCreate) {
        form.setFields([
          { name: 'businessSource', errors: ['应用来源标识已存在，请换一个'] },
        ]);
      }
    }

    if (error.code === 'APPLICATION_VERSION_CONFLICT') {
      setConflicted(true);
      setSnapshot(null);
    }
  };

  const handleSubmit = async (values: ApplicationFormValues) => {
    setFormError(null);

    try {
      if (isCreate) {
        const created = await createMutation.mutateAsync({
          businessSource: values.businessSource.trim(),
          name: values.name.trim(),
          note: values.note?.trim() ?? '',
        });
        message.success('应用已登记；尚未生成服务凭证');
        if (onCreated) onCreated(created);
        else onClose();
        return;
      }

      if (!snapshot || conflicted) {
        setFormError({ message: '应用详情尚未加载完成，请稍后重试', code: 'DETAIL_NOT_LOADED' });
        return;
      }

      let version = snapshot.version;
      if (formDirty) {
        const updated = await updateMutation.mutateAsync({
          id: snapshot.id,
          version,
          input: {
            name: values.name.trim(),
            note: values.note?.trim() ?? '',
          },
        });
        version = updated.version;
        // The rename is already persisted; keep the snapshot current so a later
        // product-save failure can be retried without replaying a stale version.
        setSnapshot({ id: updated.id, version: updated.version, status: updated.status });
        setFormDirty(false);
      }

      if (productsDirty) {
        const result = await productsMutation.mutateAsync({
          id: snapshot.id,
          version,
          productIds: selectedIds,
        });
        hydrate(result.application, result.products);
      } else {
        setSnapshot({ ...snapshot, version });
      }

      message.success('应用配置已保存；已启用的应用将按商品授权校验机器调用');
      onClose();
    } catch (error) {
      applyApiError(error);
    }
  };

  const handleStatusChange = async () => {
    if (!snapshot || conflicted) return;
    setFormError(null);
    const target: ApplicationStatus = snapshot.status === 'enabled' ? 'disabled' : 'enabled';
    try {
      const updated = await statusMutation.mutateAsync({
        id: snapshot.id,
        status: target,
        version: snapshot.version,
      });
      setSnapshot({ id: updated.id, version: updated.version, status: updated.status });
      message.success(
        target === 'enabled'
          ? '应用已启用；有效凭证可继续调用业务订单接口'
          : '应用已停用；该来源的机器调用立即被拒绝（订单与配置保留）',
      );
    } catch (error) {
      applyApiError(error);
    }
  };

  const handleIssueCredential = async () => {
    if (!snapshot || conflicted) return;
    setCredentialError(null);
    try {
      const issued = await issueMutation.mutateAsync(snapshot.id);
      // Copy the one-time secret into local drawer state and clear the mutation
      // result so no query/mutation cache retains it.
      setIssuedSecret({ credentialId: issued.credential.id, secret: issued.secret });
      issueMutation.reset();
      await detail.refetch();
      message.success('已签发新的服务凭证；密钥只显示一次');
    } catch (error) {
      setCredentialError(
        error instanceof ApiError ? error.message : '签发失败，请稍后重试',
      );
    }
  };

  const handleRevokeCredential = async (credentialId: string) => {
    if (!snapshot) return;
    setCredentialError(null);
    try {
      await revokeMutation.mutateAsync({ id: snapshot.id, credentialId });
      if (issuedSecret?.credentialId === credentialId) setIssuedSecret(null);
      await detail.refetch();
      message.success('服务凭证已撤销；后续调用将被拒绝');
    } catch (error) {
      setCredentialError(
        error instanceof ApiError ? error.message : '撤销失败，请稍后重试',
      );
    }
  };

  const closeSecret = () => setIssuedSecret(null);

  const requestClose = () => {
    if (saving) return;
    if (!readOnly && dirty) {
      modal.confirm({
        title: '放弃未保存的修改？',
        content: '当前应用信息或商品授权配置尚未保存，关闭后将丢失。',
        okText: '放弃修改',
        cancelText: '继续编辑',
        okButtonProps: { danger: true },
        onOk: onClose,
      });
      return;
    }
    onClose();
  };

  const title = isCreate ? '登记下游应用' : mode === 'edit' ? '编辑下游应用' : '下游应用详情';
  const status = snapshot?.status ?? detail.data?.application.status;
  const ready = isCreate || (snapshot?.id === applicationId && !conflicted);
  const configuredProducts = detail.data?.products ?? [];
  const credentials = detail.data?.credentials ?? [];
  const activeCredentials = credentials.filter((credential) => credential.status === 'active');

  const credentialColumns: ColumnsType<ApplicationCredential> = [
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 88,
      render: (value: 'active' | 'revoked') => <CredentialStatusTag status={value} />,
    },
    {
      title: '签发时间',
      dataIndex: 'issuedAt',
      key: 'issuedAt',
      width: 180,
      render: (value: number) => <Text type="secondary">{formatDateTime(value)}</Text>,
    },
    {
      title: '撤销时间',
      dataIndex: 'revokedAt',
      key: 'revokedAt',
      width: 180,
      render: (value: number | null) =>
        value === null ? <Text type="secondary">—</Text> : <Text type="secondary">{formatDateTime(value)}</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 96,
      render: (_, credential) =>
        canWrite && mode === 'edit' && credential.status === 'active' ? (
          <Popconfirm
            title="确认撤销该服务凭证？"
            description="撤销立即生效；使用该密钥的调用方将无法再调用业务订单接口，且无法恢复。"
            okText="确认撤销"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleRevokeCredential(credential.id)}
          >
            <Button size="small" danger loading={revokeMutation.isPending}>
              撤销
            </Button>
          </Popconfirm>
        ) : null,
    },
  ];

  const configuredColumns: ColumnsType<ApplicationProduct> = [
    {
      title: '商品编码',
      dataIndex: 'code',
      key: 'code',
      width: 160,
      render: (code: string) => <Text code>{code}</Text>,
    },
    { title: '商品名称', dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: '当前状态',
      dataIndex: 'status',
      key: 'status',
      width: 96,
      render: (value: 'active' | 'disabled') => <ProductStatusTag status={value} />,
    },
  ];

  return (
    <Drawer
      open={open}
      width="min(720px, 100%)"
      title={title}
      onClose={requestClose}
      destroyOnHidden
      extra={
        !isCreate && status ? (
          status === 'enabled' ? <Tag color="green">已启用</Tag> : <Tag color="orange">已停用</Tag>
        ) : null
      }
      footer={
        <Flex justify="space-between" align="center" gap={8} wrap>
          <div>
            {!isCreate && mode === 'edit' && canWrite && detail.data ? (
              <Popconfirm
                title={status === 'enabled' ? '确认停用该应用？' : '确认启用该应用？'}
                description={
                  status === 'enabled'
                    ? '停用立即拒绝该来源的机器调用；不会吊销凭证，也不会删除已配置的商品与已有订单。'
                    : '启用后，持有有效凭证的调用方可再次调用；仍需凭证有效且商品在授权清单内。'
                }
                okText="确认"
                cancelText="取消"
                onConfirm={() => handleStatusChange()}
              >
                <Button
                  danger={status === 'enabled'}
                  loading={statusMutation.isPending}
                  disabled={saving || !ready}
                >
                  {status === 'enabled' ? '停用应用' : '启用应用'}
                </Button>
              </Popconfirm>
            ) : null}
          </div>
          <Space>
            <Button onClick={requestClose}>关闭</Button>
            {!readOnly ? (
              <Button
                type="primary"
                loading={saving}
                disabled={!ready}
                onClick={() => form.submit()}
              >
                保存
              </Button>
            ) : null}
          </Space>
        </Flex>
      }
    >
      <Alert
        className="application-drawer-alert"
        type="success"
        showIcon
        title="运行时授权已生效"
        description="服务端在每次机器调用时校验：应用已启用、Bearer 凭证有效未撤销；创建新订单还要求内部商品在下方授权清单内且已启用并有生效映射。登记/启用本身不会生成凭证。"
      />

      {isCreate ? (
        <Alert
          className="application-drawer-alert"
          type="info"
          showIcon
          title="登记不会自动生成服务凭证"
          description="创建后只保存应用身份、名称与备注；请保存后在本抽屉「机器凭证」中签发，并配置商品授权。"
        />
      ) : null}

      {readOnly && !isCreate ? (
        <Alert
          className="application-drawer-alert"
          type="info"
          showIcon
          title={canWrite ? '当前为只读查看' : '当前为只读身份'}
          description={
            canWrite
              ? '此抽屉以只读方式打开；请从列表的“编辑”进入修改。'
              : '只读身份可以查看应用、商品授权与凭证状态，但不能保存、启停、签发或撤销凭证；服务端同时拒绝越权写入。'
          }
        />
      ) : null}

      {!isCreate && detail.isError ? (
        <Alert
          className="application-drawer-alert"
          type="error"
          showIcon
          title={detail.error.status === 401 ? '登录状态已失效' : '无法加载应用详情'}
          description={
            detail.error.status === 401
              ? '请刷新页面并重新登录后再查看应用配置。'
              : detail.error.message
          }
          action={
            <Button size="small" onClick={() => void detail.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      {conflicted ? (
        <Alert
          className="application-drawer-alert"
          type="warning"
          showIcon
          title="应用配置已被他人修改"
          description="保存已锁定。请重新加载最新详情，核对应用信息与商品配置后再保存。"
          action={<Button onClick={() => void reloadLatest()}>重新加载详情</Button>}
        />
      ) : null}

      {formError ? (
        <Alert
          className="application-drawer-alert"
          type="error"
          showIcon
          title={formError.message}
          description="本次修改未被保存，请根据提示调整后重试。"
        />
      ) : null}

      <Spin spinning={!isCreate && !ready && !conflicted && !detail.isError}>
        <Form<ApplicationFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ businessSource: '', name: '', note: '' }}
          disabled={readOnly}
          onValuesChange={() => setFormDirty(true)}
          onFinish={handleSubmit}
        >
          <Divider titlePlacement="start" plain className="application-form-section">
            应用身份
          </Divider>
          <Form.Item
            label="应用来源标识"
            name="businessSource"
            extra="保存时统一转为小写；登记后不可修改，也不能与已有业务来源重复。"
            rules={[
              { required: true, whitespace: true, message: '请输入应用来源标识' },
              {
                pattern: BUSINESS_SOURCE_RULE,
                message: '需为 1-64 位小写字母、数字或 . _ -，且以字母或数字开头',
              },
            ]}
          >
            <Input
              placeholder="例如 local-life"
              autoComplete="off"
              disabled={!isCreate}
              onChange={(event) => {
                const lowered = event.target.value.toLowerCase();
                if (lowered !== event.target.value) form.setFieldValue('businessSource', lowered);
              }}
            />
          </Form.Item>
          <Form.Item
            label="应用名称"
            name="name"
            rules={[
              { required: true, whitespace: true, message: '请输入应用名称' },
              { max: 80, message: '应用名称最长 80 个字符' },
            ]}
          >
            <Input placeholder="运营侧展示名称" autoComplete="off" />
          </Form.Item>
          <Form.Item label="备注" name="note" rules={[{ max: 200, message: '备注最长 200 个字符' }]}>
            <Input.TextArea rows={2} maxLength={200} showCount placeholder="可选，运营内部说明" />
          </Form.Item>

          {!isCreate && detail.data ? (
            <Text type="secondary" className="application-drawer-meta">
              版本 v{snapshot?.version ?? detail.data.application.version} · 更新于{' '}
              {formatDateTime(detail.data.application.updatedAt)}
            </Text>
          ) : null}
        </Form>
      </Spin>

      {!isCreate ? (
        <section aria-label="应用机器凭证" className="application-credentials-section">
          <Divider titlePlacement="start" plain className="application-form-section">
            机器凭证
          </Divider>

          <Space orientation="vertical" size={12} className="page-stack">
            <Alert
              type={activeCredentials.length > 0 ? 'success' : 'warning'}
              showIcon
              title={
                activeCredentials.length > 0
                  ? `当前有 ${activeCredentials.length} 个有效凭证`
                  : '尚未签发有效凭证，机器调用会被拒绝'
              }
              description={
                activeCredentials.length > 0
                  ? '有效凭证可调用业务订单接口；服务端只保存 SHA-256 摘要，原始密钥仅在签发时显示一次。'
                  : '签发后请把原始密钥配置到调用方的服务端；浏览器不会保存该密钥，刷新后无法再次查看。'
              }
            />

            {credentialError ? (
              <Alert type="error" showIcon title={credentialError} />
            ) : null}

            <Table<ApplicationCredential>
              rowKey="id"
              size="small"
              columns={credentialColumns}
              dataSource={credentials}
              pagination={false}
              scroll={{ x: 560 }}
              locale={{ emptyText: '尚未签发服务凭证' }}
            />

            {canWrite && mode === 'edit' ? (
              <Space size={12} wrap align="center">
                <Button
                  type="primary"
                  icon={<KeyRound size={16} />}
                  loading={issueMutation.isPending}
                  disabled={!ready}
                  onClick={() => void handleIssueCredential()}
                >
                  签发新凭证
                </Button>
                <Text type="secondary">
                  轮换：先签发新凭证并更新调用方配置，确认可用后再撤销旧凭证。{CREDENTIAL_LIMIT_NOTE}
                </Text>
              </Space>
            ) : null}
          </Space>
        </section>
      ) : null}

      {!isCreate ? (
        <section aria-label="应用商品授权配置" className="application-products-section">
          <Divider titlePlacement="start" plain className="application-form-section">
            商品授权配置
          </Divider>

          {readOnly ? (
            <Table<ApplicationProduct>
              rowKey="productId"
              size="small"
              columns={configuredColumns}
              dataSource={configuredProducts}
              pagination={false}
              scroll={{ x: 520 }}
              locale={{ emptyText: '尚未配置任何内部商品' }}
            />
          ) : detail.data ? (
            <Space orientation="vertical" size={12} className="page-stack">
              <Alert
                type="info"
                showIcon
                title="只授权本应用可下单的内部商品"
                description="保存立即生效：新订单只能使用清单内且已启用、有生效映射的内部商品。已创建订单的冻结商品与映射版本不会被改写。"
              />
              <div className="application-selected-summary">
                <Space size={8} wrap>
                  <Text strong>已选 {selected.size} 个内部商品</Text>
                  {productsDirty ? <Tag color="gold">有未保存变更</Tag> : null}
                </Space>
                {selected.size === 0 ? (
                  <Text type="secondary">尚未选择内部商品</Text>
                ) : (
                  <div className="application-selected-tags">
                    {[...selected.values()].map((product) => (
                      <Tag
                        key={product.productId}
                        closable
                        color={product.status === 'active' ? undefined : 'default'}
                        onClose={(event) => {
                          event.preventDefault();
                          toggleProduct(product, false);
                        }}
                      >
                        {product.code}
                        {product.status === 'disabled' ? '（已停用）' : ''}
                      </Tag>
                    ))}
                  </div>
                )}
              </div>
              <ApplicationProductPicker selected={selected} onToggle={toggleProduct} />
            </Space>
          ) : null}
        </section>
      ) : null}

      {issuedSecret ? (
        <Modal
          open
          title="服务凭证（仅显示一次）"
          onCancel={closeSecret}
          destroyOnHidden
          footer={
            <Button type="primary" onClick={closeSecret}>
              我已保存
            </Button>
          }
        >
          <Space orientation="vertical" size={12} className="page-stack">
            <Alert
              type="warning"
              showIcon
              title="请立即保存到调用方的服务器端配置"
              description="本平台只保存 SHA-256 摘要，关闭后无法再次查看或找回该密钥；浏览器不会持久保存它。"
            />
            <Paragraph
              className="application-secret-value"
              copyable={{ text: issuedSecret.secret, tooltips: ['复制', '已复制'] }}
              aria-label="一次性服务凭证"
            >
              <Text code>{issuedSecret.secret}</Text>
            </Paragraph>
            <Text type="secondary">
              调用方式：<Text code>Authorization: Bearer &lt;凭证&gt;</Text>。请勿写入前端 bundle、日志或仓库。
            </Text>
          </Space>
        </Modal>
      ) : null}
    </Drawer>
  );
}
