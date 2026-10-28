import type {
  AttemptOperation,
  AttemptResult,
  OrderStatus,
} from '@sanchuang-dev/benefit-contracts';

/** Our unified platform status; never a supplier-native status label. */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: '待处理',
  processing: '处理中',
  awaiting_claim: '待用户领取',
  partially_completed: '部分完成',
  completed: '已完成',
  failed: '失败',
  unknown: '结果未知待核实',
};

/** Tag colors stay secondary to the text label, never the only signal. */
export const ORDER_STATUS_COLORS: Record<OrderStatus, string> = {
  pending: 'default',
  processing: 'processing',
  awaiting_claim: 'gold',
  partially_completed: 'orange',
  completed: 'green',
  failed: 'red',
  unknown: 'magenta',
};

export const ATTEMPT_OPERATION_LABELS: Record<AttemptOperation, string> = {
  grant: '发放请求',
  query: '状态查询',
  reissue: '补发请求',
};

/** `accepted` is supplier acknowledgement only, not a delivered benefit. */
export const ATTEMPT_RESULT_LABELS: Record<AttemptResult, string> = {
  accepted: '供应商已受理',
  rejected: '供应商已拒绝',
  unknown: '结果未知',
};

export const ATTEMPT_RESULT_COLORS: Record<AttemptResult, string> = {
  accepted: 'blue',
  rejected: 'red',
  unknown: 'gold',
};

/** Only the current provider key has an operator-facing display name. */
export function providerLabel(provider: string): string {
  return provider === 'yangmao' ? '上力（yangmao）' : provider;
}
