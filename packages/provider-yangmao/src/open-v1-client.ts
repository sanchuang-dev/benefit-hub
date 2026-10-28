import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { YangmaoOpenV1Error } from './open-v1-errors.js';
import {
  parseOpenV1PurchaseEligibility,
  type YangmaoOpenV1PurchaseEligibility,
} from './open-v1-purchase-check.js';
import {
  buildPurchaseCheckSignedFields,
  createOpenV1Signature,
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
const RECOVERY_ID_PATTERN = /^[!-~]{1,64}$/;
const VOUCHER_CODE_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
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
const giftVoucherLookupSchema = z.object({
  claimUrl: safeClaimUrlSchema.nullish(),
  packTotal: z.number().int().min(0).nullish(),
  packRemaining: z.number().int().min(0).nullish(),
  // Vendor has not yet confirmed timestamp unit/encoding. Preserve the raw
  // bounded scalar without guessing ISO/Unix seconds/milliseconds.
  expiresAt: z.union([z.string().min(1).max(128), z.number().finite().nonnegative()]).nullish(),
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

    const data = await this.readSignedData(
      timestamp,
      nonce,
      signature,
      phone,
      options.signal,
    );

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

  /** A-mode link recovery. This POST is a read-only vendor business action. */
  async queryPrepaidOrder(
    requestId: string,
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
    const data = await this.readSignedData(
      timestamp, nonce, signature, '', options.signal, {
        path: '/open/v1/prepaid/orders/query',
        method: 'POST',
        body: JSON.stringify({ requestId }),
      },
    );
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
    const data = await this.readSignedData(
      timestamp, nonce, signature, '', options.signal, {
        path: `/open/v1/gift-vouchers/${encodeURIComponent(code)}`,
        method: 'GET',
      },
    );
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
   * Shared signed A/B/C read pipeline (business-read POST or GET), no redirects,
   * then four independent gates in order — HTTP status, JSON parsing, envelope
   * shape, and body `code`. The caller receives the raw `data` value for
   * endpoint-specific validation; nothing here is ever interpreted as an
   * order, a balance change or a deduction.
   */
  private async readSignedData(
    timestamp: string,
    nonce: string,
    signature: string,
    phone: string,
    callerSignal: AbortSignal | undefined,
    recovery?: { path: string; method: 'GET' | 'POST'; body?: string },
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    const request = new Request(`${this.baseUrl}${recovery?.path ?? OPEN_V1_PURCHASE_CHECK_PATH}`, {
      method: recovery?.method ?? 'POST',
      headers: {
        'X-App-Key': this.appKey,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Sign': signature,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: recovery ? recovery.body : JSON.stringify({ phone }),
      redirect: 'manual',
      signal,
    });

    let response: Response;
    try {
      response = await this.transport(request);
    } catch {
      throw this.classifyAbortOrTransportFailure(callerSignal, timeoutSignal);
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
      throw this.classifyAbortOrTransportFailure(callerSignal, timeoutSignal);
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
