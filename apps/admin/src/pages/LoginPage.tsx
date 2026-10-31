import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { LockKeyhole, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../shared/lib/api-client';
import { useLoginMutation, useSessionQuery } from '../features/auth/use-auth';
import './LoginPage.css';

const { Title, Paragraph, Text } = Typography;

interface LoginFormValues {
  username: string;
  password: string;
}

interface LoginLocationState {
  reason?: string;
}

const REASON_FEEDBACK: Record<string, { type: 'warning' | 'info'; text: string }> = {
  SESSION_EXPIRED: { type: 'warning', text: '登录已过期，请重新登录。' },
  LOGGED_OUT: { type: 'info', text: '已安全退出登录。' },
};

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSessionQuery();
  const loginMutation = useLoginMutation();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const state = (location.state ?? {}) as LoginLocationState;

  if (session.data) {
    return <Navigate to="/" replace />;
  }

  const reason = state.reason ? REASON_FEEDBACK[state.reason] : undefined;

  const handleSubmit = async (values: LoginFormValues) => {
    setErrorMessage(null);
    try {
      await loginMutation.mutateAsync({
        username: values.username.trim(),
        password: values.password,
      });
      // design.md §4: a successful login always lands on 总览.
      navigate('/', { replace: true });
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : '登录失败，请稍后重试');
    }
  };

  return (
    <div className="login-page">
      <section className="login-brand">
        {/* White lockup from public/brand: the only variant that stays legible on
            the blue cover. The 720px file is the 2x source. */}
        <img
          className="login-brand-logo"
          src="/brand/logo-horizontal-white-360.png"
          srcSet="/brand/logo-horizontal-white-360.png 1x, /brand/logo-horizontal-white-720.png 2x"
          alt="三创 SANCHUANG"
          width={180}
          height={80}
        />
        <Text className="login-brand-eyebrow">3C · BENEFIT HUB</Text>
        <Title level={1} className="login-brand-title">
          权益服务平台
        </Title>
        <Paragraph className="login-brand-lead">统一权益适配与轻量运营后台</Paragraph>
        <ul className="login-brand-points">
          <li>供应商权益适配与履约状态追踪</li>
          <li>内部商品与供应商映射版本管理</li>
          <li>最小权限的管理员操作与审计</li>
        </ul>
        <Text className="login-brand-footnote">仅限已授权的运营人员使用</Text>
      </section>

      <section className="login-panel">
        <Card className="login-card" variant="borderless">
          <Title level={3} className="login-title">
            运营后台登录
          </Title>
          <Paragraph type="secondary" className="login-subtitle">
            请使用已创建的管理员账号登录。
          </Paragraph>

          {reason ? (
            <Alert className="login-alert" type={reason.type} showIcon title={reason.text} />
          ) : null}
          {errorMessage ? (
            <Alert className="login-alert" type="error" showIcon title={errorMessage} />
          ) : null}

          <Form<LoginFormValues>
            layout="vertical"
            requiredMark={false}
            onFinish={handleSubmit}
            autoComplete="on"
          >
            <Form.Item
              label="账号"
              name="username"
              rules={[{ required: true, whitespace: true, message: '请输入账号' }]}
            >
              <Input
                size="large"
                autoComplete="username"
                placeholder="请输入账号"
                prefix={<UserRound size={16} aria-hidden="true" />}
              />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                size="large"
                autoComplete="current-password"
                placeholder="请输入密码"
                prefix={<LockKeyhole size={16} aria-hidden="true" />}
              />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              size="large"
              block
              loading={loginMutation.isPending}
            >
              登录
            </Button>
          </Form>

          <Paragraph type="secondary" className="login-hint">
            账号由系统管理员创建，不提供自助注册或邮件找回密码。
          </Paragraph>
        </Card>
      </section>
    </div>
  );
}
