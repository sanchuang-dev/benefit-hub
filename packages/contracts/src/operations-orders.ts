/**
 * Wire contract for the platform-local order operations read API (BHB-013-B1).
 *
 * This surface is read-only and operator-facing. It exposes the order intent we
 * actually persisted plus the frozen mapping snapshot it referenced at creation
 * time. It deliberately carries no supplier request body, raw provider status,
 * credential, financial conclusion, or write request schema: the platform can
 * prove a local record exists, never that a supplier dispatched or delivered.
 *
 * `product` on the detail is the internal product's *current* row. It is not a
 * historical snapshot and is labelled as such by the UI; only `frozenMapping`
 * describes creation-time provenance.
 */

import { z } from 'zod';
import { deductionUnitSchema, fulfillmentModeSchema } from './mapping.js';
import { giftVoucherSchema } from './gift-voucher.js';
import {
  attemptOperationSchema,
  attemptResultSchema,
  businessOrderNoSchema,
  businessSourceSchema,
  orderStatusSchema,
} from './orders.js';
import { prepaidGrantSchema } from './prepaid-grant.js';

/** Bounded server-side page sizes; the API rejects anything else. */
export const OPERATIONS_ORDER_PAGE_SIZES = [10, 20, 50] as const;
export type OperationsOrderPageSize = (typeof OPERATIONS_ORDER_PAGE_SIZES)[number];

const identifierSchema = z.string().min(1).max(128);
const timestampSchema = z.number().int().nonnegative();

/**
 * One row in the operator list. `productName` is the product's current name,
 * joined at read time, not the name at order creation.
 */
export const operationsOrderListItemSchema = z
  .object({
    id: identifierSchema,
    businessSource: businessSourceSchema,
    businessOrderNo: businessOrderNoSchema,
    productId: identifierSchema,
    productName: z.string().min(1).max(80),
    status: orderStatusSchema,
    version: z.number().int().min(1),
    fulfillmentMode: fulfillmentModeSchema,
    mappingVersionId: identifierSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type OperationsOrderListItemDto = z.infer<typeof operationsOrderListItemSchema>;

export const operationsOrderListResponseSchema = z
  .object({
    orders: z.array(operationsOrderListItemSchema),
    page: z.number().int().min(1),
    pageSize: z.union([z.literal(10), z.literal(20), z.literal(50)]),
    total: z.number().int().nonnegative(),
  })
  .strict();
export type OperationsOrderListResponse = z.infer<typeof operationsOrderListResponseSchema>;

/** Current internal product row; never a creation-time snapshot. */
export const operationsOrderProductSchema = z
  .object({
    id: identifierSchema,
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(80),
    status: z.enum(['active', 'disabled']),
  })
  .strict();
export type OperationsOrderProductDto = z.infer<typeof operationsOrderProductSchema>;

/**
 * The immutable supplier mapping snapshot frozen on the order. It is read by
 * the order's own `mappingVersionId`, never re-resolved through the product's
 * current active mapping.
 */
export const operationsOrderFrozenMappingSchema = z
  .object({
    id: identifierSchema,
    mappingId: identifierSchema,
    versionNumber: z.number().int().min(1),
    provider: z.string().min(1).max(32),
    productCode: z.string().min(1).max(64),
    fulfillmentMode: fulfillmentModeSchema,
    deductionUnit: deductionUnitSchema,
    activatedAt: timestampSchema,
  })
  .strict();
export type OperationsOrderFrozenMappingDto = z.infer<typeof operationsOrderFrozenMappingSchema>;

export const operationsOrderStatusEventSchema = z
  .object({
    id: identifierSchema,
    status: orderStatusSchema,
    version: z.number().int().min(1),
    createdAt: timestampSchema,
  })
  .strict();
export type OperationsOrderStatusEventDto = z.infer<typeof operationsOrderStatusEventSchema>;

/**
 * One stored local attempt fact. `accepted` is a supplier acknowledgement only;
 * `observedStatus` is our normalized observation, not a provider-native state.
 */
export const operationsOrderAttemptSchema = z
  .object({
    id: identifierSchema,
    operation: attemptOperationSchema,
    result: attemptResultSchema,
    observedStatus: orderStatusSchema.nullable(),
    upstreamRequestNo: z.string().min(1).max(128).nullable(),
    upstreamOrderNo: z.string().min(1).max(128).nullable(),
    occurredAt: timestampSchema,
    lastVerifiedAt: timestampSchema.nullable(),
  })
  .strict();
export type OperationsOrderAttemptDto = z.infer<typeof operationsOrderAttemptSchema>;

export const operationsOrderDetailSchema = z
  .object({
    id: identifierSchema,
    businessSource: businessSourceSchema,
    businessOrderNo: businessOrderNoSchema,
    productId: identifierSchema,
    status: orderStatusSchema,
    version: z.number().int().min(1),
    fulfillmentMode: fulfillmentModeSchema,
    mappingVersionId: identifierSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    product: operationsOrderProductSchema,
    frozenMapping: operationsOrderFrozenMappingSchema.nullable(),
    /**
     * A-mode operation identity. It carries no phone, payment reference or
     * claim link: the operator recovers the link through the existing
     * admin-only supplier read API using the surfaced `requestId`.
     */
    grant: prepaidGrantSchema.nullable(),
    /**
     * C-mode operation identity and vendor-observed quota facts. It carries no
     * voucher code, claim link, phone digest, promotion code or payload; those
     * remain encrypted and are returned only to the authenticated owning app.
     */
    giftVoucher: giftVoucherSchema.nullable(),
    statusEvents: z.array(operationsOrderStatusEventSchema),
    attempts: z.array(operationsOrderAttemptSchema),
  })
  .strict();
export type OperationsOrderDetailDto = z.infer<typeof operationsOrderDetailSchema>;

export const operationsOrderDetailResponseSchema = z
  .object({ order: operationsOrderDetailSchema })
  .strict();
export type OperationsOrderDetailResponse = z.infer<typeof operationsOrderDetailResponseSchema>;

/** Stable machine-readable error codes for the operator order surface. */
export const OPERATIONS_ORDER_ERROR_CODES = [
  'INTERNAL_ERROR',
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'ORDER_NOT_FOUND',
] as const;
export type OperationsOrderErrorCode = (typeof OPERATIONS_ORDER_ERROR_CODES)[number];

export const operationsOrderErrorResponseSchema = z
  .object({
    error: z.enum(OPERATIONS_ORDER_ERROR_CODES),
    message: z.string().min(1),
    fields: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type OperationsOrderErrorResponse = z.infer<typeof operationsOrderErrorResponseSchema>;
