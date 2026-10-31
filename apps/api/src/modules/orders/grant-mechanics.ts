import { createHash, createHmac } from 'node:crypto';
import { YangmaoOpenV1Error } from '@sanchuang-dev/provider-yangmao';
import { OrderNotFoundError, type BenefitOrder } from './benefit-orders.js';
import type { BenefitOrderRepository } from './repository.js';

/**
 * A durable reservation is considered in flight — and must not be raced by a
 * recovery read — for longer than the provider client's maximum request
 * timeout (60s). After that, a process crash or lost response is assumed and a
 * read-only recovery is allowed. Shared by every signed grant mode so the
 * window cannot drift between them.
 */
export const RESERVATION_IN_FLIGHT_MS = 2 * 60 * 1000;

/**
 * The vendor idempotency key is derived from the immutable platform order id,
 * not from caller input and not regenerated per attempt. That is what makes a
 * retry a recovery of the same intent instead of a second debit or quota
 * deduction. `domain` separates modes; `requestIdPrefix` keeps the vendor's
 * per-mode key namespace visible in the value itself.
 */
export function deriveGrantRequestId(
  domain: string,
  requestIdPrefix: string,
  orderId: string,
): string {
  const digest = createHash('sha256')
    .update(`${domain}:request:${orderId}`, 'utf8')
    .digest('hex');
  // 3 + 60 = 63 chars, within the vendor's documented 64-character bound.
  return `${requestIdPrefix}${digest.slice(0, 60)}`;
}

/**
 * Keyed, domain-separated digest of the recipient phone. The raw number is
 * never persisted; the digest only rejects a conflicting repeated grant input.
 * The mode domain keeps the same phone unlinkable across grant modes.
 */
export function hashRecipientPhone(masterKey: Buffer, domain: string, phone: string): string {
  // Derive a dedicated subkey so the master key is not reused directly across
  // the AES-GCM credential envelope and this phone digest.
  const subkey = createHmac('sha256', masterKey)
    .update(`${domain}:phone-key:v1`, 'utf8')
    .digest();
  return createHmac('sha256', subkey)
    .update(`${domain}:phone:v1\n`, 'utf8')
    .update(phone, 'utf8')
    .digest('hex');
}

/**
 * Only an explicit vendor refusal is terminal. Everything else (timeout, 5xx,
 * malformed response) leaves the operation `unknown` and recoverable, so it
 * must never be retried as a fresh debit.
 */
export function isDefiniteRejection(error: unknown): boolean {
  if (!(error instanceof YangmaoOpenV1Error)) return false;
  if (error.code === 'YANGMAO_OPEN_V1_AUTH_FAILED') return true;
  if (error.code === 'YANGMAO_OPEN_V1_FORBIDDEN') return true;
  return (
    error.code === 'YANGMAO_OPEN_V1_BUSINESS_FAILED' &&
    error.vendorCode !== undefined &&
    [400, 401, 403].includes(error.vendorCode)
  );
}

export function observedAtMillis(observedAt: string, fallback: number): number {
  const parsed = Date.parse(observedAt);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Order ownership guard shared by machine-facing grant modes. "Does not exist"
 * and "belongs to another business source" must produce the same response so a
 * caller cannot probe other sources' order ids.
 */
export function requireOwnedOrder(
  repository: BenefitOrderRepository,
  businessSource: string,
  orderId: string,
): BenefitOrder {
  const order = repository.getById(orderId);
  if (!order || order.businessSource !== businessSource) {
    throw new OrderNotFoundError('订单不存在');
  }
  return order;
}
