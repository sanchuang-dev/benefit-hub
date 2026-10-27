import { z } from 'zod';
import { hasControlCharacters } from './text-safety.js';

/**
 * Read-only `purchase-check` facts. The three flags are independent vendor
 * facts, not one status enum:
 *
 * - `purchaseRestricted`: the vendor's per-phone 7-day limit is active, so the
 *   platform must NOT collect payment or place an order. The exact scope of the
 *   limit (phone / product / campaign / sub-distributor) is still unconfirmed.
 * - `giftUnclaimed`: non-lottery benefits are not fully claimed yet.
 * - `lotteryUnbet`: lottery bets are still unplaced.
 *
 * For the latter two the vendor returns a `claimUrl` so the user can continue
 * claiming; they are not a platform-wide "cannot buy" rule. A successful check
 * is a point-in-time observation only. Callers must not persist or cache it as
 * a permanent purchase permission, and this client never deducts a pack quota
 * or a monetary balance.
 */
export interface YangmaoOpenV1PurchaseEligibilityData {
  purchaseRestricted: boolean;
  giftUnclaimed: boolean;
  lotteryUnbet: boolean;
  /**
   * Vendor explanation for a restriction, passed through unchanged. It is
   * untrusted vendor text: consumers must render it as text, never as HTML.
   */
  message?: string;
  /**
   * Vendor link for unfinished benefits. Untrusted vendor text; consumers must
   * validate it before showing it to a user.
   */
  claimUrl?: string;
}

/** Server-side snapshot, stamped with what the response actually observed. */
export interface YangmaoOpenV1PurchaseEligibility
  extends YangmaoOpenV1PurchaseEligibilityData {
  provider: 'yangmao';
  /** ISO timestamp of the response that produced this snapshot. */
  observedAt: string;
}

// Defensive bounds only, not vendor promises. Vendor text beyond these is
// treated as a malformed response rather than silently truncated.
const MAX_MESSAGE_LENGTH = 256;
const MAX_CLAIM_URL_LENGTH = 2048;

const messageSchema = z
  .string()
  .min(1)
  .max(MAX_MESSAGE_LENGTH)
  .refine((value) => !hasControlCharacters(value), 'message contains control characters');

/**
 * A claim link is only useful as a navigable http(s) URL without embedded
 * credentials. Rejecting other schemes keeps vendor text from turning into a
 * `javascript:` link downstream. Scheme support is otherwise unchanged.
 */
function isClaimUrl(value: string): boolean {
  if (hasControlCharacters(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return url.username === '' && url.password === '';
}

const claimUrlSchema = z
  .string()
  .min(1)
  .max(MAX_CLAIM_URL_LENGTH)
  .refine(isClaimUrl, 'claimUrl must be an http(s) URL without credentials');

// All three facts are required: a missing flag must fail the read instead of
// defaulting to "not restricted", which would invent a purchase permission.
// Unknown vendor keys are stripped by the schema, so unconfirmed fields are
// dropped rather than echoed.
const eligibilitySchema = z.object({
  purchaseRestricted: z.boolean(),
  giftUnclaimed: z.boolean(),
  lotteryUnbet: z.boolean(),
  // Optional vendor text may be omitted or sent as JSON null; both mean "no
  // value". A missing boolean is still a hard failure above, because
  // defaulting it would invent an eligibility fact.
  message: messageSchema.nullish(),
  claimUrl: claimUrlSchema.nullish(),
});

/**
 * Validates the `data` object of a successful `purchase-check` response.
 * Returns null for any malformed or missing field so the caller fails the whole
 * check instead of answering from a partial body.
 */
export function parseOpenV1PurchaseEligibility(
  value: unknown,
): YangmaoOpenV1PurchaseEligibilityData | null {
  const parsed = eligibilitySchema.safeParse(value);
  if (!parsed.success) return null;

  const eligibility: YangmaoOpenV1PurchaseEligibilityData = {
    purchaseRestricted: parsed.data.purchaseRestricted,
    giftUnclaimed: parsed.data.giftUnclaimed,
    lotteryUnbet: parsed.data.lotteryUnbet,
  };
  if (typeof parsed.data.message === 'string') eligibility.message = parsed.data.message;
  if (typeof parsed.data.claimUrl === 'string') eligibility.claimUrl = parsed.data.claimUrl;
  return eligibility;
}
