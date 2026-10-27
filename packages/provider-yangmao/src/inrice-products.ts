import { z } from 'zod';
import { hasControlCharacters } from './text-safety.js';

/**
 * Only fields this slice treats as contract-grounded for the D catalogue list:
 * `productCode` (the D API's item identifier) and `sellPrice` (documented list
 * field, CNY yuan). Other upstream fields, including the display-name key, are
 * not confirmed in the repository contract and are neither parsed nor
 * synthesized.
 */
export interface YangmaoInriceProduct {
  productCode: string;
  /**
   * Vendor sell price converted exactly to CNY minor units (fen).
   * This is a money amount, never a pack quota or an internal display price.
   */
  sellPriceCents: number;
}

export interface YangmaoInriceCatalog {
  provider: 'yangmao';
  currency: 'CNY';
  /** ISO timestamp of the response that produced this snapshot. */
  observedAt: string;
  products: YangmaoInriceProduct[];
}

const MAX_PRODUCT_CODE_LENGTH = 128;

const productCodeSchema = z
  .string()
  .min(1)
  .max(MAX_PRODUCT_CODE_LENGTH)
  .refine((value) => value === value.trim(), 'productCode must not have outer whitespace')
  .refine((value) => !hasControlCharacters(value), 'productCode contains control characters');

const vendorProductSchema = z.object({
  productCode: productCodeSchema,
  sellPrice: z.union([z.number(), z.string()]),
});

// Up to two decimal places only: converting a rounded value would silently
// change the vendor price, so unsupported precision fails the whole response.
const DECIMAL_MONEY_PATTERN = /^(?:0|[1-9]\d{0,13})(?:\.(\d{1,2}))?$/;

/**
 * Parses the vendor `sellPrice` (yuan) into integer fen without float
 * multiplication. Returns null for negative, non-finite, exponent-notation,
 * over-precise or unsafe values instead of rounding.
 */
export function parseVendorSellPriceCents(value: number | string): number | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (!DECIMAL_MONEY_PATTERN.test(text)) return null;

  const [whole = '', fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (Number.isSafeInteger(cents)) return cents;
  return null;
}

/**
 * Validates the full `data` array. One malformed item fails the whole snapshot
 * so an incomplete catalogue can never be mistaken for a complete one.
 */
export function parseInriceProducts(value: unknown): YangmaoInriceProduct[] | null {
  const parsed = z.array(vendorProductSchema).safeParse(value);
  if (!parsed.success) return null;

  const products: YangmaoInriceProduct[] = [];
  for (const item of parsed.data) {
    const sellPriceCents = parseVendorSellPriceCents(item.sellPrice);
    if (sellPriceCents === null) return null;
    products.push({ productCode: item.productCode, sellPriceCents });
  }
  return products;
}
