/**
 * Benefit order domain model and invariants.
 *
 * This file deliberately imports nothing from the database layer: order rules
 * belong to the business layer, while storage details live in `repository.ts`.
 * Supplier protocols and signatures stay out of this slice entirely.
 */

import {
  ATTEMPT_OPERATIONS,
  ATTEMPT_RESULTS,
  BUSINESS_ORDER_NO_PATTERN,
  BUSINESS_SOURCE_PATTERN,
  FULFILLMENT_MODES,
  ORDER_STATUSES,
  PREPAID_GRANT_STATES,
  type AttemptOperation,
  type AttemptResult,
  type FulfillmentMode,
  type OrderStatus,
  type PrepaidGrantState,
} from '@sanchuang-dev/benefit-contracts';

/** The four supplier fulfilment shapes (A/B/C/D) described in docs/product-scope.md. */
export { FULFILLMENT_MODES };
export type { FulfillmentMode };

/**
 * Our own provider-agnostic order status. Supplier answer codes are never
 * stored here. `unknown` means the upstream outcome has not been verified yet
 * and must not be treated as failure or as permission to grant again.
 *
 * The value set is owned by the shared wire contract so the HTTP DTO and the
 * persisted domain cannot drift apart.
 */
export { ORDER_STATUSES };
export type { OrderStatus };

/** Attempt vocabularies are also owned by the shared wire contract. */
export { ATTEMPT_OPERATIONS, ATTEMPT_RESULTS };
export type { AttemptOperation, AttemptResult };

/** A-mode operation states; owned by the shared wire contract. */
export { PREPAID_GRANT_STATES };
export type { PrepaidGrantState };

/**
 * A persisted business grant intent. `businessSource + businessOrderNo` is the
 * caller-provided upstream identity; `id` is our stable internal order id.
 *
 * `mappingVersionId` is the immutable supplier mapping snapshot frozen when the
 * order was created. It is `null` only for orders created before migration 0005,
 * whose creation predates mapping versions; those historical facts are never
 * backfilled with a guessed version. `fulfillmentMode` is always the mode that
 * belongs to the bound snapshot.
 */
export interface BenefitOrder {
  id: string;
  businessSource: string;
  businessOrderNo: string;
  productId: string;
  fulfillmentMode: FulfillmentMode;
  status: OrderStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
  mappingVersionId: string | null;
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

/**
 * Durable A-mode operation identity for one order. `phoneHmac` is a master-key
 * keyed digest, never a phone number; it exists only to reject a conflicting
 * repeated grant input. The claim link is deliberately not part of this model.
 * This object is server-only: build an explicit safe DTO instead of serializing
 * `phoneHmac` or `paymentReference` to a caller or operator surface.
 */
export interface PrepaidOrderGrant {
  orderId: string;
  requestId: string;
  state: PrepaidGrantState;
  upstreamOrderNo: string | null;
  refCode: string;
  phoneHmac: string;
  paymentReference: string;
  attemptedAt: number;
  updatedAt: number;
}

export class OrderInputError extends Error {}
/** Same business identity, but the key parameters describe a different intent. */
export class OrderIntentConflictError extends Error {}
export class OrderVersionConflictError extends Error {}
export class OrderNotFoundError extends Error {}
export class OrderProductNotFoundError extends Error {}
/** The product exists but is disabled, so no new order may start. */
export class OrderProductNotActiveError extends Error {}
/** The registered application has been disabled; no machine order may be created. */
export class OrderApplicationDisabledError extends Error {}
/** The product is not on the registered application's configured allowlist. */
export class OrderProductNotAuthorizedError extends Error {}
/** A previously authenticated application credential was revoked before order creation. */
export class OrderCredentialRevokedError extends Error {}
/** The product has no current active supplier mapping version to freeze. */
export class OrderMappingUnavailableError extends Error {}
/** Only a frozen A-mode Yangmao snapshot can be executed by this slice. */
export class OrderModeUnsupportedError extends Error {}
/** The order's current platform status no longer permits starting a grant. */
export class OrderNotGrantableError extends Error {}
/** A repeated grant for the same order carried different inputs. */
export class GrantInputConflictError extends Error {}
/** A reservation is still within its in-flight window; do not race it. */
export class GrantInProgressError extends Error {}
/** A previously rejected/unknown operation must not be retried blindly. */
export class GrantNotRetryableError extends Error {}
/** No durable A-mode operation exists for this order. */
export class GrantNotFoundError extends Error {}
/** The persisted grant state no longer permits the requested transition. */
export class GrantStateConflictError extends Error {}

/**
 * `BUSINESS_SOURCE_PATTERN` and `BUSINESS_ORDER_NO_PATTERN` are owned by the
 * shared wire contract; the domain normalizers below enforce them again because
 * repository callers are not necessarily HTTP requests.
 */

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

export function assertFulfillmentMode(raw: string): FulfillmentMode {
  if (!(FULFILLMENT_MODES as readonly string[]).includes(raw)) {
    throw new OrderInputError(`履约模式需为 ${FULFILLMENT_MODES.join('/')} 之一`);
  }
  return raw as FulfillmentMode;
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
