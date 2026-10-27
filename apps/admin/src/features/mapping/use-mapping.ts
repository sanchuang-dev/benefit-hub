import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  ActivateMappingDraftRequest,
  MappingOverviewDto,
  SaveMappingDraftRequest,
  ValidateMappingDraftRequest,
} from '@sanchuang-dev/benefit-contracts';
import { ApiError } from '../../shared/lib/api-client';
import {
  activateMappingDraft,
  fetchMappingOverview,
  saveMappingDraft,
  validateMappingDraft,
} from './api';

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

/**
 * A successful mapping write returns the authoritative overview for exactly
 * one product. Replacing the cached overview with that response keeps the UI
 * from asserting a local optimistic state the server did not persist.
 */
function setOverview(queryClient: QueryClient, overview: MappingOverviewDto) {
  queryClient.setQueryData(mappingQueryKeys.overview(overview.productId), overview);
}

export function useSaveMappingDraftMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation<MappingOverviewDto, ApiError, SaveMappingDraftRequest>({
    mutationFn: (input) => saveMappingDraft(productId, input),
    onSuccess: (overview) => setOverview(queryClient, overview),
  });
}

export function useValidateMappingDraftMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation<MappingOverviewDto, ApiError, ValidateMappingDraftRequest>({
    mutationFn: (input) => validateMappingDraft(productId, input),
    onSuccess: (overview) => setOverview(queryClient, overview),
  });
}

export function useActivateMappingDraftMutation(productId: string) {
  const queryClient = useQueryClient();
  return useMutation<MappingOverviewDto, ApiError, ActivateMappingDraftRequest>({
    mutationFn: (input) => activateMappingDraft(productId, input),
    onSuccess: (overview) => setOverview(queryClient, overview),
  });
}
