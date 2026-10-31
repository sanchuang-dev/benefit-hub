import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { YangmaoOpenV1Error } from '@sanchuang-dev/provider-yangmao';
import { OrderNotFoundError } from '../../src/modules/orders/benefit-orders.js';
import {
  RESERVATION_IN_FLIGHT_MS,
  deriveGrantRequestId,
  hashRecipientPhone,
  isDefiniteRejection,
  observedAtMillis,
  requireOwnedOrder,
} from '../../src/modules/orders/grant-mechanics.js';
import type { BenefitOrderRepository } from '../../src/modules/orders/repository.js';

const A_DOMAIN = 'benefit-hub:a-prepaid-grant';
const C_DOMAIN = 'benefit-hub:c-gift-voucher';
const MASTER_KEY = Buffer.alloc(32, 7);

describe('grant mechanics shared by signed grant modes', () => {
  it('pins the vendor request-id wire format', () => {
    const orderId = 'order-1';
    const expectedDigest = createHash('sha256')
      .update(`${A_DOMAIN}:request:${orderId}`, 'utf8')
      .digest('hex');

    const requestId = deriveGrantRequestId(A_DOMAIN, 'bhA', orderId);

    expect(requestId).toBe(`bhA${expectedDigest.slice(0, 60)}`);
    expect(requestId).toHaveLength(63);
    expect(requestId).toMatch(/^bhA[0-9a-f]{60}$/);
  });

  it('keeps request ids stable per order and separate per mode', () => {
    const first = deriveGrantRequestId(A_DOMAIN, 'bhA', 'order-1');

    expect(deriveGrantRequestId(A_DOMAIN, 'bhA', 'order-1')).toBe(first);
    expect(deriveGrantRequestId(A_DOMAIN, 'bhA', 'order-2')).not.toBe(first);
    expect(deriveGrantRequestId(C_DOMAIN, 'bhC', 'order-1')).not.toBe(first);
  });

  it('pins the recipient-phone digest wire format', () => {
    const phone = '13800000000';
    const subkey = createHmac('sha256', MASTER_KEY)
      .update(`${A_DOMAIN}:phone-key:v1`, 'utf8')
      .digest();
    const expected = createHmac('sha256', subkey)
      .update(`${A_DOMAIN}:phone:v1\n`, 'utf8')
      .update(phone, 'utf8')
      .digest('hex');

    const digest = hashRecipientPhone(MASTER_KEY, A_DOMAIN, phone);

    expect(digest).toBe(expected);
    expect(hashRecipientPhone(MASTER_KEY, A_DOMAIN, phone)).toBe(digest);
    expect(hashRecipientPhone(MASTER_KEY, A_DOMAIN, '13900000000')).not.toBe(digest);
    // The same phone must be unlinkable across modes.
    expect(hashRecipientPhone(MASTER_KEY, C_DOMAIN, phone)).not.toBe(digest);
  });

  it('classifies only explicit vendor refusals as definite rejections', () => {
    expect(isDefiniteRejection(new YangmaoOpenV1Error('YANGMAO_OPEN_V1_AUTH_FAILED'))).toBe(true);
    expect(isDefiniteRejection(new YangmaoOpenV1Error('YANGMAO_OPEN_V1_FORBIDDEN'))).toBe(true);
    for (const vendorCode of [400, 401, 403]) {
      expect(
        isDefiniteRejection(
          new YangmaoOpenV1Error('YANGMAO_OPEN_V1_BUSINESS_FAILED', { vendorCode }),
        ),
      ).toBe(true);
    }

    expect(isDefiniteRejection(new YangmaoOpenV1Error('YANGMAO_OPEN_V1_TIMEOUT'))).toBe(false);
    expect(
      isDefiniteRejection(
        new YangmaoOpenV1Error('YANGMAO_OPEN_V1_BUSINESS_FAILED', { vendorCode: 5001 }),
      ),
    ).toBe(false);
    expect(isDefiniteRejection(new YangmaoOpenV1Error('YANGMAO_OPEN_V1_RESPONSE_INVALID'))).toBe(
      false,
    );
    expect(isDefiniteRejection(new Error('boom'))).toBe(false);
    expect(isDefiniteRejection(undefined)).toBe(false);
  });

  it('parses observed-at timestamps with a deterministic fallback', () => {
    expect(observedAtMillis('2026-10-29T00:00:00.000Z', 1)).toBe(
      Date.parse('2026-10-29T00:00:00.000Z'),
    );
    expect(observedAtMillis('not-a-date', 1)).toBe(1);
    expect(observedAtMillis('', 1)).toBe(1);
    expect(observedAtMillis('1970-01-01T00:00:00.000Z', 1)).toBe(0);
  });

  it('keeps the reservation in-flight window longer than the provider timeout', () => {
    expect(RESERVATION_IN_FLIGHT_MS).toBe(2 * 60 * 1000);
  });

  it('hides "missing" and "foreign source" orders behind the same error', () => {
    const repository = {
      getById: (orderId: string) =>
        orderId === 'own-order' ? { businessSource: 'source-a' } : null,
    } as unknown as BenefitOrderRepository;

    expect(requireOwnedOrder(repository, 'source-a', 'own-order')).toMatchObject({
      businessSource: 'source-a',
    });
    for (const orderId of ['own-order', 'missing-order']) {
      // Both cases must be indistinguishable to the caller: same error, same
      // message, no hint that the order exists under another source.
      expect(() => requireOwnedOrder(repository, 'source-b', orderId)).toThrow(
        new OrderNotFoundError('订单不存在'),
      );
    }
  });
});
