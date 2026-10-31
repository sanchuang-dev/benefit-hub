import { Alert, Button, Card, Descriptions, Space, Tag, Typography } from 'antd';
import { formatDateTime } from '../../shared/lib/format-date-time';
import { formatUptime } from './format';
import { useRuntimeQuery } from './use-settings';

const { Paragraph, Text } = Typography;

function ConfiguredTag({ configured }: { configured: boolean }) {
  return configured ? <Tag color="green">已配置</Tag> : <Tag>未配置</Tag>;
}

/**
 * Runtime facts only. A missing build stamp, an unconfigured capability and a
 * broken database are three different states and are rendered as such; no value
 * here is inferred from the presence or absence of a secret.
 */
export function RuntimePanel() {
  const runtime = useRuntimeQuery();

  if (runtime.isError) {
    return (
      <Alert
        type="error"
        showIcon
        title="无法读取平台运行状态"
        description={runtime.error.message}
        action={
          <Button size="small" onClick={() => void runtime.refetch()}>
            重试
          </Button>
        }
      />
    );
  }

  const info = runtime.data;

  if (!info) {
    return (
      <Card loading>
        <span />
      </Card>
    );
  }

  const build = info.build;
  const database = info.database;
  const capabilities = info.capabilities;

  return (
    <Space orientation="vertical" size={16} className="page-stack">
      {!database.healthy ? (
        <Alert
          type="error"
          showIcon
          title="数据库当前不可用"
          description="健康检查未能连接 SQLite；迁移数量与最新迁移视为未知，服务端日志应作为排查依据。"
        />
      ) : null}

      <Card
        title="服务运行"
        extra={
          <Button size="small" onClick={() => void runtime.refetch()} loading={runtime.isFetching}>
            刷新
          </Button>
        }
      >
        <Descriptions
          column={1}
          size="small"
          items={[
            { key: 'service', label: '服务', children: info.service },
            {
              key: 'status',
              label: '运行状态',
              children: database.healthy ? (
                <Tag color="green">数据库已连接</Tag>
              ) : (
                <Tag color="red">数据库不可用</Tag>
              ),
            },
            { key: 'startedAt', label: '启动时间', children: formatDateTime(info.startedAt) },
            {
              key: 'uptime',
              label: '已运行',
              children: formatUptime(info.startedAt, info.generatedAt),
            },
            { key: 'node', label: 'Node.js', children: info.nodeVersion },
            { key: 'generatedAt', label: '状态生成时间', children: formatDateTime(info.generatedAt) },
          ]}
        />
      </Card>

      <Card title="构建版本">
        <Descriptions
          column={1}
          size="small"
          items={[
            { key: 'version', label: '版本', children: build.version ?? '未注入' },
            { key: 'commit', label: '提交', children: build.commit ?? '未注入' },
            {
              key: 'builtAt',
              label: '构建时间',
              children: build.builtAt !== null ? formatDateTime(build.builtAt) : '未注入',
            },
          ]}
        />
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          <Text type="secondary">
            构建信息由部署流程注入；「未注入」表示当前运行版本没有可核对的构建标记，不代表版本为 0。
          </Text>
        </Paragraph>
      </Card>

      <Card title="数据库">
        <Descriptions
          column={1}
          size="small"
          items={[
            {
              key: 'healthy',
              label: '连接状态',
              children: database.healthy ? (
                <Tag color="green">正常</Tag>
              ) : (
                <Tag color="red">不可用</Tag>
              ),
            },
            {
              key: 'applied',
              label: '已应用迁移',
              children: database.healthy ? `${database.appliedMigrations} 个` : '—',
            },
            {
              key: 'latest',
              label: '最新迁移',
              children: database.latestMigration ?? '—',
            },
          ]}
        />
      </Card>

      <Card title="能力配置">
        <Descriptions
          column={1}
          size="small"
          items={[
            {
              key: 'supplierRead',
              label: '上力只读凭证（环境变量）',
              children: <ConfiguredTag configured={capabilities.supplierReadCredentialsConfigured} />,
            },
            {
              key: 'masterKey',
              label: '供应商加密主密钥',
              children: <ConfiguredTag configured={capabilities.supplierMasterKeyConfigured} />,
            },
            {
              key: 'clients',
              label: '下游机器凭证（环境变量）',
              children:
                capabilities.businessOrderClientCount > 0
                  ? `${capabilities.businessOrderClientCount} 个业务来源`
                  : '未配置',
            },
          ]}
        />
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          <Text type="secondary">
            仅显示是否已配置与业务来源数量，不显示任何密钥、令牌或上游地址。数据库内保存的供应商接入配置请到「供应商管理」查看。
          </Text>
        </Paragraph>
      </Card>

      <Paragraph type="secondary">
        「已运行」时间由服务端启动时间推算；本页不使用浏览器时钟，也不代表业务可用性。供应商扣额与履约状态以真实订单记录为准。
      </Paragraph>
    </Space>
  );
}
