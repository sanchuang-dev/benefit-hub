import {
  Alert,
  Button,
  Descriptions,
  Empty,
  Skeleton,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type {
  DeductionUnit,
  MappingDraftDto,
  MappingOverviewDto,
  MappingProvider,
  MappingVersionDto,
} from '@sanchuang-dev/benefit-contracts';
import { ApiError } from '../../shared/lib/api-client';
import { formatDateTime } from '../../shared/lib/format-date-time';
import { MappingContractError } from './api';
import './MappingPanel.css';
import { useMappingOverviewQuery } from './use-mapping';

const { Text } = Typography;

const PROVIDER_LABELS: Record<MappingProvider, string> = {
  yangmao: 'yangmao（羊毛）',
};

const DEDUCTION_UNIT_LABELS: Record<DeductionUnit, string> = {
  pack: 'pack（礼包 / 次数）',
  amount: 'amount（金额）',
};

function providerLabel(provider: MappingProvider): string {
  return PROVIDER_LABELS[provider];
}

function deductionUnitLabel(unit: DeductionUnit): string {
  return DEDUCTION_UNIT_LABELS[unit];
}

/**
 * Local validation is only a structural fact about the stored draft. It never
 * implies the upstream accepted the product code, so the tag copy and the
 * surrounding notice must keep those two facts separate.
 */
function DraftValidationTag({ draft }: { draft: MappingDraftDto }) {
  if (draft.validatedVersion === null) return <Tag color="gold">待本地校验</Tag>;
  if (draft.validatedVersion === draft.version) {
    return <Tag color="blue">已通过本地校验</Tag>;
  }
  return <Tag color="gold">草稿已修改，需重新校验</Tag>;
}

function loadErrorCopy(error: Error): { title: string; description: string } {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return {
        title: '登录状态已失效',
        description: '请刷新页面并重新登录后再查看供应商映射。',
      };
    }
    if (error.status === 403) {
      return {
        title: '无权查看供应商映射',
        description: '当前身份没有读取该商品供应商映射的权限；服务端仍会独立校验。',
      };
    }
    if (error.status === 404) {
      return {
        title: '内部商品不存在',
        description: '该商品可能已被删除，无法读取供应商映射。',
      };
    }
    return { title: '无法加载供应商映射', description: error.message };
  }

  if (error instanceof MappingContractError) {
    return {
      title: '供应商映射数据不符合共享契约',
      description: `${error.message}。为避免把异常响应当作空状态，本区域不展示任何映射信息。`,
    };
  }

  return { title: '无法加载供应商映射', description: '请求失败，请稍后重试。' };
}

function mappingVersionFields(version: MappingVersionDto) {
  return [
    { key: 'provider', label: '供应商', children: providerLabel(version.provider) },
    {
      key: 'productCode',
      label: '上游商品编码',
      children: <Text code>{version.productCode}</Text>,
    },
    { key: 'mode', label: '模式', children: version.fulfillmentMode },
    {
      key: 'unit',
      label: '扣减单位',
      children: deductionUnitLabel(version.deductionUnit),
    },
    {
      key: 'source',
      label: '来源草稿版本',
      children: `v${version.sourceDraftVersion}`,
    },
    { key: 'activatedBy', label: '激活者', children: version.activatedBy },
    {
      key: 'activatedAt',
      label: '激活时间',
      children: formatDateTime(version.activatedAt),
    },
  ];
}

function ActiveVersion({ overview }: { overview: MappingOverviewDto }) {
  const active = overview.activeVersion;
  if (!active) {
    return (
      <Alert
        type="info"
        showIcon
        title="当前没有生效映射"
        description="草稿保存后还需要本地校验与显式激活，才会生成生效版本；本面板不提供激活写操作。"
      />
    );
  }

  return (
    <div className="mapping-block">
      <Space size={8} wrap>
        <Text strong>当前生效版本</Text>
        <Tag color="blue">映射已激活</Tag>
      </Space>
      <Descriptions
        className="mapping-descriptions"
        size="small"
        column={1}
        bordered
        items={[
          { key: 'version', label: '版本', children: `v${active.versionNumber}` },
          ...mappingVersionFields(active),
        ]}
      />
    </div>
  );
}

function CurrentDraft({ draft }: { draft: MappingDraftDto | null }) {
  if (!draft) {
    return (
      <Text type="secondary" className="mapping-note">
        当前没有草稿改动。
      </Text>
    );
  }

  return (
    <div className="mapping-block">
      <Space size={8} wrap>
        <Text strong>当前草稿</Text>
        <Tag>草稿已保存</Tag>
        <DraftValidationTag draft={draft} />
      </Space>
      <Descriptions
        className="mapping-descriptions"
        size="small"
        column={1}
        bordered
        items={[
          { key: 'version', label: '草稿版本', children: `v${draft.version}` },
          { key: 'provider', label: '供应商', children: providerLabel(draft.provider) },
          {
            key: 'productCode',
            label: '上游商品编码',
            children: <Text code>{draft.productCode}</Text>,
          },
          { key: 'mode', label: '模式', children: draft.fulfillmentMode },
          {
            key: 'unit',
            label: '扣减单位',
            children: deductionUnitLabel(draft.deductionUnit),
          },
          {
            key: 'validated',
            label: '本地校验时间',
            children: draft.validatedAt === null ? '尚未通过本地校验' : formatDateTime(draft.validatedAt),
          },
          { key: 'updatedAt', label: '草稿更新时间', children: formatDateTime(draft.updatedAt) },
        ]}
      />
      <Text type="secondary" className="mapping-note">
        草稿保存与本地校验都不影响当前生效版本；草稿也不会被自动激活。
      </Text>
    </div>
  );
}

function MappingOverview({ overview }: { overview: MappingOverviewDto }) {
  return (
    <>
      <Alert
        className="mapping-upstream-alert"
        type="warning"
        showIcon
        title="上游尚未验证，真实权益发放仍禁用"
        description="validationScope 为 local、upstreamVerified 为 false：本地结构校验只检查字段与模式规则，不代表羊毛上游已受理该商品；映射已激活也不代表可以真实发券。"
      />

      <Tabs
        size="small"
        defaultActiveKey="current"
        items={[
          {
            key: 'current',
            label: '当前映射',
            children: (
              <Space orientation="vertical" size={16} className="mapping-tab-body">
                <ActiveVersion overview={overview} />
                <CurrentDraft draft={overview.draft} />
              </Space>
            ),
          },
          {
            key: 'history',
            label: `历史版本（${overview.versions.length}）`,
            children: (
              <Space orientation="vertical" size={12} className="mapping-tab-body">
                <Alert
                  type="info"
                  showIcon
                  title="历史版本只读"
                  description="历史激活版本不可直接修改；如需恢复旧配置，应在后续写操作能力中以旧版本新建草稿，再重新校验并显式激活。"
                />
                {overview.versions.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="还没有历史激活版本"
                  />
                ) : (
                  <Space orientation="vertical" size={16} className="mapping-tab-body">
                    {overview.versions.map((version) => (
                      <div key={version.id} className="mapping-block">
                        <Space size={8} wrap>
                          <Text strong>{`v${version.versionNumber}`}</Text>
                          <Tag>只读快照</Tag>
                          <Text type="secondary">{`来源草稿 v${version.sourceDraftVersion}`}</Text>
                        </Space>
                        <Descriptions
                          className="mapping-descriptions"
                          size="small"
                          column={1}
                          bordered
                          items={mappingVersionFields(version)}
                        />
                      </div>
                    ))}
                  </Space>
                )}
              </Space>
            ),
          },
        ]}
      />
    </>
  );
}

/**
 * Read-only supplier mapping panel. Every fact is derived from the server
 * overview; the panel has no draft, validate, or activate controls of its own.
 */
export function MappingPanel({ productId }: { productId: string }) {
  const query = useMappingOverviewQuery(productId);

  if (query.isPending) {
    return <Skeleton active title={{ width: '40%' }} paragraph={{ rows: 5 }} />;
  }

  if (query.isError) {
    const copy = loadErrorCopy(query.error);
    return (
      <Alert
        type="error"
        showIcon
        title={copy.title}
        description={copy.description}
        action={
          <Button size="small" loading={query.isFetching} onClick={() => void query.refetch()}>
            重试
          </Button>
        }
      />
    );
  }

  const overview = query.data;
  const isEmpty =
    overview.draft === null && overview.activeVersion === null && overview.versions.length === 0;

  if (isEmpty) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="尚未配置供应商映射"
      >
        <Text type="secondary">
          该内部商品还没有保存过映射草稿，也没有生效版本；本面板仅提供只读查看。
        </Text>
      </Empty>
    );
  }

  return <MappingOverview overview={overview} />;
}
