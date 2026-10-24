import { Button, Result, Spin } from 'antd';
import { Navigate } from 'react-router';
import { ApiError } from '../shared/lib/api-client';
import { useSessionQuery } from '../features/auth/use-auth';
import { AppShell } from './shell/AppShell';

/**
 * Client-side gate for navigation only. Every protected API call is
 * independently authorized by the server; this redirect is UX, not security.
 */
export function ProtectedLayout() {
  const session = useSessionQuery();

  if (session.isPending) {
    return (
      <div className="page-loading">
        <Spin size="large" />
      </div>
    );
  }

  if (session.isError) {
    if (session.error instanceof ApiError && session.error.status === 401) {
      return (
        <Navigate
          to="/login"
          replace
          state={{ reason: session.error.code }}
        />
      );
    }

    return (
      <Result
        status="error"
        title="无法加载登录会话"
        subTitle={session.error.message}
        extra={
          <Button type="primary" onClick={() => session.refetch()}>
            重新加载
          </Button>
        }
      />
    );
  }

  if (!session.data) return null;

  return <AppShell admin={session.data.admin} />;
}
