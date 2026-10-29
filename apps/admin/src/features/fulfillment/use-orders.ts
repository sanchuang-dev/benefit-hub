import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  OperationsOrderDetailDto,
  OperationsOrderListResponse,
} from '@sanchuang-dev/benefit-contracts';
import { ApiError } from '../../shared/lib/api-client';
import { fetchOrderDetail, fetchOrders, type OrderListParams } from './api';

export const operationsOrderQueryKeys = {
  root: ['operations', 'orders'] as const,
  list: (params: OrderListParams) => ['operations', 'orders', 'list', params] as const,
  detail: (id: string) => ['operations', 'orders', 'detail', id] as const,
};

export function useOrdersQuery(params: OrderListParams) {
  return useQuery<OperationsOrderListResponse, ApiError>({
    queryKey: operationsOrderQueryKeys.list(params),
    queryFn: () => fetchOrders(params),
    // Paging and filtering keep the previous page visible instead of flashing
    // an empty table while the next server page is in flight.
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Detail is read only when the operator opens one order. */
export function useOrderDetailQuery(orderId: string | null) {
  return useQuery<OperationsOrderDetailDto, ApiError>({
    queryKey: operationsOrderQueryKeys.detail(orderId ?? ''),
    queryFn: () => {
      if (!orderId) throw new Error('订单 ID 缺失');
      return fetchOrderDetail(orderId);
    },
    enabled: Boolean(orderId),
    staleTime: 0,
    retry: false,
  });
}
