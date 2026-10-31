import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client.js';
import {
  benefitOrderDispatches,
  benefitOrders,
  benefitOrderStatusEvents,
  fulfillmentAttempts,
} from '../../db/schema.js';
import {
  normalizeBusinessOrderNo,
  normalizeUpstreamRef,
  OrderInputError,
  OrderNotFoundError,
  OrderNotGrantableError,
  OrderVersionConflictError,
  requireOrderId,
  requireTimestamp,
  toFulfillmentMode,
  toOrderStatus,
  type AttemptResult,
  type BenefitOrder,
  type OrderStatus,
} from './benefit-orders.js';
import { assertApplicationWriteAccess } from './repository.js';

export type DDispatchState = 'reserved' | 'accepted' | 'unknown' | 'rejected';

export interface DDispatchOperation {
  orderId: string;
  partnerOrderNo: string;
  state: DDispatchState;
  phoneHmac: string;
  paymentReference: string;
  upstreamOrderNo: string | null;
  providerStatus: string | null;
  lastVerifiedAt: number | null;
  attemptedAt: number;
  updatedAt: number;
}

export class DDispatchStateConflictError extends Error {}

export interface ReserveDDispatchInput {
  orderId: string;
  applicationCredentialId?: string | null;
  expectedVersion: number;
  partnerOrderNo: string;
  phoneHmac: string;
  paymentReference: string;
  occurredAt: number;
}

export interface SettleDDispatchInput {
  orderId: string;
  kind: 'attempt' | 'recovery';
  state: Exclude<DDispatchState, 'reserved'>;
  upstreamOrderNo?: string | null;
  providerStatus?: string | null;
  orderStatus: OrderStatus;
  result: AttemptResult;
  occurredAt: number;
  lastVerifiedAt: number | null;
}

interface OrderRow {
  id: string;
  businessSource: string;
  businessOrderNo: string;
  productId: string;
  fulfillmentMode: string;
  status: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  mappingVersionId: string | null;
}

interface DispatchRow {
  orderId: string;
  partnerOrderNo: string;
  state: string;
  phoneHmac: string;
  paymentReference: string;
  upstreamOrderNo: string | null;
  providerStatus: string | null;
  lastVerifiedAt: number | null;
  attemptedAt: number;
  updatedAt: number;
}

const PARTNER_ORDER_PATTERN = /^[!-~]{1,64}$/;
const PROVIDER_STATUS_PATTERN = /^.{1,128}$/u;

function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) return true;
  }
  return false;
}

function toOrder(row: OrderRow): BenefitOrder {
  return {
    id: row.id,
    businessSource: row.businessSource,
    businessOrderNo: row.businessOrderNo,
    productId: row.productId,
    fulfillmentMode: toFulfillmentMode(row.fulfillmentMode),
    status: toOrderStatus(row.status),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mappingVersionId: row.mappingVersionId,
  };
}

function toDispatch(row: DispatchRow): DDispatchOperation {
  if (!['reserved', 'accepted', 'unknown', 'rejected'].includes(row.state)) {
    throw new Error(`Unknown D dispatch state stored in database: ${row.state}`);
  }
  return { ...row, state: row.state as DDispatchState };
}

function normalizeProviderStatus(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (
    typeof raw !== 'string' ||
    !PROVIDER_STATUS_PATTERN.test(raw) ||
    containsControlCharacter(raw)
  ) {
    throw new OrderInputError('上游派发状态格式不正确');
  }
  return raw;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

export function createDDispatchRepository(db: AppDatabase) {
  function get(orderId: string): DDispatchOperation | null {
    const row = db
      .select()
      .from(benefitOrderDispatches)
      .where(eq(benefitOrderDispatches.orderId, requireOrderId(orderId)))
      .limit(1)
      .get();
    return row ? toDispatch(row) : null;
  }

  function reserve(input: ReserveDDispatchInput): {
    dispatch: DDispatchOperation;
    order: BenefitOrder;
    created: boolean;
  } {
    const orderId = requireOrderId(input.orderId);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new OrderInputError('订单版本号需为大于 0 的整数');
    }
    if (!PARTNER_ORDER_PATTERN.test(input.partnerOrderNo)) {
      throw new OrderInputError('D partnerOrderNo 需为 1-64 位可见 ASCII 字符');
    }
    if (!/^[0-9a-f]{64}$/.test(input.phoneHmac)) {
      throw new OrderInputError('手机号摘要格式不正确');
    }
    const paymentReference = normalizeBusinessOrderNo(input.paymentReference);
    const occurredAt = requireTimestamp(input.occurredAt, '发生时间');

    return db.transaction(
      (tx) => {
        const orderRow = tx
          .select()
          .from(benefitOrders)
          .where(eq(benefitOrders.id, orderId))
          .limit(1)
          .get();
        if (!orderRow) throw new OrderNotFoundError('订单不存在');

        assertApplicationWriteAccess(tx, {
          businessSource: orderRow.businessSource,
          productId: orderRow.productId,
          applicationCredentialId: input.applicationCredentialId,
        });

        const existing = tx
          .select()
          .from(benefitOrderDispatches)
          .where(eq(benefitOrderDispatches.orderId, orderId))
          .limit(1)
          .get();
        if (existing) {
          return { dispatch: toDispatch(existing), order: toOrder(orderRow), created: false };
        }

        if (orderRow.version !== input.expectedVersion) {
          throw new OrderVersionConflictError('订单版本已变化，未发起 D 派发');
        }
        if (orderRow.status !== 'pending') {
          throw new OrderNotGrantableError(
            `订单当前状态不允许发起 D 派发：${orderRow.status}`,
          );
        }

        const row: DispatchRow = {
          orderId,
          partnerOrderNo: input.partnerOrderNo,
          state: 'reserved',
          phoneHmac: input.phoneHmac,
          paymentReference,
          upstreamOrderNo: null,
          providerStatus: null,
          lastVerifiedAt: null,
          attemptedAt: occurredAt,
          updatedAt: occurredAt,
        };

        try {
          tx.insert(benefitOrderDispatches).values(row).run();
        } catch (error) {
          if (isUniqueViolation(error)) {
            const raced = tx
              .select()
              .from(benefitOrderDispatches)
              .where(eq(benefitOrderDispatches.orderId, orderId))
              .limit(1)
              .get();
            if (raced) {
              return { dispatch: toDispatch(raced), order: toOrder(orderRow), created: false };
            }
          }
          throw error;
        }

        const updated = tx
          .update(benefitOrders)
          .set({
            status: 'processing',
            version: input.expectedVersion + 1,
            updatedAt: occurredAt,
          })
          .where(
            and(
              eq(benefitOrders.id, orderId),
              eq(benefitOrders.version, input.expectedVersion),
            ),
          )
          .run();
        if (updated.changes !== 1) {
          throw new OrderVersionConflictError('订单版本已变化，未发起 D 派发');
        }

        tx.insert(benefitOrderStatusEvents)
          .values({
            id: randomUUID(),
            orderId,
            status: 'processing',
            version: input.expectedVersion + 1,
            createdAt: occurredAt,
          })
          .run();

        // Durable before-send evidence. A process death after this commit can
        // never be interpreted as permission to generate a new partnerOrderNo.
        tx.insert(fulfillmentAttempts)
          .values({
            id: randomUUID(),
            orderId,
            operation: 'grant',
            upstreamRequestNo: input.partnerOrderNo,
            upstreamOrderNo: null,
            result: 'unknown',
            observedStatus: 'processing',
            occurredAt,
            lastVerifiedAt: null,
          })
          .run();

        const refreshed = tx
          .select()
          .from(benefitOrders)
          .where(eq(benefitOrders.id, orderId))
          .limit(1)
          .get();
        if (!refreshed) throw new OrderNotFoundError('订单不存在');
        return { dispatch: toDispatch(row), order: toOrder(refreshed), created: true };
      },
      { behavior: 'immediate' },
    );
  }

  function settle(input: SettleDDispatchInput): {
    dispatch: DDispatchOperation;
    order: BenefitOrder;
  } {
    const orderId = requireOrderId(input.orderId);
    const occurredAt = requireTimestamp(input.occurredAt, '发生时间');
    const lastVerifiedAt =
      input.lastVerifiedAt === null
        ? null
        : requireTimestamp(input.lastVerifiedAt, '最近核实时间');
    const upstreamOrderNo = normalizeUpstreamRef(input.upstreamOrderNo, '上游订单号');
    const providerStatus = normalizeProviderStatus(input.providerStatus);

    return db.transaction(
      (tx) => {
        const orderRow = tx
          .select()
          .from(benefitOrders)
          .where(eq(benefitOrders.id, orderId))
          .limit(1)
          .get();
        if (!orderRow) throw new OrderNotFoundError('订单不存在');

        const dispatchRow = tx
          .select()
          .from(benefitOrderDispatches)
          .where(eq(benefitOrderDispatches.orderId, orderId))
          .limit(1)
          .get();
        if (!dispatchRow) throw new DDispatchStateConflictError('D 派发记录不存在');

        const current = toDispatch(dispatchRow);
        if (current.state === 'rejected' && input.state !== 'rejected') {
          throw new DDispatchStateConflictError('已拒绝的 D 派发不能改写');
        }
        if (input.kind === 'attempt' && current.state !== 'reserved') {
          throw new DDispatchStateConflictError('D 派发初始结果只能结算 reserved 记录');
        }
        if (
          current.state === 'accepted' &&
          input.state !== 'accepted'
        ) {
          throw new DDispatchStateConflictError('已受理的 D 派发不能降级');
        }

        const mergedUpstreamOrderNo = upstreamOrderNo ?? current.upstreamOrderNo;
        const mergedProviderStatus = providerStatus ?? current.providerStatus;
        const nextState =
          current.state === 'accepted' ? 'accepted' : input.state;

        tx.update(benefitOrderDispatches)
          .set({
            state: nextState,
            upstreamOrderNo: mergedUpstreamOrderNo,
            providerStatus: mergedProviderStatus,
            lastVerifiedAt,
            updatedAt: occurredAt,
          })
          .where(eq(benefitOrderDispatches.orderId, orderId))
          .run();

        let settledOrder = toOrder(orderRow);
        if (settledOrder.status !== input.orderStatus) {
          const nextVersion = settledOrder.version + 1;
          const changed = tx
            .update(benefitOrders)
            .set({
              status: input.orderStatus,
              version: nextVersion,
              updatedAt: occurredAt,
            })
            .where(
              and(
                eq(benefitOrders.id, orderId),
                eq(benefitOrders.version, settledOrder.version),
              ),
            )
            .run();
          if (changed.changes !== 1) {
            throw new OrderVersionConflictError('D 派发结算时订单状态已变化');
          }
          tx.insert(benefitOrderStatusEvents)
            .values({
              id: randomUUID(),
              orderId,
              status: input.orderStatus,
              version: nextVersion,
              createdAt: occurredAt,
            })
            .run();
          settledOrder = { ...settledOrder, status: input.orderStatus, version: nextVersion, updatedAt: occurredAt };
        }

        tx.insert(fulfillmentAttempts)
          .values({
            id: randomUUID(),
            orderId,
            operation: input.kind === 'recovery' ? 'query' : 'grant',
            upstreamRequestNo: current.partnerOrderNo,
            upstreamOrderNo: mergedUpstreamOrderNo,
            result: input.result,
            observedStatus: input.orderStatus,
            occurredAt,
            lastVerifiedAt,
          })
          .run();

        const refreshed = tx
          .select()
          .from(benefitOrderDispatches)
          .where(eq(benefitOrderDispatches.orderId, orderId))
          .limit(1)
          .get();
        if (!refreshed) throw new DDispatchStateConflictError('D 派发记录不存在');
        return { dispatch: toDispatch(refreshed), order: settledOrder };
      },
      { behavior: 'immediate' },
    );
  }

  return { get, reserve, settle };
}
