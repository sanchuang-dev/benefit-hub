import { apiRequest } from '../../shared/lib/api-client';

export interface AdminIdentity {
  id: string;
  username: string;
  displayName: string;
  role: AdminRole;
}

export type AdminRole = 'admin' | 'viewer';

export interface SessionResponse {
  admin: AdminIdentity;
  session: { expiresAt: number };
}

export interface LoginResponse extends SessionResponse {
  csrfToken: string;
}

export interface AccountSummary extends AdminIdentity {
  createdAt: number;
  disabled: boolean;
}

export interface SystemStatus {
  service: string;
  phase: string;
  adminEnabled: boolean;
  authenticationRequired: boolean;
}

export function fetchSession(): Promise<SessionResponse> {
  return apiRequest<SessionResponse>('/api/v1/auth/session');
}

export function login(username: string, password: string): Promise<LoginResponse> {
  return apiRequest<LoginResponse>('/api/v1/auth/login', {
    method: 'POST',
    body: { username, password },
  });
}

export function logout(): Promise<void> {
  return apiRequest<void>('/api/v1/auth/logout', { method: 'POST' });
}

export function fetchAccounts(): Promise<{ accounts: AccountSummary[] }> {
  return apiRequest<{ accounts: AccountSummary[] }>('/api/v1/admin/accounts');
}

export function fetchSystemStatus(): Promise<SystemStatus> {
  return apiRequest<SystemStatus>('/api/v1/system/status');
}
