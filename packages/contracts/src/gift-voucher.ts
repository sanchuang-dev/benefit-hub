/**
 * Wire contract for C-mode free gift-voucher issuance (BHB-012-E).
 *
 * C is free to the recipient, but the supplier **pre-deducts `packCount`
 * pack quota at issuance**, not at redemption. The caller therefore asserts an
 * already-authorized free-benefit intent (`refCode`, `packCount`, optional
 * recipient phone); it never supplies a payment reference, provider, mode or
 * upstream product code.
 *
 * `issued` means the supplier accepted the issuance and returned a voucher code
 * plus H5 link. It is not `redeemed`/`completed`: the recipient still has to
 * open the link and claim the packs.
 */

import { z } from 'zod';
import { businessOrderSchema } from './orders.js';
import { claimUrlSchema } from './prepaid-grant.js';

/** Vendor-documented C-mode pack bounds; must stay in sync with the adapter. */
export const GIFT_VOUCHER_PACK_COUNT_MIN = 1;
export const GIFT_VOUCHER_PACK_COUNT_MAX = 12;
/** Promotion/reference identifiers are bounded visible ASCII, like A. */
export const GIFT_VOUCHER_REFERENCE_PATTERN = /^[!-~]{1,64}$/;
/** Vendor phone shape documented for A/B/C requests. */
export const GIFT_VOUCHER_PHONE_PATTERN = /^1\d{10}$/;

/**
 * Our persisted C operation state:
 * - `reserved`: identity written, signed supplier POST may be in flight;
 * - `issued`: supplier returned a voucher code and H5 link (not redeemed);
 * - `unknown`: no trustworthy outcome yet; no automatic re-issuance;
 * - `rejected`: supplier explicitly refused before issuing.
 */
export const GIFT_VOUCHER_STATES = ['reserved', 'issued', 'unknown', 'rejected'] as const;
export type GiftVoucherState = (typeof GIFT_VOUCHER_STATES)[number];
export const giftVoucherStateSchema = z.enum(GIFT_VOUCHER_STATES);

const timestampSchema = z.number().int().nonnegative();
/** Vendor timestamp format is unconfirmed; keep the raw bounded scalar. */
export const giftVoucherExpiresAtSchema = z.union([
  z.string().min(1).max(128),
  z.number().finite().nonnegative(),
]);

/**
 * Strict issuance request. Optional `phone` is the only recipient input the
 * vendor accepts; omitting it lets the recipient bind one in the H5 page. The
 * upstream product code comes from the order's frozen C mapping.
 */
export const createGiftVoucherRequestSchema = z
  .object({
    packCount: z
      .number()
      .int()
      .min(GIFT_VOUCHER_PACK_COUNT_MIN)
      .max(GIFT_VOUCHER_PACK_COUNT_MAX),
    refCode: z.string().regex(GIFT_VOUCHER_REFERENCE_PATTERN),
    phone: z.string().regex(GIFT_VOUCHER_PHONE_PATTERN).optional(),
  })
  .strict();
export type CreateGiftVoucherRequest = z.infer<typeof createGiftVoucherRequestSchema>;

/** Recovery is a read-only vendor query by the stored issued code. */
export const recoverGiftVoucherRequestSchema = z.object({}).strict();
export type RecoverGiftVoucherRequest = z.infer<typeof recoverGiftVoucherRequestSchema>;

/**
 * Safe, non-sensitive projection of the persisted C operation. It carries no
 * voucher code, claim URL, phone digest, promotion code or supplier payload.
 * `packRemaining` is a vendor observation, never a platform refund inference.
 */
export const giftVoucherSchema = z
  .object({
    state: giftVoucherStateSchema,
    requestId: z.string().min(1).max(64),
    packCount: z
      .number()
      .int()
      .min(GIFT_VOUCHER_PACK_COUNT_MIN)
      .max(GIFT_VOUCHER_PACK_COUNT_MAX),
    packTotal: z.number().int().min(1).nullable(),
    packRemaining: z.number().int().min(0).nullable(),
    attemptedAt: timestampSchema,
    updatedAt: timestampSchema,
    /** Last time the supplier actually observed this voucher; null until then. */
    lastObservedAt: timestampSchema.nullable(),
  })
  .strict();
export type GiftVoucherDto = z.infer<typeof giftVoucherSchema>;

export const giftVoucherResponseSchema = z
  .object({
    order: businessOrderSchema,
    voucher: giftVoucherSchema,
    /**
     * Sensitive issuance result: only returned to the authenticated owning
     * application (or a read-only operator caller explicitly granted it). It
     * must never be logged, listed or stored in plaintext.
     */
    voucherCode: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional(),
    claimUrl: claimUrlSchema.optional(),
    expiresAt: giftVoucherExpiresAtSchema.optional(),
    balanceAfter: z.number().int().min(0).optional(),
    idempotentReplay: z.boolean().optional(),
    /** Supplier observation instant for the returned code/quota facts. */
    observedAt: timestampSchema.optional(),
  })
  .strict();
export type GiftVoucherResponse = z.infer<typeof giftVoucherResponseSchema>;
