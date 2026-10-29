import { z } from 'zod';
import { businessOrderSchema } from './orders.js';
import { businessOrderNoSchema } from './orders.js';

export const directTopupRequestSchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/),
  refCode: z.string().regex(/^[!-~]{1,64}$/),
  // Business-side assertion: the order has actually been paid/authorized.
  // Never invent payment from the supplier response.
  paymentReference: businessOrderNoSchema,
}).strict();

export const directTopupReissueRequestSchema = directTopupRequestSchema.extend({
  // A replay is never implied by repeating the initial endpoint.
  confirmReissue: z.literal(true),
});

export const directTopupStateSchema = z.enum([
  'reserved', 'unknown', 'partial', 'completed', 'rejected', 'retrying',
]);

export const directTopupObservationSchema = z.object({
  operation: z.enum(['grant', 'reissue']),
  upstreamOrderNo: z.string().min(1).max(128),
  successCount: z.number().int().nonnegative(),
  totalCount: z.number().int().positive(),
  items: z.array(z.object({
    claimed: z.boolean().optional(),
    status: z.string().max(128).optional(),
  }).strict()).max(100),
  observedAt: z.number().int().nonnegative(),
}).strict();

export const directTopupSummarySchema = z.object({
  state: directTopupStateSchema,
  requestId: z.string().min(1).max(64),
  upstreamOrderNo: z.string().max(128).nullable(),
  successCount: z.number().int().nonnegative().nullable(),
  totalCount: z.number().int().positive().nullable(),
  items: z.array(z.object({
    claimed: z.boolean().optional(),
    status: z.string().max(128).optional(),
  }).strict()).max(100),
  observations: z.array(directTopupObservationSchema),
  lastVerifiedAt: z.number().int().nonnegative().nullable(),
  attemptedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export type DirectTopupSummaryDto = z.infer<typeof directTopupSummarySchema>;

export const directTopupResponseSchema = z.object({
  order: businessOrderSchema,
  topup: directTopupSummarySchema,
  observedAt: z.number().int().nonnegative().optional(),
}).strict();

export type DirectTopupResponse = z.infer<typeof directTopupResponseSchema>;
