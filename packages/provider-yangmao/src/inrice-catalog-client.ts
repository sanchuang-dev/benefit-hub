import { z } from 'zod';
import { YangmaoInriceError } from './inrice-errors.js';
import {
  parseInriceProducts,
  type YangmaoInriceCatalog,
} from './inrice-products.js';
import {
  createInriceSignature,
  INRICE_LIST_SIGNED_BODY,
  INRICE_PRODUCTS_PATH,
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

export interface YangmaoInriceListOptions {
  /** Caller cancellation, distinguished from a timeout in the error code. */
  signal?: AbortSignal;
}

export interface YangmaoInriceCatalogReader {
  /** Read-only snapshot. Never implies supplier dispatch or fulfilment success. */
  listProducts(options?: YangmaoInriceListOptions): Promise<YangmaoInriceCatalog>;
}

export const DEFAULT_INRICE_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;

// `data` may be absent on error envelopes; a successful `code=0` without a
// catalogue array still fails the product-shape check below.
const envelopeSchema = z.object({
  code: z.number().int(),
  data: z.unknown().optional(),
});

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

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_INRICE_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw configError();
  }
  return value;
}

class YangmaoInriceCatalogClient implements YangmaoInriceCatalogReader {
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

  async listProducts(options: YangmaoInriceListOptions = {}): Promise<YangmaoInriceCatalog> {
    const timestamp = String(Math.trunc(this.clock()));
    const signature = createInriceSignature(this.appSecret, timestamp, INRICE_LIST_SIGNED_BODY);
    const callerSignal = options.signal;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    const request = new Request(`${this.baseUrl}${INRICE_PRODUCTS_PATH}`, {
      method: 'GET',
      headers: {
        'X-App-Key': this.appKey,
        'X-Timestamp': timestamp,
        'X-Signature': signature,
        Accept: 'application/json',
      },
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
      throw new YangmaoInriceError('YANGMAO_INRICE_BUSINESS_FAILED', {
        vendorCode: envelope.data.code,
      });
    }

    const products = parseInriceProducts(envelope.data.data);
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
): YangmaoInriceCatalogReader {
  return new YangmaoInriceCatalogClient(options);
}
