import {
  YangmaoOpenV1Error,
  type YangmaoOpenV1PurchaseReader,
} from '@sanchuang-dev/provider-yangmao';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { logEvent } from '../../log.js';
import {
  GrantInProgressError,
  GrantInputConflictError,
  GrantNotFoundError,
  GrantNotRetryableError,
  OrderMappingUnavailableError,
  OrderModeUnsupportedError,
  OrderNotFoundError,
  type BenefitOrder,
  type PrepaidOrderGrant,
} from './benefit-orders.js';
import {
  deriveGrantRequestId,
  hashRecipientPhone,
  isDefiniteRejection,
  observedAtMillis,
} from './grant-mechanics.js';
import {
  createGrantPipeline,
  isInFlight,
  type GrantContinueInput,
  type GrantExecuteInput,
} from './grant-pipeline.js';
import { createBenefitOrderRepository } from './repository.js';

const A_MODE_DOMAIN = 'benefit-hub:a-prepaid-grant';
const A_REQUEST_ID_PREFIX = 'bhA';

export class PurchaseNotEligibleError extends Error {}
export class PrepaidGrantWriteDisabledError extends Error {}

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
 * Steps 1, 3 (persistence) and 5 (ordering) live in the shared grant pipeline;
 * this module keeps only A-mode eligibility, frozen-mapping and outcome rules.
 */
export function createPrepaidGrantService(deps: {
  db: AppDatabase;
  config: AppConfig;
  now?: () => number;
}): PrepaidGrantService {
  const repository = createBenefitOrderRepository(deps.db);
  const now = deps.now ?? Date.now;

  function requireFrozenA(order: BenefitOrder): { productCode: string } {
    const detail = repository.getForOperations(order.id);
    if (!detail) throw new OrderNotFoundError('订单不存在');
    const frozen = detail.frozenMapping;
    if (!frozen) {
      throw new OrderMappingUnavailableError('订单没有冻结的供应商映射，不能发起上力下单');
    }
    if (
      frozen.provider !== 'yangmao' ||
      frozen.fulfillmentMode !== 'A' ||
      order.fulfillmentMode !== 'A'
    ) {
      throw new OrderModeUnsupportedError('该订单冻结的履约模式不是上力 A 预充值礼包');
    }
    return { productCode: frozen.productCode };
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

  async function continueExisting({
    order,
    operation: grant,
    command,
    masterKey,
    client,
  }: GrantContinueInput<PrepaidOrderGrant, GrantPrepaidOrderCommand>): Promise<PrepaidGrantOutcome> {
    const sameInput =
      grant.phoneHmac === hashRecipientPhone(masterKey, A_MODE_DOMAIN, command.phone) &&
      grant.refCode === command.refCode &&
      grant.paymentReference === command.paymentReference;
    if (!sameInput) {
      throw new GrantInputConflictError('相同订单的手机号、推广码或支付凭据与原下单记录不一致');
    }
    if (grant.state === 'rejected') {
      throw new GrantNotRetryableError('该订单已被上力明确拒绝，不会自动重试');
    }
    if (isInFlight(grant, now())) {
      throw new GrantInProgressError('该订单的上力下单仍在处理中，请稍后用同一订单取回结果');
    }
    return recoverGrant(order, grant, client, command.signal);
  }

  async function executeReserved({
    order,
    operation: grant,
    command,
    productCode,
    client,
  }: GrantExecuteInput<PrepaidOrderGrant, GrantPrepaidOrderCommand>): Promise<PrepaidGrantOutcome> {
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

  const pipeline = createGrantPipeline<
    PrepaidOrderGrant,
    GrantPrepaidOrderCommand,
    PrepaidGrantOutcome
  >(
    { db: deps.db, config: deps.config, repository, now },
    {
      actionLabel: '发起上力下单',
      requireFrozen: requireFrozenA,
      findOperation: (orderId) => repository.getGrant(orderId),
      preflight: async ({ command, client }) => {
        // Shipping code is not authorization to spend supplier pack quota.
        // Fail before even the read-only purchase-check while the A live gate is off.
        if (!deps.config.aLiveWritesEnabled) {
          throw new PrepaidGrantWriteDisabledError('A 真实礼包扣额未被维护者单独启用');
        }
        // A is paid, so the live purchase-check must pass before any local
        // reservation or supplier debit. A restricted phone must not be charged.
        const eligibility = await client.checkPurchase(command.phone, {
          signal: command.signal,
        });
        if (
          eligibility.purchaseRestricted ||
          eligibility.giftUnclaimed ||
          eligibility.lotteryUnbet
        ) {
          throw new PurchaseNotEligibleError(
            '该手机号当前存在限领或未领取权益，未发起上力下单',
          );
        }
      },
      reserve: ({ order, command, masterKey }) => {
        const reservation = repository.reserveGrant({
          orderId: order.id,
          applicationCredentialId: command.applicationCredentialId,
          expectedVersion: order.version,
          requestId: deriveGrantRequestId(A_MODE_DOMAIN, A_REQUEST_ID_PREFIX, order.id),
          refCode: command.refCode,
          phoneHmac: hashRecipientPhone(masterKey, A_MODE_DOMAIN, command.phone),
          paymentReference: command.paymentReference,
          occurredAt: now(),
        });
        return {
          created: reservation.created,
          order: reservation.order,
          operation: reservation.grant,
        };
      },
      continueExisting,
      execute: executeReserved,
      recovery: {
        recoverExisting: ({ order, operation, client, signal }) =>
          recoverGrant(order, operation, client, signal),
        operationNotFoundError: () => new GrantNotFoundError('该订单尚未发起过上力下单'),
        operationRejectedError: () =>
          new GrantNotRetryableError('该订单已被上力明确拒绝，没有可恢复的领取链接'),
        operationInFlightError: () =>
          new GrantInProgressError('该订单的上力下单仍在处理中，请稍后再取回领取链接'),
      },
    },
  );

  return {
    grant: (command) => pipeline.start(command),
    recover: (command) => pipeline.recover(command),
  };
}
