import { createHash, createHmac } from 'node:crypto';
import {
  createYangmaoOpenV1Client,
  YangmaoOpenV1Error,
  type YangmaoOpenV1PurchaseReader,
} from '@sanchuang-dev/provider-yangmao';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { logEvent } from '../../log.js';
import { findApplicationBySource, listApplicationProducts } from '../applications/applications.js';
import {
  activeYangmaoReadConfig,
  SupplierCredentialUnavailableError,
} from '../suppliers/connection.js';
import {
  GrantInProgressError,
  GrantInputConflictError,
  GrantNotFoundError,
  GrantNotRetryableError,
  OrderApplicationDisabledError,
  OrderMappingUnavailableError,
  OrderModeUnsupportedError,
  OrderNotFoundError,
  OrderNotGrantableError,
  OrderProductNotAuthorizedError,
  type BenefitOrder,
  type PrepaidOrderGrant,
} from './benefit-orders.js';
import { createBenefitOrderRepository } from './repository.js';

/**
 * A durable reservation is considered in flight — and must not be raced by a
 * recovery read — for longer than the provider client's maximum request
 * timeout (60s). After that, a process crash or lost response is assumed and a
 * read-only recovery is allowed.
 */
const RESERVATION_IN_FLIGHT_MS = 2 * 60 * 1000;
const REQUEST_ID_PREFIX = 'bhA';
const PHONE_HMAC_DOMAIN = 'benefit-hub:a-prepaid-grant:phone:v1\n';

/**
 * The vendor idempotency key is derived from the immutable platform order id,
 * not from caller input and not regenerated per attempt. That is what makes a
 * retry a recovery of the same intent instead of a second quota deduction.
 */
export function derivePrepaidGrantRequestId(orderId: string): string {
  const digest = createHash('sha256')
    .update(`benefit-hub:a-prepaid-grant:request:${orderId}`, 'utf8')
    .digest('hex');
  // 3 + 60 = 63 chars, within the vendor's documented 64-character bound.
  return `${REQUEST_ID_PREFIX}${digest.slice(0, 60)}`;
}

/**
 * Keyed, domain-separated digest of the recipient phone. The raw number is
 * never persisted; the digest exists only to reject a conflicting repeated
 * grant input.
 */
export function hashPrepaidGrantPhone(masterKey: Buffer, phone: string): string {
  // Derive a dedicated subkey so the master key is not reused directly across
  // the AES-GCM credential envelope and this phone digest.
  const subkey = createHmac('sha256', masterKey)
    .update('benefit-hub:a-prepaid-grant:phone-key:v1', 'utf8')
    .digest();
  return createHmac('sha256', subkey)
    .update(PHONE_HMAC_DOMAIN, 'utf8')
    .update(phone, 'utf8')
    .digest('hex');
}

export class PurchaseNotEligibleError extends Error {}
export class SupplierNotConfiguredError extends Error {}
export class SupplierKeyUnavailableError extends Error {}

export interface PrepaidGrantOutcome {
  order: BenefitOrder;
  grant: PrepaidOrderGrant;
  /** Present only when the supplier returned a usable H5 link. */
  claimUrl?: string;
  observedAt?: number;
}

export interface GrantPrepaidOrderCommand {
  businessSource: string;
  /** Authenticated DB-issued machine credential, never accepted from the request body. */
  applicationCredentialId?: string | null;
  orderId: string;
  phone: string;
  refCode: string;
  /** Caller-asserted paid/authorized fact, recorded but never inferred. */
  paymentReference: string;
  signal?: AbortSignal;
}

export interface RecoverPrepaidGrantCommand {
  businessSource: string;
  orderId: string;
  signal?: AbortSignal;
}

export interface PrepaidGrantService {
  grant(command: GrantPrepaidOrderCommand): Promise<PrepaidGrantOutcome>;
  recover(command: RecoverPrepaidGrantCommand): Promise<PrepaidGrantOutcome>;
}

function isDefiniteRejection(error: unknown): boolean {
  if (!(error instanceof YangmaoOpenV1Error)) return false;
  if (error.code === 'YANGMAO_OPEN_V1_AUTH_FAILED') return true;
  if (error.code === 'YANGMAO_OPEN_V1_FORBIDDEN') return true;
  return (
    error.code === 'YANGMAO_OPEN_V1_BUSINESS_FAILED' &&
    error.vendorCode !== undefined &&
    [400, 401, 403].includes(error.vendorCode)
  );
}

function observedAtMillis(observedAt: string, fallback: number): number {
  const parsed = Date.parse(observedAt);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * A-mode prepaid gift-pack execution (BHB-012-C).
 *
 * The sequence is deliberately conservative:
 * 1. verify order ownership, frozen A mapping and application entitlement;
 * 2. run the live `purchase-check` and refuse restricted/unclaimed phones;
 * 3. persist a durable reservation and pre-send `unknown` attempt;
 * 4. perform the signed supplier POST with no local transaction open;
 * 5. settle the observed result (accepted / unknown / rejected).
 *
 * Any indeterminate result stays `unknown`; a retry only performs the vendor's
 * read-only `orders/query` with the same requestId and never re-sends the debit.
 */
export function createPrepaidGrantService(deps: {
  db: AppDatabase;
  config: AppConfig;
  now?: () => number;
}): PrepaidGrantService {
  const repository = createBenefitOrderRepository(deps.db);
  const now = deps.now ?? Date.now;

  function requireOwnedOrder(businessSource: string, orderId: string): BenefitOrder {
    const order = repository.getById(orderId);
    // The same response for "does not exist" and "belongs to another source".
    if (!order || order.businessSource !== businessSource) {
      throw new OrderNotFoundError('订单不存在');
    }
    return order;
  }

  function requireFrozenA(order: BenefitOrder): { productCode: string } {
    const detail = repository.getForOperations(order.id);
    if (!detail) throw new OrderNotFoundError('订单不存在');
    const frozen = detail.frozenMapping;
    if (!frozen) {
      throw new OrderMappingUnavailableError('订单没有冻结的供应商映射，不能发起上力下单');
    }
    if (frozen.provider !== 'yangmao' || frozen.fulfillmentMode !== 'A' || order.fulfillmentMode !== 'A') {
      throw new OrderModeUnsupportedError('该订单冻结的履约模式不是上力 A 预充值礼包');
    }
    return { productCode: frozen.productCode };
  }

  function assertApplicationEntitlement(businessSource: string, productId: string): void {
    const application = findApplicationBySource(deps.db, businessSource);
    // Legacy environment clients have no registered application, matching the
    // existing create-intent compatibility path.
    if (!application) return;
    if (application.status !== 'enabled') {
      throw new OrderApplicationDisabledError('应用已停用，不能发起上力下单');
    }
    const authorized = listApplicationProducts(deps.db, application.id).some(
      (product) => product.productId === productId,
    );
    if (!authorized) {
      throw new OrderProductNotAuthorizedError('该应用未被授权使用此内部商品');
    }
  }

  function requireSupplierClient(): YangmaoOpenV1PurchaseReader {
    let supplier;
    try {
      supplier = activeYangmaoReadConfig(deps.db, deps.config);
    } catch (error) {
      if (error instanceof SupplierCredentialUnavailableError) {
        throw new SupplierKeyUnavailableError('上力凭证加密主密钥不可用');
      }
      throw error;
    }
    if (!supplier) throw new SupplierNotConfiguredError('上力接口凭证尚未保存');
    return createYangmaoOpenV1Client(supplier);
  }

  function requireMasterKey(): Buffer {
    const key = deps.config.supplierMasterKey;
    if (!key || key.length !== 32) {
      throw new SupplierKeyUnavailableError('上力凭证加密主密钥不可用');
    }
    return key;
  }

  function settleFailure(
    order: BenefitOrder,
    grant: PrepaidOrderGrant,
    definiteRejection: boolean,
    occurredAt: number,
  ): void {
    try {
      repository.settleGrant({
        orderId: order.id,
        expectedVersion: order.version,
        kind: 'attempt',
        grantState: definiteRejection ? 'rejected' : 'unknown',
        upstreamOrderNo: null,
        orderStatus: definiteRejection ? 'failed' : 'unknown',
        operation: 'grant',
        result: definiteRejection ? 'rejected' : 'unknown',
        occurredAt,
        lastVerifiedAt: definiteRejection ? occurredAt : null,
      });
    } catch (error) {
      // The durable reservation remains, so the outcome stays unknown. Record
      // that settlement failed without hiding the original supplier failure.
      logEvent('prepaid_grant.settle_failed', {
        orderId: order.id,
        requestId: grant.requestId,
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  async function recoverGrant(
    order: BenefitOrder,
    grant: PrepaidOrderGrant,
    client: YangmaoOpenV1PurchaseReader,
    signal: AbortSignal | undefined,
  ): Promise<PrepaidGrantOutcome> {
    const attemptedAt = now();
    let lookup;
    try {
      lookup = await client.queryPrepaidOrder(grant.requestId, { signal });
    } catch (error) {
      const definiteRejection = isDefiniteRejection(error);
      const currentStatus = order.status;
      const orderStatus =
        currentStatus === 'pending' || currentStatus === 'processing' ? 'unknown' : currentStatus;
      try {
        repository.settleGrant({
          orderId: order.id,
          expectedVersion: order.version,
          kind: 'recovery',
          // A read-only query never turns an operation into an accepted or
          // rejected one; it only records what this read observed.
          grantState: 'unknown',
          upstreamOrderNo: null,
          orderStatus,
          operation: 'query',
          result: definiteRejection ? 'rejected' : 'unknown',
          occurredAt: attemptedAt,
          lastVerifiedAt: definiteRejection ? attemptedAt : null,
        });
      } catch (settleError) {
        logEvent('prepaid_grant.recovery_settle_failed', {
          orderId: order.id,
          requestId: grant.requestId,
          name: settleError instanceof Error ? settleError.name : 'unknown',
        });
      }
      throw error;
    }

    const verifiedAt = now();
    const observedAt = observedAtMillis(lookup.observedAt, verifiedAt);
    const upstreamOrderNo = lookup.orderNo ?? grant.upstreamOrderNo;

    if (lookup.claimUrl) {
      const settled = repository.settleGrant({
        orderId: order.id,
        expectedVersion: order.version,
        kind: 'recovery',
        grantState: 'accepted',
        upstreamOrderNo,
        // A verified link means the order exists; the recipient still has to
        // open it, so the platform state is awaiting_claim, not completed.
        orderStatus: 'awaiting_claim',
        operation: 'query',
        result: 'accepted',
        occurredAt: verifiedAt,
        lastVerifiedAt: verifiedAt,
      });
      return {
        order: settled.order,
        grant: settled.grant,
        claimUrl: lookup.claimUrl,
        observedAt,
      };
    }

    // The read succeeded but did not return a usable link. Preserve that as an
    // unknown operation rather than inventing a success.
    const currentStatus = order.status;
    const orderStatus =
      currentStatus === 'pending' || currentStatus === 'processing' ? 'unknown' : currentStatus;
    const settled = repository.settleGrant({
      orderId: order.id,
      expectedVersion: order.version,
      kind: 'recovery',
      grantState: 'unknown',
      upstreamOrderNo,
      orderStatus,
      operation: 'query',
      result: 'accepted',
      occurredAt: verifiedAt,
      lastVerifiedAt: verifiedAt,
    });
    if (settled.grant.state === 'accepted') {
      // A previously accepted order whose recovery read returned no usable
      // link is not a successful recovery. Keep the accepted fact and make the
      // caller retry, rather than returning an "accepted without link" answer.
      throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_RESPONSE_INVALID');
    }
    return { order: settled.order, grant: settled.grant, observedAt };
  }

  async function resumeExistingGrant(
    order: BenefitOrder,
    grant: PrepaidOrderGrant,
    command: GrantPrepaidOrderCommand,
    masterKey: Buffer,
    client: YangmaoOpenV1PurchaseReader,
  ): Promise<PrepaidGrantOutcome> {
    const sameInput =
      grant.phoneHmac === hashPrepaidGrantPhone(masterKey, command.phone) &&
      grant.refCode === command.refCode &&
      grant.paymentReference === command.paymentReference;
    if (!sameInput) {
      throw new GrantInputConflictError('相同订单的手机号、推广码或支付凭据与原下单记录不一致');
    }
    if (grant.state === 'rejected') {
      throw new GrantNotRetryableError('该订单已被上力明确拒绝，不会自动重试');
    }
    if (grant.state === 'reserved' && now() - grant.updatedAt < RESERVATION_IN_FLIGHT_MS) {
      throw new GrantInProgressError('该订单的上力下单仍在处理中，请稍后用同一订单取回结果');
    }
    return recoverGrant(order, grant, client, command.signal);
  }

  async function executeReservedGrant(
    order: BenefitOrder,
    grant: PrepaidOrderGrant,
    command: GrantPrepaidOrderCommand,
    productCode: string,
    client: YangmaoOpenV1PurchaseReader,
  ): Promise<PrepaidGrantOutcome> {
    let result;
    try {
      result = await client.createPrepaidOrder(
        {
          phone: command.phone,
          refCode: command.refCode,
          productCode,
          requestId: grant.requestId,
        },
        { signal: command.signal },
      );
    } catch (error) {
      // No transaction is open here; the reservation already exists. Anything
      // that is not an explicit vendor refusal remains `unknown` and must be
      // recovered by requestId, never by sending a fresh grant.
      settleFailure(order, grant, isDefiniteRejection(error), now());
      throw error;
    }

    const settled = repository.settleGrant({
      orderId: order.id,
      expectedVersion: order.version,
      kind: 'attempt',
      grantState: 'accepted',
      upstreamOrderNo: result.orderNo,
      // code=0 plus a claimUrl only means an H5 order exists. The user still
      // has to claim the benefit, so this is never `completed`.
      orderStatus: 'awaiting_claim',
      operation: 'grant',
      result: 'accepted',
      occurredAt: now(),
      lastVerifiedAt: now(),
    });
    return {
      order: settled.order,
      grant: settled.grant,
      claimUrl: result.claimUrl,
      observedAt: observedAtMillis(result.observedAt, now()),
    };
  }

  return {
    async grant(command) {
      const order = requireOwnedOrder(command.businessSource, command.orderId);
      assertApplicationEntitlement(command.businessSource, order.productId);
      const frozen = requireFrozenA(order);
      const masterKey = requireMasterKey();
      const client = requireSupplierClient();

      const existing = repository.getGrant(order.id);
      if (existing) {
        return resumeExistingGrant(order, existing, command, masterKey, client);
      }

      if (order.status !== 'pending') {
        throw new OrderNotGrantableError(`订单当前状态不允许发起上力下单：${order.status}`);
      }

      // Live, read-only eligibility must pass before any local reservation or
      // supplier debit. A restricted phone must not be charged.
      const eligibility = await client.checkPurchase(command.phone, { signal: command.signal });
      if (eligibility.purchaseRestricted || eligibility.giftUnclaimed || eligibility.lotteryUnbet) {
        throw new PurchaseNotEligibleError(
          '该手机号当前存在限领或未领取权益，未发起上力下单',
        );
      }

      const reservation = repository.reserveGrant({
        orderId: order.id,
        applicationCredentialId: command.applicationCredentialId,
        expectedVersion: order.version,
        requestId: derivePrepaidGrantRequestId(order.id),
        refCode: command.refCode,
        phoneHmac: hashPrepaidGrantPhone(masterKey, command.phone),
        paymentReference: command.paymentReference,
        occurredAt: now(),
      });

      if (!reservation.created) {
        // A concurrent caller won the reservation. Never send a second debit.
        return resumeExistingGrant(
          reservation.order,
          reservation.grant,
          command,
          masterKey,
          client,
        );
      }

      return executeReservedGrant(
        reservation.order,
        reservation.grant,
        command,
        frozen.productCode,
        client,
      );
    },

    async recover(command) {
      const order = requireOwnedOrder(command.businessSource, command.orderId);
      assertApplicationEntitlement(command.businessSource, order.productId);
      requireFrozenA(order);
      const client = requireSupplierClient();

      const grant = repository.getGrant(order.id);
      if (!grant) throw new GrantNotFoundError('该订单尚未发起过上力下单');
      if (grant.state === 'rejected') {
        throw new GrantNotRetryableError('该订单已被上力明确拒绝，没有可恢复的领取链接');
      }
      if (grant.state === 'reserved' && now() - grant.updatedAt < RESERVATION_IN_FLIGHT_MS) {
        throw new GrantInProgressError('该订单的上力下单仍在处理中，请稍后再取回领取链接');
      }
      return recoverGrant(order, grant, client, command.signal);
    },
  };
}
