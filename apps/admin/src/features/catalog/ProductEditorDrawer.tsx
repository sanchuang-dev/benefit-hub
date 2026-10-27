import {
  Alert,
  App as AntdApp,
  Button,
  Divider,
  Drawer,
  Flex,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import './ProductEditorDrawer.css';
import { ApiError } from '../../shared/lib/api-client';
import { formatDateTime } from '../../shared/lib/format-date-time';
import { MappingPanel } from '../mapping/MappingPanel';
import { centsToYuan, yuanToCents } from './money';
import type { CatalogProduct, ProductStatus } from './api';
import {
  useCreateProductMutation,
  useProductQuery,
  useSetProductStatusMutation,
  useUpdateProductMutation,
} from './use-catalog';

export type ProductDrawerState =
  | { mode: 'create' }
  | { mode: 'edit'; productId: string }
  | { mode: 'view'; productId: string };

interface ProductFormValues {
  code: string;
  name: string;
  shortDescription?: string;
  displayPriceYuan?: number | null;
  estimatedCostYuan?: number | null;
}

interface ProductEditorDrawerProps {
  state: ProductDrawerState | null;
  canWrite: boolean;
  onClose: () => void;
}

const PRODUCT_CODE_RULE = /^[a-z0-9][a-z0-9._-]{1,63}$/i;

/** Server validation reports field paths; map them onto the form's yuan fields. */
const SERVER_FIELD_TO_FORM: Record<string, keyof ProductFormValues> = {
  code: 'code',
  name: 'name',
  shortDescription: 'shortDescription',
  displayPriceCents: 'displayPriceYuan',
  estimatedCostCents: 'estimatedCostYuan',
};

function toFormValues(product: CatalogProduct): ProductFormValues {
  return {
    code: product.code,
    name: product.name,
    shortDescription: product.shortDescription,
    displayPriceYuan: centsToYuan(product.displayPriceCents),
    estimatedCostYuan: centsToYuan(product.estimatedCostCents),
  };
}

const DEFAULT_VALUES: ProductFormValues = {
  code: '',
  name: '',
  shortDescription: '',
  displayPriceYuan: null,
  estimatedCostYuan: null,
};

/**
 * One Ant Design Form + Drawer for create, edit, read-only detail, and status
 * changes. Nothing is reported as saved until the API request resolves, and the
 * catalogue queries are invalidated so the table shows the persisted result.
 */
export function ProductEditorDrawer({ state, canWrite, onClose }: ProductEditorDrawerProps) {
  const [form] = Form.useForm<ProductFormValues>();
  const { message, modal } = AntdApp.useApp();
  const [formError, setFormError] = useState<{ message: string; code: string } | null>(null);
  // Keep the form values and optimistic-lock version from the same fetch.
  const [editingSnapshot, setEditingSnapshot] = useState<{ id: string; version: number } | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Mapping draft edits are owned by MappingPanel; the drawer only needs to
  // know whether closing would discard them.
  const [mappingDirty, setMappingDirty] = useState(false);

  const open = state !== null;
  const mode = state?.mode ?? 'create';
  const productId = state !== null && state.mode !== 'create' ? state.productId : undefined;
  const isCreate = mode === 'create';
  const readOnly = mode === 'view' || !canWrite;

  const detail = useProductQuery(open && !isCreate ? productId : undefined);
  const createMutation = useCreateProductMutation();
  const updateMutation = useUpdateProductMutation();
  const statusMutation = useSetProductStatusMutation();
  const saving =
    createMutation.isPending || updateMutation.isPending || statusMutation.isPending;

  useEffect(() => {
    if (!open) {
      setEditingSnapshot(null);
      setConflicted(false);
      setDirty(false);
      setMappingDirty(false);
      return;
    }
    setFormError(null);
    setEditingSnapshot(null);
    setConflicted(false);
    setDirty(false);
    setMappingDirty(false);
    form.resetFields();
    if (isCreate || !productId) return;

    // Never hydrate the form from stale cached detail on a new drawer session.
    let cancelled = false;
    void detail.refetch().then((result) => {
      if (cancelled || !result.data || result.isError) return;
      form.setFieldsValue(toFormValues(result.data));
      setDirty(false);
      setEditingSnapshot({ id: result.data.id, version: result.data.version });
    });
    return () => { cancelled = true; };
    // A drawer session begins when its identity changes; query cache changes
    // must not silently replace the form's editing snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, productId, form, isCreate]);

  const reloadLatest = async () => {
    setEditingSnapshot(null);
    const result = await detail.refetch();
    if (result.isError || !result.data) return;
    form.setFieldsValue(toFormValues(result.data));
    setDirty(false);
    setEditingSnapshot({ id: result.data.id, version: result.data.version });
    setConflicted(false);
    setFormError(null);
  };

  const applyApiError = (error: unknown) => {
    if (!(error instanceof ApiError)) {
      setFormError({ message: '操作失败，请稍后重试', code: 'UNKNOWN' });
      return;
    }
    setFormError({ message: error.message, code: error.code });

    const fieldErrors = (error.fields ?? []).flatMap((field) => {
      const name = SERVER_FIELD_TO_FORM[field];
      return name ? [{ name, errors: ['未通过服务端校验'] }] : [];
    });
    if (fieldErrors.length > 0) form.setFields(fieldErrors);

    if (error.code === 'PRODUCT_VERSION_CONFLICT' && productId) {
      setConflicted(true);
      setEditingSnapshot(null);
    }
  };

  const handleSubmit = async (values: ProductFormValues) => {
    setFormError(null);
    const input = {
      code: values.code.trim(),
      name: values.name.trim(),
      shortDescription: values.shortDescription?.trim() ?? '',
      displayPriceCents: yuanToCents(values.displayPriceYuan),
      estimatedCostCents: yuanToCents(values.estimatedCostYuan),
    };

    try {
      if (isCreate) {
        await createMutation.mutateAsync(input);
      } else {
        if (!editingSnapshot || conflicted) {
          setFormError({ message: '商品详情尚未加载完成，请稍后重试', code: 'DETAIL_NOT_LOADED' });
          return;
        }
        const updated = await updateMutation.mutateAsync({
          id: editingSnapshot.id,
          version: editingSnapshot.version,
          input,
        });
        // The mapping editor can keep this drawer open after a product save.
        // Carry forward the authoritative version so a second PATCH cannot
        // accidentally reuse the version that was just consumed.
        setEditingSnapshot({ id: updated.id, version: updated.version });
        form.setFieldsValue(toFormValues(updated));
        setDirty(false);
      }
      message.success('商品已保存');
      if (mappingDirty) {
        // Closing now would discard mapping draft edits without the discard
        // confirmation; keep the drawer open after an unrelated product save.
        message.info('商品已保存；供应商映射仍有未保存修改，请继续处理');
        return;
      }
      onClose();
    } catch (error) {
      applyApiError(error);
    }
  };

  const handleStatusChange = async (status: ProductStatus) => {
    if (!editingSnapshot || conflicted) return;
    setFormError(null);
    try {
      const updated = await statusMutation.mutateAsync({
        id: editingSnapshot.id,
        status,
        version: editingSnapshot.version,
      });
      setEditingSnapshot({ id: updated.id, version: updated.version });
      message.success(status === 'active' ? '商品已启用' : '商品已停用');
    } catch (error) {
      applyApiError(error);
    }
  };

  const requestClose = () => {
    if (saving) return;
    if (!readOnly && (dirty || mappingDirty)) {
      modal.confirm({
        title: '放弃未保存的修改？',
        content:
          '当前商品或供应商映射有未保存的修改，关闭后将丢失。已保存的映射草稿与生效版本不受影响。',
        okText: '放弃修改',
        cancelText: '继续编辑',
        okButtonProps: { danger: true },
        onOk: onClose,
      });
      return;
    }
    onClose();
  };

  const title = isCreate ? '新建内部商品' : mode === 'edit' ? '编辑内部商品' : '内部商品详情';
  const status = detail.data?.status;
  const ready = isCreate || (editingSnapshot?.id === productId && !conflicted);

  return (
    <Drawer
      open={open}
      size={640}
      title={title}
      onClose={requestClose}
      destroyOnHidden
      extra={
        !isCreate && status ? (
          status === 'active' ? (
            <Tag color="green">已启用</Tag>
          ) : (
            <Tag>已停用</Tag>
          )
        ) : null
      }
      footer={
        <Flex justify="space-between" align="center" gap={8}>
          <div>
            {!isCreate && mode === 'edit' && canWrite && detail.data ? (
              <Popconfirm
                title={status === 'active' ? '确认停用该商品？' : '确认启用该商品？'}
                description={
                  status === 'active'
                    ? '停用后该内部商品不可再用于后续发放，历史数据不会被删除。'
                    : '启用只代表内部配置可用；供应商映射与真实发放状态以下方映射面板为准。'
                }
                okText="确认"
                cancelText="取消"
                onConfirm={() => handleStatusChange(status === 'active' ? 'disabled' : 'active')}
              >
                <Button
                  danger={status === 'active'}
                  loading={statusMutation.isPending}
                  disabled={saving || !ready}
                >
                  {status === 'active' ? '停用商品' : '启用商品'}
                </Button>
              </Popconfirm>
            ) : null}
          </div>
          <Space>
            <Button onClick={requestClose}>关闭</Button>
            {!readOnly ? (
              <Button type="primary" loading={saving} disabled={!ready} onClick={() => form.submit()}>
                保存
              </Button>
            ) : null}
          </Space>
        </Flex>
      }
    >
      {!isCreate && detail.isError ? (
        <Alert
          className="product-drawer-alert"
          type="error"
          showIcon
          title="无法加载商品详情"
          description={detail.error.message}
          action={
            <Button size="small" onClick={() => detail.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      {isCreate ? (
        <Alert
          className="product-drawer-alert"
          type="info"
          showIcon
          title="新建商品不包含供应商映射"
          description="创建成功后可在商品编辑抽屉中保存映射草稿、执行本地校验并显式激活；激活只影响此后新建订单，真实发放仍禁用。"
        />
      ) : detail.data ? (
        <Alert
          className="product-drawer-alert"
          type="info"
          showIcon
          title="真实权益发放仍禁用"
          description="供应商映射以下方面板为准；保存、本地校验与显式激活只改变此后新建订单的映射绑定，本版本不会请求羊毛上游或发放真实权益。"
        />
      ) : null}

      {readOnly && !isCreate ? (
        <Alert
          className="product-drawer-alert"
          type="info"
          showIcon
          title={canWrite ? '当前为只读查看' : '当前为只读身份'}
          description={
            canWrite
              ? '此抽屉以只读方式打开；请从列表的“编辑”进入修改。'
              : '只读身份可以查看商品，但不能保存或启停；服务端同时拒绝越权写入。'
          }
        />
      ) : null}

      {conflicted ? (
        <Alert
          className="product-drawer-alert"
          type="warning"
          showIcon
          title="商品已被他人修改"
          description="保存已锁定。请重新加载最新详情，核对字段后再编辑。"
          action={<Button onClick={() => void reloadLatest()}>重新加载详情</Button>}
        />
      ) : null}

      {formError ? (
        <Alert
          className="product-drawer-alert"
          type="error"
          showIcon
          title={formError.message}
          description="本次修改未被保存，请根据提示调整后重试。"
        />
      ) : null}

      <Spin spinning={!isCreate && !ready && !conflicted}>
        <Form<ProductFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={DEFAULT_VALUES}
          disabled={readOnly}
          onValuesChange={() => setDirty(true)}
          onFinish={handleSubmit}
        >
          <Divider
            titlePlacement="start"
            plain
            className="product-form-section"
            style={{ margin: '4px 0 16px' }}
          >
            基本信息
          </Divider>
          <Form.Item
            label="商品编码"
            name="code"
            extra="保存时统一转为大写；编码在系统内唯一。"
            rules={[
              { required: true, whitespace: true, message: '请输入商品编码' },
              { pattern: PRODUCT_CODE_RULE, message: '商品编码需为 2-64 位字母、数字或 . _ -' },
            ]}
          >
            <Input placeholder="例如 TX-TRAVEL-10" autoComplete="off" />
          </Form.Item>
          <Form.Item
            label="商品名称"
            name="name"
            rules={[
              { required: true, whitespace: true, message: '请输入商品名称' },
              { max: 80, message: '商品名称最长 80 个字符' },
            ]}
          >
            <Input placeholder="运营侧展示名称" autoComplete="off" />
          </Form.Item>
          <Form.Item
            label="商品描述"
            name="shortDescription"
            rules={[{ max: 200, message: '商品描述最长 200 个字符' }]}
          >
            <Input.TextArea rows={2} maxLength={200} showCount placeholder="可选，运营内部说明" />
          </Form.Item>

          <Divider
            titlePlacement="start"
            plain
            className="product-form-section"
            style={{ margin: '4px 0 16px' }}
          >
            价格与成本
          </Divider>
          <div className="product-form-grid">
            <Form.Item
              label="展示价（元）"
              name="displayPriceYuan"
              rules={[{ type: 'number', min: 0, message: '展示价不能为负' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                prefix="¥"
                min={0}
                precision={2}
                placeholder="留空表示未配置"
              />
            </Form.Item>
            <Form.Item
              label="预估成本（元）"
              name="estimatedCostYuan"
              rules={[{ type: 'number', min: 0, message: '预估成本不能为负' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                prefix="¥"
                min={0}
                precision={2}
                placeholder="留空表示未配置"
              />
            </Form.Item>
          </div>

          {!isCreate && detail.data ? (
            <Typography.Text type="secondary" className="product-drawer-meta">
              版本 v{detail.data.version} · 更新于 {formatDateTime(detail.data.updatedAt)}
            </Typography.Text>
          ) : null}
        </Form>
      </Spin>

      {!isCreate && productId && detail.data ? (
        <section aria-label="供应商映射面板" className="product-mapping-section">
          <Divider
            titlePlacement="start"
            plain
            className="product-form-section"
            style={{ margin: '20px 0 16px' }}
          >
            供应商映射
          </Divider>
          <MappingPanel
            key={productId}
            productId={productId}
            canWrite={canWrite && mode === 'edit'}
            onDirtyChange={setMappingDirty}
          />
        </section>
      ) : null}
    </Drawer>
  );
}
