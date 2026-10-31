import { describe, expect, it } from 'vitest';
import {
  buildInriceDispatchSignedBody,
  createYangmaoInriceCatalogClient,
  YangmaoInriceError,
  type YangmaoInriceCatalogClientOptions,
  type YangmaoInriceTransport,
} from '../src/index.js';

const FIXED_NOW = 1793059200000;
const APP_KEY = 'fixture-app-key';
const APP_SECRET = 'test-secret-do-not-use';
const PARTNER_ORDER_NO = 'P202610310001';
const PRODUCT_CODE = 'INRICE_TEST_1';
const MOBILE = '13800138000';
const SIGNATURE = 'F5KZpsVLzxPywoYBldXW3IuAqer4sjTdkqSNeO7KRQk=';

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
  throw new Error('Expected the request to reject');
}

describe('D-mode dispatch signature/body', () => {
  it('freezes exact field order and compact JSON bytes', () => {
    expect(
      buildInriceDispatchSignedBody({
        partnerOrderNo: PARTNER_ORDER_NO,
        productCode: PRODUCT_CODE,
        mobile: MOBILE,
      }),
    ).toBe(
      '{"mobile":"13800138000","partnerOrderNo":"P202610310001","productCode":"INRICE_TEST_1"}',
    );
  });

  it('signs the verified DTO order while sending the documented request body', async () => {
    let captured: Request | undefined;
    const client = createClient(async (request) => {
      captured = request;
      return jsonResponse({ code: 0, message: 'success', data: {} });
    });

    const result = await client.dispatch({
      partnerOrderNo: PARTNER_ORDER_NO,
      productCode: PRODUCT_CODE,
      mobile: MOBILE,
    });
    if (!captured) throw new Error('Transport did not receive a request');

    expect(captured.method).toBe('POST');
    expect(captured.url).toBe('https://vendor.example.test/api/open/inrice/v1/dispatch');
    expect(captured.headers.get('x-app-key')).toBe(APP_KEY);
    expect(captured.headers.get('x-timestamp')).toBe(String(FIXED_NOW));
    expect(captured.headers.get('x-signature')).toBe(SIGNATURE);
    expect(captured.headers.get('x-sign')).toBeNull();
    expect(captured.headers.get('x-nonce')).toBeNull();
    expect(captured.headers.get('content-type')).toBe('application/json');
    expect(captured.redirect).toBe('manual');
    expect(await captured.text()).toBe(
      '{"partnerOrderNo":"P202610310001","productCode":"INRICE_TEST_1","mobile":"13800138000"}',
    );

    expect(result).toEqual({
      provider: 'yangmao',
      partnerOrderNo: PARTNER_ORDER_NO,
      accepted: true,
      observedAt: new Date(FIXED_NOW).toISOString(),
    });
    expect(result).not.toHaveProperty('completed');
    expect(result).not.toHaveProperty('dispatchStatus');
  });

  it.each([
    { code: 400, expected: 'YANGMAO_INRICE_BUSINESS_FAILED' },
    { code: 401, expected: 'YANGMAO_INRICE_AUTH_FAILED' },
    { code: 403, expected: 'YANGMAO_INRICE_FORBIDDEN' },
    { code: 500, expected: 'YANGMAO_INRICE_BUSINESS_FAILED' },
  ])('does not treat vendor code=$code as accepted', async ({ code, expected }) => {
    const client = createClient(async () =>
      jsonResponse({ code, message: 'failure', data: null }),
    );
    const error = await captureError(
      client.dispatch({
        partnerOrderNo: PARTNER_ORDER_NO,
        productCode: PRODUCT_CODE,
        mobile: MOBILE,
      }),
    );
    expect(error.code).toBe(expected);
    expect(error.vendorCode).toBe(code);
  });

  it('does not follow redirects for a debit-capable POST', async () => {
    const client = createClient(async () =>
      Promise.resolve(
        new Response('', {
          status: 302,
          headers: { location: 'https://evil.example.test/replay' },
        }),
      ),
    );
    const error = await captureError(
      client.dispatch({
        partnerOrderNo: PARTNER_ORDER_NO,
        productCode: PRODUCT_CODE,
        mobile: MOBILE,
      }),
    );
    expect(error.code).toBe('YANGMAO_INRICE_HTTP_ERROR');
    expect(error.httpStatus).toBe(302);
  });

  it.each([
    { name: 'blank partnerOrderNo', value: { partnerOrderNo: '', productCode: PRODUCT_CODE, mobile: MOBILE } },
    { name: 'long partnerOrderNo', value: { partnerOrderNo: 'x'.repeat(65), productCode: PRODUCT_CODE, mobile: MOBILE } },
    { name: 'bad productCode', value: { partnerOrderNo: PARTNER_ORDER_NO, productCode: ' BAD ', mobile: MOBILE } },
    { name: 'bad mobile', value: { partnerOrderNo: PARTNER_ORDER_NO, productCode: PRODUCT_CODE, mobile: '10000000000' } },
  ])('rejects $name locally before a vendor write', async ({ value }) => {
    let calls = 0;
    const client = createClient(async () => {
      calls += 1;
      return jsonResponse({ code: 0, data: {} });
    });
    const error = await captureError(client.dispatch(value));
    expect(error.code).toBe('YANGMAO_INRICE_DISPATCH_INPUT_INVALID');
    expect(calls).toBe(0);
  });

  it('classifies a lost response as unknown transport failure rather than accepted', async () => {
    const client = createClient(async () => {
      throw new TypeError('socket closed');
    });
    const error = await captureError(
      client.dispatch({
        partnerOrderNo: PARTNER_ORDER_NO,
        productCode: PRODUCT_CODE,
        mobile: MOBILE,
      }),
    );
    expect(error.code).toBe('YANGMAO_INRICE_TRANSPORT_FAILED');
  });
});
