import { createHmac } from 'node:crypto';

/** D-mode read-only product list path; the base URL is supplied by the caller. */
export const INRICE_PRODUCTS_PATH = '/api/open/inrice/v1/products';

/**
 * The list endpoint takes no query or body parameters, so the signed payload
 * is the empty compact JSON object. It is sent only inside the signature; the
 * HTTP request keeps an empty body.
 */
export const INRICE_LIST_SIGNED_BODY = '{}';

/**
 * D-mode string to sign: `<timestamp>\n<compact JSON>`.
 *
 * `timestamp` must be the exact string sent in `X-Timestamp`; the vendor
 * accepts seconds or milliseconds, so this module never converts the unit.
 */
export function buildInriceStringToSign(timestamp: string, compactJson: string): string {
  return `${timestamp}\n${compactJson}`;
}

/**
 * D-mode signature: Base64(HMAC-SHA256(stringToSign, appSecret)).
 *
 * This is intentionally separate from the A/B/C `X-Sign` implementation
 * (sorted fields + uppercase SHA-256 hex). Do not reuse one for the other.
 */
export function createInriceSignature(
  appSecret: string,
  timestamp: string,
  compactJson: string,
): string {
  return createHmac('sha256', appSecret)
    .update(buildInriceStringToSign(timestamp, compactJson), 'utf8')
    .digest('base64');
}
