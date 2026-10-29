import { describe, expect, it } from 'vitest';
import {
  createYangmaoOpenV1Client,
  YangmaoOpenV1Error,
  type YangmaoOpenV1Transport,
} from '../src/index.js';

const FIXED_NOW = 1793059200000;
const KEY = 'fixture-app-key';
const SECRET = 'test-secret-do-not-use';
const NONCE = 'abc123def456';
const REQUEST = {
  phone: '13800138000',
  refCode: 'ref_abc123',
  productCode: 'benefit_pack_299',
  requestId: 'bhA0123456789abcdef',
};
// Independently pinned A/B canonical vector with all seven required fields.
const EXPECTED_SIGN = '6533E065D57A7FC1621B53436F6561DFB0A1E2E661B9E46E3BE0CE4977E51F62';

function client(transport: YangmaoOpenV1Transport) {
  return createYangmaoOpenV1Client({
    baseUrl: 'https://vendor.example.test',
    appKey: KEY, appSecret: SECRET, transport,
    clock: () => FIXED_NOW, nonceFactory: () => NONCE,
  });
}
function response(data: unknown, code = 0) {
  return Promise.resolve(new Response(JSON.stringify({ code, data })));
}
const PARTIAL = {
  orderNo: 'PKG-MOCK-1', allClaimed: false, successCount: 1, totalCount: 2,
  items: [
    { claimed: true, status: 'completed' },
    { claimed: false, status: 'failed', message: 'mock failure' },
  ],
  balanceAfter: 9, idempotentReplay: false,
};

describe('B direct-topup contract', () => {
  it('signs exact B-mode fields with X-Sign, sends required productCode, no H5 url', async () => {
    let request: Request | undefined;
    const c = client(async (r) => { request = r; return response(PARTIAL); });
    const result = await c.directTopup(REQUEST);
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('https://vendor.example.test/open/v1/prepaid/direct-topup');
    expect(request?.headers.get('x-timestamp')).toBe(String(FIXED_NOW));
    expect(request?.headers.get('x-nonce')).toBe(NONCE);
    expect(request?.headers.get('x-sign')).toBe(EXPECTED_SIGN);
    expect(request?.headers.get('x-signature')).toBeNull();
    expect(await request?.text()).toBe(JSON.stringify(REQUEST));
    expect(result).toMatchObject({
      allClaimed: false, successCount: 1, totalCount: 2, orderNo: 'PKG-MOCK-1',
    });
    expect(result).not.toHaveProperty('claimUrl');
  });

  it('rejects missing required productCode before any vendor write', async () => {
    let sent = 0;
    const c = client(async () => { sent++; return response(PARTIAL); });
    await expect(c.directTopup({ ...REQUEST, productCode: '' })).rejects.toMatchObject({
      code: 'YANGMAO_OPEN_V1_CONFIG_INVALID',
    });
    expect(sent).toBe(0);
  });

  it.each([
    { ...PARTIAL, successCount: 3 },
    { ...PARTIAL, totalCount: 1 },
    { ...PARTIAL, allClaimed: true, successCount: 2 },
    { ...PARTIAL, allClaimed: true, successCount: 2, items: [{ claimed: true }] },
    { ...PARTIAL, allClaimed: false, successCount: 2 },
    { ...PARTIAL, items: [
      { claimed: false, status: 'completed' }, { claimed: true, status: 'failed' },
    ] },
    { ...PARTIAL, items: [
      { claimed: true, status: 'failed' }, { claimed: false, status: 'failed' },
    ] },
    { ...PARTIAL, allClaimed: true, successCount: 2, items: [
      { claimed: true }, { status: 'completed' },
    ] },
    { ...PARTIAL, orderNo: undefined },
  ])('rejects impossible or unsupported successful envelopes', async (data) => {
    const c = client(async () => response(data));
    await expect(c.directTopup(REQUEST)).rejects.toMatchObject({
      code: 'YANGMAO_OPEN_V1_RESPONSE_INVALID',
    });
  });

  it('classifies explicit cancellation without assuming B supplier debit failed', async () => {
    const controller = new AbortController();
    const stalled: YangmaoOpenV1Transport = async (request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('fixture aborted')), {
          once: true,
        });
      });
    const attempted = client(stalled).directTopup(REQUEST, { signal: controller.signal });
    controller.abort();
    await expect(attempted).rejects.toMatchObject({ code: 'YANGMAO_OPEN_V1_CANCELLED' });
  });

  it('classifies bounded supplier timeout independently from invalid vendor data', async () => {
    const stalled: YangmaoOpenV1Transport = async (request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('fixture timeout')), {
          once: true,
        });
      });
    const c = createYangmaoOpenV1Client({
      baseUrl: 'https://vendor.example.test', appKey: KEY, appSecret: SECRET,
      transport: stalled, timeoutMs: 100, clock: () => FIXED_NOW, nonceFactory: () => NONCE,
    });
    await expect(c.directTopup(REQUEST)).rejects.toMatchObject({
      code: 'YANGMAO_OPEN_V1_TIMEOUT',
    });
  });

  it('never treats HTTP 200 with vendor code 400 as a successful topup', async () => {
    const c = client(async () => response(PARTIAL, 400));
    await expect(c.directTopup(REQUEST)).rejects.toBeInstanceOf(YangmaoOpenV1Error);
  });
});
