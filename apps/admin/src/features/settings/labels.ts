import type { AuditEventCategory } from '@sanchuang-dev/benefit-contracts';

/** Human labels for the audit categories the console renders. */
export const AUDIT_CATEGORY_LABELS: Record<AuditEventCategory, string> = {
  authentication: '登录与会话',
  account: '账号管理',
  other: '其他',
};

/** Ant Design Tag colors; `other` intentionally keeps the neutral default. */
export const AUDIT_CATEGORY_COLORS: Partial<Record<AuditEventCategory, string>> = {
  authentication: 'blue',
  account: 'purple',
};

/**
 * Stable event code → operator-facing label. Unknown codes fall back to the raw
 * code so a newer server event is never silently dropped or mislabeled.
 */
export const AUDIT_EVENT_LABELS: Record<string, string> = {
  'login.succeeded': '登录成功',
  'login.failed': '登录失败',
  'login.rate_limited': '登录尝试被限速',
  logout: '退出登录',
  'session.rejected': '会话被拒绝',
  'admin_account.created': '创建运营账号',
  'admin_account.password_reset': '重置账号密码',
  'admin_account.disabled': '停用运营账号',
  'admin_accounts.listed': '查看账号列表',
};

export function auditEventLabel(event: string): string {
  return AUDIT_EVENT_LABELS[event] ?? event;
}

/**
 * Detail codes are stable reason/operation identifiers from the server, e.g.
 * `invalid_credentials`; exposing the code is honest, inventing prose is not.
 */
export const AUDIT_DETAIL_LABELS: Record<string, string> = {
  invalid_credentials: '账号或密码不正确',
  account_disabled: '账号已停用',
  too_many_attempts: '尝试次数过多',
  password_rotated: '密码已重置',
};

/**
 * `detail` is event-specific: account creation stores the role as its detail
 * code, while login events store a reason code. Rendering stays explicit so a
 * role value is never presented as an error reason.
 */
export function auditDetailText(event: string, detail: string | null): string {
  if (!detail) return '—';
  if (event === 'admin_account.created') {
    if (detail === 'admin') return '角色：管理员';
    if (detail === 'viewer') return '角色：只读';
  }
  return AUDIT_DETAIL_LABELS[detail] ?? detail;
}
