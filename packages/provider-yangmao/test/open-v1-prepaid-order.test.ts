import { describe, expect, it } from 'vitest';
import {
  createInriceSignature,
  createYangmaoOpenV1Client,
  YangmaoOpenV1Error,
  type YangmaoOpenV1ClientOptions,
  type YangmaoOpenV1Transport,
} from '../src/index.js';

const FIXED_NOW = 1793059200000;
const APP_KEY = 'fixture-app-key';
const APP_SECRET = 'test-secret-do-not-use';
const NONCE = 'abc123def456';
const PHONE = '13800138000';
const REF_CODE = 'ref_abc123';
const PRODUCT_CODE = 'benefit_pack_299';
const REQUEST_ID = 'bhA0123456789abcdef';
const CLAIM_URL = 'https://h5.example.test/bet?orderNo=PKG20261022000001';

/**
 * OpenSSL-derived vector for
 * `appKey=...&nonce=...&phone=...&productCode=...&refCode=...&requestId=...&timestamp=...&appSecret=...`
 * so the assertion does not reuse the signing implementation under test.
 */
const SIGNED_WITH_PRODUCT_CODE =
  '6533E065D57A7FC1621B53436F6561DFB0A1E2E661B9E46E3BE0CE4977E51F62';
/** Same vector with the optional productCode omitted from the signed string. */
const SIGNED_WITHOUT_PRODUCT_CODE =
  '66FF9752A5D4CB31D4E4B89DE6902904595B46CA4313571A205B32A7F59B31EA';

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function createClient(
  transport: YangmaoOpenV1Transport,
  overrides: Partial<YangmaoOpenV1ClientOptions> = {},
) {
  return createYangmaoOpenV1Client({
    baseUrl: 'https://vendor.example.test',
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    clock: () => FIXED_NOW,
    nonceFactory: () => NONCE,
    transport,
    ...overrides,
  });
}

async function captureError(promise: Promise<unknown>): Promise<YangmaoOpenV1Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(YangmaoOpenV1Error);
    return error as YangmaoOpenV1Error;
  }
  throw new Error('Expected the client request to reject');
}

const ACCEPTED_BODY = {
  code: 0,
  message: 'success',
  data: {
    orderNo: 'PKG20261022000001',
    claimUrl: CLAIM_URL,
    betPagePath: '/bet?orderNo=PKG20261022000001',
    balanceAfter: 99,
    idempotentReplay: false,
  },
};

describe('A-mode prepaid order creation', () => {
  it('sends the documented signed fields and body through X-Sign only', async () => {
    let captured: Request | undefined;
    let capturedBody: string | undefined;
    const client = createClient(async (request) => {
      captured = request;
      capturedBody = await request.text();
      return jsonResponse(ACCEPTED_BODY);
    });

    const result = await client.createPrepaidOrder({
      phone: PHONE,
      refCode: REF_CODE,
      productCode: PRODUCT_CODE,
      requestId: REQUEST_ID,
    });
    if (!captured) throw new Error('Transport did not receive a request');

    expect(captured.method).toBe('POST');
    expect(captured.url).toBe('https://vendor.example.test/open/v1/prepaid/orders');
    expect(captured.headers.get('x-app-key')).toBe(APP_KEY);
    expect(captured.headers.get('x-timestamp')).toBe(String(FIXED_NOW));
    expect(captured.headers.get('x-nonce')).toBe(NONCE);
    expect(captured.headers.get('x-sign')).toBe(SIGNED_WITH_PRODUCT_CODE);
    expect(captured.headers.get('content-type')).toBe('application/json');
    expect(captured.redirect).toBe('manual');
    // A/B/C signs with uppercase SHA-256 hex in X-Sign. The D HMAC header must
    // never appear, and the value must not be a Base64 HMAC.
    expect(captured.headers.get('x-signature')).toBeNull();
    expect(captured.headers.get('x-sign')).not.toBe(
      createInriceSignature(APP_SECRET, String(FIXED_NOW), capturedBody ?? ''),
    );
    expect(captured.headers.get('x-sign')).toMatch(/^[A-F0-9]{64}$/);

    // Sensitive values travel only in the JSON body, never in the URL.
    expect(captured.url).not.toContain(PHONE);
    expect(captured.url).not.toContain(REF_CODE);
    expect(captured.url).not.toContain(APP_SECRET);
    expect(capturedBody).toBe(
      JSON.stringify({
        phone: PHONE,
        refCode: REF_CODE,
        requestId: REQUEST_ID,
        productCode: PRODUCT_CODE,
      }),
    );

    expect(result).toEqual({
      provider: 'yangmao',
      observedAt: new Date(FIXED_NOW).toISOString(),
      orderNo: 'PKG20261022000001',
      claimUrl: CLAIM_URL,
      balanceAfter: 99,
      idempotentReplay: false,
    });
    // An accepted order is not a redeemed/claimed/completed benefit.
    expect(result).not.toHaveProperty('claimed');
    expect(result).not.toHaveProperty('completed');
    expect(result).not.toHaveProperty('delivered');
  });

  it('omits an absent productCode from both the body and the signature', async () => {
    let capturedBody: string | undefined;
    const client = createClient(async (request) => {
      capturedBody = await request.text();
      return jsonResponse(ACCEPTED_BODY);
    });

    await client.createPrepaidOrder({
      phone: PHONE,
      refCode: REF_CODE,
      requestId: REQUEST_ID,
    });

    expect(capturedBody).toBe(
      JSON.stringify({ phone: PHONE, refCode: REF_CODE, requestId: REQUEST_ID }),
    );
    expect(capturedBody).not.toContain('productCode');
  });

  it('uses the no-productCode signature vector when productCode is absent', async () => {
    let sign: string | null = null;
    const client = createClient(async (request) => {
      sign = request.headers.get('x-sign');
      return jsonResponse(ACCEPTED_BODY);
    });

    await client.createPrepaidOrder({ phone: PHONE, refCode: REF_CODE, requestId: REQUEST_ID });
    expect(sign).toBe(SIGNED_WITHOUT_PRODUCT_CODE);
  });

  it('keeps an idempotent replay as an accepted order, not a second deduction', async () => {
    const client = createClient(async () =>
      jsonResponse({
        code: 0,
        data: {
          orderNo: 'PKG20261022000001',
          claimUrl: CLAIM_URL,
          balanceAfter: 99,
          idempotentReplay: true,
        },
      }),
    );

    const result = await client.createPrepaidOrder({
      phone: PHONE,
      refCode: REF_CODE,
      productCode: PRODUCT_CODE,
      requestId: REQUEST_ID,
    });
    expect(result.idempotentReplay).toBe(true);
    expect(result.claimUrl).toBe(CLAIM_URL);
  });

  it('accepts a response without the optional balance/replay fields', async () => {
    const client = createClient(async () =>
      jsonResponse({
        code: 0,
        data: { orderNo: 'PKG20261022000001', claimUrl: CLAIM_URL },
      }),
    );

    const result = await client.createPrepaidOrder({
      phone: PHONE,
      refCode: REF_CODE,
      requestId: REQUEST_ID,
    });
    expect(result).toEqual({
      provider: 'yangmao',
      observedAt: new Date(FIXED_NOW).toISOString(),
      orderNo: 'PKG20261022000001',
      claimUrl: CLAIM_URL,
    });
  });

  it('drops unknown vendor keys instead of treating them as success fields', async () => {
    const client = createClient(async () =>
      jsonResponse({
        code: 0,
        data: {
          orderNo: 'PKG20261022000001',
          claimUrl: CLAIM_URL,
          phone: PHONE,
          delivered: true,
          raw: { balance: 1 },
        },
      }),
    );

    const result = await client.createPrepaidOrder({
      phone: PHONE,
      refCode: REF_CODE,
      requestId: REQUEST_ID,
    });
    expect(result).not.toHaveProperty('phone');
    expect(result).not.toHaveProperty('delivered');
    expect(result).not.toHaveProperty('raw');
    expect(JSON.stringify(result)).not.toContain(PHONE);
  });
});

describe('A-mode prepaid order failure normalization', () => {
  it.each([
    { name: 'missing orderNo', data: { claimUrl: CLAIM_URL } },
    { name: 'missing claimUrl', data: { orderNo: 'PKG-1' } },
    { name: 'blank orderNo', data: { orderNo: '', claimUrl: CLAIM_URL } },
    { name: 'javascript claimUrl', data: { orderNo: 'PKG-1', claimUrl: 'javascript:alert(1)' } },
    {
      name: 'credentialed claimUrl',
      data: { orderNo: 'PKG-1', claimUrl: 'https://user:pass@h5.example.test/bet' },
    },
    { name: 'string balanceAfter', data: { orderNo: 'PKG-1', claimUrl: CLAIM_URL, balanceAfter: '99' } },
    { name: 'negative balanceAfter', data: { orderNo: 'PKG-1', claimUrl: CLAIM_URL, balanceAfter: -1 } },
    { name: 'string idempotentReplay', data: { orderNo: 'PKG-1', claimUrl: CLAIM_URL, idempotentReplay: 'false' } },
    { name: 'null data', data: null },
    { name: 'array data', data: [] },
  ])('rejects $name as an unverified response', async ({ data }) => {
    const client = createClient(async () => jsonResponse({ code: 0, data }));

    const error = await captureError(
      client.createPrepaidOrder({ phone: PHONE, refCode: REF_CODE, requestId: REQUEST_ID }),
    );
    expect(error.code).toBe('YANGMAO_OPEN_V1_RESPONSE_INVALID');
  });

  it.each([
    { status: 401, code: 'YANGMAO_OPEN_V1_AUTH_FAILED' },
    { status: 403, code: 'YANGMAO_OPEN_V1_FORBIDDEN' },
    { status: 402, code: 'YANGMAO_OPEN_V1_HTTP_ERROR' },
    { status: 500, code: 'YANGMAO_OPEN_V1_HTTP_ERROR' },
  ])('maps HTTP $status to $code without retrying', async ({ status, code }) => {
    let calls = 0;
    const client = createClient(async () => {
      calls += 1;
      return jsonResponse(ACCEPTED_BODY, status);
    });

    const error = await captureError(
      client.createPrepaidOrder({ phone: PHONE, refCode: REF_CODE, requestId: REQUEST_ID }),
    );
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
    expect(calls).toBe(1);
  });

  it.each([
    { code: 400, expected: 'YANGMAO_OPEN_V1_BUSINESS_FAILED' },
    { code: 401, expected: 'YANGMAO_OPEN_V1_AUTH_FAILED' },
    { code: 403, expected: 'YANGMAO_OPEN_V1_FORBIDDEN' },
    { code: 500, expected: 'YANGMAO_OPEN_V1_BUSINESS_FAILED' },
  ])('checks HTTP 200 body code=$code before reading order fields', async ({ code, expected }) => {
    let calls = 0;
    const client = createClient(async () => {
      calls += 1;
      return jsonResponse({ code, message: 'business failure', data: ACCEPTED_BODY.data });
    });

    const error = await captureError(
      client.createPrepaidOrder({ phone: PHONE, refCode: REF_CODE, requestId: REQUEST_ID }),
    );
    expect(error.code).toBe(expected);
    expect(error.vendorCode).toBe(code);
    expect(calls).toBe(1);
  });

  it('classifies a timeout as unknown and performs exactly one transport call', async () => {
    let calls = 0;
    const client = createClient(
      (request) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        });
      },
      { timeoutMs: 100 },
    );

    const error = await captureError(
      client.createPrepaidOrder({ phone: PHONE, refCode: REF_CODE, requestId: REQUEST_ID }),
    );
    expect(error.code).toBe('YANGMAO_OPEN_V1_TIMEOUT');
    expect(calls).toBe(1);
  });

  it('normalizes a transport rejection without exposing its message', async () => {
    const client = createClient(async () => {
      throw new TypeError(`${APP_SECRET} at ${PHONE}`);
    });

    const error = await captureError(
      client.createPrepaidOrder({ phone: PHONE, refCode: REF_CODE, requestId: REQUEST_ID }),
    );
    expect(error.code).toBe('YANGMAO_OPEN_V1_TRANSPORT_FAILED');
    expect(error.message).not.toContain(APP_SECRET);
    expect(error.message).not.toContain(PHONE);
  });
});

describe('A-mode prepaid order request boundary', () => {
  it.each([
    { name: 'blank phone', input: { phone: '', refCode: REF_CODE, requestId: REQUEST_ID } },
    { name: 'phone with space', input: { phone: '138 00138000', refCode: REF_CODE, requestId: REQUEST_ID } },
    { name: 'blank refCode', input: { phone: PHONE, refCode: '', requestId: REQUEST_ID } },
    { name: 'refCode with whitespace', input: { phone: PHONE, refCode: 'bad ref', requestId: REQUEST_ID } },
    { name: 'blank requestId', input: { phone: PHONE, refCode: REF_CODE, requestId: '' } },
    { name: 'requestId too long', input: { phone: PHONE, refCode: REF_CODE, requestId: 'a'.repeat(65) } },
    {
      name: 'blank productCode',
      input: { phone: PHONE, refCode: REF_CODE, productCode: '', requestId: REQUEST_ID },
    },
    {
      name: 'productCode with whitespace',
      input: { phone: PHONE, refCode: REF_CODE, productCode: 'bad code', requestId: REQUEST_ID },
    },
  ])('rejects $name locally before signing or sending', async ({ input }) => {
    let calls = 0;
    const client = createClient(async () => {
      calls += 1;
      return jsonResponse(ACCEPTED_BODY);
    });

    await captureError(client.createPrepaidOrder(input));
    expect(calls).toBe(0);
  });
});
