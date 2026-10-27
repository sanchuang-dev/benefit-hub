import { createHmac } from 'node:crypto';
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
const PRODUCT_CODE = 'TEST-1813';
/**
 * OpenSSL-derived vector for
 * `printf '1793059200000\n{"productCode":"TEST-1813"}' | openssl dgst -sha256
 *  -hmac 'test-secret-do-not-use' -binary | openssl base64 -A`
 * so the header expectation does not depend on the implementation under test.
 */
const DETAIL_SIGNATURE = 'r8ipv2R56uiczVxxOhEQkwjOFLiUI3oGVhgussoeMpo=';

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

/**
 * Sanitized contract-regression fixture based on the authorized 2026-10-27
 * signed read-only dev probe: the HTTP 200 / code=0 detail response had `data`
 * as an OBJECT whose observed keys included `productCode` (string), `name`
 * (string), `sellPrice` (number) plus goodsStatus/details/extraJson/... All
 * numbers here are fictitious fixture values. This is NOT the raw supplier
 * body and must not be presented as a live integration test.
 */
const OBSERVED_DETAIL_SHAPE_FIXTURE = {
  code: 0,
  message: 'success',
  data: {
    productCode: PRODUCT_CODE,
    id: 100_001,
    inriceGoodsId: 900_002,
    name: '测试商品一（虚构详情）',
    goodsType: 1,
    distributionType: 0,
    settlementType: 1,
    denomination: 10_000,
    salesPrice: 3.33,
    sellPrice: 2.22,
    goodsStatus: 1,
    defaultBatchId: 700_003,
    picture: 'https://fixture.invalid/p.png',
    sketch: '虚构简介',
    details: '<p>虚构富文本，禁止进入前端</p>',
    extraJson: '{"note":"虚构扩展字段"}',
    lastSyncTime: '2026-10-27 00:00:00',
  },
};

describe('D-mode product detail client', () => {
  it('sends the signed GET with the productCode query and parses only confirmed fields', async () => {
    let captured: Request | undefined;
    const client = createClient(async (request) => {
      captured = request;
      return jsonResponse(OBSERVED_DETAIL_SHAPE_FIXTURE);
    });

    const detail = await client.getProductDetail(PRODUCT_CODE);
    if (!captured) throw new Error('Transport did not receive a request');

    expect(captured.method).toBe('GET');
    expect(captured.url).toBe(
      `https://vendor.example.test/api/open/inrice/v1/products/query?productCode=${PRODUCT_CODE}`,
    );
    expect(captured.headers.get('x-app-key')).toBe(APP_KEY);
    expect(captured.headers.get('x-timestamp')).toBe(String(FIXED_NOW));
    expect(captured.headers.get('x-signature')).toBe(DETAIL_SIGNATURE);
    expect(captured.headers.get('accept')).toBe('application/json');
    // D uses X-Signature only; A/B/C headers must never appear here.
    expect(captured.headers.get('x-sign')).toBeNull();
    expect(captured.headers.get('x-nonce')).toBeNull();
    expect(captured.body).toBeNull();
    expect(captured.redirect).toBe('manual');
    expect(captured.url).not.toContain(APP_SECRET);

    expect(detail).toEqual({
      provider: 'yangmao',
      currency: 'CNY',
      observedAt: new Date(FIXED_NOW).toISOString(),
      productCode: PRODUCT_CODE,
      name: '测试商品一（虚构详情）',
      sellPriceCents: 222,
    });
    // Unconfirmed fields are dropped, never echoed: no saleability meaning is
    // invented from goodsStatus, and vendor HTML/JSON text cannot leak.
    for (const dropped of [
      'goodsStatus',
      'details',
      'extraJson',
      'picture',
      'sketch',
      'lastSyncTime',
      'salesPrice',
      'denomination',
      'id',
      'inriceGoodsId',
      'goodsType',
      'distributionType',
      'settlementType',
      'defaultBatchId',
    ]) {
      expect(detail).not.toHaveProperty(dropped);
    }
    expect(JSON.stringify(detail)).not.toContain('<p>');
    expect(JSON.stringify(detail)).not.toContain('extraJson');
    // A read-only detail carries no dispatch/fulfilment claim.
    expect(detail).not.toHaveProperty('dispatchStatus');
    expect(detail).not.toHaveProperty('fulfillmentSummary');
  });

  it('signs the raw productCode while percent-encoding the identical value into the URL query', async () => {
    // Space and quote force URL encoding in the query but must stay raw (and
    // JSON-escaped) inside the signed compact object the vendor verifies.
    const awkwardCode = '套 餐"A-1';
    let captured: Request | undefined;
    const client = createClient(async (request) => {
      captured = request;
      return jsonResponse({
        code: 0,
        data: { productCode: awkwardCode, name: '虚构商品', sellPrice: 1 },
      });
    });

    const detail = await client.getProductDetail(awkwardCode);
    if (!captured) throw new Error('Transport did not receive a request');

    const url = new URL(captured.url);
    expect(url.pathname).toBe('/api/open/inrice/v1/products/query');
    expect(url.searchParams.get('productCode')).toBe(awkwardCode);
    expect(captured.url).not.toContain(' ');
    // Independent HMAC of the spec string-to-sign: timestamp + newline + the
    // compact JSON carrying the same decoded code as the query.
    const expected = createHmac('sha256', APP_SECRET)
      .update(`${FIXED_NOW}\n${JSON.stringify({ productCode: awkwardCode })}`, 'utf8')
      .digest('base64');
    expect(captured.headers.get('x-signature')).toBe(expected);
    expect(detail).toMatchObject({ productCode: awkwardCode, sellPriceCents: 100 });
  });

  it.each([
    { raw: 2.22, expected: 222 },
    { raw: 30, expected: 3000 },
    { raw: '10.50', expected: 1050 },
    { raw: '0.01', expected: 1 },
  ])('converts detail sellPrice $raw yuan to $expected fen exactly', async ({ raw, expected }) => {
    const client = createClient(async () =>
      jsonResponse({ code: 0, data: { productCode: PRODUCT_CODE, name: '虚构商品', sellPrice: raw } }),
    );

    const detail = await client.getProductDetail(PRODUCT_CODE);
    expect(detail.sellPriceCents).toBe(expected);
  });
});

describe('D-mode product detail missing and abnormal data', () => {
  it('treats the observed HTTP 200 / code=400 "product does not exist" as a generic business failure', async () => {
    // Observed 2026-10-27 for a non-existent code: HTTP 200, body code=400,
    // data=null, message "趣米商品不存在". The numeric vendorCode is preserved
    // for the caller; the message string is NOT promoted to permanent
    // semantics and never reaches the thrown error.
    const client = createClient(async () =>
      jsonResponse({ code: 400, message: '趣米商品不存在', data: null }),
    );

    const error = await captureError(client.getProductDetail('MISSING-0001'));
    expect(error.code).toBe('YANGMAO_INRICE_BUSINESS_FAILED');
    expect(error.vendorCode).toBe(400);
    expect(error.httpStatus).toBeUndefined();
    expect(error.message).toBe('供应商业务处理失败');
    expect(error.message).not.toContain('趣米');
    expect(error.message).not.toContain('不存在');
  });

  it.each([
    { code: 500, expected: 'YANGMAO_INRICE_BUSINESS_FAILED' },
    { code: 401, expected: 'YANGMAO_INRICE_AUTH_FAILED' },
    { code: 403, expected: 'YANGMAO_INRICE_FORBIDDEN' },
  ])('maps HTTP 200 with body code=$code to $expected', async ({ code, expected }) => {
    const client = createClient(async () => jsonResponse({ code, message: 'failure', data: null }));

    const error = await captureError(client.getProductDetail(PRODUCT_CODE));
    expect(error.code).toBe(expected);
    expect(error.vendorCode).toBe(code);
  });

  it.each([
    { name: 'missing data', body: { code: 0 } },
    { name: 'null data on code=0', body: { code: 0, data: null } },
    { name: 'array data instead of object', body: { code: 0, data: [] } },
    { name: 'string data', body: { code: 0, data: PRODUCT_CODE } },
    {
      name: 'missing productCode',
      body: { code: 0, data: { name: '虚构商品', sellPrice: 1 } },
    },
    {
      name: 'productCode different from the requested one',
      body: { code: 0, data: { productCode: 'OTHER-1', name: '虚构商品', sellPrice: 1 } },
    },
    {
      name: 'non-string name',
      body: { code: 0, data: { productCode: PRODUCT_CODE, name: 123, sellPrice: 1 } },
    },
    {
      name: 'blank name',
      body: { code: 0, data: { productCode: PRODUCT_CODE, name: '   ', sellPrice: 1 } },
    },
    {
      name: 'name with control characters',
      body: { code: 0, data: { productCode: PRODUCT_CODE, name: 'bad\nname', sellPrice: 1 } },
    },
    {
      name: 'oversized name',
      body: { code: 0, data: { productCode: PRODUCT_CODE, name: 'x'.repeat(257), sellPrice: 1 } },
    },
    {
      name: 'missing sellPrice',
      body: { code: 0, data: { productCode: PRODUCT_CODE, name: '虚构商品' } },
    },
    {
      name: 'negative sellPrice',
      body: { code: 0, data: { productCode: PRODUCT_CODE, name: '虚构商品', sellPrice: -1 } },
    },
    {
      name: 'sub-fen precision sellPrice',
      body: { code: 0, data: { productCode: PRODUCT_CODE, name: '虚构商品', sellPrice: '2.222' } },
    },
    {
      name: 'non-numeric sellPrice',
      body: { code: 0, data: { productCode: PRODUCT_CODE, name: '虚构商品', sellPrice: 'ten' } },
    },
  ])('fails the whole detail read for $name', async ({ body }) => {
    const client = createClient(async () => jsonResponse(body));

    const error = await captureError(client.getProductDetail(PRODUCT_CODE));
    expect(error.code).toBe('YANGMAO_INRICE_RESPONSE_INVALID');
  });
});

describe('D-mode product detail failure normalization', () => {
  it.each([
    { status: 401, code: 'YANGMAO_INRICE_AUTH_FAILED' },
    { status: 403, code: 'YANGMAO_INRICE_FORBIDDEN' },
    { status: 500, code: 'YANGMAO_INRICE_HTTP_ERROR' },
    { status: 302, code: 'YANGMAO_INRICE_HTTP_ERROR' },
  ])('maps HTTP $status to $code', async ({ status, code }) => {
    const client = createClient(async () => jsonResponse({ code: 0, data: null }, status));

    const error = await captureError(client.getProductDetail(PRODUCT_CODE));
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
    expect(error.vendorCode).toBeUndefined();
  });

  it.each([
    { name: 'non-JSON body', response: () => Promise.resolve(new Response('<html>oops</html>')) },
    { name: 'empty body', response: () => Promise.resolve(new Response('')) },
    { name: 'missing code', response: () => jsonResponse({ data: null }) },
    { name: 'string code', response: () => jsonResponse({ code: '0', data: null }) },
  ])('rejects $name as a response-shape failure', async ({ response }) => {
    const client = createClient(response);

    const error = await captureError(client.getProductDetail(PRODUCT_CODE));
    expect(error.code).toBe('YANGMAO_INRICE_RESPONSE_INVALID');
  });

  it('classifies a timeout separately from other transport failures', async () => {
    const client = createClient(hangingTransport, { timeoutMs: 100 });

    const error = await captureError(client.getProductDetail(PRODUCT_CODE));
    expect(error.code).toBe('YANGMAO_INRICE_TIMEOUT');
  });

  it('classifies caller cancellation separately from a timeout', async () => {
    const controller = new AbortController();
    const client = createClient(hangingTransport, { timeoutMs: 5_000 });

    setTimeout(() => controller.abort(), 10);
    const error = await captureError(
      client.getProductDetail(PRODUCT_CODE, { signal: controller.signal }),
    );
    expect(error.code).toBe('YANGMAO_INRICE_CANCELLED');
  });

  it('honours an already-aborted caller signal without waiting', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createClient(hangingTransport, { timeoutMs: 5_000 });

    const error = await captureError(
      client.getProductDetail(PRODUCT_CODE, { signal: controller.signal }),
    );
    expect(error.code).toBe('YANGMAO_INRICE_CANCELLED');
  });

  it('normalizes a transport rejection without exposing its message', async () => {
    const client = createClient(async () => {
      throw new TypeError(`${APP_SECRET} at 10.0.0.1`);
    });

    const error = await captureError(client.getProductDetail(PRODUCT_CODE));
    expect(error.code).toBe('YANGMAO_INRICE_TRANSPORT_FAILED');
    expect(error.message).not.toContain(APP_SECRET);
    expect(JSON.stringify(error)).not.toContain(APP_SECRET);
  });
});

describe('D-mode product detail caller input boundary', () => {
  it.each([
    { name: 'empty code', productCode: '' },
    { name: 'blank code', productCode: '   ' },
    { name: 'outer whitespace', productCode: ` ${PRODUCT_CODE}` },
    { name: 'control character', productCode: 'TEST\n1813' },
    { name: 'oversized code', productCode: 'x'.repeat(129) },
  ])('rejects $name before signing or sending anything', async ({ productCode }) => {
    let transportCalls = 0;
    const client = createClient(async () => {
      transportCalls += 1;
      return jsonResponse(OBSERVED_DETAIL_SHAPE_FIXTURE);
    });

    const error = await captureError(client.getProductDetail(productCode));
    expect(error.code).toBe('YANGMAO_INRICE_PRODUCT_CODE_INVALID');
    expect(error.message).toBe('商品编码无效');
    expect(transportCalls).toBe(0);
  });
});
