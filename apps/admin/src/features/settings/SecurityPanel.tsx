import { Alert, Button, Card, Descriptions, Space, Tag, Typography } from 'antd';
import { useSessionQuery } from '../auth/use-auth';
import { formatDateTime } from '../../shared/lib/format-date-time';
import { formatSwitch } from './format';
import { RoleTag } from './RoleTag';
import { useRuntimeQuery } from './use-settings';

const { Paragraph, Text } = Typography;

/**
 * Session and effective-policy view. The policy values come from the server
 * runtime snapshot, so this card cannot drift from the login/creation rules.
 */
export function SecurityPanel() {
  const session = useSessionQuery();
  const runtime = useRuntimeQuery();
  const admin = session.data?.admin;
  const policy = runtime.data?.security;

  const loginFailureText = policy
    ? `同一账号 ${policy.loginFailure.windowMinutes} 分钟内 ${policy.loginFailure.perAccount} 次失败；同一来源 ${policy.loginFailure.windowMinutes} 分钟内 ${policy.loginFailure.perAddress} 次失败`
    : '—';

  const passwordText = policy
    ? [
        `至少 ${policy.password.minLength} 个字符`,
        `不超过 ${policy.password.maxLength} 个字符`,
        policy.password.noLeadingTrailingWhitespace ? '首尾不能是空白' : null,
        policy.password.mustNotContainUsername ? '不能包含账号名' : null,
      ]
        .filter(Boolean)
        .join('；')
    : '—';

  return (
    <Space orientation="vertical" size={16} className="page-stack">
      <Card title="当前会话">
        <Descriptions
          column={1}
          size="small"
          items={[
            { key: 'username', label: '账号', children: admin?.username ?? '—' },
            { key: 'displayName', label: '显示名', children: admin?.displayName ?? '—' },
            {
              key: 'role',
              label: '权限',
              children: admin ? <RoleTag role={admin.role} /> : '—',
            },
            {
              key: 'expiresAt',
              label: '会话到期时间',
              children: session.data ? formatDateTime(session.data.session.expiresAt) : '—',
            },
          ]}
        />
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          会话到期后需要重新登录；当前页面不会延长会话有效期。
        </Paragraph>
      </Card>

      {runtime.isError ? (
        <Alert
          type="error"
          showIcon
          title="无法读取生效安全策略"
          description={runtime.error.message}
          action={
            <Button size="small" onClick={() => void runtime.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      <Card title="生效安全策略" loading={runtime.isPending}>
        {policy ? (
          <>
            <Descriptions
              column={1}
              size="small"
              items={[
                { key: 'ttl', label: '会话有效期', children: `${policy.sessionTtlHours} 小时` },
                {
                  key: 'cookie',
                  label: 'Cookie Secure',
                  children: (
                    <Tag color={policy.cookieSecure ? 'green' : 'orange'}>
                      {formatSwitch(policy.cookieSecure)}
                    </Tag>
                  ),
                },
                {
                  key: 'proxy',
                  label: '信任反向代理转发头',
                  children: formatSwitch(policy.trustProxy),
                },
                { key: 'loginFailure', label: '登录失败限制', children: loginFailureText },
                { key: 'password', label: '密码策略', children: passwordText },
              ]}
            />
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
              <Text type="secondary">
                以上为服务端当前生效值，由部署配置决定；本页只读展示，不能在此修改运行环境。
              </Text>
            </Paragraph>
          </>
        ) : null}
      </Card>

      <Alert
        type="info"
        showIcon
        title="账号与安全写操作尚未接入页面"
        description="修改密码、退出其他会话与账号管理目前由服务器端管理员工具执行；接入后会在此页提供，并记录操作人、时间与结果。"
      />
    </Space>
  );
}
