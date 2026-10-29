import { useQuery } from '@tanstack/react-query';
import { apiRequest, type ApiError } from '../../shared/lib/api-client';

export interface SupplierSummary {
  key: 'yangmao';
  name: string;
  catalogRead: {
    supported: boolean;
    configured: boolean;
  };
}

interface SupplierListResponse {
  suppliers: SupplierSummary[];
}

interface SupplierDetailResponse {
  supplier: SupplierSummary;
}

export function useSuppliersQuery() {
  return useQuery<SupplierListResponse, ApiError>({
    queryKey: ['suppliers', 'list'],
    queryFn: () => apiRequest<SupplierListResponse>('/api/v1/suppliers'),
    retry: false,
  });
}

export function useSupplierQuery(key: 'yangmao') {
  return useQuery<SupplierDetailResponse, ApiError>({
    queryKey: ['suppliers', 'detail', key],
    queryFn: () => apiRequest<SupplierDetailResponse>('/api/v1/suppliers/' + key),
    retry: false,
  });
}
