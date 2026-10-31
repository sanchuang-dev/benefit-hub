import { z } from 'zod';
import { hasControlCharacters } from './text-safety.js';

function orderReferenceSchema(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value === value.trim(), 'order reference must not have outer whitespace')
    .refine((value) => !hasControlCharacters(value), 'order reference contains control characters');
}

const orderNoSchema = orderReferenceSchema(128);
const partnerOrderNoSchema = orderReferenceSchema(64);
const dispatchStatusSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim(), 'dispatchStatus must not have outer whitespace')
  .refine((value) => !hasControlCharacters(value), 'dispatchStatus contains control characters');

const orderQueryInputSchema = z
  .object({
    orderNo: orderNoSchema.optional(),
    partnerOrderNo: partnerOrderNoSchema.optional(),
  })
  .refine(
    (value) => value.orderNo !== undefined || value.partnerOrderNo !== undefined,
    'at least one order reference is required',
  );

const vendorOrderDataSchema = z.object({
  orderNo: orderNoSchema.optional().nullable(),
  partnerOrderNo: partnerOrderNoSchema.optional().nullable(),
  dispatchStatus: dispatchStatusSchema.optional().nullable(),
  fulfillmentSummary: z.unknown().optional().nullable(),
});

export interface YangmaoInriceOrderQueryInput {
  /** Supplier-side D order number, when known. */
  orderNo?: string;
  /** Our idempotent D dispatch number, documented as max 64 chars. */
  partnerOrderNo?: string;
}

export interface YangmaoInriceOrderData {
  orderNo?: string;
  partnerOrderNo?: string;
  /** Raw provider status token. No terminal meaning is inferred here. */
  dispatchStatus?: string;
  /**
   * Provider-owned fulfillment payload. Its structure is still unverified and
   * may contain sensitive delivery material; callers must not log it.
   */
  fulfillmentSummary?: unknown;
  /**
   * No D terminal-state set has been verified yet. Even documented examples
   * such as RECEIVE remain unknown until runtime evidence proves the mapping.
   */
  state: 'unknown';
}

export interface YangmaoInriceOrderQueryResult extends YangmaoInriceOrderData {
  provider: 'yangmao';
  observedAt: string;
  query: YangmaoInriceOrderQueryInput;
}

export function normalizeInriceOrderQueryInput(
  value: YangmaoInriceOrderQueryInput,
): YangmaoInriceOrderQueryInput | null {
  const parsed = orderQueryInputSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data;
}

export function parseInriceOrderQueryData(
  value: unknown,
  requested: YangmaoInriceOrderQueryInput,
): YangmaoInriceOrderData | null {
  const parsed = vendorOrderDataSchema.safeParse(value);
  if (!parsed.success) return null;

  if (
    requested.orderNo !== undefined &&
    parsed.data.orderNo !== null &&
    parsed.data.orderNo !== undefined &&
    parsed.data.orderNo !== requested.orderNo
  ) {
    return null;
  }
  if (
    requested.partnerOrderNo !== undefined &&
    parsed.data.partnerOrderNo !== null &&
    parsed.data.partnerOrderNo !== undefined &&
    parsed.data.partnerOrderNo !== requested.partnerOrderNo
  ) {
    return null;
  }

  const hasObservedField =
    parsed.data.orderNo !== null && parsed.data.orderNo !== undefined ||
    parsed.data.partnerOrderNo !== null && parsed.data.partnerOrderNo !== undefined ||
    parsed.data.dispatchStatus !== null && parsed.data.dispatchStatus !== undefined ||
    parsed.data.fulfillmentSummary !== null && parsed.data.fulfillmentSummary !== undefined;
  if (!hasObservedField) return null;

  const result: YangmaoInriceOrderData = { state: 'unknown' };
  if (parsed.data.orderNo !== null && parsed.data.orderNo !== undefined) {
    result.orderNo = parsed.data.orderNo;
  }
  if (parsed.data.partnerOrderNo !== null && parsed.data.partnerOrderNo !== undefined) {
    result.partnerOrderNo = parsed.data.partnerOrderNo;
  }
  if (parsed.data.dispatchStatus !== null && parsed.data.dispatchStatus !== undefined) {
    result.dispatchStatus = parsed.data.dispatchStatus;
  }
  if (parsed.data.fulfillmentSummary !== null && parsed.data.fulfillmentSummary !== undefined) {
    result.fulfillmentSummary = parsed.data.fulfillmentSummary;
  }
  return result;
}
