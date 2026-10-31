import type {
  YangmaoOpenV1DirectTopupResult,
  YangmaoOpenV1PurchaseReader,
} from '@sanchuang-dev/provider-yangmao';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { logEvent } from '../../log.js';
import {
  OrderMappingUnavailableError,
  OrderModeUnsupportedError,
  OrderNotFoundError,
  type BenefitOrder,
} from './benefit-orders.js';
import {
  createDirectTopupRepository,
  DirectTopupConflictError,
  DirectTopupInProgressError,
  DirectTopupUnknownError,
  type DirectTopupOperation,
} from './b-direct-topup-repository.js';
import {
  deriveGrantRequestId,
  hashRecipientPhone,
  isDefiniteRejection,
  observedAtMillis,
  requireOwnedOrder,
} from './grant-mechanics.js';
import {
  createGrantPipeline,
  isInFlight,
  type GrantContinueInput,
  type GrantExecuteInput,
} from './grant-pipeline.js';
import { createBenefitOrderRepository } from './repository.js';
import {
  assertApplicationEntitlement,
  requireSupplierMasterKey,
  requireYangmaoClient,
} from './supplier-access.js';

const B_MODE_DOMAIN = 'benefit-hub:b-direct-topup';
const B_REQUEST_ID_PREFIX = 'bhB';

export class DirectTopupProductUnverifiedError extends Error {}
export class DirectTopupWriteDisabledError extends Error {}
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

/**
 * B-mode direct pack topup.
 *
 * The initial debit is a signed grant like A/C, so it runs through the shared
 * grant pipeline: ownership -> application entitlement -> frozen verified-B
 * mapping -> one reservation -> exactly one supplier POST -> durable settle.
 * The pipeline also owns the "never send a second debit" race rule.
 *
 * Reissue is deliberately outside that pipeline. It is not a new purchase but
 * the vendor-documented continuation of the SAME requestId after a verified
 * partial result, so it must skip the live purchase-check (which would see the
 * partial order's own unclaimed items) and is gated by persisted evidence
 * instead. B has no read-by-requestId recovery, so it supplies no recovery spec.
 */
export function createDirectTopupService(deps: {
  db: AppDatabase;
  config: AppConfig;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const orders = createBenefitOrderRepository(deps.db);
  const topups = createDirectTopupRepository(deps.db);

  function requireFrozenVerifiedB(order: BenefitOrder): { productCode: string } {
    if (!deps.config.bLiveWritesEnabled) {
      throw new DirectTopupWriteDisabledError('B 真实扣额写操作未单独启用');
    }
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
    return { productCode: frozen.productCode };
  }

  function requireSameInput(
    topup: DirectTopupOperation, command: DirectTopupCommand, masterKey: Buffer,
  ) {
    if (topup.phoneHmac !== hashRecipientPhone(masterKey, B_MODE_DOMAIN, command.phone) ||
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
    const verifiedAt = now();
    const settled = topups.settle({ orderId, kind, observed: result, occurredAt: verifiedAt });
    return outcome(orderId, settled.operation, observedAtMillis(result.observedAt, verifiedAt));
  }

  async function continueExisting({
    order, operation, command, masterKey,
  }: GrantContinueInput<DirectTopupOperation, DirectTopupCommand>): Promise<DirectTopupOutcome> {
    requireSameInput(operation, command, masterKey);
    if (isInFlight(operation, now())) {
      throw new DirectTopupInProgressError('原单仍在调用中');
    }
    if (operation.state === 'reserved' || operation.state === 'unknown' ||
        operation.state === 'retrying') {
      throw new DirectTopupUnknownError('原单结果待人工核实，禁止盲目重发');
    }
    return outcome(order.id, operation);
  }

  async function executeReserved({
    order, operation, command, productCode, client,
  }: GrantExecuteInput<DirectTopupOperation, DirectTopupCommand>): Promise<DirectTopupOutcome> {
    return callVendor(order.id, operation, command, productCode, client, 'grant');
  }

  const pipeline = createGrantPipeline<
    DirectTopupOperation,
    DirectTopupCommand,
    DirectTopupOutcome
  >(
    { db: deps.db, config: deps.config, repository: orders, now },
    {
      actionLabel: '发起 B 直充',
      requireFrozen: requireFrozenVerifiedB,
      findOperation: (orderId) => topups.get(orderId),
      preflight: async ({ command, client }) => requireLiveEligibility(client, command),
      reserve: ({ order, command, masterKey }) => {
        const reservation = topups.reserve({
          order,
          credentialId: command.applicationCredentialId,
          requestId: deriveGrantRequestId(B_MODE_DOMAIN, B_REQUEST_ID_PREFIX, order.id),
          refCode: command.refCode,
          phoneHmac: hashRecipientPhone(masterKey, B_MODE_DOMAIN, command.phone),
          paymentReference: command.paymentReference,
          occurredAt: now(),
        });
        return {
          created: reservation.created,
          order,
          operation: reservation.operation,
        };
      },
      continueExisting,
      execute: executeReserved,
    },
  );

  return {
    /** Initial B-mode request: never retried as a new vendor operation. */
    issue: (command: DirectTopupCommand) => pipeline.start(command),

    /** Explicit operator/business reissue ONLY after a verified partial result.
     * Unknown responses can never be blindly retried, even with the same id.
     */
    async reissue(command: DirectTopupCommand): Promise<DirectTopupOutcome> {
      const order = requireOwnedOrder(orders, command.businessSource, command.orderId);
      assertApplicationEntitlement(deps.db, command.businessSource, order.productId);
      const { productCode } = requireFrozenVerifiedB(order);
      const masterKey = requireSupplierMasterKey(deps.config);
      const client = requireYangmaoClient(deps.db, deps.config);
      const existing = topups.get(order.id);
      if (!existing) throw new DirectTopupConflictError('原单未创建 B 直充');
      requireSameInput(existing, command, masterKey);
      if (existing.state !== 'partial') {
        throw new DirectTopupConflictError('只能对有明确部分成功证据的原单补发');
      }
      // This is NOT a new purchase: it is the vendor-documented continuation
      // of an already checked and potentially charged requestId. A new
      // purchase-check could see unclaimed items from the very same partial
      // order and incorrectly block compensating their failed siblings.
      const lease = topups.beginReissue({
        order, credentialId: command.applicationCredentialId, occurredAt: now(),
      });
      return callVendor(order.id, lease, command, productCode, client, 'reissue');
    },

    /** Read from local persisted facts: never asks the provider to debit again. */
    get(businessSource: string, orderId: string): DirectTopupOutcome | null {
      requireOwnedOrder(orders, businessSource, orderId);
      const topup = topups.get(orderId);
      return topup ? outcome(orderId, topup) : null;
    },
  };
}
