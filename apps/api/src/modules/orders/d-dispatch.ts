import { YangmaoInriceError } from '@sanchuang-dev/provider-yangmao';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { logEvent } from '../../log.js';
import {
  normalizeBusinessOrderNo,
  OrderMappingUnavailableError,
  OrderNotFoundError,
  type BenefitOrder,
} from './benefit-orders.js';
import {
  deriveGrantRequestId,
  hashRecipientPhone,
  requireOwnedOrder,
  RESERVATION_IN_FLIGHT_MS,
} from './grant-mechanics.js';
import {
  createDDispatchRepository,
  DDispatchStateConflictError,
  type DDispatchOperation,
} from './d-dispatch-repository.js';
import { createBenefitOrderRepository } from './repository.js';
import {
  assertApplicationEntitlement,
  requireSupplierMasterKey,
  requireYangmaoInriceClient,
} from './supplier-access.js';

const D_MODE_DOMAIN = 'benefit-hub:d-dispatch';
const D_PARTNER_ORDER_PREFIX = 'bhD';

export class DDispatchWriteDisabledError extends Error {}
export class DDispatchModeUnsupportedError extends Error {}
export class DDispatchInputConflictError extends Error {}
export class DDispatchInProgressError extends Error {}
export class DDispatchNotRetryableError extends Error {}
export class DDispatchNotFoundError extends Error {}

export { DDispatchStateConflictError };

export interface DDispatchCommand {
  businessSource: string;
  applicationCredentialId?: string | null;
  orderId: string;
  mobile: string;
  paymentReference: string;
  signal?: AbortSignal;
}

export interface RecoverDDispatchCommand {
  businessSource: string;
  orderId: string;
  signal?: AbortSignal;
}

export interface DDispatchOutcome {
  order: BenefitOrder;
  dispatch: DDispatchOperation;
  observedAt?: number;
}

function isDefiniteDispatchRejection(error: unknown): boolean {
  if (!(error instanceof YangmaoInriceError)) return false;
  if (
    error.code === 'YANGMAO_INRICE_AUTH_FAILED' ||
    error.code === 'YANGMAO_INRICE_FORBIDDEN'
  ) {
    return true;
  }
  return (
    error.code === 'YANGMAO_INRICE_BUSINESS_FAILED' &&
    error.vendorCode !== undefined &&
    [400, 401, 403].includes(error.vendorCode)
  );
}

function observedAtMillis(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createDDispatchService(deps: {
  db: AppDatabase;
  config: AppConfig;
  now?: () => number;
}) {
  const orderRepository = createBenefitOrderRepository(deps.db);
  const dispatchRepository = createDDispatchRepository(deps.db);
  const now = deps.now ?? Date.now;

  function requireFrozenD(order: BenefitOrder): { productCode: string } {
    const detail = orderRepository.getForOperations(order.id);
    if (!detail) throw new OrderNotFoundError('订单不存在');
    const frozen = detail.frozenMapping;
    if (!frozen) {
      throw new OrderMappingUnavailableError('订单没有冻结的供应商映射，不能发起 D 派发');
    }
    if (
      frozen.provider !== 'yangmao' ||
      frozen.fulfillmentMode !== 'D' ||
      order.fulfillmentMode !== 'D' ||
      frozen.deductionUnit !== 'amount'
    ) {
      throw new DDispatchModeUnsupportedError(
        '该订单冻结的履约来源不是上力 D 金额派发',
      );
    }
    return { productCode: frozen.productCode };
  }

  function assertSameIntent(
    operation: DDispatchOperation,
    phoneHmac: string,
    paymentReference: string,
  ): void {
    if (
      operation.phoneHmac !== phoneHmac ||
      operation.paymentReference !== paymentReference
    ) {
      throw new DDispatchInputConflictError(
        '重复 D 派发与原始收件手机号或支付凭据不一致',
      );
    }
  }

  async function recoverExisting(
    order: BenefitOrder,
    operation: DDispatchOperation,
    signal: AbortSignal | undefined,
  ): Promise<DDispatchOutcome> {
    if (operation.state === 'rejected') {
      throw new DDispatchNotRetryableError('该 D 派发已被供应商明确拒绝');
    }
    if (
      operation.state === 'reserved' &&
      now() - operation.updatedAt < RESERVATION_IN_FLIGHT_MS
    ) {
      throw new DDispatchInProgressError('D 派发仍在请求窗口内，禁止并发查单或重发');
    }

    const client = requireYangmaoInriceClient(deps.db, deps.config);
    const attemptedAt = now();
    try {
      const lookup = await client.queryOrder(
        { partnerOrderNo: operation.partnerOrderNo },
        { signal },
      );
      const verifiedAt = now();
      const observedAt = observedAtMillis(lookup.observedAt, verifiedAt);
      const settled = dispatchRepository.settle({
        orderId: order.id,
        kind: 'recovery',
        state: 'accepted',
        upstreamOrderNo: lookup.orderNo,
        providerStatus: lookup.dispatchStatus,
        // A successful query proves the provider has the order, not that the
        // benefit is terminally delivered. Keep it processing until a verified
        // provider-state mapping exists.
        orderStatus: 'processing',
        result: 'accepted',
        occurredAt: verifiedAt,
        lastVerifiedAt: observedAt,
      });
      return { ...settled, observedAt };
    } catch (error) {
      try {
        dispatchRepository.settle({
          orderId: order.id,
          kind: 'recovery',
          state: operation.state === 'accepted' ? 'accepted' : 'unknown',
          orderStatus: operation.state === 'accepted' ? order.status : 'unknown',
          result: 'unknown',
          occurredAt: attemptedAt,
          lastVerifiedAt: null,
        });
      } catch (settleError) {
        logEvent('d_dispatch.recovery_settle_failed', {
          orderId: order.id,
          partnerOrderNo: operation.partnerOrderNo,
          name: settleError instanceof Error ? settleError.name : 'unknown',
        });
      }
      throw error;
    }
  }

  async function dispatch(command: DDispatchCommand): Promise<DDispatchOutcome> {
    const order = requireOwnedOrder(
      orderRepository,
      command.businessSource,
      command.orderId,
    );
    assertApplicationEntitlement(deps.db, command.businessSource, order.productId);
    const frozen = requireFrozenD(order);
    const masterKey = requireSupplierMasterKey(deps.config);
    const paymentReference = normalizeBusinessOrderNo(command.paymentReference);
    const phoneHmac = hashRecipientPhone(masterKey, D_MODE_DOMAIN, command.mobile);

    const existing = dispatchRepository.get(order.id);
    if (existing) {
      assertSameIntent(existing, phoneHmac, paymentReference);
      return recoverExisting(order, existing, command.signal);
    }

    if (!deps.config.dLiveWritesEnabled) {
      throw new DDispatchWriteDisabledError(
        'D 真实金额扣减未被维护者单独启用',
      );
    }

    // Resolve/validate the supplier configuration before persisting a billable
    // reservation. Once reserved, this method will never generate a replacement
    // partnerOrderNo even when the network result is lost.
    const client = requireYangmaoInriceClient(deps.db, deps.config);
    const partnerOrderNo = deriveGrantRequestId(
      D_MODE_DOMAIN,
      D_PARTNER_ORDER_PREFIX,
      order.id,
    );
    const reserved = dispatchRepository.reserve({
      orderId: order.id,
      applicationCredentialId: command.applicationCredentialId,
      expectedVersion: order.version,
      partnerOrderNo,
      phoneHmac,
      paymentReference,
      occurredAt: now(),
    });

    if (!reserved.created) {
      assertSameIntent(reserved.dispatch, phoneHmac, paymentReference);
      return recoverExisting(reserved.order, reserved.dispatch, command.signal);
    }

    try {
      const accepted = await client.dispatch(
        {
          partnerOrderNo,
          productCode: frozen.productCode,
          mobile: command.mobile,
        },
        { signal: command.signal },
      );
      const observedAt = observedAtMillis(accepted.observedAt, now());
      const settled = dispatchRepository.settle({
        orderId: order.id,
        kind: 'attempt',
        state: 'accepted',
        orderStatus: 'processing',
        result: 'accepted',
        occurredAt: observedAt,
        lastVerifiedAt: observedAt,
      });
      return { ...settled, observedAt };
    } catch (error) {
      const definiteRejection = isDefiniteDispatchRejection(error);
      const occurredAt = now();
      try {
        dispatchRepository.settle({
          orderId: order.id,
          kind: 'attempt',
          state: definiteRejection ? 'rejected' : 'unknown',
          orderStatus: definiteRejection ? 'failed' : 'unknown',
          result: definiteRejection ? 'rejected' : 'unknown',
          occurredAt,
          lastVerifiedAt: definiteRejection ? occurredAt : null,
        });
      } catch (settleError) {
        logEvent('d_dispatch.settle_failed', {
          orderId: order.id,
          partnerOrderNo,
          name: settleError instanceof Error ? settleError.name : 'unknown',
        });
      }
      throw error;
    }
  }

  async function recover(command: RecoverDDispatchCommand): Promise<DDispatchOutcome> {
    const order = requireOwnedOrder(
      orderRepository,
      command.businessSource,
      command.orderId,
    );
    assertApplicationEntitlement(deps.db, command.businessSource, order.productId);
    requireFrozenD(order);
    const operation = dispatchRepository.get(order.id);
    if (!operation) {
      throw new DDispatchNotFoundError('该订单尚未发起 D 派发');
    }
    return recoverExisting(order, operation, command.signal);
  }

  return { dispatch, recover };
}
