import { createHash, createHmac } from 'node:crypto';
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
  OrderNotGrantableError,
  type BenefitOrder,
} from './benefit-orders.js';
import { createBenefitOrderRepository, type GiftVoucherOperation } from './repository.js';
import {
  decryptGiftVoucherData,
  encryptGiftVoucherData,
  type GiftVoucherSecretData,
} from './gift-voucher-vault.js';
import {
  assertApplicationEntitlement,
  requireSupplierMasterKey,
  requireYangmaoClient,
} from './supplier-access.js';

/**
 * A durable reservation is considered in flight — and must not be raced by a
 * recovery read — for longer than the provider client's maximum request
 * timeout (60s). After that, a process crash or lost response is assumed.
 */
const RESERVATION_IN_FLIGHT_MS = 2 * 60 * 1000;
const REQUEST_ID_PREFIX = 'bhC';
const PHONE_HMAC_DOMAIN = 'benefit-hub:c-gift-voucher:phone:v1\n';

/**
 * C-mode `requestId` is derived from the immutable platform order id, never
 * from caller input and never regenerated per attempt. That makes any retry a
 * recovery of the same intent instead of a second `packCount` pre-deduction.
 */
export function deriveGiftVoucherRequestId(orderId: string): string {
  const digest = createHash('sha256')
    .update(`benefit-hub:c-gift-voucher:request:${orderId}`, 'utf8')
    .digest('hex');
  // 3 + 60 = 63 chars, within the vendor's documented 64-character bound.
  return `${REQUEST_ID_PREFIX}${digest.slice(0, 60)}`;
}

/**
 * Keyed, domain-separated digest of the recipient phone. The raw number is
 * never persisted; the digest only rejects a conflicting repeated issuance.
 */
export function hashGiftVoucherPhone(masterKey: Buffer, phone: string): string {
  const subkey = createHmac('sha256', masterKey)
    .update('benefit-hub:c-gift-voucher:phone-key:v1', 'utf8')
    .digest();
  return createHmac('sha256', subkey)
    .update(PHONE_HMAC_DOMAIN, 'utf8')
    .update(phone, 'utf8')
    .digest('hex');
}

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
 * investigation.
 */
export function createGiftVoucherService(deps: {
  db: AppDatabase;
  config: AppConfig;
  now?: () => number;
}): GiftVoucherService {
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
      // An issued voucher remains awaiting the recipient's claim, never
      // redeemed/completed by a read.
      orderStatus: 'awaiting_claim',
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

  async function resumeExisting(
    order: BenefitOrder,
    voucher: GiftVoucherOperation,
    command: IssueGiftVoucherCommand,
    masterKey: Buffer,
  ): Promise<GiftVoucherOutcome> {
    const commandPhoneHmac =
      command.phone === undefined ? null : hashGiftVoucherPhone(masterKey, command.phone);
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
    if (voucher.state === 'reserved' && now() - voucher.updatedAt < RESERVATION_IN_FLIGHT_MS) {
      throw new GiftVoucherInProgressError('该订单的上力发券仍在处理中，请稍后用同一订单核实');
    }
    // No issued code was persisted: the supplier may already have pre-deducted
    // quota, so the only safe answer is "unknown, investigate manually".
    throw new GiftVoucherOutcomeUnknownError(
      '该订单的发券结果未知且没有可恢复的券码，不能用新的 requestId 重发；请人工核实',
    );
  }

  async function executeReserved(
    order: BenefitOrder,
    voucher: GiftVoucherOperation,
    command: IssueGiftVoucherCommand,
    productCode: string,
    masterKey: Buffer,
    client: YangmaoOpenV1PurchaseReader,
  ): Promise<GiftVoucherOutcome> {
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

  return {
    async issue(command) {
      const order = requireOwnedOrder(command.businessSource, command.orderId);
      assertApplicationEntitlement(deps.db, command.businessSource, order.productId);
      const frozen = requireFrozenC(order);
      const masterKey = requireSupplierMasterKey(deps.config);
      const client = requireYangmaoClient(deps.db, deps.config);

      const existing = repository.getGiftVoucher(order.id);
      if (existing) {
        return resumeExisting(order, existing, command, masterKey);
      }

      if (order.status !== 'pending') {
        throw new OrderNotGrantableError(`订单当前状态不允许发起上力发券：${order.status}`);
      }

      const reservation = repository.reserveGiftVoucher({
        orderId: order.id,
        applicationCredentialId: command.applicationCredentialId,
        expectedVersion: order.version,
        requestId: deriveGiftVoucherRequestId(order.id),
        packCount: command.packCount,
        refCode: command.refCode,
        phoneHmac:
          command.phone === undefined ? null : hashGiftVoucherPhone(masterKey, command.phone),
        occurredAt: now(),
      });

      if (!reservation.created) {
        // A concurrent caller won the reservation. Never send a second issuance.
        return resumeExisting(reservation.order, reservation.voucher, command, masterKey);
      }

      return executeReserved(
        reservation.order,
        reservation.voucher,
        command,
        frozen.productCode,
        masterKey,
        client,
      );
    },

    async recover(command) {
      const order = requireOwnedOrder(command.businessSource, command.orderId);
      assertApplicationEntitlement(deps.db, command.businessSource, order.productId);
      requireFrozenC(order);
      const masterKey = requireSupplierMasterKey(deps.config);
      const client = requireYangmaoClient(deps.db, deps.config);

      const voucher = repository.getGiftVoucher(order.id);
      if (!voucher) throw new GiftVoucherNotFoundError('该订单尚未发起过上力发券');
      if (voucher.state === 'rejected') {
        throw new GiftVoucherNotRetryableError('该订单已被上力明确拒绝，没有可恢复的券码');
      }
      if (voucher.state === 'reserved' && now() - voucher.updatedAt < RESERVATION_IN_FLIGHT_MS) {
        throw new GiftVoucherInProgressError('该订单的上力发券仍在处理中，请稍后再核实');
      }
      const data = decryptIssued(masterKey, voucher);
      return recoverIssued(order, voucher, data, masterKey, client, command.signal);
    },
  };
}
