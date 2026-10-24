import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client.js';
import { benefitOrders, fulfillmentAttempts } from '../../db/schema.js';
import {
  assertAttemptOperation,
  assertAttemptResult,
  assertFulfillmentMode,
  assertOrderStatus,
  normalizeBusinessOrderNo,
  normalizeBusinessSource,
  normalizeUpstreamRef,
  OrderInputError,
  OrderIntentConflictError,
  OrderNotFoundError,
  OrderProductNotFoundError,
  OrderVersionConflictError,
  requireOrderId,
  requireProductId,
  requireTimestamp,
  toAttemptOperation,
  toAttemptResult,
  toFulfillmentMode,
  toOrderStatus,
  type AttemptOperation,
  type AttemptResult,
  type BenefitOrder,
  type FulfillmentAttempt,
  type FulfillmentMode,
  type OrderStatus,
} from './benefit-orders.js';

export interface CreateOrderIntentInput {
  businessSource: string;
  businessOrderNo: string;
  productId: string;
  fulfillmentMode: FulfillmentMode;
}

export interface CreateOrderIntentResult {
  order: BenefitOrder;
  /** False when the same business intent already existed and was replayed. */
  created: boolean;
}

export interface UpdateOrderStatusInput {
  orderId: string;
  expectedVersion: number;
  status: OrderStatus;
}

export interface AppendFulfillmentAttemptInput {
  orderId: string;
  operation: AttemptOperation;
  result: AttemptResult;
  upstreamRequestNo?: string | null;
  upstreamOrderNo?: string | null;
  observedStatus?: OrderStatus | null;
  occurredAt?: number;
  lastVerifiedAt?: number | null;
}

/**
 * Persistence boundary for benefit orders. Business code depends on this
 * interface rather than on Drizzle or SQLite, so supplier calls and future
 * storage changes stay outside the domain rules.
 *
 * Every method is a short local operation. The interface deliberately has no
 * "transaction handle" parameter: an external supplier HTTP call must never be
 * made while a local transaction is open.
 */
export interface BenefitOrderRepository {
  /**
   * Creates the order intent, or returns the existing order for the same
   * `businessSource + businessOrderNo`. Replaying equivalent key parameters is
   * idempotent; a different product or fulfillment mode for the same business
   * identity fails with `OrderIntentConflictError` instead of overwriting.
   *
   * Only referential integrity is checked here. Whether the product is enabled
   * or fulfils the requested mode belongs to the later grant slice, not to
   * intent persistence.
   */
  createOrGetIntent(input: CreateOrderIntentInput): CreateOrderIntentResult;
  getById(orderId: string): BenefitOrder | null;
  findByIdentity(businessSource: string, businessOrderNo: string): BenefitOrder | null;
  /**
   * Optimistic status change; a stale `expectedVersion` fails stably.
   *
   * This slice guarantees atomic versioning only. Mode-specific transition
   * rules are intentionally not invented here; they are frozen per A/B/C/D by
   * later implementation work.
   */
  updateStatus(input: UpdateOrderStatusInput): BenefitOrder;
  appendAttempt(input: AppendFulfillmentAttemptInput): FulfillmentAttempt;
  listAttempts(orderId: string): FulfillmentAttempt[];
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
}

interface AttemptRow {
  id: string;
  orderId: string;
  operation: string;
  upstreamRequestNo: string | null;
  upstreamOrderNo: string | null;
  result: string;
  observedStatus: string | null;
  occurredAt: number;
  lastVerifiedAt: number | null;
}

function toBenefitOrder(row: OrderRow): BenefitOrder {
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
  };
}

function toFulfillmentAttempt(row: AttemptRow): FulfillmentAttempt {
  return {
    id: row.id,
    orderId: row.orderId,
    operation: toAttemptOperation(row.operation),
    upstreamRequestNo: row.upstreamRequestNo,
    upstreamOrderNo: row.upstreamOrderNo,
    result: toAttemptResult(row.result),
    observedStatus: row.observedStatus === null ? null : toOrderStatus(row.observedStatus),
    occurredAt: row.occurredAt,
    lastVerifiedAt: row.lastVerifiedAt,
  };
}

function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('FOREIGN KEY constraint failed');
}

export function createBenefitOrderRepository(db: AppDatabase): BenefitOrderRepository {
  return {
    createOrGetIntent(input) {
      const businessSource = normalizeBusinessSource(input.businessSource);
      const businessOrderNo = normalizeBusinessOrderNo(input.businessOrderNo);
      const productId = requireProductId(input.productId);
      const fulfillmentMode = assertFulfillmentMode(input.fulfillmentMode);
      const now = Date.now();

      const row: OrderRow = {
        id: randomUUID(),
        businessSource,
        businessOrderNo,
        productId,
        fulfillmentMode,
        status: 'pending',
        version: 1,
        createdAt: now,
        updatedAt: now,
      };

      // `ON CONFLICT DO NOTHING` is the idempotency decision point: the unique
      // index serializes concurrent writers, so only one row can ever exist.
      let inserted;
      try {
        inserted = db
          .insert(benefitOrders)
          .values(row)
          .onConflictDoNothing({
            target: [benefitOrders.businessSource, benefitOrders.businessOrderNo],
          })
          .run();
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw new OrderProductNotFoundError(`内部商品不存在：${productId}`);
        }
        throw error;
      }

      if (inserted.changes > 0) return { order: toBenefitOrder(row), created: true };

      const existing = db
        .select()
        .from(benefitOrders)
        .where(
          and(
            eq(benefitOrders.businessSource, businessSource),
            eq(benefitOrders.businessOrderNo, businessOrderNo),
          ),
        )
        .limit(1)
        .get();
      if (!existing) {
        // Orders are never deleted in this slice, so a conflicting insert must
        // be readable afterwards. Treat anything else as a real failure.
        throw new Error('Benefit order conflict could not be resolved');
      }

      const order = toBenefitOrder(existing);
      if (order.productId !== productId || order.fulfillmentMode !== fulfillmentMode) {
        throw new OrderIntentConflictError(
          `业务单号 ${businessSource}/${businessOrderNo} 已存在且关键参数不同，未覆盖已有订单`,
        );
      }
      return { order, created: false };
    },

    getById(orderId) {
      const row = db
        .select()
        .from(benefitOrders)
        .where(eq(benefitOrders.id, requireOrderId(orderId)))
        .limit(1)
        .get();
      return row ? toBenefitOrder(row) : null;
    },

    findByIdentity(businessSource, businessOrderNo) {
      const row = db
        .select()
        .from(benefitOrders)
        .where(
          and(
            eq(benefitOrders.businessSource, normalizeBusinessSource(businessSource)),
            eq(benefitOrders.businessOrderNo, normalizeBusinessOrderNo(businessOrderNo)),
          ),
        )
        .limit(1)
        .get();
      return row ? toBenefitOrder(row) : null;
    },

    updateStatus(input) {
      const orderId = requireOrderId(input.orderId);
      const status = assertOrderStatus(input.status);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new OrderInputError('订单版本号需为大于 0 的整数');
      }

      const now = Date.now();
      return db.transaction((tx) => {
        const updated = tx
          .update(benefitOrders)
          .set({ status, version: input.expectedVersion + 1, updatedAt: now })
          .where(
            and(eq(benefitOrders.id, orderId), eq(benefitOrders.version, input.expectedVersion)),
          )
          .run();

        if (updated.changes === 0) {
          const current = tx
            .select({ version: benefitOrders.version })
            .from(benefitOrders)
            .where(eq(benefitOrders.id, orderId))
            .limit(1)
            .get();
          if (!current) throw new OrderNotFoundError(`订单不存在：${orderId}`);
          throw new OrderVersionConflictError(
            `订单版本已变化（当前版本 ${current.version}，提交版本 ${input.expectedVersion}）`,
          );
        }

        const row = tx
          .select()
          .from(benefitOrders)
          .where(eq(benefitOrders.id, orderId))
          .limit(1)
          .get();
        if (!row) throw new OrderNotFoundError(`订单不存在：${orderId}`);
        return toBenefitOrder(row);
      });
    },

    appendAttempt(input) {
      const orderId = requireOrderId(input.orderId);
      const operation = assertAttemptOperation(input.operation);
      const result = assertAttemptResult(input.result);
      const observedStatus =
        input.observedStatus === null || input.observedStatus === undefined
          ? null
          : assertOrderStatus(input.observedStatus);
      const occurredAt = requireTimestamp(input.occurredAt ?? Date.now(), '发生时间');
      const lastVerifiedAt =
        input.lastVerifiedAt === null || input.lastVerifiedAt === undefined
          ? null
          : requireTimestamp(input.lastVerifiedAt, '最近核实时间');

      const row: AttemptRow = {
        id: randomUUID(),
        orderId,
        operation,
        upstreamRequestNo: normalizeUpstreamRef(input.upstreamRequestNo, '上游请求号'),
        upstreamOrderNo: normalizeUpstreamRef(input.upstreamOrderNo, '上游订单号'),
        result,
        observedStatus,
        occurredAt,
        lastVerifiedAt,
      };

      try {
        db.insert(fulfillmentAttempts).values(row).run();
      } catch (error) {
        if (isForeignKeyViolation(error)) throw new OrderNotFoundError(`订单不存在：${orderId}`);
        throw error;
      }
      return toFulfillmentAttempt(row);
    },

    listAttempts(orderId) {
      const rows = db
        .select()
        .from(fulfillmentAttempts)
        .where(eq(fulfillmentAttempts.orderId, requireOrderId(orderId)))
        .orderBy(asc(fulfillmentAttempts.occurredAt), asc(fulfillmentAttempts.id))
        .all();
      return rows.map(toFulfillmentAttempt);
    },
  };
}
