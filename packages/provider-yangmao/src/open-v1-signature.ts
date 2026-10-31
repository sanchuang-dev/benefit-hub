import { createHash } from 'node:crypto';

/** A/B/C `POST /open/v1/prepaid/purchase-check`; the base URL is caller-supplied. */
export const OPEN_V1_PURCHASE_CHECK_PATH = '/open/v1/prepaid/purchase-check';
/** A-mode `POST /open/v1/prepaid/orders`: deducts one prepaid gift pack. */
export const OPEN_V1_PREPAID_ORDER_PATH = '/open/v1/prepaid/orders';
/** B-mode direct topup: may consume one pack and issue multiple travel items. */
export const OPEN_V1_DIRECT_TOPUP_PATH = '/open/v1/prepaid/direct-topup';
/** A-mode read-only link recovery by the original `requestId`. */
export const OPEN_V1_PREPAID_ORDER_QUERY_PATH = '/open/v1/prepaid/orders/query';
/** C-mode voucher issuance. The supplier pre-deducts `packCount` packs here. */
export const OPEN_V1_GIFT_VOUCHER_PATH = '/open/v1/gift-vouchers';

/**
 * Values the vendor accepts inside the A/B/C canonical string. A `number` is
 * stringified by this module; booleans, floats and `undefined` are rejected so
 * a value can never be signed as something other than what the request sends.
 */
export type OpenV1SigningValue = string | number;

/**
 * The explicit field set of ONE endpoint. Callers must build it from the
 * endpoint contract, never by walking an HTTP JSON payload: the vendor signs
 * different fields per endpoint and ignores unknown ones.
 */
export type OpenV1SigningFields = Readonly<Record<string, OpenV1SigningValue>>;

export interface OpenV1RequestIdentity {
  /** Sent in `X-App-Key` and signed as `appKey`. */
  appKey: string;
  /**
   * Milliseconds since the epoch, sent verbatim in `X-Timestamp` and signed.
   * The vendor tolerates at most five minutes of clock skew.
   */
  timestamp: string;
  /** Single-use value sent in `X-Nonce` and signed. */
  nonce: string;
}

const RESERVED_FIELD_NAMES = new Set(['appsecret', 'sign', 'signature']);
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * A/B/C canonical value: strings stay byte-identical (no URL encoding, no
 * trimming) and integers become their decimal representation. An empty string
 * is omitted by the caller-facing builder, matching the vendor's "空值不参与".
 */
function canonicalValue(value: OpenV1SigningValue): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('签名数值必须是安全整数');
    }
    return String(value);
  }
  throw new TypeError('签名值只支持字符串或整数');
}

/**
 * A/B/C canonical string:
 * `<field>=<value>&...&appSecret=<secret>`, fields sorted by name.
 *
 * This is intentionally separate from the D `X-Signature` implementation
 * (`timestamp + "\n" + compact JSON` → Base64 HMAC). Do not reuse one for the
 * other, and never log the returned string: it carries the AppSecret.
 */
export function buildOpenV1StringToSign(
  fields: OpenV1SigningFields,
  appSecret: string,
): string {
  if (typeof appSecret !== 'string' || appSecret === '') {
    throw new TypeError('appSecret 不能为空');
  }

  const parts: string[] = [];
  for (const name of Object.keys(fields).sort()) {
    if (!FIELD_NAME_PATTERN.test(name)) {
      throw new TypeError('签名字段名非法');
    }
    // appSecret is appended exactly once below; a field with a reserved name
    // would make the canonical string ambiguous to the verifier.
    if (RESERVED_FIELD_NAMES.has(name.toLowerCase())) {
      throw new TypeError('签名字段名非法');
    }

    const value = canonicalValue(fields[name] as OpenV1SigningValue);
    if (value === null) continue;
    parts.push(`${name}=${value}`);
  }

  if (parts.length === 0) {
    throw new TypeError('至少需要一个签名字段');
  }

  return `${parts.join('&')}&appSecret=${appSecret}`;
}

/** A/B/C `X-Sign`: uppercase hex SHA-256 of the canonical string. */
export function createOpenV1Signature(
  fields: OpenV1SigningFields,
  appSecret: string,
): string {
  return createHash('sha256')
    .update(buildOpenV1StringToSign(fields, appSecret), 'utf8')
    .digest('hex')
    .toUpperCase();
}

/**
 * `purchase-check` participates only in `appKey`, `timestamp`, `nonce` and
 * `phone`. The returned map is exhaustive: adding a field here is a contract
 * change, not a side effect of what happens to be in the request body.
 */
export function buildPurchaseCheckSignedFields(
  identity: OpenV1RequestIdentity,
  phone: string,
): OpenV1SigningFields {
  return {
    appKey: identity.appKey,
    timestamp: identity.timestamp,
    nonce: identity.nonce,
    phone,
  };
}

/**
 * A-mode `prepaid/orders` participates in `appKey`, `timestamp`, `nonce`,
 * `phone`, `refCode`, and the non-empty `productCode` / `requestId`. Omitting an
 * empty optional value here keeps the signed string identical to what the
 * vendor's "空值不参与" rule expects.
 */
export function buildPrepaidOrderSignedFields(
  identity: OpenV1RequestIdentity,
  input: {
    phone: string;
    refCode: string;
    productCode?: string;
    requestId: string;
  },
): OpenV1SigningFields {
  return {
    appKey: identity.appKey,
    timestamp: identity.timestamp,
    nonce: identity.nonce,
    phone: input.phone,
    refCode: input.refCode,
    ...(input.productCode ? { productCode: input.productCode } : {}),
    requestId: input.requestId,
  };
}

/**
 * C-mode `gift-vouchers` participates in `appKey`, `timestamp`, `nonce`,
 * `refCode`, `packCount`, `requestId`, and the non-empty `phone` /
 * `productCode`. `packCount` is a number in the JSON body but is stringified by
 * the canonicalizer, matching the vendor's documented `"3"` form.
 */
export function buildGiftVoucherSignedFields(
  identity: OpenV1RequestIdentity,
  input: {
    refCode: string;
    packCount: number;
    requestId: string;
    phone?: string;
    productCode?: string;
  },
): OpenV1SigningFields {
  return {
    appKey: identity.appKey,
    timestamp: identity.timestamp,
    nonce: identity.nonce,
    refCode: input.refCode,
    packCount: input.packCount,
    requestId: input.requestId,
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.productCode ? { productCode: input.productCode } : {}),
  };
}


/** B-mode has the same canonical fields as A, but productCode is mandatory. */
export function buildDirectTopupSignedFields(
  identity: OpenV1RequestIdentity,
  input: { phone: string; refCode: string; productCode: string; requestId: string },
): OpenV1SigningFields {
  if (!input.productCode) throw new TypeError('B 模式 productCode 不能为空');
  return buildPrepaidOrderSignedFields(identity, input);
}
