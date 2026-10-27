import { describe, expect, it } from 'vitest';
import {
  createYangmaoInriceCatalogClient,
  YangmaoInriceError,
  type YangmaoInriceCatalogClientOptions,
  type YangmaoInriceTransport,
} from '../src/index.js';

const FIXED_NOW = 1793059200000;
const APP_KEY = 'fixture-app-key';
const APP_SECRET = 'test-secret-do-not-use';
const LIST_SIGNATURE =
  'WGOyr6kPjYGHpUQA7bSFkUA3oOMmxjKlWwxbj5SxsW4=';

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function createClient(
  transport: YangmaoInriceTransport,
  overrides: Partial<YangmaoInriceCatalogClientOptions> = {},
) {
  return createYangmaoInriceCatalogClient({
    baseUrl: 'https://vendor.example.test',
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    clock: () => FIXED_NOW,
    transport,
    ...overrides,
  });
}

async function captureError(promise: Promise<unknown>): Promise<YangmaoInriceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(YangmaoInriceError);
    return error as YangmaoInriceError;
  }
  throw new Error('Expected the client request to reject');
}

/** Simulates a transport waiting on the request signal until it is aborted. */
function hangingTransport(request: Request): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(request.signal.reason);
    if (request.signal.aborted) {
      fail();
      return;
    }
    request.signal.addEventListener('abort', fail, { once: true });
  });
}

const SUCCESS_BODY = {
  code: 0,
  message: 'success',
  data: [
    {
      productCode: 'INRICE_VIP_30',
      sellPrice: 30.0,
      // The actual dev list used "name"; it is not exposed in this narrow adapter.
      name: '上游名称（已观察，但本卡不输出展示文案）',
      status: 'ON_SALE',
    },
    { productCode: 'INRICE_CARD_10', sellPrice: '10.50' },
  ],
};

/**
 * Sanitized contract-regression fixture based on the authorized 2026-10-27
 * read-only probe: the HTTP 200 / code=0 response had `data` as an ARRAY with
 * 21 entries; the sampled items had `productCode`, `name`, `sellPrice`.
 * This is a deliberately synthetic 4-item subset, NOT the raw supplier body,
 * and must not be presented as a new live integration test.
 */
const OBSERVED_LIST_SHAPE_FIXTURE = {
  code: 0,
  message: 'success',
  data: [
    { productCode: 'TEST-1813', name: '测试商品一', sellPrice: 2.22 },
    { productCode: 'TEST-2423', name: '测试商品二', sellPrice: 2.2 },
    { productCode: 'TEST-2418', name: '测试商品三', sellPrice: 2.2 },
    { productCode: 'TEST-4243', name: '测试商品四', sellPrice: 2.2 },
  ],
};

describe('D-mode product list client', () => {
  it('sends the exact D headers and parses only confirmed fields', async () => {
    let captured: Request | undefined;
    const client = createClient(async (request) => {
      captured = request;
      return jsonResponse(SUCCESS_BODY);
    });

    const catalog = await client.listProducts();
    if (!captured) throw new Error('Transport did not receive a request');

    expect(captured.method).toBe('GET');
    expect(captured.url).toBe('https://vendor.example.test/api/open/inrice/v1/products');
    expect(captured.headers.get('x-app-key')).toBe(APP_KEY);
    expect(captured.headers.get('x-timestamp')).toBe(String(FIXED_NOW));
    expect(captured.headers.get('x-signature')).toBe(LIST_SIGNATURE);
    expect(captured.headers.get('accept')).toBe('application/json');
    // D uses X-Signature only; A/B/C headers must never appear here.
    expect(captured.headers.get('x-sign')).toBeNull();
    expect(captured.headers.get('x-nonce')).toBeNull();
    expect(captured.body).toBeNull();
    expect(captured.redirect).toBe('manual');
    expect(captured.url).not.toContain(APP_SECRET);

    expect(catalog).toEqual({
      provider: 'yangmao',
      currency: 'CNY',
      observedAt: new Date(FIXED_NOW).toISOString(),
      products: [
        { productCode: 'INRICE_VIP_30', sellPriceCents: 3000 },
        { productCode: 'INRICE_CARD_10', sellPriceCents: 1050 },
      ],
    });
    // A read-only catalogue snapshot carries no dispatch/fulfilment claim.
    expect(catalog).not.toHaveProperty('dispatchStatus');
    expect(catalog).not.toHaveProperty('fulfillmentSummary');
  });

  it('accepts the observed D list envelope and sampled item fields without inventing display data', async () => {
    const client = createClient(async () => jsonResponse(OBSERVED_LIST_SHAPE_FIXTURE));

    const catalog = await client.listProducts();

    expect(catalog.products).toEqual([
      { productCode: 'TEST-1813', sellPriceCents: 222 },
      { productCode: 'TEST-2423', sellPriceCents: 220 },
      { productCode: 'TEST-2418', sellPriceCents: 220 },
      { productCode: 'TEST-4243', sellPriceCents: 220 },
    ]);
    expect(catalog.products.every((product) => !('name' in product))).toBe(true);
  });

  it.each([
    { raw: 30, expected: 3000 },
    { raw: 30.5, expected: 3050 },
    { raw: '10.50', expected: 1050 },
    { raw: '0.01', expected: 1 },
    { raw: '0', expected: 0 },
    { raw: 0.07, expected: 7 },
  ])('converts vendor sellPrice $raw yuan to $expected fen exactly', async ({ raw, expected }) => {
    const client = createClient(async () =>
      jsonResponse({ code: 0, data: [{ productCode: 'SKU-1', sellPrice: raw }] }),
    );

    const catalog = await client.listProducts();
    expect(catalog.products).toEqual([{ productCode: 'SKU-1', sellPriceCents: expected }]);
  });

  it.each([
    { name: 'negative price', data: [{ productCode: 'SKU-1', sellPrice: -1 }] },
    { name: 'sub-fen precision', data: [{ productCode: 'SKU-1', sellPrice: '10.001' }] },
    { name: 'exponent notation', data: [{ productCode: 'SKU-1', sellPrice: '1e3' }] },
    { name: 'outer whitespace', data: [{ productCode: 'SKU-1', sellPrice: ' 10' }] },
    { name: 'leading zero', data: [{ productCode: 'SKU-1', sellPrice: '01.00' }] },
    { name: 'non-numeric price', data: [{ productCode: 'SKU-1', sellPrice: 'ten' }] },
    { name: 'null price', data: [{ productCode: 'SKU-1', sellPrice: null }] },
    { name: 'missing price', data: [{ productCode: 'SKU-1' }] },
    { name: 'blank code', data: [{ productCode: '  ', sellPrice: 1 }] },
    { name: 'missing code', data: [{ sellPrice: 1 }] },
  ])('fails the whole snapshot for $name', async ({ data }) => {
    const client = createClient(async () => jsonResponse({ code: 0, data }));

    const error = await captureError(client.listProducts());
    expect(error.code).toBe('YANGMAO_INRICE_RESPONSE_INVALID');
  });
});

describe('D-mode product list failure normalization', () => {
  it.each([
    { status: 401, code: 'YANGMAO_INRICE_AUTH_FAILED' },
    { status: 403, code: 'YANGMAO_INRICE_FORBIDDEN' },
    { status: 500, code: 'YANGMAO_INRICE_HTTP_ERROR' },
    { status: 302, code: 'YANGMAO_INRICE_HTTP_ERROR' },
  ])('maps HTTP $status to $code', async ({ status, code }) => {
    const client = createClient(async () =>
      jsonResponse({ code: 0, message: 'success', data: [] }, status),
    );

    const error = await captureError(client.listProducts());
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
    expect(error.vendorCode).toBeUndefined();
  });

  it('treats HTTP 200 with body code=500 as a business failure, not success', async () => {
    const client = createClient(async () =>
      jsonResponse({ code: 500, message: 'server error', data: null }),
    );

    const error = await captureError(client.listProducts());
    expect(error.code).toBe('YANGMAO_INRICE_BUSINESS_FAILED');
    expect(error.vendorCode).toBe(500);
    expect(error.httpStatus).toBeUndefined();
  });

  it.each([
    { code: 401, expected: 'YANGMAO_INRICE_AUTH_FAILED' },
    { code: 403, expected: 'YANGMAO_INRICE_FORBIDDEN' },
    { code: 400, expected: 'YANGMAO_INRICE_BUSINESS_FAILED' },
  ])('maps HTTP 200 with body code=$code to $expected', async ({ code, expected }) => {
    const client = createClient(async () => jsonResponse({ code, message: 'failure' }));

    const error = await captureError(client.listProducts());
    expect(error.code).toBe(expected);
    expect(error.vendorCode).toBe(code);
  });

  it.each([
    { name: 'non-JSON body', response: () => Promise.resolve(new Response('<html>oops</html>')) },
    { name: 'empty body', response: () => Promise.resolve(new Response('')) },
    { name: 'missing code', response: () => jsonResponse({ data: [] }) },
    { name: 'string code', response: () => jsonResponse({ code: '0', data: [] }) },
    { name: 'object data instead of array', response: () => jsonResponse({ code: 0, data: { list: [] } }) },
    { name: 'missing data', response: () => jsonResponse({ code: 0 }) },
  ])('rejects $name as a response-shape failure', async ({ response }) => {
    const client = createClient(response);

    const error = await captureError(client.listProducts());
    expect(error.code).toBe('YANGMAO_INRICE_RESPONSE_INVALID');
  });

  it('classifies a timeout separately from other transport failures', async () => {
    const client = createClient(hangingTransport, { timeoutMs: 100 });

    const error = await captureError(client.listProducts());
    expect(error.code).toBe('YANGMAO_INRICE_TIMEOUT');
  });

  it('classifies caller cancellation separately from a timeout', async () => {
    const controller = new AbortController();
    const client = createClient(hangingTransport, { timeoutMs: 5_000 });

    setTimeout(() => controller.abort(), 10);
    const error = await captureError(client.listProducts({ signal: controller.signal }));
    expect(error.code).toBe('YANGMAO_INRICE_CANCELLED');
  });

  it('honours an already-aborted caller signal without waiting', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createClient(hangingTransport, { timeoutMs: 5_000 });

    const error = await captureError(client.listProducts({ signal: controller.signal }));
    expect(error.code).toBe('YANGMAO_INRICE_CANCELLED');
  });

  it('normalizes a transport rejection without exposing its message', async () => {
    const client = createClient(async () => {
      throw new TypeError(`${APP_SECRET} at 10.0.0.1`);
    });

    const error = await captureError(client.listProducts());
    expect(error.code).toBe('YANGMAO_INRICE_TRANSPORT_FAILED');
    expect(error.message).not.toContain(APP_SECRET);
    expect(JSON.stringify(error)).not.toContain(APP_SECRET);
  });

  it('never copies the vendor message or credentials into an error', async () => {
    const client = createClient(async () =>
      jsonResponse({ code: 500, message: `AppSecret=${APP_SECRET}`, data: null }),
    );

    const error = await captureError(client.listProducts());
    expect(error.message).not.toContain(APP_SECRET);
    expect(error.message).not.toContain('AppSecret');
    expect(JSON.stringify(error)).not.toContain(APP_SECRET);
  });
});

describe('D-mode client configuration boundary', () => {
  const valid = {
    baseUrl: 'https://vendor.example.test',
    appKey: APP_KEY,
    appSecret: APP_SECRET,
  };

  it.each([
    { name: 'remote plain HTTP', baseUrl: 'http://vendor.example.test' },
    { name: 'unsupported scheme', baseUrl: 'ftp://vendor.example.test' },
    { name: 'relative URL', baseUrl: 'vendor.example.test' },
    { name: 'URL credentials', baseUrl: 'https://user:pass@vendor.example.test' },
    { name: 'path prefix', baseUrl: 'https://vendor.example.test/api' },
    { name: 'query string', baseUrl: 'https://vendor.example.test?x=1' },
  ])('rejects $name base URLs', ({ baseUrl }) => {
    expect(() =>
      createYangmaoInriceCatalogClient({ ...valid, baseUrl, transport: hangingTransport }),
    ).toThrowError(YangmaoInriceError);
  });

  it('accepts plain HTTP only for a loopback test server', async () => {
    const client = createYangmaoInriceCatalogClient({
      ...valid,
      baseUrl: 'http://127.0.0.1:3999',
      transport: async () => jsonResponse({ code: 0, data: [] }),
    });
    await expect(client.listProducts()).resolves.toMatchObject({ products: [] });
  });

  it.each([
    { name: 'blank appKey', appKey: '   ' },
    { name: 'blank appSecret', appSecret: '' },
    { name: 'outer whitespace in secret', appSecret: ' secret ' },
    { name: 'timeout below bound', timeoutMs: 99 },
    { name: 'timeout above bound', timeoutMs: 60_001 },
    { name: 'fractional timeout', timeoutMs: 1000.5 },
  ])('rejects $name without echoing credentials', ({ name: _name, ...overrides }) => {
    let thrown: unknown;
    try {
      createYangmaoInriceCatalogClient({
        ...valid,
        ...overrides,
        transport: hangingTransport,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(YangmaoInriceError);
    const error = thrown as YangmaoInriceError;
    expect(error.code).toBe('YANGMAO_INRICE_CONFIG_INVALID');
    expect(String(error)).not.toContain(APP_SECRET);
    expect(JSON.stringify(error)).not.toContain(APP_SECRET);
  });
});
