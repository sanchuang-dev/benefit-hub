import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { YangmaoOpenV1Error } from './open-v1-errors.js';
import {
  parseOpenV1PurchaseEligibility,
  type YangmaoOpenV1PurchaseEligibility,
} from './open-v1-purchase-check.js';
import {
  buildGiftVoucherSignedFields,
  buildPrepaidOrderSignedFields,
  buildPurchaseCheckSignedFields,
  createOpenV1Signature,
  OPEN_V1_GIFT_VOUCHER_PATH,
  OPEN_V1_PREPAID_ORDER_PATH,
  OPEN_V1_PREPAID_ORDER_QUERY_PATH,
  OPEN_V1_PURCHASE_CHECK_PATH,
} from './open-v1-signature.js';
import { hasControlCharacters } from './text-safety.js';

/**
 * Replaces only the HTTP transport (for contract tests or a future proxy).
 * A replacement must honour `request.signal` and must not follow redirects.
 */
export type YangmaoOpenV1Transport = (request: Request) => Promise<Response>;

export interface YangmaoOpenV1ClientOptions {
  /**
   * Vendor origin only, e.g. `https://dev-api.isunpow.com`. Production and
   * unrecognised hosts must use HTTPS; plain HTTP is accepted only for
   * loopback test servers so credentials never cross a network in clear text.
   */
  baseUrl: string;
  appKey: string;
  appSecret: string;
  /** Bounded request timeout. Defaults to 10s. */
  timeoutMs?: number;
  transport?: YangmaoOpenV1Transport;
  /** Millisecond clock; injectable to freeze the signature timestamp. */
  clock?: () => number;
  /**
   * Nonce source. Defaults to 16 random bytes as hex; injectable so a fixed
   * test vector can pin the exact signed string. Every call asks for a fresh
   * nonce and an invalid value fails before any request is sent.
   */
  nonceFactory?: () => string;
}

export interface YangmaoOpenV1ReadOptions {
  /** Caller cancellation, distinguished from a timeout in the error code. */
  signal?: AbortSignal;
}

/**
 * Recovery reads are only validated snapshots of the fields documented so far.
 * Unknown upstream keys are discarded; no successful read means an issuance.
 */
export interface YangmaoOpenV1PrepaidOrderLookup {
  provider: 'yangmao';
  observedAt: string;
  claimUrl?: string;
  claimable?: boolean;
  orderNo?: string;
}
export interface YangmaoOpenV1GiftVoucherLookup {
  provider: 'yangmao';
  observedAt: string;
  claimUrl?: string;
  packTotal?: number;
  packRemaining?: number;
  expiresAt?: string | number;
}
/**
 * Accepted A-mode order. `claimUrl` is an H5 link the recipient must still open
 * and use; a successful response consumed one pack quota but is never proof that
 * the user claimed anything.
 */
export interface YangmaoOpenV1PrepaidOrderResult {
  provider: 'yangmao';
  observedAt: string;
  orderNo: string;
  claimUrl: string;
  balanceAfter?: number;
  idempotentReplay?: boolean;
}
export interface YangmaoOpenV1CreatePrepaidOrderInput {
  phone: string;
  refCode: string;
  /** Optional per the vendor contract; omitted when falsy. */
  productCode?: string;
  /** Stable idempotency key shared by the caller and its recovery read. */
  requestId: string;
}
/**
 * Accepted C-mode voucher issuance. Issuance pre-deducts `packCount` pack
 * quota at the supplier; `packRemaining` is the vendor-observed remainder for
 * that voucher and is never a platform refund or monetary balance.
 */
export interface YangmaoOpenV1GiftVoucherResult {
  provider: 'yangmao';
  observedAt: string;
  voucherCode: string;
  claimUrl: string;
  packTotal?: number;
  packRemaining?: number;
  /** Raw vendor scalar; the timestamp format is not yet confirmed. */
  expiresAt?: string | number;
  balanceAfter?: number;
  idempotentReplay?: boolean;
}
export interface YangmaoOpenV1CreateGiftVoucherInput {
  refCode: string;
  /** Number of packs bundled in this voucher; the vendor accepts 1–12. */
  packCount: number;
  /** Stable idempotency key; the same value must be used for any investigation. */
  requestId: string;
  /** Optional per the vendor contract; omitted when falsy. */
  phone?: string;
  /** Optional per the vendor contract; omitted when falsy. */
  productCode?: string;
}
const RECOVERY_ID_PATTERN = /^[!-~]{1,64}$/;
const VOUCHER_CODE_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
/** Vendor-documented C-mode pack bounds; also enforced at the platform boundary. */
export const GIFT_VOUCHER_PACK_COUNT_MIN = 1;
export const GIFT_VOUCHER_PACK_COUNT_MAX = 12;
const safeClaimUrlSchema = z.string().min(1).max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
});
const prepaidOrderLookupSchema = z.object({
  claimUrl: safeClaimUrlSchema.nullish(),
  claimable: z.boolean().nullish(),
  orderNo: z.string().min(1).max(128).nullish(),
});
// A successful order MUST carry both the vendor order number and a usable H5
// link. Unknown extra keys are stripped by zod, so an unconfirmed field can
// never be mistaken for a successful issuance.
const prepaidOrderResultSchema = z.object({
  orderNo: z.string().min(1).max(128),
  claimUrl: safeClaimUrlSchema,
  balanceAfter: z.number().int().min(0).nullish(),
  idempotentReplay: z.boolean().nullish(),
});
const rawExpiresAtSchema = z
  .union([z.string().min(1).max(128), z.number().finite().nonnegative()])
  .nullish();
const giftVoucherLookupSchema = z.object({
  claimUrl: safeClaimUrlSchema.nullish(),
  packTotal: z.number().int().min(0).nullish(),
  packRemaining: z.number().int().min(0).nullish(),
  // Vendor has not yet confirmed timestamp unit/encoding. Preserve the raw
  // bounded scalar without guessing ISO/Unix seconds/milliseconds.
  expiresAt: rawExpiresAtSchema,
});
const issuedVoucherSchema = z.object({
  // The vendor documents the issued code as uppercase; accepting any bounded
  // identifier here avoids inventing a stricter shape than the contract states.
  voucherCode: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  // A code without a usable H5 link is not an accepted issuance.
  claimUrl: safeClaimUrlSchema,
  packTotal: z.number().int().min(1).nullish(),
  packRemaining: z.number().int().min(0).nullish(),
  expiresAt: rawExpiresAtSchema,
  balanceAfter: z.number().int().min(0).nullish(),
  idempotentReplay: z.boolean().nullish(),
});

export interface YangmaoOpenV1PurchaseReader {
  queryPrepaidOrder(requestId: string, options?: YangmaoOpenV1ReadOptions): Promise<YangmaoOpenV1PrepaidOrderLookup>;
  queryGiftVoucher(code: string, options?: YangmaoOpenV1ReadOptions): Promise<YangmaoOpenV1GiftVoucherLookup>;
  /**
   * Read-only pre-payment eligibility check by phone. Never deducts a pack
   * quota or a monetary balance and never places an order. A successful answer
   * describes only this moment: it must not be cached as a permanent
   * permission to purchase.
   */
  checkPurchase(
    phone: string,
    options?: YangmaoOpenV1ReadOptions,
  ): Promise<YangmaoOpenV1PurchaseEligibility>;
  /**
   * A-mode `POST /prepaid/orders`: deducts exactly one pack quota (or replays
   * the same `requestId` without a second deduction) and returns the H5 claim
   * link. A caller must persist the request identity and an unknown/attempt
   * fact before invoking this method, and must never invent a fresh
   * `requestId` after an indeterminate result.
   */
  createPrepaidOrder(
    input: YangmaoOpenV1CreatePrepaidOrderInput,
    options?: YangmaoOpenV1ReadOptions,
  ): Promise<YangmaoOpenV1PrepaidOrderResult>;
  /**
   * C-mode `POST /gift-vouchers`: pre-deducts `packCount` packs (1–12) at
   * issuance, not at redemption, and returns the voucher code plus H5 link.
   * `requestId` is the vendor idempotency key; a caller must persist it and the
   * unknown outcome before invoking this method and must never invent a new
   * value after an indeterminate result.
   */
  createGiftVoucher(
    input: YangmaoOpenV1CreateGiftVoucherInput,
    options?: YangmaoOpenV1ReadOptions,
  ): Promise<YangmaoOpenV1GiftVoucherResult>;
}

export const DEFAULT_OPEN_V1_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;

/** Documented phone shape for A/B/C requests (`^1\d{10}$`). */
const PHONE_PATTERN = /^1\d{10}$/;
/** Nonce is signed verbatim, so it must never contain a separator or space. */
const NONCE_PATTERN = /^[0-9A-Za-z._-]{8,64}$/;

// `data` may be absent on error envelopes; a successful `code=0` without the
// expected object still fails the eligibility-shape check below.
const envelopeSchema = z.object({
  code: z.number().int(),
  data: z.unknown().optional(),
});

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function configError(): YangmaoOpenV1Error {
  return new YangmaoOpenV1Error('YANGMAO_OPEN_V1_CONFIG_INVALID');
}

/**
 * Normalizes the configured origin. Rejecting paths, credentials, queries and
 * non-HTTPS remote hosts keeps the signed request deterministic and prevents
 * the AppSecret-backed signature from travelling to an unintended scheme.
 */
function normalizeBaseUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw !== raw.trim()) throw configError();

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw configError();
  }

  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) throw configError();
  if (url.username || url.password) throw configError();
  if (url.pathname !== '/' || url.search || url.hash) throw configError();

  return url.origin;
}

function normalizeCredential(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) throw configError();
  if (hasControlCharacters(value)) throw configError();
  return value;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OPEN_V1_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw configError();
  }
  return value;
}

class YangmaoOpenV1Client implements YangmaoOpenV1PurchaseReader {
  private readonly baseUrl: string;
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly timeoutMs: number;
  private readonly transport: YangmaoOpenV1Transport;
  private readonly clock: () => number;
  private readonly nonceFactory: () => string;

  constructor(options: YangmaoOpenV1ClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.appKey = normalizeCredential(options.appKey);
    this.appSecret = normalizeCredential(options.appSecret);
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.transport = options.transport ?? ((request) => fetch(request));
    this.clock = options.clock ?? Date.now;
    this.nonceFactory = options.nonceFactory ?? (() => randomBytes(16).toString('hex'));
  }

  async checkPurchase(
    phone: string,
    options: YangmaoOpenV1ReadOptions = {},
  ): Promise<YangmaoOpenV1PurchaseEligibility> {
    // Nothing is signed or sent for an obviously invalid phone: a signed
    // request must carry exactly the value the platform validated.
    if (typeof phone !== 'string' || !PHONE_PATTERN.test(phone)) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_PHONE_INVALID');
    }

    const timestamp = String(Math.trunc(this.clock()));
    const nonce = this.nonceFactory();
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) throw configError();

    // The signed field set is built explicitly from the endpoint contract. The
    // JSON body is NOT walked to decide what participates.
    const signature = createOpenV1Signature(
      buildPurchaseCheckSignedFields({ appKey: this.appKey, timestamp, nonce }, phone),
      this.appSecret,
    );

    const data = await this.sendSignedRequest({
      path: OPEN_V1_PURCHASE_CHECK_PATH,
      method: 'POST',
      body: JSON.stringify({ phone }),
      timestamp,
      nonce,
      signature,
      callerSignal: options.signal,
    });

    const eligibility = parseOpenV1PurchaseEligibility(data);
    if (eligibility === null) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_RESPONSE_INVALID');
    }

    return {
      provider: 'yangmao',
      observedAt: new Date(this.clock()).toISOString(),
      ...eligibility,
    };
  }

  /**
   * A-mode order creation. The vendor treats `requestId` as the idempotency
   * key, so reusing it is the only safe way to retry or recover; a new value is
   * a genuinely new debit. The response is only accepted when both the vendor
   * order number and a credential-free http(s) claim link are present.
   */
  async createPrepaidOrder(
    input: YangmaoOpenV1CreatePrepaidOrderInput,
    options: YangmaoOpenV1ReadOptions = {},
  ): Promise<YangmaoOpenV1PrepaidOrderResult> {
    if (typeof input.phone !== 'string' || !PHONE_PATTERN.test(input.phone)) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_PHONE_INVALID');
    }
    if (typeof input.refCode !== 'string' || !RECOVERY_ID_PATTERN.test(input.refCode)) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_CONFIG_INVALID');
    }
    if (typeof input.requestId !== 'string' || !RECOVERY_ID_PATTERN.test(input.requestId)) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_CONFIG_INVALID');
    }
    if (
      input.productCode !== undefined &&
      (typeof input.productCode !== 'string' || !RECOVERY_ID_PATTERN.test(input.productCode))
    ) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_CONFIG_INVALID');
    }

    const timestamp = String(Math.trunc(this.clock()));
    const nonce = this.nonceFactory();
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) throw configError();

    const signature = createOpenV1Signature(
      buildPrepaidOrderSignedFields(
        { appKey: this.appKey, timestamp, nonce },
        input,
      ),
      this.appSecret,
    );

    // Omit an empty optional product code from BOTH the signed fields and the
    // JSON body, matching the vendor's "空值不参与" rule.
    const body: Record<string, string> = {
      phone: input.phone,
      refCode: input.refCode,
      requestId: input.requestId,
    };
    if (input.productCode) body.productCode = input.productCode;

    const data = await this.sendSignedRequest({
      path: OPEN_V1_PREPAID_ORDER_PATH,
      method: 'POST',
      body: JSON.stringify(body),
      timestamp,
      nonce,
      signature,
      callerSignal: options.signal,
    });

    const parsed = prepaidOrderResultSchema.safeParse(data);
    if (!parsed.success) throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_RESPONSE_INVALID');
    return {
      provider: 'yangmao',
      observedAt: new Date(this.clock()).toISOString(),
      orderNo: parsed.data.orderNo,
      claimUrl: parsed.data.claimUrl,
      ...(parsed.data.balanceAfter == null ? {} : { balanceAfter: parsed.data.balanceAfter }),
      ...(parsed.data.idempotentReplay == null
        ? {}
        : { idempotentReplay: parsed.data.idempotentReplay }),
    };
  }

  /**
   * C-mode voucher issuance. The vendor pre-deducts `packCount` packs here, so
   * this method is a write even though the recipient pays nothing. Both the
   * voucher code and the H5 link must be present before the response is
   * accepted; a `code=0` envelope without them is not an issuance.
   */
  async createGiftVoucher(
    input: YangmaoOpenV1CreateGiftVoucherInput,
    options: YangmaoOpenV1ReadOptions = {},
  ): Promise<YangmaoOpenV1GiftVoucherResult> {
    if (
      input.phone !== undefined &&
      (typeof input.phone !== 'string' || !PHONE_PATTERN.test(input.phone))
    ) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_PHONE_INVALID');
    }
    if (typeof input.refCode !== 'string' || !RECOVERY_ID_PATTERN.test(input.refCode)) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_CONFIG_INVALID');
    }
    if (typeof input.requestId !== 'string' || !RECOVERY_ID_PATTERN.test(input.requestId)) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_CONFIG_INVALID');
    }
    if (
      !Number.isInteger(input.packCount) ||
      input.packCount < GIFT_VOUCHER_PACK_COUNT_MIN ||
      input.packCount > GIFT_VOUCHER_PACK_COUNT_MAX
    ) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_CONFIG_INVALID');
    }
    if (
      input.productCode !== undefined &&
      (typeof input.productCode !== 'string' || !RECOVERY_ID_PATTERN.test(input.productCode))
    ) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_CONFIG_INVALID');
    }

    const timestamp = String(Math.trunc(this.clock()));
    const nonce = this.nonceFactory();
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) throw configError();

    const signature = createOpenV1Signature(
      buildGiftVoucherSignedFields({ appKey: this.appKey, timestamp, nonce }, input),
      this.appSecret,
    );

    // `packCount` stays a JSON number; the canonicalizer stringifies it for the
    // signature. Empty optional values are omitted from both sides.
    const body: Record<string, string | number> = {
      refCode: input.refCode,
      packCount: input.packCount,
      requestId: input.requestId,
    };
    if (input.phone) body.phone = input.phone;
    if (input.productCode) body.productCode = input.productCode;

    const data = await this.sendSignedRequest({
      path: OPEN_V1_GIFT_VOUCHER_PATH,
      method: 'POST',
      body: JSON.stringify(body),
      timestamp,
      nonce,
      signature,
      callerSignal: options.signal,
    });

    const parsed = issuedVoucherSchema.safeParse(data);
    if (!parsed.success) throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_RESPONSE_INVALID');
    return {
      provider: 'yangmao',
      observedAt: new Date(this.clock()).toISOString(),
      voucherCode: parsed.data.voucherCode,
      claimUrl: parsed.data.claimUrl,
      ...(parsed.data.packTotal == null ? {} : { packTotal: parsed.data.packTotal }),
      ...(parsed.data.packRemaining == null
        ? {}
        : { packRemaining: parsed.data.packRemaining }),
      ...(parsed.data.expiresAt == null ? {} : { expiresAt: parsed.data.expiresAt }),
      ...(parsed.data.balanceAfter == null ? {} : { balanceAfter: parsed.data.balanceAfter }),
      ...(parsed.data.idempotentReplay == null
        ? {}
        : { idempotentReplay: parsed.data.idempotentReplay }),
    };
  }

  /** A-mode link recovery. This POST is a read-only vendor business action. */
  async queryPrepaidOrder(    requestId: string,
    options: YangmaoOpenV1ReadOptions = {},
  ): Promise<YangmaoOpenV1PrepaidOrderLookup> {
    if (!RECOVERY_ID_PATTERN.test(requestId)) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_CONFIG_INVALID');
    }
    const timestamp = String(Math.trunc(this.clock()));
    const nonce = this.nonceFactory();
    if (!NONCE_PATTERN.test(nonce)) throw configError();
    const signature = createOpenV1Signature(
      { appKey: this.appKey, timestamp, nonce, requestId },
      this.appSecret,
    );
    const data = await this.sendSignedRequest({
      path: OPEN_V1_PREPAID_ORDER_QUERY_PATH,
      method: 'POST',
      body: JSON.stringify({ requestId }),
      timestamp,
      nonce,
      signature,
      callerSignal: options.signal,
    });
    const parsed = prepaidOrderLookupSchema.safeParse(data);
    if (!parsed.success) throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_RESPONSE_INVALID');
    const { claimUrl, claimable, orderNo } = parsed.data;
    if (claimUrl == null && claimable == null && orderNo == null) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_RESPONSE_INVALID');
    }
    return {
      provider: 'yangmao',
      observedAt: new Date(this.clock()).toISOString(),
      ...(claimUrl == null ? {} : { claimUrl }),
      ...(claimable == null ? {} : { claimable }),
      ...(orderNo == null ? {} : { orderNo }),
    };
  }

  /** C-mode lookup; the vendor voucher code is never logged or echoed. */
  async queryGiftVoucher(
    code: string,
    options: YangmaoOpenV1ReadOptions = {},
  ): Promise<YangmaoOpenV1GiftVoucherLookup> {
    if (!VOUCHER_CODE_PATTERN.test(code)) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_CONFIG_INVALID');
    }
    const timestamp = String(Math.trunc(this.clock()));
    const nonce = this.nonceFactory();
    if (!NONCE_PATTERN.test(nonce)) throw configError();
    const signature = createOpenV1Signature(
      { appKey: this.appKey, timestamp, nonce, code },
      this.appSecret,
    );
    const data = await this.sendSignedRequest({
      path: `/open/v1/gift-vouchers/${encodeURIComponent(code)}`,
      method: 'GET',
      timestamp,
      nonce,
      signature,
      callerSignal: options.signal,
    });
    const parsed = giftVoucherLookupSchema.safeParse(data);
    if (!parsed.success) throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_RESPONSE_INVALID');
    const { claimUrl, packTotal, packRemaining, expiresAt } = parsed.data;
    if (claimUrl == null && packTotal == null && packRemaining == null && expiresAt == null) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_RESPONSE_INVALID');
    }
    return {
      provider: 'yangmao',
      observedAt: new Date(this.clock()).toISOString(),
      ...(claimUrl == null ? {} : { claimUrl }),
      ...(packTotal == null ? {} : { packTotal }),
      ...(packRemaining == null ? {} : { packRemaining }),
      ...(expiresAt == null ? {} : { expiresAt }),
    };
  }

  /**
   * Shared signed A/B/C transport, no redirects, then four independent gates in
   * order — HTTP status, JSON parsing, envelope shape, and body `code`. The
   * caller receives the raw `data` value for endpoint-specific validation.
   * A successful envelope is still never interpreted here as an order, a
   * balance change or a delivered benefit.
   */
  private async sendSignedRequest(input: {
    path: string;
    method: 'GET' | 'POST';
    body?: string;
    timestamp: string;
    nonce: string;
    signature: string;
    callerSignal?: AbortSignal;
  }): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = input.callerSignal
      ? AbortSignal.any([input.callerSignal, timeoutSignal])
      : timeoutSignal;

    const request = new Request(`${this.baseUrl}${input.path}`, {
      method: input.method,
      headers: {
        'X-App-Key': this.appKey,
        'X-Timestamp': input.timestamp,
        'X-Nonce': input.nonce,
        'X-Sign': input.signature,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: input.body,
      redirect: 'manual',
      signal,
    });

    let response: Response;
    try {
      response = await this.transport(request);
    } catch {
      throw this.classifyAbortOrTransportFailure(input.callerSignal, timeoutSignal);
    }

    // HTTP status and body `code` are two independent gates. A 2xx status is
    // never read as a successful eligibility answer on its own.
    if (response.status === 401) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_AUTH_FAILED', { httpStatus: 401 });
    }
    if (response.status === 403) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_FORBIDDEN', { httpStatus: 403 });
    }
    if (!response.ok) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_HTTP_ERROR', {
        httpStatus: response.status,
      });
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw this.classifyAbortOrTransportFailure(input.callerSignal, timeoutSignal);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_RESPONSE_INVALID');
    }

    const envelope = envelopeSchema.safeParse(body);
    if (!envelope.success) {
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_RESPONSE_INVALID');
    }

    // Body `code` is checked before any eligibility field is read.
    if (envelope.data.code !== 0) {
      if (envelope.data.code === 401) {
        throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_AUTH_FAILED', {
          vendorCode: 401,
        });
      }
      if (envelope.data.code === 403) {
        throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_FORBIDDEN', {
          vendorCode: 403,
        });
      }
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_BUSINESS_FAILED', {
        vendorCode: envelope.data.code,
      });
    }

    return envelope.data.data;
  }

  private classifyAbortOrTransportFailure(
    callerSignal: AbortSignal | undefined,
    timeoutSignal: AbortSignal,
  ): YangmaoOpenV1Error {
    if (callerSignal?.aborted) return new YangmaoOpenV1Error('YANGMAO_OPEN_V1_CANCELLED');
    if (timeoutSignal.aborted) return new YangmaoOpenV1Error('YANGMAO_OPEN_V1_TIMEOUT');
    return new YangmaoOpenV1Error('YANGMAO_OPEN_V1_TRANSPORT_FAILED');
  }
}

/**
 * Builds the server-side A/B/C purchase-check reader. Credentials are supplied
 * by the server configuration at the call site and are never read from
 * globals, persisted, or included in errors.
 */
export function createYangmaoOpenV1Client(
  options: YangmaoOpenV1ClientOptions,
): YangmaoOpenV1PurchaseReader {
  return new YangmaoOpenV1Client(options);
}
