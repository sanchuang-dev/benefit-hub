import type {
  AttemptOperation,
  AttemptResult,
  GiftVoucherState,
  OrderStatus,
  PrepaidGrantState,
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

/** A-mode operation state, deliberately separate from the platform order status. */
export const PREPAID_GRANT_STATE_LABELS: Record<PrepaidGrantState, string> = {
  reserved: '已持久化，结果待确认',
  accepted: '上力已受理（待用户领取）',
  unknown: '结果未知，需核实',
  rejected: '上力已明确拒绝',
};

export const PREPAID_GRANT_STATE_COLORS: Record<PrepaidGrantState, string> = {
  reserved: 'processing',
  accepted: 'blue',
  unknown: 'gold',
  rejected: 'red',
};

/** C-mode operation state, deliberately separate from the platform order status. */
export const GIFT_VOUCHER_STATE_LABELS: Record<GiftVoucherState, string> = {
  reserved: '已持久化，结果待确认',
  issued: '上力已签发（待用户领取）',
  unknown: '结果未知，需人工核实',
  rejected: '上力已明确拒绝',
};

export const GIFT_VOUCHER_STATE_COLORS: Record<GiftVoucherState, string> = {
  reserved: 'processing',
  issued: 'blue',
  unknown: 'gold',
  rejected: 'red',
};

/** Only the current provider key has an operator-facing display name. */
export function providerLabel(provider: string): string {
  return provider === 'yangmao' ? '上力（yangmao）' : provider;
}
