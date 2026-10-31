import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { OperationsOverviewDto, OverviewWindow } from '@sanchuang-dev/benefit-contracts';
import type { ApiError } from '../../shared/lib/api-client';
import { fetchOverview } from './api';

export const overviewQueryKeys = {
  root: ['operations', 'overview'] as const,
  window: (window: OverviewWindow) => ['operations', 'overview', window] as const,
};

/**
 * A short stale time keeps tab switching from re-querying on every focus while
 * still letting the operator force freshness with the refresh button. The page
 * must always show the server `asOf`, never the client clock.
 */
export function useOverviewQuery(window: OverviewWindow) {
  return useQuery<OperationsOverviewDto, ApiError>({
    queryKey: overviewQueryKeys.window(window),
    queryFn: () => fetchOverview(window),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
}
