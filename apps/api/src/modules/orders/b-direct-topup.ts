import { createHash, createHmac } from 'node:crypto';
import {
  YangmaoOpenV1Error,
  type YangmaoOpenV1DirectTopupResult,
  type YangmaoOpenV1PurchaseReader,
} from '@sanchuang-dev/provider-yangmao';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { logEvent } from '../../log.js';
import {
  OrderMappingUnavailableError,
  OrderModeUnsupportedError,
  OrderNotFoundError,
  OrderNotGrantableError,
  type BenefitOrder,
} from './benefit-orders.js';
import {
  createDirectTopupRepository,
  DirectTopupConflictError,
  DirectTopupUnknownError,
  DirectTopupInProgressError,
  type DirectTopupOperation,
} from './b-direct-topup-repository.js';
import { createBenefitOrderRepository } from './repository.js';
import {
  assertApplicationEntitlement,
  requireSupplierMasterKey,
  requireYangmaoClient,
} from './supplier-access.js';

const RESERVATION_IN_FLIGHT_MS = 2 * 60 * 1000;

/** B-mode uses a distinct, immutable supplier idempotency namespace. */
export function deriveDirectTopupRequestId(orderId: string): string {
  return 'bhB' + createHash('sha256')
    .update('benefit-hub:b-direct-topup:request:' + orderId, 'utf8')
    .digest('hex').slice(0, 60);
}
export function hashDirectTopupPhone(masterKey: Buffer, phone: string): string {
  const subkey = createHmac('sha256', masterKey)
    .update('benefit-hub:b-direct-topup:phone-key:v1', 'utf8').digest();
  return createHmac('sha256', subkey)
    .update('benefit-hub:b-direct-topup:phone:v1\n', 'utf8')
    .update(phone, 'utf8').digest('hex');
}

export class DirectTopupProductUnverifiedError extends Error {}
export class DirectTopupPurchaseIneligibleError extends Error {}
export class DirectTopupInputConflictError extends Error {}

export interface DirectTopupCommand {
  businessSource: string;
  applicationCredentialId?: string | null;
  orderId: string;
  phone: string;
  refCode: string;
  paymentReference: string;
  signal?: AbortSignal;
}
export interface DirectTopupOutcome {
  order: BenefitOrder;
  topup: DirectTopupOperation;
  /** Supplier result is deliberately not echoed raw. */
  observedAt?: number;
}

function isDefiniteRejection(error: unknown): boolean {
  return error instanceof YangmaoOpenV1Error && (
    error.code === 'YANGMAO_OPEN_V1_AUTH_FAILED' ||
    error.code === 'YANGMAO_OPEN_V1_FORBIDDEN' ||
    (error.code === 'YANGMAO_OPEN_V1_BUSINESS_FAILED' &&
      error.vendorCode !== undefined && [400, 401, 403].includes(error.vendorCode))
  );
}

export function createDirectTopupService(deps: {
  db: AppDatabase; config: AppConfig; now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const orders = createBenefitOrderRepository(deps.db);
  const topups = createDirectTopupRepository(deps.db);

  function requireOwned(businessSource: string, orderId: string): BenefitOrder {
    const order = orders.getById(orderId);
    if (!order || order.businessSource !== businessSource) {
      throw new OrderNotFoundError('订单不存在');
    }
    return order;
  }

  function requireFrozenVerifiedB(order: BenefitOrder): string {
    const detail = orders.getForOperations(order.id);
    const frozen = detail?.frozenMapping;
    if (!frozen) throw new OrderMappingUnavailableError('订单没有冻结的供应商映射');
    if (order.fulfillmentMode !== 'B' || frozen.fulfillmentMode !== 'B' ||
        frozen.provider !== 'yangmao' || frozen.deductionUnit !== 'pack') {
      throw new OrderModeUnsupportedError('不是上力 B 直充订单');
    }
    // Supplier product identity must be proven by server-held evidence.
    // Neither the product display name nor a browser/body flag can authorize a debit.
    if (!deps.config.verifiedBTravelProducts[frozen.productCode]) {
      throw new DirectTopupProductUnverifiedError(
        '缺少供应商纯腾讯出行礼包的可信核验依据，未发起直充',
      );
    }
    return frozen.productCode;
  }

  function requireSameInput(
    topup: DirectTopupOperation, command: DirectTopupCommand, masterKey: Buffer,
  ) {
    if (topup.phoneHmac !== hashDirectTopupPhone(masterKey, command.phone) ||
        topup.refCode !== command.refCode ||
        topup.paymentReference !== command.paymentReference) {
      throw new DirectTopupInputConflictError('手机号、推广码或支付凭据与原单不一致');
    }
  }

  function outcome(orderId: string, topup: DirectTopupOperation, observedAt?: number) {
    const order = orders.getById(orderId);
    if (!order) throw new OrderNotFoundError('订单不存在');
    return {
      order, topup, ...(observedAt === undefined ? {} : { observedAt }),
    };
  }

  async function requireLiveEligibility(
    client: YangmaoOpenV1PurchaseReader, command: DirectTopupCommand,
  ) {
    const e = await client.checkPurchase(command.phone, { signal: command.signal });
    if (e.purchaseRestricted || e.giftUnclaimed || e.lotteryUnbet) {
      throw new DirectTopupPurchaseIneligibleError(
        '当前手机号限领或已有未领取的权益，未请求直充',
      );
    }
  }

  async function callVendor(
    orderId: string,
    topup: DirectTopupOperation,
    command: DirectTopupCommand,
    productCode: string,
    client: YangmaoOpenV1PurchaseReader,
    kind: 'grant' | 'reissue',
  ): Promise<DirectTopupOutcome> {
    let result: YangmaoOpenV1DirectTopupResult;
    try {
      result = await client.directTopup({
        phone: command.phone,
        refCode: topup.refCode,
        productCode,
        // Reissue deliberately uses the EXACT original key, never a new debit identity.
        requestId: topup.requestId,
      }, { signal: command.signal });
    } catch (error) {
      try {
        topups.settle({
          orderId, kind, definiteRejection: isDefiniteRejection(error),
          occurredAt: now(),
        });
      } catch (settleError) {
        logEvent('b_topup.settle_failed', {
          orderId, name: settleError instanceof Error ? settleError.name : 'unknown',
        });
      }
      throw error;
    }
    const settled = topups.settle({
      orderId, kind, observed: result, occurredAt: now(),
    });
    return outcome(orderId, settled.operation, Date.parse(result.observedAt));
  }

  return {
    /** Initial B-mode request: never retried as a new vendor operation. */
    async issue(command: DirectTopupCommand): Promise<DirectTopupOutcome> {
      const order = requireOwned(command.businessSource, command.orderId);
      assertApplicationEntitlement(deps.db, command.businessSource, order.productId);
      const productCode = requireFrozenVerifiedB(order);
      const masterKey = requireSupplierMasterKey(deps.config);
      const client = requireYangmaoClient(deps.db, deps.config);
      const old = topups.get(order.id);
      if (old) {
        requireSameInput(old, command, masterKey);
        if (old.state === 'reserved' && now() - old.updatedAt < RESERVATION_IN_FLIGHT_MS) {
          throw new DirectTopupInProgressError('原单仍在调用中');
        }
        if (old.state === 'reserved' || old.state === 'unknown' || old.state === 'retrying') {
          throw new DirectTopupUnknownError('原单结果待人工核实，禁止盲目重发');
        }
        return outcome(order.id, old);
      }
      if (order.status !== 'pending') {
        throw new OrderNotGrantableError('订单当前状态不允许发起 B 直充');
      }
      await requireLiveEligibility(client, command);
      const reserved = topups.reserve({
        order, credentialId: command.applicationCredentialId,
        requestId: deriveDirectTopupRequestId(order.id),
        refCode: command.refCode,
        phoneHmac: hashDirectTopupPhone(masterKey, command.phone),
        paymentReference: command.paymentReference,
        occurredAt: now(),
      });
      if (!reserved.created) {
        requireSameInput(reserved.operation, command, masterKey);
        // Crucially, a racing caller NEVER makes the second supplier write.
        throw new DirectTopupInProgressError('已有同单直充记录，未重复请求供应商');
      }
      return callVendor(order.id, reserved.operation, command, productCode, client, 'grant');
    },

    /** Explicit operator/business reissue ONLY after a verified partial result.
     * Unknown responses can never be blindly retried, even with the same id.
     */
    async reissue(command: DirectTopupCommand): Promise<DirectTopupOutcome> {
      const order = requireOwned(command.businessSource, command.orderId);
      assertApplicationEntitlement(deps.db, command.businessSource, order.productId);
      const productCode = requireFrozenVerifiedB(order);
      const masterKey = requireSupplierMasterKey(deps.config);
      const client = requireYangmaoClient(deps.db, deps.config);
      const existing = topups.get(order.id);
      if (!existing) throw new DirectTopupConflictError('原单未创建 B 直充');
      requireSameInput(existing, command, masterKey);
      if (existing.state !== 'partial') {
        throw new DirectTopupConflictError('只能对有明确部分成功证据的原单补发');
      }
      await requireLiveEligibility(client, command);
      const lease = topups.beginReissue({
        order, credentialId: command.applicationCredentialId, occurredAt: now(),
      });
      return callVendor(order.id, lease, command, productCode, client, 'reissue');
    },

    /** Read from local persisted facts: never asks the provider to debit again. */
    get(businessSource: string, orderId: string): DirectTopupOutcome | null {
      requireOwned(businessSource, orderId);
      const topup = topups.get(orderId);
      return topup ? outcome(orderId, topup) : null;
    },
  };
}
