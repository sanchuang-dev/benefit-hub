import type {
  OperationsOrderDetailDto,
  OperationsOrderListResponse,
  OrderStatus,
} from '@sanchuang-dev/benefit-contracts';
import { apiRequest } from '../../shared/lib/api-client';

export interface OrderListParams {
  page: number;
  pageSize: number;
  /** Exact business source key; the server normalizes case. */
  businessSource?: string;
  /** Exact business order number, not a substring search. */
  businessOrderNo?: string;
  status?: OrderStatus;
  /** Inclusive UTC epoch-millisecond bounds derived from Beijing calendar days. */
  createdFrom?: number;
  createdTo?: number;
}

export function fetchOrders(params: OrderListParams): Promise<OperationsOrderListResponse> {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  if (params.businessSource) query.set('businessSource', params.businessSource);
  if (params.businessOrderNo) query.set('businessOrderNo', params.businessOrderNo);
  if (params.status) query.set('status', params.status);
  if (params.createdFrom !== undefined) query.set('createdFrom', String(params.createdFrom));
  if (params.createdTo !== undefined) query.set('createdTo', String(params.createdTo));
  return apiRequest<OperationsOrderListResponse>(`/api/v1/operations/orders?${query.toString()}`);
}

export async function fetchOrderDetail(id: string): Promise<OperationsOrderDetailDto> {
  const body = await apiRequest<{ order: OperationsOrderDetailDto }>(
    `/api/v1/operations/orders/${encodeURIComponent(id)}`,
  );
  return body.order;
}


/**
 * Admin-role / CSRF protected B-mode manual reissue. The upstream requestId
 * comes from the persisted B operation, NOT from these browser inputs.
 */
export async function reissueDirectTopup(
  id: string,
  request: { phone: string; refCode: string; paymentReference: string },
): Promise<OperationsOrderDetailDto> {
  const body = await apiRequest<{ order: OperationsOrderDetailDto }>(
    "/api/v1/operations/orders/" + encodeURIComponent(id) + "/direct-topup/reissue",
    { method: "POST", body: { ...request, confirmReissue: true } },
  );
  return body.order;
}
