import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntdApp,
  Button,
  Drawer,
  Flex,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Space,
  Spin,
} from 'antd';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../shared/lib/api-client';
import { centsToYuan, yuanToCents } from './money';
import type { CatalogProduct, ProductStatus } from './api';
import {
  catalogQueryKeys,
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
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<{ message: string; code: string } | null>(null);
  const filledProductId = useRef<string | null>(null);

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
      filledProductId.current = null;
      return;
    }
    setFormError(null);
    form.resetFields();
  }, [open, mode, productId, form]);

  useEffect(() => {
    if (!open || isCreate || !detail.data) return;
    // Fill once per drawer session: a background refetch must not overwrite edits.
    if (filledProductId.current === detail.data.id) return;
    filledProductId.current = detail.data.id;
    form.setFieldsValue(toFormValues(detail.data));
  }, [open, isCreate, detail.data, form]);

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
      void queryClient.invalidateQueries({ queryKey: catalogQueryKeys.detail(productId) });
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
        if (!detail.data) {
          setFormError({ message: '商品详情尚未加载完成，请稍后重试', code: 'DETAIL_NOT_LOADED' });
          return;
        }
        await updateMutation.mutateAsync({
          id: detail.data.id,
          version: detail.data.version,
          input,
        });
      }
      message.success('商品已保存');
      onClose();
    } catch (error) {
      applyApiError(error);
    }
  };

  const handleStatusChange = async (status: ProductStatus) => {
    if (!detail.data) return;
    setFormError(null);
    try {
      await statusMutation.mutateAsync({
        id: detail.data.id,
        status,
        version: detail.data.version,
      });
      message.success(status === 'active' ? '商品已启用' : '商品已停用');
    } catch (error) {
      applyApiError(error);
    }
  };

  const title = isCreate ? '新建内部商品' : mode === 'edit' ? '编辑内部商品' : '内部商品详情';
  const status = detail.data?.status;

  return (
    <Drawer
      open={open}
      size={640}
      title={title}
      onClose={onClose}
      destroyOnHidden
      footer={
        <Flex justify="space-between" align="center" gap={8}>
          <div>
            {!isCreate && mode === 'edit' && canWrite && detail.data ? (
              <Popconfirm
                title={status === 'active' ? '确认停用该商品？' : '确认启用该商品？'}
                description={
                  status === 'active'
                    ? '停用后该内部商品不可再用于后续发放，历史数据不会被删除。'
                    : '启用只代表内部配置可用；本商品尚未映射供应商，仍不能发放。'
                }
                okText="确认"
                cancelText="取消"
                onConfirm={() => handleStatusChange(status === 'active' ? 'disabled' : 'active')}
              >
                <Button
                  danger={status === 'active'}
                  loading={statusMutation.isPending}
                  disabled={saving}
                >
                  {status === 'active' ? '停用商品' : '启用商品'}
                </Button>
              </Popconfirm>
            ) : null}
          </div>
          <Space>
            <Button onClick={onClose}>关闭</Button>
            {!readOnly ? (
              <Button type="primary" loading={saving} onClick={() => form.submit()}>
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
          description="创建成功后商品仍未映射供应商，不能发放；映射能力将在后续实施卡中提供。"
        />
      ) : detail.data ? (
        <Alert
          className="product-drawer-alert"
          type={detail.data.vendorFulfillmentEnabled ? 'success' : 'warning'}
          showIcon
          title={
            detail.data.vendorFulfillmentEnabled
              ? '供应商映射已生效'
              : '未映射供应商，当前不能发放'
          }
          description={
            detail.data.vendorFulfillmentEnabled
              ? undefined
              : '本版本的内部商品没有供应商映射；启用或停用只影响内部配置，不代表可以履约。'
          }
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

      {formError ? (
        <Alert
          className="product-drawer-alert"
          type="error"
          showIcon
          title={formError.message}
          description="本次修改未被保存，请根据提示调整后重试。"
        />
      ) : null}

      <Spin spinning={!isCreate && detail.isPending}>
        <Form<ProductFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={DEFAULT_VALUES}
          disabled={readOnly}
          onFinish={handleSubmit}
        >
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
            <Input.TextArea rows={3} maxLength={200} showCount placeholder="可选，运营内部说明" />
          </Form.Item>
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
          {!isCreate && detail.data ? (
            <Form.Item label="版本">
              <Input value={`v${detail.data.version}`} readOnly />
            </Form.Item>
          ) : null}
        </Form>
      </Spin>
    </Drawer>
  );
}
