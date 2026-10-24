/**
 * Benefit order domain model and invariants.
 *
 * This file deliberately imports nothing from the database layer: order rules
 * belong to the business layer, while storage details live in `repository.ts`.
 * Supplier protocols and signatures stay out of this slice entirely.
 */

/** The four supplier fulfilment shapes (A/B/C/D) described in docs/product-scope.md. */
export const FULFILLMENT_MODES = ['A', 'B', 'C', 'D'] as const;
export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number];

/**
 * Our own provider-agnostic order status. Supplier answer codes are never
 * stored here. `unknown` means the upstream outcome has not been verified yet
 * and must not be treated as failure or as permission to grant again.
 */
export const ORDER_STATUSES = [
  'pending',
  'processing',
  'awaiting_claim',
  'partially_completed',
  'completed',
  'failed',
  'unknown',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Operations we may record against an order; no supplier-specific action names. */
export const ATTEMPT_OPERATIONS = ['grant', 'query', 'reissue'] as const;
export type AttemptOperation = (typeof ATTEMPT_OPERATIONS)[number];

/**
 * What a single attempt observed. `accepted` only means the supplier
 * acknowledged the request, never that the benefit reached the user.
 */
export const ATTEMPT_RESULTS = ['accepted', 'rejected', 'unknown'] as const;
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];

/**
 * A persisted business grant intent. `businessSource + businessOrderNo` is the
 * caller-provided upstream identity; `id` is our stable internal order id.
 *
 * `mappingVersionId` is the immutable supplier mapping snapshot captured when a
 * new order was created (BHB-008). It is `null` only for orders created before
 * that snapshot mechanism existed: those historical facts are never backfilled
 * or rebound to a later mapping version.
 */
export interface BenefitOrder {
  id: string;
  businessSource: string;
  businessOrderNo: string;
  productId: string;
  mappingVersionId: string | null;
  fulfillmentMode: FulfillmentMode;
  status: OrderStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** Immutable status/version fact for reconstructing an order's local state history. */
export interface OrderStatusEvent {
  id: string;
  orderId: string;
  status: OrderStatus;
  version: number;
  createdAt: number;
}

/**
 * One recorded upstream call/verification fact. Upstream references are stable
 * supplier identifiers only; credentials, phone numbers, card keys, and raw
 * supplier payloads do not belong in this model.
 */
export interface FulfillmentAttempt {
  id: string;
  orderId: string;
  operation: AttemptOperation;
  upstreamRequestNo: string | null;
  upstreamOrderNo: string | null;
  result: AttemptResult;
  /** Internal status observed at the time; never a supplier status code. */
  observedStatus: OrderStatus | null;
  occurredAt: number;
  lastVerifiedAt: number | null;
}

export class OrderInputError extends Error {}
/** Same business identity, but the key parameters describe a different intent. */
export class OrderIntentConflictError extends Error {}
export class OrderVersionConflictError extends Error {}
export class OrderNotFoundError extends Error {}
export class OrderProductNotFoundError extends Error {}
/** The internal product exists but is disabled, so no new order may reference it. */
export class OrderProductDisabledError extends Error {}
/** The product has no current active supplier mapping snapshot to freeze. */
export class OrderMappingUnavailableError extends Error {}

/**
 * Our own source key (for example `local-life`). It is lower-cased so two
 * callers cannot create parallel identities that differ only by case.
 */
const BUSINESS_SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Business order numbers come from another system. Case is preserved because it
 * may be significant upstream, so `ORDER-1` and `order-1` stay distinct intents
 * rather than being merged silently.
 */
const BUSINESS_ORDER_NO_PATTERN = /^[!-~]{1,128}$/;

/** Upstream request/order references are bounded printable ASCII identifiers. */
const UPSTREAM_REF_PATTERN = /^[!-~]{1,128}$/;

export function normalizeBusinessSource(raw: string): string {
  if (typeof raw !== 'string') throw new OrderInputError('业务来源不能为空');
  const value = raw.trim().toLowerCase();
  if (!BUSINESS_SOURCE_PATTERN.test(value)) {
    throw new OrderInputError('业务来源需为 1-64 位字母、数字或 . _ -（统一转为小写）');
  }
  return value;
}

export function normalizeBusinessOrderNo(raw: string): string {
  if (typeof raw !== 'string') throw new OrderInputError('业务单号不能为空');
  const value = raw.trim();
  if (!BUSINESS_ORDER_NO_PATTERN.test(value)) {
    throw new OrderInputError('业务单号需为 1-128 位可见 ASCII 字符且不含空格');
  }
  return value;
}

/**
 * Empty references are treated as "not provided"; anything else must look like
 * a bounded supplier identifier. This keeps raw responses and free text out of
 * the attempt fact table.
 */
export function normalizeUpstreamRef(raw: string | null | undefined, label: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new OrderInputError(`${label}格式不正确`);
  const value = raw.trim();
  if (value === '') return null;
  if (!UPSTREAM_REF_PATTERN.test(value)) {
    throw new OrderInputError(`${label}需为 1-128 位可见 ASCII 字符`);
  }
  return value;
}

export function requireOrderId(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new OrderInputError('订单 ID 不能为空');
  return raw;
}

export function requireProductId(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new OrderInputError('内部商品 ID 不能为空');
  return raw.trim();
}

/** Timestamps are explicit UTC epoch milliseconds; never local-time strings. */
export function requireTimestamp(raw: number, label: string): number {
  if (!Number.isSafeInteger(raw) || raw < 0) {
    throw new OrderInputError(`${label}需为非负毫秒时间戳`);
  }
  return raw;
}

export function assertOrderStatus(raw: string): OrderStatus {
  if (!(ORDER_STATUSES as readonly string[]).includes(raw)) {
    throw new OrderInputError('订单状态不在内部统一状态集合内');
  }
  return raw as OrderStatus;
}

export function assertAttemptOperation(raw: string): AttemptOperation {
  if (!(ATTEMPT_OPERATIONS as readonly string[]).includes(raw)) {
    throw new OrderInputError(`操作类别需为 ${ATTEMPT_OPERATIONS.join('/')} 之一`);
  }
  return raw as AttemptOperation;
}

export function assertAttemptResult(raw: string): AttemptResult {
  if (!(ATTEMPT_RESULTS as readonly string[]).includes(raw)) {
    throw new OrderInputError(`结果类别需为 ${ATTEMPT_RESULTS.join('/')} 之一`);
  }
  return raw as AttemptResult;
}

/**
 * Stored values outside the documented sets are data corruption, not a reason
 * to fall back to a convenient default status.
 */
export function toFulfillmentMode(value: string): FulfillmentMode {
  if (!(FULFILLMENT_MODES as readonly string[]).includes(value)) {
    throw new Error(`Unknown fulfillment mode stored in database: ${value}`);
  }
  return value as FulfillmentMode;
}

export function toOrderStatus(value: string): OrderStatus {
  if (!(ORDER_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`Unknown order status stored in database: ${value}`);
  }
  return value as OrderStatus;
}

export function toAttemptOperation(value: string): AttemptOperation {
  if (!(ATTEMPT_OPERATIONS as readonly string[]).includes(value)) {
    throw new Error(`Unknown attempt operation stored in database: ${value}`);
  }
  return value as AttemptOperation;
}

export function toAttemptResult(value: string): AttemptResult {
  if (!(ATTEMPT_RESULTS as readonly string[]).includes(value)) {
    throw new Error(`Unknown attempt result stored in database: ${value}`);
  }
  return value as AttemptResult;
}
