import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AuditEventListResponse, SystemRuntimeDto } from '@sanchuang-dev/benefit-contracts';
import type { ApiError } from '../../shared/lib/api-client';
import { fetchAuditEvents, fetchRuntime, type AuditEventQuery } from './api';

export const runtimeQueryKey = ['system', 'runtime'] as const;

/**
 * Runtime facts change only on deploy/restart; a short stale time avoids
 * re-querying on every tab switch while still letting the refresh button fetch
 * a current snapshot.
 */
export function useRuntimeQuery() {
  return useQuery<SystemRuntimeDto, ApiError>({
    queryKey: runtimeQueryKey,
    queryFn: fetchRuntime,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * `enabled` is false for viewers: the API is admin-only and the page must not
 * fire a request it already knows will be rejected.
 */
export function useAuditEventsQuery(query: AuditEventQuery, enabled: boolean) {
  return useQuery<AuditEventListResponse, ApiError>({
    queryKey: ['admin', 'audit-events', query],
    queryFn: () => fetchAuditEvents(query),
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}
