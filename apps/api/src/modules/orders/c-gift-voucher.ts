import {
  YangmaoOpenV1Error,
  type YangmaoOpenV1PurchaseReader,
} from '@sanchuang-dev/provider-yangmao';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { logEvent } from '../../log.js';
import {
  GiftVoucherInProgressError,
  GiftVoucherInputConflictError,
  GiftVoucherModeUnsupportedError,
  GiftVoucherNotFoundError,
  GiftVoucherNotRetryableError,
  GiftVoucherOutcomeUnknownError,
  OrderMappingUnavailableError,
  OrderNotFoundError,
  type BenefitOrder,
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
import { createBenefitOrderRepository, type GiftVoucherOperation } from './repository.js';
import {
  decryptGiftVoucherData,
  encryptGiftVoucherData,
  type GiftVoucherSecretData,
} from './gift-voucher-vault.js';

const C_MODE_DOMAIN = 'benefit-hub:c-gift-voucher';
const C_REQUEST_ID_PREFIX = 'bhC';

export interface GiftVoucherOutcome {
  order: BenefitOrder;
  voucher: GiftVoucherOperation;
  /** Present only when the supplier issued (or recovery re-read) the code. */
  voucherCode?: string;
  claimUrl?: string;
  expiresAt?: string | number;
  packTotal?: number;
  packRemaining?: number;
  balanceAfter?: number;
  idempotentReplay?: boolean;
  observedAt?: number;
}

export interface IssueGiftVoucherCommand {
  businessSource: string;
  /** Authenticated DB-issued machine credential, never accepted from the request body. */
  applicationCredentialId?: string | null;
  orderId: string;
  packCount: number;
  refCode: string;
  /** Optional; when absent the recipient binds a phone in the H5 page. */
  phone?: string;
  signal?: AbortSignal;
}

export interface RecoverGiftVoucherCommand {
  businessSource: string;
  orderId: string;
  signal?: AbortSignal;
}

export interface GiftVoucherService {
  issue(command: IssueGiftVoucherCommand): Promise<GiftVoucherOutcome>;
  recover(command: RecoverGiftVoucherCommand): Promise<GiftVoucherOutcome>;
}

/**
 * C-mode free gift-voucher issuance (BHB-012-E).
 *
 * C is free to the recipient, so there is deliberately no payment assertion or
 * purchase-eligibility gate. The sequence is:
 * 1. verify order ownership, frozen C mapping and application entitlement;
 * 2. persist a durable reservation plus a pre-send `unknown` attempt;
 * 3. perform exactly one signed supplier POST with no local transaction open;
 * 4. settle the observed result as `issued` / `rejected` / `unknown`.
 *
 * An unknown outcome is never re-signed with a new requestId. Because the
 * vendor exposes no read-by-requestId recovery for C, only the stored issued
 * code can be re-read; without it the operation stays unknown for authorized
 * investigation. Steps 1, 2 (persistence) and 4 (ordering) live in the shared
 * grant pipeline; this module keeps only C-mode frozen-mapping, vault and
 * outcome rules.
 */
export function createGiftVoucherService(deps: {
  db: AppDatabase;
  config: AppConfig;
  now?: () => number;
}): GiftVoucherService {
  const repository = createBenefitOrderRepository(deps.db);
  const now = deps.now ?? Date.now;

  function requireFrozenC(order: BenefitOrder): { productCode: string } {
    const detail = repository.getForOperations(order.id);
    if (!detail) throw new OrderNotFoundError('订单不存在');
    const frozen = detail.frozenMapping;
    if (!frozen) {
      throw new OrderMappingUnavailableError('订单没有冻结的供应商映射，不能发起上力发券');
    }
    if (
      frozen.provider !== 'yangmao' ||
      frozen.fulfillmentMode !== 'C' ||
      order.fulfillmentMode !== 'C'
    ) {
      throw new GiftVoucherModeUnsupportedError('该订单冻结的履约模式不是上力 C 公众号礼包券');
    }
    return { productCode: frozen.productCode };
  }

  function settleFailure(
    order: BenefitOrder,
    voucher: GiftVoucherOperation,
    definiteRejection: boolean,
    occurredAt: number,
  ): void {
    try {
      repository.settleGiftVoucher({
        orderId: order.id,
        expectedVersion: order.version,
        kind: 'attempt',
        state: definiteRejection ? 'rejected' : 'unknown',
        orderStatus: definiteRejection ? 'failed' : 'unknown',
        operation: 'grant',
        result: definiteRejection ? 'rejected' : 'unknown',
        occurredAt,
        lastVerifiedAt: definiteRejection ? occurredAt : null,
      });
    } catch (error) {
      // The durable reservation remains, so the outcome stays unknown. Record
      // that settlement failed without hiding the original supplier failure.
      logEvent('gift_voucher.settle_failed', {
        orderId: order.id,
        requestId: voucher.requestId,
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  function decryptIssued(
    masterKey: Buffer,
    voucher: GiftVoucherOperation,
  ): GiftVoucherSecretData {
    if (voucher.encryptedVoucher === null) {
      throw new GiftVoucherOutcomeUnknownError(
        '该订单的发券结果未知，且没有可恢复的券码；请用已记录的上游请求号人工核实',
      );
    }
    return decryptGiftVoucherData(masterKey, voucher.encryptedVoucher);
  }

  function toStoredOutcome(
    order: BenefitOrder,
    voucher: GiftVoucherOperation,
    data: GiftVoucherSecretData,
  ): GiftVoucherOutcome {
    return {
      order,
      voucher,
      voucherCode: data.voucherCode,
      claimUrl: data.claimUrl,
      ...(data.expiresAt === undefined ? {} : { expiresAt: data.expiresAt }),
      ...(voucher.packTotal === null ? {} : { packTotal: voucher.packTotal }),
      ...(voucher.packRemaining === null
        ? {}
        : { packRemaining: voucher.packRemaining }),
      ...(voucher.lastObservedAt === null ? {} : { observedAt: voucher.lastObservedAt }),
    };
  }

  async function recoverIssued(
    order: BenefitOrder,
    voucher: GiftVoucherOperation,
    data: GiftVoucherSecretData,
    masterKey: Buffer,
    client: YangmaoOpenV1PurchaseReader,
    signal: AbortSignal | undefined,
  ): Promise<GiftVoucherOutcome> {
    const attemptedAt = now();
    let lookup;
    try {
      // The vendor signs/queries the uppercase issued code as documented.
      lookup = await client.queryGiftVoucher(data.voucherCode.toUpperCase(), { signal });
      // A lookup may omit one quota field. Reconcile it against the last
      // persisted observation and reject an impossible combined balance. A
      // malformed read is never allowed to overwrite a valid issued fact.
      const observedTotal = lookup.packTotal ?? voucher.packTotal;
      const observedRemaining = lookup.packRemaining ?? voucher.packRemaining;
      if (
        observedTotal !== null &&
        observedRemaining !== null &&
        observedRemaining > observedTotal
      ) {
        throw new YangmaoOpenV1Error('YANGMAO_OPEN_V1_RESPONSE_INVALID');
      }
    } catch (error) {
      const definiteRejection = isDefiniteRejection(error);
      try {
        repository.settleGiftVoucher({
          orderId: order.id,
          expectedVersion: order.version,
          kind: 'recovery',
          // A failed read never turns an issuance into a failure; it only
          // records that this observation did not verify anything new.
          state: 'unknown',
          orderStatus: order.status,
          operation: 'query',
          result: definiteRejection ? 'rejected' : 'unknown',
          occurredAt: attemptedAt,
          lastVerifiedAt: definiteRejection ? attemptedAt : null,
        });
      } catch (settleError) {
        logEvent('gift_voucher.recovery_settle_failed', {
          orderId: order.id,
          requestId: voucher.requestId,
          name: settleError instanceof Error ? settleError.name : 'unknown',
        });
      }
      throw error;
    }

    const verifiedAt = now();
    const observedAt = observedAtMillis(lookup.observedAt, verifiedAt);
    const merged: GiftVoucherSecretData = {
      voucherCode: data.voucherCode,
      // A query may omit the link; never discard a previously stored one.
      claimUrl: lookup.claimUrl ?? data.claimUrl,
      ...(lookup.expiresAt === undefined
        ? data.expiresAt === undefined ? {} : { expiresAt: data.expiresAt }
        : { expiresAt: lookup.expiresAt }),
    };

    const settled = repository.settleGiftVoucher({
      orderId: order.id,
      expectedVersion: order.version,
      kind: 'recovery',
      state: 'issued',
      encryptedVoucher: encryptGiftVoucherData(masterKey, merged),
      ...(lookup.packTotal === undefined ? {} : { packTotal: lookup.packTotal }),
      ...(lookup.packRemaining === undefined
        ? {}
        : { packRemaining: lookup.packRemaining }),
      lastObservedAt: observedAt,
      // A supplier quota read is not evidence that a previously recorded
      // partial/full claim was reversed. Only unresolved local states may
      // advance to awaiting_claim; terminal fulfillment facts remain intact.
      orderStatus:
        order.status === 'processing' || order.status === 'unknown'
          ? 'awaiting_claim'
          : order.status,
      operation: 'query',
      result: 'accepted',
      occurredAt: verifiedAt,
      lastVerifiedAt: verifiedAt,
    });
    return {
      order: settled.order,
      voucher: settled.voucher,
      voucherCode: merged.voucherCode,
      claimUrl: merged.claimUrl,
      ...(merged.expiresAt === undefined ? {} : { expiresAt: merged.expiresAt }),
      ...(lookup.packTotal === undefined
        ? settled.voucher.packTotal === null ? {} : { packTotal: settled.voucher.packTotal }
        : { packTotal: lookup.packTotal }),
      ...(lookup.packRemaining === undefined
        ? settled.voucher.packRemaining === null
          ? {}
          : { packRemaining: settled.voucher.packRemaining }
        : { packRemaining: lookup.packRemaining }),
      observedAt,
    };
  }

  async function continueExisting({
    order,
    operation: voucher,
    command,
    masterKey,
  }: GrantContinueInput<GiftVoucherOperation, IssueGiftVoucherCommand>): Promise<GiftVoucherOutcome> {
    const commandPhoneHmac =
      command.phone === undefined
        ? null
        : hashRecipientPhone(masterKey, C_MODE_DOMAIN, command.phone);
    const sameInput =
      voucher.packCount === command.packCount &&
      voucher.refCode === command.refCode &&
      voucher.phoneHmac === commandPhoneHmac;
    if (!sameInput) {
      throw new GiftVoucherInputConflictError(
        '相同订单的礼包个数、推广码或收件手机号与原发券记录不一致',
      );
    }
    if (voucher.state === 'rejected') {
      throw new GiftVoucherNotRetryableError('该订单已被上力明确拒绝，不会自动重试');
    }
    if (voucher.state === 'issued') {
      return toStoredOutcome(order, voucher, decryptIssued(masterKey, voucher));
    }
    if (isInFlight(voucher, now())) {
      throw new GiftVoucherInProgressError('该订单的上力发券仍在处理中，请稍后用同一订单核实');
    }
    // No issued code was persisted: the supplier may already have pre-deducted
    // quota, so the only safe answer is "unknown, investigate manually".
    throw new GiftVoucherOutcomeUnknownError(
      '该订单的发券结果未知且没有可恢复的券码，不能用新的 requestId 重发；请人工核实',
    );
  }

  async function executeReserved({
    order,
    operation: voucher,
    command,
    productCode,
    masterKey,
    client,
  }: GrantExecuteInput<GiftVoucherOperation, IssueGiftVoucherCommand>): Promise<GiftVoucherOutcome> {
    let result;
    try {
      result = await client.createGiftVoucher(
        {
          refCode: command.refCode,
          packCount: command.packCount,
          requestId: voucher.requestId,
          ...(command.phone === undefined ? {} : { phone: command.phone }),
          productCode,
        },
        { signal: command.signal },
      );
    } catch (error) {
      // No transaction is open here and the reservation already exists. Only an
      // explicit vendor refusal is terminal; everything else stays unknown and
      // must never trigger a second signed issuance.
      settleFailure(order, voucher, isDefiniteRejection(error), now());
      throw error;
    }

    const verifiedAt = now();
    const observedAt = observedAtMillis(result.observedAt, verifiedAt);
    const secret: GiftVoucherSecretData = {
      voucherCode: result.voucherCode,
      claimUrl: result.claimUrl,
      ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
    };
    const settled = repository.settleGiftVoucher({
      orderId: order.id,
      expectedVersion: order.version,
      kind: 'attempt',
      state: 'issued',
      encryptedVoucher: encryptGiftVoucherData(masterKey, secret),
      ...(result.packTotal === undefined ? {} : { packTotal: result.packTotal }),
      ...(result.packRemaining === undefined
        ? {}
        : { packRemaining: result.packRemaining }),
      lastObservedAt: observedAt,
      // Issued and awaiting claim; never `completed` from a successful POST.
      orderStatus: 'awaiting_claim',
      operation: 'grant',
      result: 'accepted',
      occurredAt: verifiedAt,
      lastVerifiedAt: verifiedAt,
    });

    return {
      order: settled.order,
      voucher: settled.voucher,
      voucherCode: result.voucherCode,
      claimUrl: result.claimUrl,
      ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
      ...(result.packTotal === undefined ? {} : { packTotal: result.packTotal }),
      ...(result.packRemaining === undefined ? {} : { packRemaining: result.packRemaining }),
      ...(result.balanceAfter === undefined ? {} : { balanceAfter: result.balanceAfter }),
      ...(result.idempotentReplay === undefined
        ? {}
        : { idempotentReplay: result.idempotentReplay }),
      observedAt,
    };
  }

  const pipeline = createGrantPipeline<
    GiftVoucherOperation,
    IssueGiftVoucherCommand,
    GiftVoucherOutcome
  >(
    { db: deps.db, config: deps.config, repository, now },
    {
      actionLabel: '发起上力发券',
      requireFrozen: requireFrozenC,
      findOperation: (orderId) => repository.getGiftVoucher(orderId),
      reserve: ({ order, command, masterKey }) => {
        const reservation = repository.reserveGiftVoucher({
          orderId: order.id,
          applicationCredentialId: command.applicationCredentialId,
          expectedVersion: order.version,
          requestId: deriveGrantRequestId(C_MODE_DOMAIN, C_REQUEST_ID_PREFIX, order.id),
          packCount: command.packCount,
          refCode: command.refCode,
          phoneHmac:
            command.phone === undefined
              ? null
              : hashRecipientPhone(masterKey, C_MODE_DOMAIN, command.phone),
          occurredAt: now(),
        });
        return {
          created: reservation.created,
          order: reservation.order,
          operation: reservation.voucher,
        };
      },
      continueExisting,
      execute: executeReserved,
      recovery: {
        recoverExisting: ({ order, operation, masterKey, client, signal }) => {
          const data = decryptIssued(masterKey, operation);
          return recoverIssued(order, operation, data, masterKey, client, signal);
        },
        operationNotFoundError: () =>
          new GiftVoucherNotFoundError('该订单尚未发起过上力发券'),
        operationRejectedError: () =>
          new GiftVoucherNotRetryableError('该订单已被上力明确拒绝，没有可恢复的券码'),
        operationInFlightError: () =>
          new GiftVoucherInProgressError('该订单的上力发券仍在处理中，请稍后再核实'),
      },
    },
  );

  return {
    issue: (command) => pipeline.start(command),
    recover: (command) => pipeline.recover(command),
  };
}
