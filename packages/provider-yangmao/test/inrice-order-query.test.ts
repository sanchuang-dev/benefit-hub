import { describe, expect, it } from 'vitest';
import {
  buildInriceOrderQuerySignedBody,
  createYangmaoInriceCatalogClient,
  YangmaoInriceError,
  type YangmaoInriceCatalogClientOptions,
  type YangmaoInriceTransport,
} from '../src/index.js';

const FIXED_NOW = 1793059200000;
const APP_KEY = 'fixture-app-key';
const APP_SECRET = 'test-secret-do-not-use';

const ORDER_NO = 'D202610310001';
const PARTNER_ORDER_NO = 'P202610310001';

// Independent HMAC-SHA256/Base64 vectors for FIXED_NOW were cross-checked
// outside this module against the exact compact JSON bytes used below.
const ORDER_ONLY_SIGNATURE =
  '2NBRwuMC2dGY1BsTCFGcMUrXo8apJtp5KFfQapogXa0=';
const PARTNER_ONLY_SIGNATURE =
  'bagxdd4hgeMu8LQuN+sgXM14gWeYQD2sf/ezbu7DFgQ=';
const BOTH_SIGNATURE =
  'x9IuDLe+6bNH4BqscrzF8OxtrvyqC/QINX79GIHELpA=';

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

describe('D-mode order-query signed DTO', () => {
  it('keeps the recovered field order and explicit null for a missing partner order number', () => {
    expect(buildInriceOrderQuerySignedBody({ orderNo: ORDER_NO })).toBe(
      `{"orderNo":"${ORDER_NO}","partnerOrderNo":null}`,
    );
  });

  it('keeps the recovered field order and explicit null for a missing supplier order number', () => {
    expect(buildInriceOrderQuerySignedBody({ partnerOrderNo: PARTNER_ORDER_NO })).toBe(
      `{"orderNo":null,"partnerOrderNo":"${PARTNER_ORDER_NO}"}`,
    );
  });

  it('serializes both identifiers in the exact recovered order', () => {
    expect(
      buildInriceOrderQuerySignedBody({
        orderNo: ORDER_NO,
        partnerOrderNo: PARTNER_ORDER_NO,
      }),
    ).toBe(
      `{"orderNo":"${ORDER_NO}","partnerOrderNo":"${PARTNER_ORDER_NO}"}`,
    );
  });
});

describe('D-mode order-query client', () => {
  it('queries by supplier orderNo with the exact recovered signature bytes', async () => {
    let captured: Request | undefined;
    const client = createClient(async (request) => {
      captured = request;
      return jsonResponse({
        code: 0,
        message: 'success',
        data: {
          orderNo: ORDER_NO,
          dispatchStatus: 'PROCESSING',
        },
      });
    });

    const result = await client.queryOrder({ orderNo: ORDER_NO });
    if (!captured) throw new Error('Transport did not receive a request');

    expect(captured.method).toBe('GET');
    expect(captured.url).toBe(
      `https://vendor.example.test/api/open/inrice/v1/orders/query?orderNo=${ORDER_NO}`,
    );
    expect(captured.headers.get('x-app-key')).toBe(APP_KEY);
    expect(captured.headers.get('x-timestamp')).toBe(String(FIXED_NOW));
    expect(captured.headers.get('x-signature')).toBe(ORDER_ONLY_SIGNATURE);
    expect(captured.headers.get('x-sign')).toBeNull();
    expect(captured.headers.get('x-nonce')).toBeNull();
    expect(captured.body).toBeNull();
    expect(captured.redirect).toBe('manual');

    expect(result).toEqual({
      provider: 'yangmao',
      observedAt: new Date(FIXED_NOW).toISOString(),
      query: { orderNo: ORDER_NO },
      orderNo: ORDER_NO,
      dispatchStatus: 'PROCESSING',
      state: 'unknown',
    });
  });

  it('queries by partnerOrderNo and keeps documented RECEIVE semantically unknown', async () => {
    let captured: Request | undefined;
    const fulfillmentSummary = { kind: 'fixture-only', value: 'masked' };
    const client = createClient(async (request) => {
      captured = request;
      return jsonResponse({
        code: 0,
        message: 'success',
        data: {
          partnerOrderNo: PARTNER_ORDER_NO,
          dispatchStatus: 'RECEIVE',
          fulfillmentSummary,
        },
      });
    });

    const result = await client.queryOrder({ partnerOrderNo: PARTNER_ORDER_NO });
    if (!captured) throw new Error('Transport did not receive a request');

    expect(captured.url).toBe(
      `https://vendor.example.test/api/open/inrice/v1/orders/query?partnerOrderNo=${PARTNER_ORDER_NO}`,
    );
    expect(captured.headers.get('x-signature')).toBe(PARTNER_ONLY_SIGNATURE);
    expect(result).toEqual({
      provider: 'yangmao',
      observedAt: new Date(FIXED_NOW).toISOString(),
      query: { partnerOrderNo: PARTNER_ORDER_NO },
      partnerOrderNo: PARTNER_ORDER_NO,
      dispatchStatus: 'RECEIVE',
      fulfillmentSummary,
      state: 'unknown',
    });
  });

  it('supports both query keys in the same stable URL/signature order', async () => {
    let captured: Request | undefined;
    const client = createClient(async (request) => {
      captured = request;
      return jsonResponse({
        code: 0,
        message: 'success',
        data: {
          orderNo: ORDER_NO,
          partnerOrderNo: PARTNER_ORDER_NO,
          dispatchStatus: 'UNVERIFIED_FIXTURE_STATUS',
        },
      });
    });

    await client.queryOrder({
      orderNo: ORDER_NO,
      partnerOrderNo: PARTNER_ORDER_NO,
    });
    if (!captured) throw new Error('Transport did not receive a request');

    expect(captured.url).toBe(
      `https://vendor.example.test/api/open/inrice/v1/orders/query?orderNo=${ORDER_NO}&partnerOrderNo=${PARTNER_ORDER_NO}`,
    );
    expect(captured.headers.get('x-signature')).toBe(BOTH_SIGNATURE);
  });

  it('classifies the observed 400 订单不存在 response without copying vendor text', async () => {
    const client = createClient(async () =>
      jsonResponse({ code: 400, message: '订单不存在', data: null }),
    );

    const error = await captureError(
      client.queryOrder({ partnerOrderNo: PARTNER_ORDER_NO }),
    );
    expect(error.code).toBe('YANGMAO_INRICE_ORDER_NOT_FOUND');
    expect(error.vendorCode).toBe(400);
    expect(error.message).not.toContain('订单不存在');
  });

  it('keeps other vendor code=400 responses as generic business failures', async () => {
    const client = createClient(async () =>
      jsonResponse({ code: 400, message: 'different supplier failure', data: null }),
    );

    const error = await captureError(client.queryOrder({ orderNo: ORDER_NO }));
    expect(error.code).toBe('YANGMAO_INRICE_BUSINESS_FAILED');
    expect(error.vendorCode).toBe(400);
  });

  it.each([
    { name: 'no identifier', input: {} },
    { name: 'blank orderNo', input: { orderNo: '' } },
    { name: 'outer whitespace', input: { partnerOrderNo: ' P-1 ' } },
    { name: 'control character', input: { orderNo: 'D-1\n' } },
  ])('rejects $name locally without sending a request', async ({ input }) => {
    let calls = 0;
    const client = createClient(async () => {
      calls += 1;
      return jsonResponse({ code: 0, data: {} });
    });

    const error = await captureError(client.queryOrder(input));
    expect(error.code).toBe('YANGMAO_INRICE_ORDER_QUERY_INVALID');
    expect(calls).toBe(0);
  });

  it.each([
    { name: 'null data', data: null },
    { name: 'array data', data: [] },
    { name: 'empty object', data: {} },
    { name: 'blank dispatchStatus', data: { dispatchStatus: '' } },
    {
      name: 'mismatched requested partnerOrderNo',
      data: { partnerOrderNo: 'OTHER', dispatchStatus: 'PROCESSING' },
    },
  ])('rejects $name as a response-shape failure', async ({ data }) => {
    const client = createClient(async () =>
      jsonResponse({ code: 0, message: 'success', data }),
    );

    const error = await captureError(
      client.queryOrder({ partnerOrderNo: PARTNER_ORDER_NO }),
    );
    expect(error.code).toBe('YANGMAO_INRICE_RESPONSE_INVALID');
  });
});
