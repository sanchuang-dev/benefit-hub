import {
  Alert,
  App as AntdApp,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  FULFILLMENT_MODES,
  MAPPING_PROVIDERS,
  SUPPLIER_PRODUCT_CODE_PATTERN,
  saveMappingDraftRequestSchema,
  type DeductionUnit,
  type FulfillmentMode,
  type MappingDraftDto,
  type MappingOverviewDto,
  type MappingProvider,
  type MappingValidationIssue,
  type SaveMappingDraftRequest,
} from '@sanchuang-dev/benefit-contracts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../shared/lib/api-client';
import { formatDateTime } from '../../shared/lib/format-date-time';
import { MappingContractError } from './api';
import { useSaveMappingDraftMutation, useValidateMappingDraftMutation, useActivateMappingDraftMutation } from './use-mapping';

const { Text } = Typography;

interface MappingFormValues {
  provider: MappingProvider;
  productCode: string;
  fulfillmentMode: FulfillmentMode;
  deductionUnit: DeductionUnit;
}

const DEFAULT_FORM_VALUES: MappingFormValues = {
  provider: 'yangmao',
  productCode: '',
  fulfillmentMode: 'A',
  deductionUnit: 'pack',
};

const PROVIDER_OPTIONS = MAPPING_PROVIDERS.map((provider) => ({
  value: provider,
  label: `${provider}（羊毛）`,
}));

const FULFILLMENT_MODE_OPTIONS = FULFILLMENT_MODES.map((mode) => ({
  value: mode,
  label: mode,
}));

const DEDUCTION_UNIT_OPTIONS: { value: DeductionUnit; label: string }[] = [
  { value: 'pack', label: 'pack（礼包 / 次数）' },
  { value: 'amount', label: 'amount（金额）' },
];

/** Only A/B/C `pack` and D `amount` pass the API's local structural check. */
function modeUnitMismatch(mode: FulfillmentMode | undefined, unit: DeductionUnit | undefined) {
  if (!mode || !unit) return false;
  return (mode === 'D' ? 'amount' : 'pack') !== unit;
}

/** Stable local-validation issue codes; never raw supplier content. */
const VALIDATION_ISSUE_LABELS: Record<MappingValidationIssue, string> = {
  product_missing: '内部商品不存在或已被删除',
  provider_unsupported: '供应商不在本期支持范围内（当前仅支持 yangmao）',
  product_code_invalid: '上游商品编码格式不正确，需为 1-64 位字母、数字或 . _ -',
  fulfillment_mode_unsupported: '履约模式不受支持，只能是 A/B/C/D',
  deduction_unit_mismatch: '扣减单位与履约模式不匹配：A/B/C 使用 pack，D 使用 amount',
};

function validationIssueLabel(issue: string): string {
  return (
    VALIDATION_ISSUE_LABELS[issue as MappingValidationIssue] ?? `未识别的本地校验问题（${issue}）`
  );
}

const MAPPING_FORM_FIELDS = [
  'provider',
  'productCode',
  'fulfillmentMode',
  'deductionUnit',
] as const;

type MappingFormField = (typeof MAPPING_FORM_FIELDS)[number];

function isFormField(value: string): value is MappingFormField {
  return (MAPPING_FORM_FIELDS as readonly string[]).includes(value);
}

type ConflictCode =
  | 'MAPPING_ALREADY_EXISTS'
  | 'MAPPING_VERSION_CONFLICT'
  | 'MAPPING_NOT_VALIDATED';

const CONFLICT_COPY: Record<ConflictCode, { title: string; description: string }> = {
  MAPPING_ALREADY_EXISTS: {
    title: '该商品已存在映射草稿',
    description: '首次创建被拒绝，服务器上已有更早的草稿。为避免覆盖，请重新加载最新版本后再编辑。',
  },
  MAPPING_VERSION_CONFLICT: {
    title: '映射草稿版本已变化',
    description: '其他操作已经更新了草稿版本。为避免覆盖服务器上较新的内容，请重新加载后再操作。',
  },
  MAPPING_NOT_VALIDATED: {
    title: '当前草稿版本尚未通过本地校验',
    description: '服务器上的草稿版本可能已被修改。请重新加载并核对该版本后，再保存、校验或激活。',
  },
};

type EditorFeedback =
  | { kind: 'validation'; issues: readonly string[]; message: string }
  | { kind: 'error'; title: string; description: string };

function draftToFormValues(draft: MappingDraftDto): MappingFormValues {
  return {
    provider: draft.provider,
    productCode: draft.productCode,
    fulfillmentMode: draft.fulfillmentMode,
    deductionUnit: draft.deductionUnit,
  };
}

function sameFormValues(left: MappingFormValues, right: MappingFormValues): boolean {
  return (
    left.provider === right.provider &&
    left.productCode === right.productCode &&
    left.fulfillmentMode === right.fulfillmentMode &&
    left.deductionUnit === right.deductionUnit
  );
}

function fieldValueLabel(
  field: 'provider' | 'productCode' | 'fulfillmentMode' | 'deductionUnit',
  source: { provider: MappingProvider; productCode: string; fulfillmentMode: FulfillmentMode; deductionUnit: DeductionUnit },
): string {
  switch (field) {
    case 'provider':
      return source.provider === 'yangmao' ? 'yangmao（羊毛）' : source.provider;
    case 'productCode':
      return source.productCode;
    case 'fulfillmentMode':
      return source.fulfillmentMode;
    case 'deductionUnit':
      return source.deductionUnit === 'pack' ? 'pack（礼包 / 次数）' : 'amount（金额）';
  }
}

const DIFF_FIELDS = [
  { key: 'provider', label: '供应商' },
  { key: 'productCode', label: '上游商品编码' },
  { key: 'fulfillmentMode', label: '履约模式' },
  { key: 'deductionUnit', label: '扣减单位' },
] as const;

/** A disabled Ant Design button cannot show its own tooltip without a wrapper. */
function WithHint({ hint, children }: { hint: string | null; children: ReactNode }) {
  if (!hint) return <>{children}</>;
  return (
    <Tooltip title={hint}>
      <span>{children}</span>
    </Tooltip>
  );
}

interface MappingDraftEditorProps {
  productId: string;
  overview: MappingOverviewDto;
  /** Reads the latest overview after a conflict; resolves null on failure. */
  onReload: () => Promise<MappingOverviewDto | null>;
  onDirtyChange: (dirty: boolean) => void;
}

/**
 * Admin-only draft editor for one product. The server overview stays the only
 * source of truth: every write replaces the cached overview with the response,
 * and a locally validated draft is never presented as upstream-verified.
 */
export function MappingDraftEditor({
  productId,
  overview,
  onReload,
  onDirtyChange,
}: MappingDraftEditorProps) {
  const [form] = Form.useForm<MappingFormValues>();
  const { message, modal } = AntdApp.useApp();
  const [dirty, setDirty] = useState(false);
  // Version of the overview snapshot the form was hydrated from. Saves and
  // validations must never borrow a newer version for older form content.
  const [baseVersion, setBaseVersion] = useState<number | null>(
    overview.draft?.version ?? null,
  );
  const [baselineValues, setBaselineValues] = useState<MappingFormValues>(
    overview.draft ? draftToFormValues(overview.draft) : DEFAULT_FORM_VALUES,
  );
  const [reloading, setReloading] = useState(false);
  const [conflicted, setConflicted] = useState<ConflictCode | null>(null);
  const [feedback, setFeedback] = useState<EditorFeedback | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Guards same-tick double clicks before React re-renders the disabled state.
  const requestInFlight = useRef(false);

  const saveMutation = useSaveMappingDraftMutation(productId);
  const validateMutation = useValidateMappingDraftMutation(productId);
  const activateMutation = useActivateMappingDraftMutation(productId);
  const busy =
    saveMutation.isPending ||
    validateMutation.isPending ||
    activateMutation.isPending ||
    reloading;

  const draft = overview.draft;
  const mode = Form.useWatch('fulfillmentMode', form);
  const unit = Form.useWatch('deductionUnit', form);

  /**
   * The form must not follow query updates while the operator has unsaved
   * input or an unresolved version conflict; that would silently replace it.
   */
  useEffect(() => {
    if (dirty || conflicted) return;
    const nextValues = draft ? draftToFormValues(draft) : DEFAULT_FORM_VALUES;
    form.setFieldsValue(nextValues);
    setBaselineValues(nextValues);
    setBaseVersion(draft?.version ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, dirty, conflicted, form]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const applyDraftToForm = (next: MappingDraftDto | null) => {
    const nextValues = next ? draftToFormValues(next) : DEFAULT_FORM_VALUES;
    form.setFieldsValue(nextValues);
    setBaselineValues(nextValues);
    setBaseVersion(next?.version ?? null);
    setDirty(false);
  };

  const locked = conflicted !== null;
  /**
   * Writes use the same snapshot the form was hydrated from. If the server has
   * moved on since then, the version check fails safely instead of overwriting
   * newer content; activation additionally requires no unsaved edits.
   */
  const sameSnapshot =
    Boolean(draft) && !dirty && baseVersion !== null && baseVersion === draft?.version;
  const locallyValidated = Boolean(draft && draft.validatedVersion === draft.version);
  const canActivate = sameSnapshot && locallyValidated && !locked;

  const saveDisabled = !dirty || busy || locked;
  const validateDisabled = !sameSnapshot || busy || locked;
  const activateDisabled = !canActivate || busy;

  const saveHint = locked
    ? '存在版本冲突，请先重新加载最新版本'
    : busy
      ? null
      : !dirty
        ? '表单没有未保存的修改'
        : null;
  const validateHint = locked
    ? '存在版本冲突，请先重新加载最新版本'
    : !draft || baseVersion === null
      ? '请先保存草稿'
      : dirty
        ? '表单有未保存的修改，请先保存草稿'
        : baseVersion !== draft.version
          ? '服务器草稿版本已变化，请先刷新映射状态'
          : null;
  const activateHint = locked
    ? '存在版本冲突，请先重新加载最新版本'
    : !draft || baseVersion === null
      ? '请先保存草稿并完成本地校验'
      : dirty
        ? '表单有未保存的修改，请先保存草稿'
        : baseVersion !== draft.version
          ? '服务器草稿版本已变化，请先刷新映射状态'
          : !locallyValidated
            ? '当前草稿版本尚未通过本地校验'
            : null;

  const applyApiError = (error: unknown) => {
    if (error instanceof MappingContractError) {
      setFeedback({
        kind: 'error',
        title: '供应商映射响应不符合共享契约',
        description: error.message,
      });
      return;
    }
    if (!(error instanceof ApiError)) {
      setFeedback({
        kind: 'error',
        title: '操作失败',
        description: '请求未完成，本次没有写入草稿或激活映射，请稍后重试。',
      });
      return;
    }

    if (
      error.code === 'MAPPING_ALREADY_EXISTS' ||
      error.code === 'MAPPING_VERSION_CONFLICT' ||
      error.code === 'MAPPING_NOT_VALIDATED'
    ) {
      setConflicted(error.code);
      setFeedback(null);
      return;
    }

    if (error.code === 'MAPPING_VALIDATION_FAILED') {
      setFeedback({
        kind: 'validation',
        issues: error.issues ?? [],
        message: error.message,
      });
      return;
    }

    if (error.code === 'INVALID_REQUEST') {
      const fieldErrors = (error.fields ?? [])
        .filter(isFormField)
        .map((name) => ({ name, errors: ['未通过服务端参数校验'] }));
      if (fieldErrors.length > 0) form.setFields(fieldErrors);
      setFeedback({
        kind: 'error',
        title: '映射草稿参数不正确',
        description: error.message,
      });
      return;
    }

    if (error.status === 403) {
      setFeedback({
        kind: 'error',
        title: '服务端拒绝该操作',
        description: `当前身份没有管理员权限，映射未保存或激活。${error.message}`,
      });
      return;
    }

    if (error.status === 401) {
      setFeedback({
        kind: 'error',
        title: '登录状态已失效',
        description: '请刷新页面并重新登录后再操作；本次请求未被接受。',
      });
      return;
    }

    setFeedback({
      kind: 'error',
      title: error.status === 0 ? '网络请求失败' : '映射操作失败',
      description: `${error.message}；本次没有把操作当作成功。`,
    });
  };

  const handleSave = async (values: MappingFormValues) => {
    if (requestInFlight.current || busy || locked || !dirty) return;
    requestInFlight.current = true;
    setFeedback(null);

    try {
      const candidate: SaveMappingDraftRequest = {
        // `null` only for a first create; edits always carry the hydrated version.
        expectedVersion: baseVersion,
        provider: values.provider,
        productCode: values.productCode,
        fulfillmentMode: values.fulfillmentMode,
        deductionUnit: values.deductionUnit,
      };
      const parsed = saveMappingDraftRequestSchema.safeParse(candidate);
      if (!parsed.success) {
        const fieldErrors = [
          ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? ''))),
        ]
          .filter(isFormField)
          .map((name) => ({ name, errors: ['不符合共享契约'] }));
        if (fieldErrors.length > 0) form.setFields(fieldErrors);
        setFeedback({
          kind: 'error',
          title: '映射草稿参数不正确',
          description: '请检查表单字段；请求未发送。',
        });
        return;
      }

      const result = await saveMutation.mutateAsync(parsed.data);
      applyDraftToForm(result.draft);
      setConflicted(null);
      message.success('草稿已保存，未生效');
    } catch (error) {
      applyApiError(error);
    } finally {
      requestInFlight.current = false;
    }
  };

  const handleValidate = async () => {
    if (requestInFlight.current || busy || locked || !draft || !sameSnapshot || baseVersion === null) {
      return;
    }
    requestInFlight.current = true;
    setFeedback(null);
    try {
      const result = await validateMutation.mutateAsync({ version: baseVersion });
      applyDraftToForm(result.draft);
      message.success('本地校验已记录，仅代表本地结构检查');
    } catch (error) {
      applyApiError(error);
    } finally {
      requestInFlight.current = false;
    }
  };

  const reloadLatest = async () => {
    if (requestInFlight.current || reloading || busy) return;
    requestInFlight.current = true;
    setReloading(true);
    try {
      const latest = await onReload();
      if (!latest) {
        setFeedback({
          kind: 'error',
          title: '无法加载最新映射状态',
          description: '刷新失败，保留当前输入与冲突锁定；请稍后重试。',
        });
        return;
      }
      applyDraftToForm(latest.draft);
      setConflicted(null);
      setFeedback(null);
      message.info(
        latest.draft ? `已加载最新草稿 v${latest.draft.version}` : '已加载最新映射状态',
      );
    } finally {
      requestInFlight.current = false;
      setReloading(false);
    }
  };

  const requestReload = () => {
    if (dirty) {
      modal.confirm({
        title: '放弃未保存的映射修改？',
        content: '重新加载会使用服务器上的最新草稿覆盖当前输入。',
        okText: '放弃并刷新',
        cancelText: '继续编辑',
        okButtonProps: { danger: true },
        onOk: () => reloadLatest(),
      });
      return;
    }
    void reloadLatest();
  };

  const handleActivate = async () => {
    if (requestInFlight.current || !draft || baseVersion === null || busy || !canActivate) return;
    requestInFlight.current = true;
    try {
      const result = await activateMutation.mutateAsync({ version: baseVersion });
      applyDraftToForm(result.draft);
      setConflicted(null);
      setFeedback(null);
      setConfirmOpen(false);
      const activated = result.activeVersion;
      message.success(
        activated
          ? `映射 v${activated.versionNumber} 已激活，仅影响此后新建订单`
          : '映射已激活，仅影响此后新建订单',
      );
    } catch (error) {
      setConfirmOpen(false);
      applyApiError(error);
    } finally {
      requestInFlight.current = false;
    }
  };

  const confirmedDraft = draft;
  const activeVersion = overview.activeVersion;

  return (
    <div className="mapping-editor">
      <Space size={8} wrap className="mapping-editor-heading">
        <Text strong>映射草稿编辑</Text>
        {draft ? <Tag>{`草稿 v${draft.version}`}</Tag> : <Tag>尚未保存草稿</Tag>}
        {dirty ? (
          <Tag color="gold">表单已修改，需保存并重新校验</Tag>
        ) : locallyValidated && draft ? (
          <Tag color="blue">{`本地校验有效（v${draft.version}）`}</Tag>
        ) : (
          <Tag color="gold">待本地校验</Tag>
        )}
      </Space>

      <Text type="secondary" className="mapping-note">
        保存、校验和激活都直接调用映射 API。validationScope: {overview.validationScope} · upstreamVerified:{' '}
        {String(overview.upstreamVerified)}
        ：本地校验只检查本地字段与模式规则，不代表羊毛上游已受理该商品。
      </Text>

      {conflicted ? (
        <Alert
          className="mapping-editor-alert"
          type="warning"
          showIcon
          title={CONFLICT_COPY[conflicted].title}
          description={`${CONFLICT_COPY[conflicted].description} 当前输入会保留，但在刷新前不能继续保存、校验或激活。`}
          action={
            <Button loading={reloading} onClick={requestReload}>
              重新加载最新版本
            </Button>
          }
        />
      ) : null}

      {feedback?.kind === 'validation' ? (
        <Alert
          className="mapping-editor-alert"
          type="error"
          showIcon
          title="草稿未通过本地校验"
          description={
            <div>
              <div>{feedback.message}（未调用供应商，也不代表上游验证）</div>
              <ul className="mapping-validation-issues">
                {(feedback.issues.length > 0
                  ? feedback.issues
                  : ['服务器未返回可用的本地校验原因']
                ).map((issue) => (
                  <li key={issue}>{validationIssueLabel(issue)}</li>
                ))}
              </ul>
            </div>
          }
        />
      ) : null}

      {feedback?.kind === 'error' ? (
        <Alert
          className="mapping-editor-alert"
          type="error"
          showIcon
          title={feedback.title}
          description={feedback.description}
        />
      ) : null}

      {draft && !dirty && locallyValidated ? (
        <Text type="secondary" className="mapping-note">
          {`本地校验记录：草稿 v${draft.validatedVersion} 通过于 ${formatDateTime(draft.validatedAt ?? 0)}；该草稿仍处于待上游验证状态。`}
        </Text>
      ) : null}

      <Form<MappingFormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={DEFAULT_FORM_VALUES}
        disabled={busy}
        onValuesChange={(_, allValues) => {
          const nextDirty = !sameFormValues(allValues, baselineValues);
          setDirty(nextDirty);
          if (nextDirty) setFeedback(null);
        }}
        onFinish={handleSave}
      >
        <div className="mapping-editor-grid">
          <Form.Item
            label="供应商"
            name="provider"
            rules={[{ required: true, message: '请选择供应商' }]}
          >
            <Select options={PROVIDER_OPTIONS} />
          </Form.Item>
          <Form.Item
            label="上游商品编码"
            name="productCode"
            extra="保存时去除首尾空格；编码区分大小写，不会作为供应商验证结果。"
            rules={[
              { required: true, whitespace: true, message: '请输入上游商品编码' },
              {
                pattern: SUPPLIER_PRODUCT_CODE_PATTERN,
                message: '上游商品编码需为 1-64 位字母、数字或 . _ -',
              },
            ]}
          >
            <Input placeholder="例如 YM-1001" autoComplete="off" />
          </Form.Item>
          <Form.Item
            label="履约模式"
            name="fulfillmentMode"
            rules={[{ required: true, message: '请选择履约模式' }]}
          >
            <Select options={FULFILLMENT_MODE_OPTIONS} />
          </Form.Item>
          <Form.Item
            label="扣减单位"
            name="deductionUnit"
            extra="A/B/C 对应 pack，D 对应 amount；前端提示不替代服务端本地校验。"
            rules={[{ required: true, message: '请选择扣减单位' }]}
          >
            <Select options={DEDUCTION_UNIT_OPTIONS} />
          </Form.Item>
        </div>

        {modeUnitMismatch(mode, unit) ? (
          <Alert
            className="mapping-editor-alert"
            type="warning"
            showIcon
            title="履约模式与扣减单位可能不匹配"
            description="A/B/C 只能按 pack 扣减，D 只能按 amount 扣减。仍可保存草稿，但服务端本地校验会拒绝该组合。"
          />
        ) : null}

        <Space size={8} wrap className="mapping-editor-actions">
          <WithHint hint={saveHint}>
            <Button
              type="primary"
              htmlType="submit"
              loading={saveMutation.isPending}
              disabled={saveDisabled}
            >
              保存草稿
            </Button>
          </WithHint>
          <WithHint hint={validateHint}>
            <Button loading={validateMutation.isPending} disabled={validateDisabled} onClick={handleValidate}>
              本地校验
            </Button>
          </WithHint>
          <WithHint hint={activateHint}>
            <Button
              type="primary"
              ghost
              loading={activateMutation.isPending}
              disabled={activateDisabled}
              onClick={() => setConfirmOpen(true)}
            >
              激活映射
            </Button>
          </WithHint>
          <Button loading={reloading} disabled={busy || reloading} onClick={requestReload}>
            刷新映射状态
          </Button>
        </Space>
      </Form>

      <Modal
        open={confirmOpen}
        title={confirmedDraft ? `确认激活映射草稿 v${confirmedDraft.version}` : '确认激活映射'}
        okText="确认激活"
        cancelText="取消"
        confirmLoading={activateMutation.isPending}
        onOk={handleActivate}
        onCancel={() => {
          if (!activateMutation.isPending) setConfirmOpen(false);
        }}
        destroyOnHidden
        width={640}
      >
        {activeVersion ? (
          <>
            <Text strong>当前生效版本 v{activeVersion.versionNumber} 与拟激活草稿的差异</Text>
            <Descriptions
              className="mapping-modal-descriptions"
              size="small"
              column={1}
              bordered
              items={DIFF_FIELDS.map(({ key, label }) => {
                const previous = fieldValueLabel(key, activeVersion);
                const next = confirmedDraft ? fieldValueLabel(key, confirmedDraft) : '—';
                const changed = previous !== next;
                return {
                  key,
                  label,
                  children: (
                    <Space size={8} wrap>
                      <Text type={changed ? 'secondary' : undefined} delete={changed}>
                        {previous}
                      </Text>
                      {changed ? <span aria-hidden>→</span> : null}
                      <Text strong={changed}>{next}</Text>
                      {changed ? <Tag color="gold">变更</Tag> : null}
                    </Space>
                  ),
                };
              })}
            />
          </>
        ) : (
          <>
            <Alert
              type="info"
              showIcon
              title="此前无生效版本"
              description="本次将是该内部商品第一次激活供应商映射。"
            />
            <Descriptions
              className="mapping-modal-descriptions"
              size="small"
              column={1}
              bordered
              title="拟激活内容"
              items={
                confirmedDraft
                  ? DIFF_FIELDS.map(({ key, label }) => ({
                      key,
                      label,
                      children: fieldValueLabel(key, confirmedDraft),
                    }))
                  : []
              }
            />
          </>
        )}

        <Alert
          className="mapping-editor-alert"
          type="warning"
          showIcon
          title="激活影响范围"
          description={
            <ul className="mapping-modal-list">
              <li>只影响此后新建订单；旧订单已绑定原映射版本，保持不变。</li>
              <li>本次仅基于本地结构校验，未进行上游验证（upstreamVerified: false）。</li>
              <li>激活映射只绑定订单使用的供货关系；具体派发与到账状态由订单履约记录确定。</li>
            </ul>
          }
        />
      </Modal>
    </div>
  );
}
