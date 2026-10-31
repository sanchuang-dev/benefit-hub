import { createHmac } from 'node:crypto';

/** D-mode read-only product list path; the base URL is supplied by the caller. */
export const INRICE_PRODUCTS_PATH = '/api/open/inrice/v1/products';

/**
 * The list endpoint takes no query or body parameters, so the signed payload
 * is the empty compact JSON object. It is sent only inside the signature; the
 * HTTP request keeps an empty body.
 */
export const INRICE_LIST_SIGNED_BODY = '{}';

/** D-mode read-only product detail path; it always carries a query string. */
export const INRICE_PRODUCT_DETAIL_PATH = '/api/open/inrice/v1/products/query';

/**
 * The detail endpoint takes `productCode` both as the URL query parameter and
 * inside the signed compact JSON object. The signed value is the raw code; the
 * client percent-encodes the same raw value into the URL query, so the value
 * the vendor decodes is exactly the value that was signed.
 */
export function buildInriceProductDetailSignedBody(productCode: string): string {
  return JSON.stringify({ productCode });
}

/** D-mode read-only order query path. */
export const INRICE_ORDER_QUERY_PATH = '/api/open/inrice/v1/orders/query';

/** D-mode amount-debit dispatch endpoint. */
export const INRICE_DISPATCH_PATH = '/api/open/inrice/v1/dispatch';

export interface InriceDispatchSignedInput {
  partnerOrderNo: string;
  productCode: string;
  mobile: string;
}

/**
 * Exact dispatch DTO serialization recovered from the authorized 2026-10-31
 * dev probe. The vendor binds the request, then serializes the DTO in this
 * order before verifying HMAC: mobile -> partnerOrderNo -> productCode.
 *
 * This is intentionally NOT the HTTP request-body order from the public docs.
 * Signing must follow the server DTO bytes, while JSON body member order is
 * semantically irrelevant.
 */
export function buildInriceDispatchSignedBody(
  input: InriceDispatchSignedInput,
): string {
  return JSON.stringify({
    mobile: input.mobile,
    partnerOrderNo: input.partnerOrderNo,
    productCode: input.productCode,
  });
}

export interface InriceOrderQuerySignedInput {
  orderNo?: string | null;
  partnerOrderNo?: string | null;
}

/**
 * Exact signed DTO recovered from the authorized 2026-10-31 dev probe.
 * Field order is part of the HMAC bytes. Missing query fields serialize as
 * explicit nulls; omitting either property makes the vendor reject the
 * signature before business validation.
 */
export function buildInriceOrderQuerySignedBody(
  input: InriceOrderQuerySignedInput,
): string {
  return JSON.stringify({
    orderNo: input.orderNo ?? null,
    partnerOrderNo: input.partnerOrderNo ?? null,
  });
}

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
