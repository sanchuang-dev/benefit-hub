import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
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
/**
 * OpenSSL-derived vector for
 * `appKey=fixture-app-key&nonce=abc123def456&phone=13800138000&timestamp=1793059200000&appSecret=test-secret-do-not-use`
 * so the header expectation does not depend on the implementation under test.
 */
const PURCHASE_CHECK_SIGNATURE =
  '39A5CD69E106D904F7F7E8888AB2427BF1DFDD1F027060D0822AE01CF13B3B58';

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

const ELIGIBLE_BODY = {
  code: 0,
  message: 'success',
  data: { purchaseRestricted: false, giftUnclaimed: false, lotteryUnbet: false },
};

describe('A/B/C purchase-check client', () => {
  it('sends the exact A/B/C headers and body with an endpoint-scoped signature', async () => {
    let captured: Request | undefined;
    let capturedBody: string | undefined;
    const client = createClient(async (request) => {
      captured = request;
      capturedBody = await request.text();
      return jsonResponse(ELIGIBLE_BODY);
    });

    const eligibility = await client.checkPurchase(PHONE);
    if (!captured) throw new Error('Transport did not receive a request');

    expect(captured.method).toBe('POST');
    expect(captured.url).toBe('https://vendor.example.test/open/v1/prepaid/purchase-check');
    expect(captured.headers.get('x-app-key')).toBe(APP_KEY);
    expect(captured.headers.get('x-timestamp')).toBe(String(FIXED_NOW));
    expect(captured.headers.get('x-nonce')).toBe(NONCE);
    expect(captured.headers.get('x-sign')).toBe(PURCHASE_CHECK_SIGNATURE);
    expect(captured.headers.get('content-type')).toBe('application/json');
    expect(captured.headers.get('accept')).toBe('application/json');
    // A/B/C uses X-Sign/RFC headers only; the D X-Signature must never appear.
    expect(captured.headers.get('x-signature')).toBeNull();
    expect(captured.redirect).toBe('manual');
    // The phone travels in the JSON body, never in the URL or a header.
    expect(captured.url).not.toContain(PHONE);
    expect(captured.url).not.toContain(APP_SECRET);
    expect(captured.headers.get('x-sign')).not.toBe(APP_SECRET);
    expect(capturedBody).toBe(JSON.stringify({ phone: PHONE }));

    expect(eligibility).toEqual({
      provider: 'yangmao',
      observedAt: new Date(FIXED_NOW).toISOString(),
      purchaseRestricted: false,
      giftUnclaimed: false,
      lotteryUnbet: false,
    });
    // No order, balance or deduction field is ever invented by a read-only check.
    expect(eligibility).not.toHaveProperty('orderNo');
    expect(eligibility).not.toHaveProperty('balanceAfter');
    expect(eligibility).not.toHaveProperty('packRemaining');
  });

  it('expresses a purchase restriction on its own', async () => {
    const client = createClient(async () =>
      jsonResponse({
        code: 0,
        data: {
          purchaseRestricted: true,
          giftUnclaimed: false,
          lotteryUnbet: false,
          message: '该手机号 7 天内已领取',
        },
      }),
    );

    const eligibility = await client.checkPurchase(PHONE);

    expect(eligibility).toMatchObject({
      purchaseRestricted: true,
      giftUnclaimed: false,
      lotteryUnbet: false,
      message: '该手机号 7 天内已领取',
    });
  });

  it('expresses unclaimed non-lottery benefits with the vendor claim link', async () => {
    const claimUrl = 'https://h5.example.test/bet?orderNo=PKG20261022000001';
    const client = createClient(async () =>
      jsonResponse({
        code: 0,
        data: {
          purchaseRestricted: false,
          giftUnclaimed: true,
          lotteryUnbet: false,
          claimUrl,
        },
      }),
    );

    const eligibility = await client.checkPurchase(PHONE);

    expect(eligibility.giftUnclaimed).toBe(true);
    expect(eligibility.lotteryUnbet).toBe(false);
    expect(eligibility.claimUrl).toBe(claimUrl);
  });

  it('expresses unplaced lottery bets independently of the other facts', async () => {
    const client = createClient(async () =>
      jsonResponse({
        code: 0,
        data: {
          purchaseRestricted: false,
          giftUnclaimed: false,
          lotteryUnbet: true,
          claimUrl: 'https://h5.example.test/bet?orderNo=PKG20261022000002',
        },
      }),
    );

    const eligibility = await client.checkPurchase(PHONE);

    expect(eligibility).toMatchObject({
      purchaseRestricted: false,
      giftUnclaimed: false,
      lotteryUnbet: true,
    });
  });

  it('drops unknown vendor fields instead of echoing them', async () => {
    const client = createClient(async () =>
      jsonResponse({
        code: 0,
        message: 'success',
        data: {
          purchaseRestricted: true,
          giftUnclaimed: false,
          lotteryUnbet: false,
          claimUrl: 'https://h5.example.test/bet',
          phone: PHONE,
          balanceAfter: 99,
          orderNo: 'PKG20261022000003',
        },
      }),
    );

    const eligibility = await client.checkPurchase(PHONE);
    const serialized = JSON.stringify(eligibility);

    expect(eligibility).not.toHaveProperty('phone');
    expect(eligibility).not.toHaveProperty('balanceAfter');
    expect(eligibility).not.toHaveProperty('orderNo');
    expect(serialized).not.toContain(PHONE);
  });

  it('treats null optional vendor text as absent without inventing eligibility', async () => {
    const client = createClient(async () =>
      jsonResponse({
        code: 0,
        message: 'success',
        data: {
          purchaseRestricted: false,
          giftUnclaimed: false,
          lotteryUnbet: false,
          message: null,
          claimUrl: null,
        },
      }),
    );

    const eligibility = await client.checkPurchase(PHONE);

    expect(eligibility).toEqual({
      provider: 'yangmao',
      observedAt: new Date(FIXED_NOW).toISOString(),
      purchaseRestricted: false,
      giftUnclaimed: false,
      lotteryUnbet: false,
    });
  });

  it('does not turn the envelope message into an eligibility message', async () => {
    const client = createClient(async () => jsonResponse(ELIGIBLE_BODY));

    const eligibility = await client.checkPurchase(PHONE);

    expect(eligibility).not.toHaveProperty('message');
  });
});

describe('A/B/C purchase-check failure normalization', () => {
  it.each([
    { status: 401, code: 'YANGMAO_OPEN_V1_AUTH_FAILED' },
    { status: 403, code: 'YANGMAO_OPEN_V1_FORBIDDEN' },
    { status: 500, code: 'YANGMAO_OPEN_V1_HTTP_ERROR' },
    { status: 302, code: 'YANGMAO_OPEN_V1_HTTP_ERROR' },
  ])('maps HTTP $status to $code', async ({ status, code }) => {
    const client = createClient(async () => jsonResponse(ELIGIBLE_BODY, status));

    const error = await captureError(client.checkPurchase(PHONE));
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
    expect(error.vendorCode).toBeUndefined();
  });

  it('checks body code before reading any eligibility field', async () => {
    // HTTP 200 with a permissive-looking data object but a failing body code
    // must not be reported as "not restricted".
    const client = createClient(async () =>
      jsonResponse({
        code: 400,
        message: '参数 / 业务失败',
        data: { purchaseRestricted: false, giftUnclaimed: false, lotteryUnbet: false },
      }),
    );

    const error = await captureError(client.checkPurchase(PHONE));
    expect(error.code).toBe('YANGMAO_OPEN_V1_BUSINESS_FAILED');
    expect(error.vendorCode).toBe(400);
    expect(error.httpStatus).toBeUndefined();
  });

  it.each([
    { code: 401, expected: 'YANGMAO_OPEN_V1_AUTH_FAILED' },
    { code: 403, expected: 'YANGMAO_OPEN_V1_FORBIDDEN' },
    { code: 400, expected: 'YANGMAO_OPEN_V1_BUSINESS_FAILED' },
    { code: 500, expected: 'YANGMAO_OPEN_V1_BUSINESS_FAILED' },
  ])('maps HTTP 200 with body code=$code to $expected', async ({ code, expected }) => {
    const client = createClient(async () => jsonResponse({ code, message: 'failure' }));

    const error = await captureError(client.checkPurchase(PHONE));
    expect(error.code).toBe(expected);
    expect(error.vendorCode).toBe(code);
  });

  it.each([
    { name: 'non-JSON body', response: () => Promise.resolve(new Response('<html>oops</html>')) },
    { name: 'fake 200 with HTML challenge', response: () => Promise.resolve(new Response('<html>maintenance</html>', { status: 200 })) },
    { name: 'empty body', response: () => Promise.resolve(new Response('')) },
    { name: 'missing code', response: () => jsonResponse({ data: ELIGIBLE_BODY.data }) },
    { name: 'string code', response: () => jsonResponse({ code: '0', data: ELIGIBLE_BODY.data }) },
    { name: 'missing data', response: () => jsonResponse({ code: 0, message: 'success' }) },
    { name: 'null data', response: () => jsonResponse({ code: 0, data: null }) },
    { name: 'array data', response: () => jsonResponse({ code: 0, data: [] }) },
    {
      name: 'missing purchaseRestricted',
      response: () => jsonResponse({ code: 0, data: { giftUnclaimed: false, lotteryUnbet: false } }),
    },
    {
      name: 'missing giftUnclaimed',
      response: () => jsonResponse({ code: 0, data: { purchaseRestricted: false, lotteryUnbet: false } }),
    },
    {
      name: 'missing lotteryUnbet',
      response: () => jsonResponse({ code: 0, data: { purchaseRestricted: false, giftUnclaimed: false } }),
    },
    {
      name: 'string flag',
      response: () =>
        jsonResponse({
          code: 0,
          data: { purchaseRestricted: 'false', giftUnclaimed: false, lotteryUnbet: false },
        }),
    },
    {
      name: 'javascript claimUrl',
      response: () =>
        jsonResponse({
          code: 0,
          data: {
            purchaseRestricted: false,
            giftUnclaimed: true,
            lotteryUnbet: false,
            claimUrl: 'javascript:alert(1)',
          },
        }),
    },
    {
      name: 'claimUrl with embedded credentials',
      response: () =>
        jsonResponse({
          code: 0,
          data: {
            purchaseRestricted: false,
            giftUnclaimed: true,
            lotteryUnbet: false,
            claimUrl: 'https://user:pass@h5.example.test/bet',
          },
        }),
    },
    {
      name: 'empty claimUrl',
      response: () =>
        jsonResponse({
          code: 0,
          data: {
            purchaseRestricted: false,
            giftUnclaimed: true,
            lotteryUnbet: false,
            claimUrl: '',
          },
        }),
    },
    {
      name: 'message with control characters',
      response: () =>
        jsonResponse({
          code: 0,
          data: {
            purchaseRestricted: true,
            giftUnclaimed: false,
            lotteryUnbet: false,
            message: 'blocked\u0000now',
          },
        }),
    },
  ])('rejects $name as a response-shape failure', async ({ response }) => {
    const client = createClient(response);

    const error = await captureError(client.checkPurchase(PHONE));
    expect(error.code).toBe('YANGMAO_OPEN_V1_RESPONSE_INVALID');
  });

  it('classifies a timeout separately from other transport failures', async () => {
    const client = createClient(hangingTransport, { timeoutMs: 100 });

    const error = await captureError(client.checkPurchase(PHONE));
    expect(error.code).toBe('YANGMAO_OPEN_V1_TIMEOUT');
  });

  it('classifies caller cancellation separately from a timeout', async () => {
    const controller = new AbortController();
    const client = createClient(hangingTransport, { timeoutMs: 5_000 });

    setTimeout(() => controller.abort(), 10);
    const error = await captureError(client.checkPurchase(PHONE, { signal: controller.signal }));
    expect(error.code).toBe('YANGMAO_OPEN_V1_CANCELLED');
  });

  it('honours an already-aborted caller signal without waiting', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createClient(hangingTransport, { timeoutMs: 5_000 });

    const error = await captureError(client.checkPurchase(PHONE, { signal: controller.signal }));
    expect(error.code).toBe('YANGMAO_OPEN_V1_CANCELLED');
  });

  it('normalizes a transport rejection without exposing its message', async () => {
    const client = createClient(async () => {
      throw new TypeError(`${APP_SECRET} at ${PHONE}`);
    });

    const error = await captureError(client.checkPurchase(PHONE));
    expect(error.code).toBe('YANGMAO_OPEN_V1_TRANSPORT_FAILED');
    expect(error.message).not.toContain(APP_SECRET);
    expect(error.message).not.toContain(PHONE);
    expect(JSON.stringify(error)).not.toContain(APP_SECRET);
    expect(JSON.stringify(error)).not.toContain(PHONE);
  });

  it('never copies the vendor message, phone or credentials into an error', async () => {
    const client = createClient(async () =>
      jsonResponse({
        code: 500,
        message: `AppSecret=${APP_SECRET} phone=${PHONE}`,
        data: null,
      }),
    );

    const error = await captureError(client.checkPurchase(PHONE));
    expect(error.code).toBe('YANGMAO_OPEN_V1_BUSINESS_FAILED');
    expect(error.message).not.toContain(APP_SECRET);
    expect(error.message).not.toContain(PHONE);
    expect(String(error)).not.toContain(APP_SECRET);
    expect(String(error)).not.toContain(PHONE);
  });
});

describe('A/B/C purchase-check request boundary', () => {
  it.each([
    { name: 'blank phone', phone: '' },
    { name: 'too short', phone: '1380013800' },
    { name: 'too long', phone: '138001380000' },
    { name: 'does not start with 1', phone: '23800138000' },
    { name: 'contains a letter', phone: '1380013800a' },
    { name: 'contains a space', phone: '138 00138000' },
    { name: 'has outer whitespace', phone: ' 13800138000 ' },
    { name: 'non-string input', phone: 13800138000 },
  ])('rejects $name locally without sending a request', async ({ phone }) => {
    let sent = 0;
    const client = createClient(async () => {
      sent += 1;
      return jsonResponse(ELIGIBLE_BODY);
    });

    const error = await captureError(client.checkPurchase(phone as string));
    expect(error.code).toBe('YANGMAO_OPEN_V1_PHONE_INVALID');
    expect(sent).toBe(0);
  });

  it('uses a fresh nonce per call and signs the exact nonce it sends', async () => {
    const captured: Request[] = [];
    const client = createClient(
      async (request) => {
        captured.push(request);
        return jsonResponse(ELIGIBLE_BODY);
      },
      { nonceFactory: undefined },
    );

    await client.checkPurchase(PHONE);
    await client.checkPurchase(PHONE);

    expect(captured).toHaveLength(2);
    const nonces = captured.map((request) => request.headers.get('x-nonce'));
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(nonces[0]).not.toBe(nonces[1]);

    for (const request of captured) {
      const nonce = request.headers.get('x-nonce') ?? '';
      const expected = createHash('sha256')
        .update(
          `appKey=${APP_KEY}&nonce=${nonce}&phone=${PHONE}` +
            `&timestamp=${FIXED_NOW}&appSecret=${APP_SECRET}`,
          'utf8',
        )
        .digest('hex')
        .toUpperCase();
      expect(request.headers.get('x-sign')).toBe(expected);
    }
  });

  it.each([
    { name: 'blank nonce', nonce: '' },
    { name: 'nonce with a separator', nonce: 'abc&123456' },
    { name: 'nonce with a space', nonce: 'abc 123456' },
    { name: 'too short', nonce: 'short' },
    { name: 'non-string nonce', nonce: 123 as unknown as string },
  ])('rejects $name before signing or sending', async ({ nonce }) => {
    let sent = 0;
    const client = createClient(
      async () => {
        sent += 1;
        return jsonResponse(ELIGIBLE_BODY);
      },
      { nonceFactory: () => nonce },
    );

    const error = await captureError(client.checkPurchase(PHONE));
    expect(error.code).toBe('YANGMAO_OPEN_V1_CONFIG_INVALID');
    expect(sent).toBe(0);
  });
});

describe('A/B/C client configuration boundary', () => {
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
    { name: 'path prefix', baseUrl: 'https://vendor.example.test/open' },
    { name: 'query string', baseUrl: 'https://vendor.example.test?x=1' },
  ])('rejects $name base URLs', ({ baseUrl }) => {
    expect(() =>
      createYangmaoOpenV1Client({ ...valid, baseUrl, transport: hangingTransport }),
    ).toThrowError(YangmaoOpenV1Error);
  });

  it('accepts plain HTTP only for a loopback test server', async () => {
    const client = createYangmaoOpenV1Client({
      ...valid,
      baseUrl: 'http://127.0.0.1:3999',
      transport: async () => jsonResponse(ELIGIBLE_BODY),
    });
    await expect(client.checkPurchase(PHONE)).resolves.toMatchObject({
      purchaseRestricted: false,
    });
  });

  it.each([
    { name: 'blank appKey', appKey: '   ' },
    { name: 'blank appSecret', appSecret: '' },
    { name: 'outer whitespace in secret', appSecret: ' secret ' },
    { name: 'control character in secret', appSecret: `sec${'\u0000'}ret` },
    { name: 'timeout below bound', timeoutMs: 99 },
    { name: 'timeout above bound', timeoutMs: 60_001 },
    { name: 'fractional timeout', timeoutMs: 1000.5 },
  ])('rejects $name without echoing credentials', ({ name: _name, ...overrides }) => {
    let thrown: unknown;
    try {
      createYangmaoOpenV1Client({
        ...valid,
        ...overrides,
        transport: hangingTransport,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(YangmaoOpenV1Error);
    const error = thrown as YangmaoOpenV1Error;
    expect(error.code).toBe('YANGMAO_OPEN_V1_CONFIG_INVALID');
    expect(String(error)).not.toContain(APP_SECRET);
    expect(JSON.stringify(error)).not.toContain(APP_SECRET);
  });
});
