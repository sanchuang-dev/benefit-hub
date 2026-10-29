/**
 * Wire contract for the A-mode prepaid gift-pack grant (BHB-012-C).
 *
 * The machine caller must explicitly assert that the business intent was paid
 * or otherwise authorized (`paymentReference`); this platform does not own a
 * payment gateway and never infers payment from a local `pending` order.
 *
 * A successful `claimUrl` only means the supplier created an H5 order and
 * deducted one pack quota. The recipient still has to open the link and claim
 * the benefit, so this contract never exposes `completed`/`delivered` facts.
 */

import { z } from 'zod';
import { businessOrderSchema } from './orders.js';

/** Vendor phone shape documented for A/B/C requests. */
export const PREPAID_GRANT_PHONE_PATTERN = /^1\d{10}$/;
/** Distribution/request identifiers are bounded visible ASCII (no spaces). */
export const PREPAID_GRANT_REFERENCE_PATTERN = /^[!-~]{1,64}$/;
/** Caller-owned payment/authorization reference kept for audit only. */
export const PREPAID_GRANT_PAYMENT_REFERENCE_PATTERN = /^[!-~]{1,128}$/;

/**
 * Our persisted A operation state:
 * - `reserved`: identity written, signed supplier POST may be in flight;
 * - `accepted`: supplier acknowledged the order (not a claimed benefit);
 * - `unknown`: no trustworthy outcome yet, recover with the same requestId;
 * - `rejected`: supplier explicitly refused before creating an order.
 */
export const PREPAID_GRANT_STATES = ['reserved', 'accepted', 'unknown', 'rejected'] as const;
export type PrepaidGrantState = (typeof PREPAID_GRANT_STATES)[number];
export const prepaidGrantStateSchema = z.enum(PREPAID_GRANT_STATES);

const identifierSchema = z.string().min(1).max(128);
const timestampSchema = z.number().int().nonnegative();

const claimUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.username === '' &&
        url.password === ''
      );
    } catch {
      return false;
    }
  }, 'claimUrl 必须是无需内嵌凭证的 http(s) 链接');

/**
 * Strict grant request. `phone` and `refCode` are forwarded to the supplier;
 * `paymentReference` is the explicit business-side authorization fact. The
 * provider, fulfillment mode and upstream product code are never accepted here:
 * they come from the order's frozen mapping.
 */
export const createPrepaidGrantRequestSchema = z
  .object({
    phone: z.string().regex(PREPAID_GRANT_PHONE_PATTERN),
    refCode: z.string().regex(PREPAID_GRANT_REFERENCE_PATTERN),
    paymentReference: z.string().regex(PREPAID_GRANT_PAYMENT_REFERENCE_PATTERN),
  })
  .strict();
export type CreatePrepaidGrantRequest = z.infer<typeof createPrepaidGrantRequestSchema>;

/** Link recovery is a read-only vendor query; it needs no phone or payment ref. */
export const recoverPrepaidGrantRequestSchema = z.object({}).strict();
export type RecoverPrepaidGrantRequest = z.infer<typeof recoverPrepaidGrantRequestSchema>;

/** Safe, non-sensitive projection of the persisted operation identity. */
export const prepaidGrantSchema = z
  .object({
    state: prepaidGrantStateSchema,
    requestId: z.string().min(1).max(64),
    upstreamOrderNo: identifierSchema.nullable(),
    attemptedAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type PrepaidGrantDto = z.infer<typeof prepaidGrantSchema>;

export const prepaidGrantResponseSchema = z
  .object({
    order: businessOrderSchema,
    grant: prepaidGrantSchema,
    /**
     * Only present when the supplier returned a usable H5 link. It is never
     * persisted and never means the benefit was claimed.
     */
    claimUrl: claimUrlSchema.optional(),
    /** Supplier observation instant for a link obtained by a recovery read. */
    observedAt: timestampSchema.optional(),
  })
  .strict();
export type PrepaidGrantResponse = z.infer<typeof prepaidGrantResponseSchema>;
