import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client.js';
import {
  benefitOrders,
  benefitOrderStatusEvents,
  catalogProducts,
  fulfillmentAttempts,
  supplierProductMappingVersions,
  supplierProductMappings,
} from '../../db/schema.js';
import {
  assertAttemptOperation,
  assertAttemptResult,
  assertOrderStatus,
  normalizeBusinessOrderNo,
  normalizeBusinessSource,
  normalizeUpstreamRef,
  OrderInputError,
  OrderIntentConflictError,
  OrderMappingUnavailableError,
  OrderNotFoundError,
  OrderProductDisabledError,
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
  type OrderStatus,
  type OrderStatusEvent,
} from './benefit-orders.js';

/**
 * Callers supply only the business identity and internal product. Fulfillment
 * mode is not a caller choice: a genuinely new order copies it from the
 * product's active immutable mapping snapshot, so it cannot disagree with the
 * frozen `mappingVersionId`.
 */
export interface CreateOrderIntentInput {
  businessSource: string;
  businessOrderNo: string;
  productId: string;
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
   * `businessSource + businessOrderNo`.
   *
   * An equivalent replay is resolved **before** any current product or mapping
   * eligibility check: a later product disable or mapping rotation must never
   * invalidate or rebind an order that already exists. A different product for
   * the same business identity fails with `OrderIntentConflictError`.
   *
   * A genuinely new order requires an existing `active` internal product and
   * copies `productId`, `fulfillmentMode` and `mappingVersionId` from that
   * product's current active mapping snapshot. Reading that snapshot and
   * inserting the order plus its initial status fact happen in one short
   * IMMEDIATE transaction, so a concurrent BHB-007 activation either completes
   * before or after the order and can never leave a mixed/stale binding.
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
  listStatusEvents(orderId: string): OrderStatusEvent[];
  appendAttempt(input: AppendFulfillmentAttemptInput): FulfillmentAttempt;
  listAttempts(orderId: string): FulfillmentAttempt[];
}

interface OrderRow {
  id: string;
  businessSource: string;
  businessOrderNo: string;
  productId: string;
  mappingVersionId: string | null;
  fulfillmentMode: string;
  status: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

interface StatusEventRow {
  id: string;
  orderId: string;
  status: string;
  version: number;
  createdAt: number;
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
    mappingVersionId: row.mappingVersionId,
    fulfillmentMode: toFulfillmentMode(row.fulfillmentMode),
    status: toOrderStatus(row.status),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toOrderStatusEvent(row: StatusEventRow): OrderStatusEvent {
  return {
    id: row.id,
    orderId: row.orderId,
    status: toOrderStatus(row.status),
    version: row.version,
    createdAt: row.createdAt,
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
      const now = Date.now();

      // IMMEDIATE serializes this read-then-write unit against BHB-007's
      // activation transaction. Everything the new order freezes is read from
      // the same committed state that the INSERT then persists.
      return db.transaction(
        (tx) => {
          // Replay before eligibility: an existing equivalent intent keeps its
          // original order and mapping version even if the product was disabled
          // or the active mapping rotated afterwards.
          const existing = tx
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

          if (existing) {
            const order = toBenefitOrder(existing);
            if (order.productId !== productId) {
              throw new OrderIntentConflictError(
                `业务单号 ${businessSource}/${businessOrderNo} 已存在且商品不同，未覆盖已有订单`,
              );
            }
            return { order, created: false };
          }

          const product = tx
            .select({ status: catalogProducts.status })
            .from(catalogProducts)
            .where(eq(catalogProducts.id, productId))
            .limit(1)
            .get();
          if (!product) throw new OrderProductNotFoundError(`内部商品不存在：${productId}`);
          if (product.status !== 'active') {
            throw new OrderProductDisabledError(`内部商品已停用，不能创建新订单：${productId}`);
          }

          const active = tx
            .select({
              id: supplierProductMappingVersions.id,
              fulfillmentMode: supplierProductMappingVersions.fulfillmentMode,
            })
            .from(supplierProductMappings)
            .innerJoin(
              supplierProductMappingVersions,
              and(
                eq(supplierProductMappingVersions.id, supplierProductMappings.activeVersionId),
                eq(
                  supplierProductMappingVersions.mappingId,
                  supplierProductMappings.id,
                ),
              ),
            )
            .where(eq(supplierProductMappings.productId, productId))
            .limit(1)
            .get();
          if (!active) {
            throw new OrderMappingUnavailableError(
              `内部商品缺少当前生效的供应商映射版本：${productId}`,
            );
          }

          const row: OrderRow = {
            id: randomUUID(),
            businessSource,
            businessOrderNo,
            productId,
            mappingVersionId: active.id,
            fulfillmentMode: active.fulfillmentMode,
            status: 'pending',
            version: 1,
            createdAt: now,
            updatedAt: now,
          };

          // The unique business-identity index and the migration 0005 triggers
          // are the final guards: this transaction can only create one order,
          // and the row can only reference the active same-product snapshot.
          tx.insert(benefitOrders).values(row).run();
          tx.insert(benefitOrderStatusEvents)
            .values({
              id: randomUUID(),
              orderId: row.id,
              status: row.status,
              version: row.version,
              createdAt: now,
            })
            .run();

          return { order: toBenefitOrder(row), created: true };
        },
        { behavior: 'immediate' },
      );
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

        tx.insert(benefitOrderStatusEvents)
          .values({
            id: randomUUID(),
            orderId,
            status,
            version: input.expectedVersion + 1,
            createdAt: now,
          })
          .run();

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

    listStatusEvents(orderId) {
      const rows = db
        .select()
        .from(benefitOrderStatusEvents)
        .where(eq(benefitOrderStatusEvents.orderId, requireOrderId(orderId)))
        .orderBy(asc(benefitOrderStatusEvents.version))
        .all();
      return rows.map(toOrderStatusEvent);
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
