import { describe, expect, it } from 'vitest';
import {
  createYangmaoOpenV1Client,
  YangmaoOpenV1Error,
  type YangmaoOpenV1ClientOptions,
  type YangmaoOpenV1Transport,
} from '../src/index.js';

/**
 * FICTIONAL FIXTURES ONLY. The secret, codes, links and phone are synthetic and
 * exist only in this test process.
 */
const FIXED_NOW = 1793059200000;
const APP_KEY = 'fixture-app-key';
const APP_SECRET = 'test-secret-do-not-use';
const NONCE = 'abc123def456';
const PHONE = '13800138000';
const REF_CODE = 'ref_abc123';
const REQUEST_ID = 'bhC-fixed-request-0001';
const PRODUCT_CODE = 'YM-VOUCHER-C';
const VOUCHER_CODE = 'GV-FICTIONAL-0001';
const CLAIM_URL = 'https://h5.example.test/voucher?code=GV-FICTIONAL-0001';
/**
 * OpenSSL-derived vector for
 * `appKey=fixture-app-key&nonce=abc123def456&packCount=3&productCode=YM-VOUCHER-C`
 * + `&refCode=ref_abc123&requestId=bhC-fixed-request-0001`
 * + `&timestamp=1793059200000&appSecret=test-secret-do-not-use`.
 */
const ISSUE_SIGNATURE =
  '548CB3E6A2AEBFF13E4F16F52A52646CC5FD63543EDDD0E5D123E435392D62D0';

const VALID_INPUT = {
  refCode: REF_CODE,
  packCount: 3,
  requestId: REQUEST_ID,
  productCode: PRODUCT_CODE,
};

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

const ISSUED = {
  code: 0,
  message: 'success',
  data: {
    voucherCode: VOUCHER_CODE,
    claimUrl: CLAIM_URL,
    packTotal: 3,
    packRemaining: 3,
    expiresAt: '2026-11-28 00:00:00',
    balanceAfter: 97,
    idempotentReplay: false,
  },
};

describe('C-mode gift-voucher client', () => {
  it('sends the exact A/B/C headers and signed C body', async () => {
    let captured: Request | undefined;
    let capturedBody: string | undefined;
    const client = createClient(async (request) => {
      captured = request;
      capturedBody = await request.text();
      return jsonResponse(ISSUED);
    });

    const result = await client.createGiftVoucher(VALID_INPUT);
    if (!captured) throw new Error('Transport did not receive a request');

    expect(captured.method).toBe('POST');
    expect(captured.url).toBe('https://vendor.example.test/open/v1/gift-vouchers');
    expect(captured.headers.get('x-app-key')).toBe(APP_KEY);
    expect(captured.headers.get('x-timestamp')).toBe(String(FIXED_NOW));
    expect(captured.headers.get('x-nonce')).toBe(NONCE);
    expect(captured.headers.get('x-sign')).toBe(ISSUE_SIGNATURE);
    expect(captured.headers.get('x-signature')).toBeNull();
    expect(captured.redirect).toBe('manual');
    expect(capturedBody).toBe(
      JSON.stringify({
        refCode: REF_CODE,
        packCount: 3,
        requestId: REQUEST_ID,
        productCode: PRODUCT_CODE,
      }),
    );
    // The pack count is a JSON number but the signature stringifies it; the
    // secret and request identity never appear in the URL.
    expect(captured.url).not.toContain(APP_SECRET);
    expect(captured.url).not.toContain(REQUEST_ID);

    expect(result).toEqual({
      provider: 'yangmao',
      observedAt: new Date(FIXED_NOW).toISOString(),
      voucherCode: VOUCHER_CODE,
      claimUrl: CLAIM_URL,
      packTotal: 3,
      packRemaining: 3,
      expiresAt: '2026-11-28 00:00:00',
      balanceAfter: 97,
      idempotentReplay: false,
    });
    // Issuance is not a redemption or a claimed benefit.
    expect(result).not.toHaveProperty('redeemed');
    expect(result).not.toHaveProperty('completed');
  });

  it('includes the optional phone only when supplied and never in the URL', async () => {
    let captured: Request | undefined;
    let capturedBody: string | undefined;
    const client = createClient(async (request) => {
      captured = request;
      capturedBody = await request.text();
      return jsonResponse(ISSUED);
    });

    await client.createGiftVoucher({ ...VALID_INPUT, phone: PHONE });
    if (!captured) throw new Error('Transport did not receive a request');
    expect(JSON.parse(capturedBody!)).toEqual({
      refCode: REF_CODE,
      packCount: 3,
      requestId: REQUEST_ID,
      productCode: PRODUCT_CODE,
      phone: PHONE,
    });
    expect(captured.url).not.toContain(PHONE);
    expect(captured.headers.get('x-sign')).not.toBe(ISSUE_SIGNATURE);
  });

  it('accepts a numeric raw expiry scalar without interpreting it', async () => {
    const client = createClient(async () =>
      jsonResponse({
        code: 0,
        data: {
          voucherCode: VOUCHER_CODE,
          claimUrl: CLAIM_URL,
          expiresAt: 1795651200000,
        },
      }),
    );
    const result = await client.createGiftVoucher(VALID_INPUT);
    expect(result.expiresAt).toBe(1795651200000);
    expect(result.packTotal).toBeUndefined();
    expect(result.packRemaining).toBeUndefined();
  });

  it('drops unknown vendor fields and present-null optionals instead of inventing facts', async () => {
    const client = createClient(async () =>
      jsonResponse({
        code: 0,
        data: {
          voucherCode: VOUCHER_CODE,
          claimUrl: CLAIM_URL,
          packTotal: null,
          packRemaining: null,
          expiresAt: null,
          balanceAfter: null,
          idempotentReplay: null,
          redeemed: true,
          completed: true,
          dispatchStatus: 'RECEIVE',
        },
      }),
    );
    const result = await client.createGiftVoucher(VALID_INPUT);
    expect(result).toEqual({
      provider: 'yangmao',
      observedAt: new Date(FIXED_NOW).toISOString(),
      voucherCode: VOUCHER_CODE,
      claimUrl: CLAIM_URL,
    });
  });

  it.each([
    { name: 'missing voucherCode', data: { claimUrl: CLAIM_URL } },
    { name: 'missing claimUrl', data: { voucherCode: VOUCHER_CODE } },
    { name: 'credentialed claimUrl', data: { voucherCode: VOUCHER_CODE, claimUrl: 'https://u:p@h5.example.test/x' } },
    { name: 'non-http claimUrl', data: { voucherCode: VOUCHER_CODE, claimUrl: 'javascript:alert(1)' } },
    { name: 'malformed voucherCode', data: { voucherCode: 'GV CODE/1', claimUrl: CLAIM_URL } },
    { name: 'negative packRemaining', data: { voucherCode: VOUCHER_CODE, claimUrl: CLAIM_URL, packRemaining: -1 } },
    { name: 'fractional packTotal', data: { voucherCode: VOUCHER_CODE, claimUrl: CLAIM_URL, packTotal: 1.5 } },
    { name: 'impossible quota', data: { voucherCode: VOUCHER_CODE, claimUrl: CLAIM_URL, packTotal: 3, packRemaining: 4 } },
    { name: 'negative balanceAfter', data: { voucherCode: VOUCHER_CODE, claimUrl: CLAIM_URL, balanceAfter: -1 } },
    { name: 'non-boolean replay flag', data: { voucherCode: VOUCHER_CODE, claimUrl: CLAIM_URL, idempotentReplay: 'false' } },
  ])('rejects a $name response as unverified, never as a successful issuance', async ({ data }) => {
    const client = createClient(async () => jsonResponse({ code: 0, data }));
    const error = await captureError(client.createGiftVoucher(VALID_INPUT));
    expect(error.code).toBe('YANGMAO_OPEN_V1_RESPONSE_INVALID');
    expect(error.message).not.toContain(VOUCHER_CODE);
    expect(error.message).not.toContain(CLAIM_URL);
  });

  it('rejects an inconsistent C lookup quota, but accepts missing optional quota fields', async () => {
    const contradictory = createClient(async () =>
      jsonResponse({ code: 0, data: { packTotal: 3, packRemaining: 4 } }),
    );
    const bad = await captureError(contradictory.queryGiftVoucher(VOUCHER_CODE));
    expect(bad.code).toBe('YANGMAO_OPEN_V1_RESPONSE_INVALID');

    const partial = createClient(async () =>
      jsonResponse({ code: 0, data: { packRemaining: 2 } }),
    );
    await expect(partial.queryGiftVoucher(VOUCHER_CODE)).resolves.toMatchObject({
      packRemaining: 2,
    });
  });

  it.each([
    { name: 'packCount below 1', input: { ...VALID_INPUT, packCount: 0 } },
    { name: 'packCount above 12', input: { ...VALID_INPUT, packCount: 13 } },
    { name: 'fractional packCount', input: { ...VALID_INPUT, packCount: 1.5 } },
    { name: 'blank refCode', input: { ...VALID_INPUT, refCode: '' } },
    { name: 'refCode with a space', input: { ...VALID_INPUT, refCode: 'ref abc' } },
    { name: 'requestId above 64 chars', input: { ...VALID_INPUT, requestId: 'a'.repeat(65) } },
    { name: 'blank productCode', input: { ...VALID_INPUT, productCode: '' } },
  ])('rejects $name before sending any request', async ({ input }) => {
    let sent = 0;
    const client = createClient(async () => {
      sent += 1;
      return jsonResponse(ISSUED);
    });
    const error = await captureError(client.createGiftVoucher(input));
    expect(error.code).toBe('YANGMAO_OPEN_V1_CONFIG_INVALID');
    expect(sent).toBe(0);
  });

  it('rejects an invalid phone locally without sending', async () => {
    let sent = 0;
    const client = createClient(async () => {
      sent += 1;
      return jsonResponse(ISSUED);
    });
    const error = await captureError(
      client.createGiftVoucher({ ...VALID_INPUT, phone: '12345' }),
    );
    expect(error.code).toBe('YANGMAO_OPEN_V1_PHONE_INVALID');
    expect(sent).toBe(0);
  });

  it.each([
    { name: 'business 400', status: 200, body: { code: 400, data: null }, code: 'YANGMAO_OPEN_V1_BUSINESS_FAILED' },
    { name: 'business 401', status: 200, body: { code: 401, data: null }, code: 'YANGMAO_OPEN_V1_AUTH_FAILED' },
    { name: 'business 403', status: 200, body: { code: 403, data: null }, code: 'YANGMAO_OPEN_V1_FORBIDDEN' },
    { name: 'HTTP 401', status: 401, body: { error: 'nope' }, code: 'YANGMAO_OPEN_V1_AUTH_FAILED' },
    { name: 'HTTP 403', status: 403, body: { error: 'nope' }, code: 'YANGMAO_OPEN_V1_FORBIDDEN' },
    { name: 'HTTP 500', status: 500, body: { error: 'nope' }, code: 'YANGMAO_OPEN_V1_HTTP_ERROR' },
  ])('normalizes $name without echoing vendor content', async ({ status, body, code }) => {
    const client = createClient(async () => jsonResponse(body, status));
    const error = await captureError(client.createGiftVoucher(VALID_INPUT));
    expect(error.code).toBe(code);
    expect(error.message).not.toContain('nope');
    expect(error.message).not.toContain('fixture-app-key');
  });

  it('treats a non-JSON success as unverified', async () => {
    const client = createClient(
      async () => new Response('<html>ok</html>', { status: 200 }),
    );
    const error = await captureError(client.createGiftVoucher(VALID_INPUT));
    expect(error.code).toBe('YANGMAO_OPEN_V1_RESPONSE_INVALID');
  });

  it('classifies a bounded timeout separately from a transport failure', async () => {
    const client = createClient(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
      { timeoutMs: 100 },
    );
    const error = await captureError(client.createGiftVoucher(VALID_INPUT));
    expect(error.code).toBe('YANGMAO_OPEN_V1_TIMEOUT');
  });

  it('rejects a malformed envelope before reading any issuance field', async () => {
    const client = createClient(async () => jsonResponse({ code: '0', data: ISSUED.data }));
    const error = await captureError(client.createGiftVoucher(VALID_INPUT));
    expect(error.code).toBe('YANGMAO_OPEN_V1_RESPONSE_INVALID');
  });
});
