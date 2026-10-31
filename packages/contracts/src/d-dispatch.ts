import { z } from 'zod';
import { businessOrderNoSchema, businessOrderSchema } from './orders.js';

export const dDispatchRequestSchema = z
  .object({
    mobile: z.string().regex(/^1[3-9]\d{9}$/),
    // Business-side authorization/payment fact. It is never inferred from a
    // provider code=0 response and is not forwarded to the supplier.
    paymentReference: businessOrderNoSchema,
  })
  .strict();

export const recoverDDispatchRequestSchema = z.object({}).strict();

export const dDispatchStateSchema = z.enum([
  'reserved',
  'accepted',
  'unknown',
  'rejected',
]);

export const dDispatchSummarySchema = z
  .object({
    state: dDispatchStateSchema,
    partnerOrderNo: z.string().min(1).max(64),
    upstreamOrderNo: z.string().min(1).max(128).nullable(),
    // Raw provider token, intentionally not mapped to completed until live
    // terminal-state evidence exists.
    providerStatus: z.string().min(1).max(128).nullable(),
    lastVerifiedAt: z.number().int().nonnegative().nullable(),
    attemptedAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type DDispatchSummaryDto = z.infer<typeof dDispatchSummarySchema>;

export const dDispatchResponseSchema = z
  .object({
    order: businessOrderSchema,
    dispatch: dDispatchSummarySchema,
    observedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type DDispatchResponse = z.infer<typeof dDispatchResponseSchema>;
