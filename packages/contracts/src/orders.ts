/**
 * Wire contract for the downstream business order intake API (BHB-012-A).
 *
 * This is the machine-to-machine surface consumed by downstream business
 * systems (for example local-life or card doctor). It describes an order
 * *intent* only: a created order is always `pending` and nothing in this
 * contract implies that a supplier accepted, dispatched or delivered anything.
 *
 * The caller identity (`businessSource`) is deliberately absent from the create
 * request: it can only come from the authenticated service credential on the
 * server side.
 */

import { z } from 'zod';
import { fulfillmentModeSchema } from './mapping.js';

/** Our own provider-agnostic order lifecycle values persisted in SQLite. */
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
export const orderStatusSchema = z.enum(ORDER_STATUSES);

/** Operations we may record against an order; no supplier-specific action names. */
export const ATTEMPT_OPERATIONS = ['grant', 'query', 'reissue'] as const;
export type AttemptOperation = (typeof ATTEMPT_OPERATIONS)[number];
export const attemptOperationSchema = z.enum(ATTEMPT_OPERATIONS);

/**
 * What a single attempt observed. `accepted` only means the supplier
 * acknowledged the request, never that the benefit reached the user.
 */
export const ATTEMPT_RESULTS = ['accepted', 'rejected', 'unknown'] as const;
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];
export const attemptResultSchema = z.enum(ATTEMPT_RESULTS);

/**
 * Our own source key (for example `local-life`). It is lower-cased so two
 * callers cannot create parallel identities that differ only by case.
 */
export const BUSINESS_SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Business order numbers come from another system. Case is preserved because it
 * may be significant upstream, so `ORDER-1` and `order-1` stay distinct intents
 * rather than being merged silently.
 */
export const BUSINESS_ORDER_NO_PATTERN = /^[!-~]{1,128}$/;

/** Shared validators for the two caller-owned identity fields. */
export const businessSourceSchema = z.string().regex(BUSINESS_SOURCE_PATTERN);
export const businessOrderNoSchema = z.string().trim().regex(BUSINESS_ORDER_NO_PATTERN);

const identifierSchema = z.string().min(1).max(128);
const timestampSchema = z.number().int().nonnegative();

/** Server-derived business identity and time-ordered order state. */
export const businessOrderSchema = z
  .object({
    id: identifierSchema,
    businessSource: z.string().regex(BUSINESS_SOURCE_PATTERN),
    businessOrderNo: z.string().regex(BUSINESS_ORDER_NO_PATTERN),
    productId: identifierSchema,
    status: orderStatusSchema,
    version: z.number().int().min(1),
    fulfillmentMode: fulfillmentModeSchema,
    /** Frozen immutable snapshot; `null` only for pre-BHB-008 history. */
    mappingVersionId: identifierSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type BusinessOrderDto = z.infer<typeof businessOrderSchema>;

/**
 * Only the caller's own business order number and our internal product id are
 * accepted. `businessSource` and the fulfillment mode are server-owned facts.
 */
export const createBusinessOrderRequestSchema = z
  .object({
    businessOrderNo: businessOrderNoSchema,
    productId: z.string().trim().min(1).max(128),
  })
  .strict();
export type CreateBusinessOrderRequest = z.infer<typeof createBusinessOrderRequestSchema>;

/** `created` distinguishes a genuine insert (201) from an exact replay (200). */
export const createBusinessOrderResponseSchema = z
  .object({ order: businessOrderSchema, created: z.boolean() })
  .strict();
export type CreateBusinessOrderResponse = z.infer<typeof createBusinessOrderResponseSchema>;

/** Read responses carry the same order shape without the creation fact. */
export const businessOrderResponseSchema = z.object({ order: businessOrderSchema }).strict();
export type BusinessOrderResponse = z.infer<typeof businessOrderResponseSchema>;

/** Stable machine-readable error codes for the machine order surface. */
export const BUSINESS_ORDER_ERROR_CODES = [
  'INTERNAL_ERROR',
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'SERVICE_UNAVAILABLE',
  'APPLICATION_DISABLED',
  'ORDER_NOT_FOUND',
  'PRODUCT_NOT_FOUND',
  'PRODUCT_NOT_ACTIVE',
  'PRODUCT_NOT_AUTHORIZED',
  'ORDER_MAPPING_UNAVAILABLE',
  'ORDER_INTENT_CONFLICT',
  // A-mode prepaid grant (BHB-012-C).
  'PURCHASE_NOT_ELIGIBLE',
  'ORDER_MODE_UNSUPPORTED',
  'ORDER_NOT_GRANTABLE',
  'ORDER_STATE_CONFLICT',
  'GRANT_INPUT_CONFLICT',
  'GRANT_IN_PROGRESS',
  'GRANT_NOT_RETRYABLE',
  'GRANT_NOT_FOUND',
  'GRANT_STATE_CONFLICT',
  // C-mode free gift-voucher issuance (BHB-012-E).
  'GIFT_VOUCHER_INPUT_CONFLICT',
  'GIFT_VOUCHER_IN_PROGRESS',
  'GIFT_VOUCHER_NOT_RETRYABLE',
  'GIFT_VOUCHER_NOT_FOUND',
  'GIFT_VOUCHER_OUTCOME_UNKNOWN',
  'SUPPLIER_NOT_CONFIGURED',
  'SUPPLIER_KEY_UNAVAILABLE',
  'SUPPLIER_TIMEOUT',
  'SUPPLIER_AUTH_FAILED',
  'SUPPLIER_BUSINESS_FAILED',
  'SUPPLIER_RESPONSE_UNVERIFIED',
  'SUPPLIER_UNAVAILABLE',
] as const;
export type BusinessOrderErrorCode = (typeof BUSINESS_ORDER_ERROR_CODES)[number];

/**
 * Validation failures may name only the offending field paths. No error body
 * echoes submitted values, tokens or provider content.
 */
export const businessOrderErrorResponseSchema = z
  .object({
    error: z.enum(BUSINESS_ORDER_ERROR_CODES),
    message: z.string().min(1),
    fields: z.array(z.string().min(1)).min(1).optional(),
    // Sanitized supplier observation only (numeric code / HTTP status). Raw
    // supplier messages, payloads and identifiers are never echoed.
    vendorCode: z.number().int().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();
export type BusinessOrderErrorResponse = z.infer<typeof businessOrderErrorResponseSchema>;
