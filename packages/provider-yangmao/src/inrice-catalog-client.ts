import { z } from 'zod';
import { YangmaoInriceError } from './inrice-errors.js';
import {
  parseInriceProducts,
  productCodeSchema,
  type YangmaoInriceCatalog,
} from './inrice-products.js';
import {
  parseInriceProductDetail,
  type YangmaoInriceProductDetail,
} from './inrice-product-detail.js';
import {
  normalizeInriceOrderQueryInput,
  parseInriceOrderQueryData,
  type YangmaoInriceOrderQueryInput,
  type YangmaoInriceOrderQueryResult,
} from './inrice-order-query.js';
import {
  normalizeInriceDispatchInput,
  type YangmaoInriceDispatchInput,
  type YangmaoInriceDispatchResult,
} from './inrice-dispatch.js';
import {
  buildInriceDispatchSignedBody,
  buildInriceOrderQuerySignedBody,
  buildInriceProductDetailSignedBody,
  createInriceSignature,
  INRICE_DISPATCH_PATH,
  INRICE_LIST_SIGNED_BODY,
  INRICE_ORDER_QUERY_PATH,
  INRICE_PRODUCTS_PATH,
  INRICE_PRODUCT_DETAIL_PATH,
} from './inrice-signature.js';
import { hasControlCharacters } from './text-safety.js';

/**
 * Replaces only the HTTP transport (for contract tests or a future proxy).
 * A replacement must honour `request.signal` and must not follow redirects.
 */
export type YangmaoInriceTransport = (request: Request) => Promise<Response>;

export interface YangmaoInriceCatalogClientOptions {
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
  transport?: YangmaoInriceTransport;
  /** Millisecond clock; injectable to freeze the signature timestamp. */
  clock?: () => number;
}

export interface YangmaoInriceReadOptions {
  /** Caller cancellation, distinguished from a timeout in the error code. */
  signal?: AbortSignal;
}

/** Backwards-compatible name for the existing list reader options. */
export type YangmaoInriceListOptions = YangmaoInriceReadOptions;

export interface YangmaoInriceDispatchWriter {
  /**
   * Executes one D-mode dispatch submission. A resolved result means only that
   * the supplier returned HTTP success + body code=0; delivery is verified
   * later through queryOrder().
   */
  dispatch(
    input: YangmaoInriceDispatchInput,
    options?: YangmaoInriceReadOptions,
  ): Promise<YangmaoInriceDispatchResult>;
}

export interface YangmaoInriceOrderReader {
  /**
   * Read-only D order lookup. The provider status token is preserved without
   * inventing terminal semantics; until those are verified the result state
   * remains `unknown`.
   */
  queryOrder(
    input: YangmaoInriceOrderQueryInput,
    options?: YangmaoInriceReadOptions,
  ): Promise<YangmaoInriceOrderQueryResult>;
}

export interface YangmaoInriceCatalogReader {
  /** Read-only snapshot. Never implies supplier dispatch or fulfilment success. */
  listProducts(options?: YangmaoInriceReadOptions): Promise<YangmaoInriceCatalog>;
  /**
   * Read-only detail for one vendor product code. A code the vendor does not
   * know surfaces as a business failure carrying the vendor's numeric code,
   * never as an empty success and never as a dispatch/fulfilment signal.
   */
  getProductDetail(
    productCode: string,
    options?: YangmaoInriceReadOptions,
  ): Promise<YangmaoInriceProductDetail>;
}

export const DEFAULT_INRICE_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;

// `data` may be absent on error envelopes; a successful `code=0` without a
// catalogue array still fails the product-shape check below.
const envelopeSchema = z.object({
  code: z.number().int(),
  message: z.unknown().optional(),
  data: z.unknown().optional(),
});

type BusinessFailureClassifier = (
  vendorCode: number,
  vendorMessage: string | undefined,
) => YangmaoInriceError | undefined;

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function configError(): YangmaoInriceError {
  return new YangmaoInriceError('YANGMAO_INRICE_CONFIG_INVALID');
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

function safeVendorMessage(
  value: unknown,
  sensitiveValues: readonly string[],
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (normalized === '' || normalized.length > 256 || hasControlCharacters(normalized)) {
    return undefined;
  }
  if (sensitiveValues.some((secret) => secret !== '' && normalized.includes(secret))) {
    return undefined;
  }
  if (/appsecret|x-signature|x-app-key|authorization|bearer\s|access[_ -]?token/i.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_INRICE_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw configError();
  }
  return value;
}

class YangmaoInriceCatalogClient
  implements YangmaoInriceCatalogReader, YangmaoInriceOrderReader, YangmaoInriceDispatchWriter
{
  private readonly baseUrl: string;
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly timeoutMs: number;
  private readonly transport: YangmaoInriceTransport;
  private readonly clock: () => number;

  constructor(options: YangmaoInriceCatalogClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.appKey = normalizeCredential(options.appKey);
    this.appSecret = normalizeCredential(options.appSecret);
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.transport = options.transport ?? ((request) => fetch(request));
    this.clock = options.clock ?? Date.now;
  }

  async listProducts(options: YangmaoInriceReadOptions = {}): Promise<YangmaoInriceCatalog> {
    const data = await this.readSignedData(
      INRICE_PRODUCTS_PATH,
      INRICE_LIST_SIGNED_BODY,
      options.signal,
    );

    const products = parseInriceProducts(data);
    if (products === null) {
      throw new YangmaoInriceError('YANGMAO_INRICE_RESPONSE_INVALID');
    }

    return {
      provider: 'yangmao',
      currency: 'CNY',
      observedAt: new Date(this.clock()).toISOString(),
      products,
    };
  }

  async getProductDetail(
    productCode: string,
    options: YangmaoInriceReadOptions = {},
  ): Promise<YangmaoInriceProductDetail> {
    // The code is embedded in both the signed JSON and the URL query; a blank
    // or control-character code must fail locally before anything is signed.
    if (!productCodeSchema.safeParse(productCode).success) {
      throw new YangmaoInriceError('YANGMAO_INRICE_PRODUCT_CODE_INVALID');
    }

    // The raw code is signed; URLSearchParams percent-encodes the identical
    // raw value into the query so the vendor decodes exactly what was signed.
    const pathWithQuery = `${INRICE_PRODUCT_DETAIL_PATH}?${new URLSearchParams({ productCode })}`;
    const data = await this.readSignedData(
      pathWithQuery,
      buildInriceProductDetailSignedBody(productCode),
      options.signal,
    );

    const detail = parseInriceProductDetail(data, productCode);
    if (detail === null) {
      throw new YangmaoInriceError('YANGMAO_INRICE_RESPONSE_INVALID');
    }

    return {
      provider: 'yangmao',
      currency: 'CNY',
      observedAt: new Date(this.clock()).toISOString(),
      ...detail,
    };
  }

  async dispatch(
    input: YangmaoInriceDispatchInput,
    options: YangmaoInriceReadOptions = {},
  ): Promise<YangmaoInriceDispatchResult> {
    const normalized = normalizeInriceDispatchInput(input);
    if (normalized === null) {
      throw new YangmaoInriceError('YANGMAO_INRICE_DISPATCH_INPUT_INVALID');
    }

    const signedBody = buildInriceDispatchSignedBody(normalized);
    const requestBody = JSON.stringify({
      partnerOrderNo: normalized.partnerOrderNo,
      productCode: normalized.productCode,
      mobile: normalized.mobile,
    });
    await this.requestSignedData(
      'POST',
      INRICE_DISPATCH_PATH,
      signedBody,
      options.signal,
      requestBody,
    );

    return {
      provider: 'yangmao',
      partnerOrderNo: normalized.partnerOrderNo,
      accepted: true,
      observedAt: new Date(this.clock()).toISOString(),
    };
  }

  async queryOrder(
    input: YangmaoInriceOrderQueryInput,
    options: YangmaoInriceReadOptions = {},
  ): Promise<YangmaoInriceOrderQueryResult> {
    const normalized = normalizeInriceOrderQueryInput(input);
    if (normalized === null) {
      throw new YangmaoInriceError('YANGMAO_INRICE_ORDER_QUERY_INVALID');
    }

    const query = new URLSearchParams();
    if (normalized.orderNo !== undefined) query.set('orderNo', normalized.orderNo);
    if (normalized.partnerOrderNo !== undefined) {
      query.set('partnerOrderNo', normalized.partnerOrderNo);
    }

    const pathWithQuery = `${INRICE_ORDER_QUERY_PATH}?${query.toString()}`;
    const data = await this.readSignedData(
      pathWithQuery,
      buildInriceOrderQuerySignedBody(normalized),
      options.signal,
      (vendorCode, vendorMessage) => {
        if (vendorCode === 400 && vendorMessage === '订单不存在') {
          return new YangmaoInriceError('YANGMAO_INRICE_ORDER_NOT_FOUND', {
            vendorCode,
            ...(vendorMessage === undefined ? {} : { vendorMessage }),
          });
        }
        return undefined;
      },
    );

    const order = parseInriceOrderQueryData(data, normalized);
    if (order === null) {
      throw new YangmaoInriceError('YANGMAO_INRICE_RESPONSE_INVALID');
    }

    return {
      provider: 'yangmao',
      observedAt: new Date(this.clock()).toISOString(),
      query: normalized,
      ...order,
    };
  }

  /**
   * Shared signed-GET pipeline for every D read: D headers only, no redirect
   * following, then four independent gates in order — HTTP status, JSON
   * parsing, envelope shape, and body `code`. The caller receives the raw
   * `data` value for endpoint-specific validation; nothing here is ever
   * interpreted as dispatch or fulfilment success.
   */
  private async readSignedData(
    pathWithQuery: string,
    signedBody: string,
    callerSignal: AbortSignal | undefined,
    businessFailureClassifier?: BusinessFailureClassifier,
  ): Promise<unknown> {
    return this.requestSignedData(
      'GET',
      pathWithQuery,
      signedBody,
      callerSignal,
      undefined,
      businessFailureClassifier,
    );
  }

  private async requestSignedData(
    method: 'GET' | 'POST',
    pathWithQuery: string,
    signedBody: string,
    callerSignal: AbortSignal | undefined,
    requestBody?: string,
    businessFailureClassifier?: BusinessFailureClassifier,
  ): Promise<unknown> {
    const timestamp = String(Math.trunc(this.clock()));
    const signature = createInriceSignature(this.appSecret, timestamp, signedBody);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    const request = new Request(`${this.baseUrl}${pathWithQuery}`, {
      method,
      headers: {
        'X-App-Key': this.appKey,
        'X-Timestamp': timestamp,
        'X-Signature': signature,
        Accept: 'application/json',
        ...(requestBody === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(requestBody === undefined ? {} : { body: requestBody }),
      redirect: 'manual',
      signal,
    });

    let response: Response;
    try {
      response = await this.transport(request);
    } catch {
      throw this.classifyAbortOrTransportFailure(callerSignal, timeoutSignal);
    }

    // HTTP status and body `code` are two independent gates. Neither is ever
    // interpreted as dispatch/fulfilment success by this read-only client.
    if (response.status === 401) {
      throw new YangmaoInriceError('YANGMAO_INRICE_AUTH_FAILED', { httpStatus: 401 });
    }
    if (response.status === 403) {
      throw new YangmaoInriceError('YANGMAO_INRICE_FORBIDDEN', { httpStatus: 403 });
    }
    if (!response.ok) {
      throw new YangmaoInriceError('YANGMAO_INRICE_HTTP_ERROR', { httpStatus: response.status });
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
      throw new YangmaoInriceError('YANGMAO_INRICE_RESPONSE_INVALID');
    }

    const envelope = envelopeSchema.safeParse(body);
    if (!envelope.success) {
      throw new YangmaoInriceError('YANGMAO_INRICE_RESPONSE_INVALID');
    }

    if (envelope.data.code !== 0) {
      if (envelope.data.code === 401) {
        throw new YangmaoInriceError('YANGMAO_INRICE_AUTH_FAILED', { vendorCode: 401 });
      }
      if (envelope.data.code === 403) {
        throw new YangmaoInriceError('YANGMAO_INRICE_FORBIDDEN', { vendorCode: 403 });
      }
      const vendorMessage = safeVendorMessage(
        envelope.data.message,
        [this.appKey, this.appSecret],
      );
      const classified = businessFailureClassifier?.(
        envelope.data.code,
        vendorMessage,
      );
      if (classified) throw classified;
      throw new YangmaoInriceError('YANGMAO_INRICE_BUSINESS_FAILED', {
        vendorCode: envelope.data.code,
        ...(vendorMessage === undefined ? {} : { vendorMessage }),
      });
    }

    return envelope.data.data;
  }

  private classifyAbortOrTransportFailure(
    callerSignal: AbortSignal | undefined,
    timeoutSignal: AbortSignal,
  ): YangmaoInriceError {
    if (callerSignal?.aborted) return new YangmaoInriceError('YANGMAO_INRICE_CANCELLED');
    if (timeoutSignal.aborted) return new YangmaoInriceError('YANGMAO_INRICE_TIMEOUT');
    return new YangmaoInriceError('YANGMAO_INRICE_TRANSPORT_FAILED');
  }
}

/**
 * Builds the server-side D-mode catalogue reader. Credentials are supplied by
 * the server configuration at the call site and are never read from globals,
 * persisted, or included in errors.
 */
export function createYangmaoInriceCatalogClient(
  options: YangmaoInriceCatalogClientOptions,
): YangmaoInriceCatalogReader & YangmaoInriceOrderReader & YangmaoInriceDispatchWriter {
  return new YangmaoInriceCatalogClient(options);
}
