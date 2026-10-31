import type {
  AuditEventCategory,
  AuditEventListResponse,
  SystemRuntimeDto,
  SystemRuntimeResponse,
} from '@sanchuang-dev/benefit-contracts';
import { apiRequest } from '../../shared/lib/api-client';

/** Filters the server-side audit read model understands. */
export interface AuditEventQuery {
  page: number;
  pageSize: number;
  category?: AuditEventCategory;
  event?: string;
  accountId?: string;
  from?: number;
  to?: number;
}

/**
 * Read-only runtime snapshot. The server decides every value; this client never
 * derives "configured" from an absent field or fills in a missing build stamp.
 */
export async function fetchRuntime(): Promise<SystemRuntimeDto> {
  const body = await apiRequest<SystemRuntimeResponse>('/api/v1/system/runtime');
  return body.runtime;
}

export function fetchAuditEvents(query: AuditEventQuery): Promise<AuditEventListResponse> {
  const search = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.category) search.set('category', query.category);
  if (query.event) search.set('event', query.event);
  if (query.accountId) search.set('accountId', query.accountId);
  if (query.from !== undefined) search.set('from', String(query.from));
  if (query.to !== undefined) search.set('to', String(query.to));

  return apiRequest<AuditEventListResponse>(`/api/v1/admin/audit-events?${search.toString()}`);
}
