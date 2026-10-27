import { z } from 'zod';
import { hasControlCharacters } from './text-safety.js';
import { parseVendorSellPriceCents, productCodeSchema } from './inrice-products.js';

/**
 * Detail fields this slice treats as contract-grounded. Basis: the authorized
 * 2026-10-27 signed read-only dev probe of `GET .../products/query`, which
 * observed `data` as an OBJECT carrying `productCode` (string), `name`
 * (string), `sellPrice` (number) among other keys. The remaining observed keys
 * (goodsStatus, details, extraJson, picture, ...) stay explicitly unsupported:
 * they are never parsed or echoed, so vendor HTML/JSON text such as `details`
 * or `extraJson` can never reach the platform or a browser, and no unconfirmed
 * saleability meaning (e.g. a guessed onSale mapping) is invented.
 */
export interface YangmaoInriceProductDetailData {
  productCode: string;
  /**
   * Vendor display name, passed through unchanged. It is untrusted vendor
   * text: consumers must render it as text, never as HTML, and this module
   * neither sanitizes nor synthesizes it.
   */
  name: string;
  /**
   * Vendor sell price converted exactly to CNY minor units (fen). This is a
   * money amount, never a pack quota or an internal display price.
   */
  sellPriceCents: number;
}

/** Read-only detail snapshot; carries no dispatch or fulfilment meaning. */
export interface YangmaoInriceProductDetail {
  provider: 'yangmao';
  currency: 'CNY';
  /** ISO timestamp of the response that produced this snapshot. */
  observedAt: string;
  productCode: string;
  name: string;
  sellPriceCents: number;
}

// Defensive bound only, not a vendor promise: a display name beyond this is
// treated as a malformed response rather than silently truncated.
const MAX_DETAIL_NAME_LENGTH = 256;

const detailNameSchema = z
  .string()
  .max(MAX_DETAIL_NAME_LENGTH)
  .refine((value) => value.trim().length > 0, 'name must not be blank')
  .refine((value) => !hasControlCharacters(value), 'name contains control characters');

const vendorProductDetailSchema = z.object({
  productCode: productCodeSchema,
  name: detailNameSchema,
  sellPrice: z.union([z.number(), z.string()]),
});

/**
 * Validates one detail record against the evidence-backed field set. Unknown
 * vendor keys are stripped by the schema, so unconfirmed fields are dropped
 * rather than echoed. The record must echo the product code that was asked
 * for: an answer about a different product is a malformed response, not a
 * detail result. Returns null for any malformed detail so the caller fails the
 * whole read instead of returning a partial or invented record.
 */
export function parseInriceProductDetail(
  value: unknown,
  requestedProductCode: string,
): YangmaoInriceProductDetailData | null {
  const parsed = vendorProductDetailSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.productCode !== requestedProductCode) return null;

  const sellPriceCents = parseVendorSellPriceCents(parsed.data.sellPrice);
  if (sellPriceCents === null) return null;

  return {
    productCode: parsed.data.productCode,
    name: parsed.data.name,
    sellPriceCents,
  };
}
