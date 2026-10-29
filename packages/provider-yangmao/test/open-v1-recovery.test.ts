import { describe, expect, it } from 'vitest';
import { createYangmaoOpenV1Client, YangmaoOpenV1Error } from '../src/index.js';
import { createOpenV1Signature } from '../src/open-v1-signature.js';

const APP_KEY = 'fixture-only-key';
const SECRET = 'fixture-only-secret';
const TIME = 1793232000000;
const NONCE = 'fixture-nonce-0001';

function client(transport: (request: Request) => Promise<Response>) {
  return createYangmaoOpenV1Client({
    baseUrl: 'https://dev-api.example.test',
    appKey: APP_KEY,
    appSecret: SECRET,
    clock: () => TIME,
    nonceFactory: () => NONCE,
    transport,
  });
}
function reply(code: number, data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ code, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}
describe('documented A/C vendor recovery reads', () => {
  it('queries an existing A order with signed requestId, never places an order', async () => {
    const api = client(async (request) => {
      expect(request.method).toBe('POST');
      expect(new URL(request.url).pathname).toBe('/open/v1/prepaid/orders/query');
      expect(request.headers.get('x-sign')).toBe(createOpenV1Signature({
        appKey: APP_KEY, timestamp: String(TIME), nonce: NONCE, requestId: 'fixture-request-1',
      }, SECRET));
      expect(request.headers.get('x-signature')).toBeNull();
      expect(await request.text()).toBe(JSON.stringify({ requestId: 'fixture-request-1' }));
      return reply(0, {
        orderNo: 'fixture-upstream-1', claimable: true,
        claimUrl: 'https://h5.example.test/claim?id=fixture',
        mobile: '13800000000', credentials: 'should never leave provider client',
      });
    });
    const result = await api.queryPrepaidOrder('fixture-request-1');
    expect(result).toMatchObject({
      provider: 'yangmao', orderNo: 'fixture-upstream-1',
      claimable: true, claimUrl: 'https://h5.example.test/claim?id=fixture',
    });
    expect(JSON.stringify(result)).not.toContain('13800000000');
    expect(JSON.stringify(result)).not.toContain('should never leave');
  });

  it('uses C GET path plus signed code, not a signing payload copied from D', async () => {
    const api = client(async (request) => {
      expect(request.method).toBe('GET');
      expect(new URL(request.url).pathname).toBe('/open/v1/gift-vouchers/FIXTURE_CODE');
      expect(request.headers.get('x-sign')).toBe(createOpenV1Signature({
        appKey: APP_KEY, timestamp: String(TIME), nonce: NONCE, code: 'FIXTURE_CODE',
      }, SECRET));
      expect(request.headers.get('x-signature')).toBeNull();
      expect(await request.text()).toBe('');
      return reply(0, {
        voucherCode: 'FIXTURE_CODE',
        claimUrl: 'https://h5.example.test/voucher',
        packTotal: 3, packRemaining: 2, expiresAt: '2026-11-30T00:00:00Z',
        phone: '13800000000',
      });
    });
    const result = await api.queryGiftVoucher('FIXTURE_CODE');
    expect(result).toMatchObject({ packTotal: 3, packRemaining: 2, expiresAt: '2026-11-30T00:00:00Z' });
    expect(result).not.toHaveProperty('voucherCode');
    expect(JSON.stringify(result)).not.toContain('13800000000');
  });

  it('rejects guessed or absent response fields instead of reporting a fabricated success', async () => {
    const empty = client(async () => reply(0, { unknownFutureField: true }));
    await expect(empty.queryPrepaidOrder('request-1')).rejects.toMatchObject({ code: 'YANGMAO_OPEN_V1_RESPONSE_INVALID' });
    await expect(empty.queryGiftVoucher('VOUCHER')).rejects.toMatchObject({ code: 'YANGMAO_OPEN_V1_RESPONSE_INVALID' });
    const malicious = client(async () => reply(0, { claimUrl: 'javascript:alert(1)' }));
    await expect(malicious.queryPrepaidOrder('request-1')).rejects.toMatchObject({ code: 'YANGMAO_OPEN_V1_RESPONSE_INVALID' });
    await expect(malicious.queryGiftVoucher('VOUCHER')).rejects.toMatchObject({ code: 'YANGMAO_OPEN_V1_RESPONSE_INVALID' });
  });

  it('propagates real numeric vendor code without issuing retries', async () => {
    let requests = 0;
    const api = client(async () => { requests++; return reply(400, null); });
    let failure: unknown;
    try { await api.queryGiftVoucher('NOT_FOUND'); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(YangmaoOpenV1Error);
    expect(failure).toMatchObject({ code: 'YANGMAO_OPEN_V1_BUSINESS_FAILED', vendorCode: 400 });
    expect(requests).toBe(1);
  });

  it('rejects invalid identifiers locally, before any signed request', async () => {
    const api = client(async () => { throw new Error('Unexpected network request'); });
    await expect(api.queryPrepaidOrder('bad request id')).rejects.toBeInstanceOf(YangmaoOpenV1Error);
    await expect(api.queryGiftVoucher('../bad')).rejects.toBeInstanceOf(YangmaoOpenV1Error);
  });
});
