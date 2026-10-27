import { useQuery } from '@tanstack/react-query';
import type { MappingOverviewDto } from '@sanchuang-dev/benefit-contracts';
import { fetchMappingOverview } from './api';

export const mappingQueryKeys = {
  overview: (productId: string) => ['catalog', 'product', productId, 'mapping'] as const,
};

/**
 * Mapping reads are scoped to one product and one drawer session. `gcTime: 0`
 * plus `refetchOnMount: 'always'` prevent a reopened drawer from briefly showing
 * the previous session's overview before the fresh response arrives.
 */
export function useMappingOverviewQuery(productId: string | undefined) {
  return useQuery<MappingOverviewDto, Error>({
    queryKey: mappingQueryKeys.overview(productId ?? ''),
    queryFn: () => {
      if (!productId) throw new Error('商品 ID 缺失');
      return fetchMappingOverview(productId);
    },
    enabled: Boolean(productId),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });
}
