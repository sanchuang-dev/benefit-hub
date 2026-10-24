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
  OrderProductNotFoundError,
  OrderProductNotActiveError,
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
 * Callers supply only the upstream business identity and our internal product.
 * The fulfilment mode is never chosen here: it is frozen from the product's
 * current active mapping snapshot at creation time.
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
   * `businessSource + businessOrderNo`. Replaying equivalent key parameters is
   * idempotent; a different product for the same business identity fails with
   * `OrderIntentConflictError` instead of overwriting.
   *
   * A genuinely new order freezes the product's current active mapping version
   * and copies its fulfilment mode, so later mapping rotation or product
   * disable cannot rewrite history. New orders therefore require an `active`
   * product with a current active mapping version; a matching replay bypasses
   * those current-state checks and keeps returning the original order.
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

/**
 * Replay decision for an already stored business identity. Current eligibility
 * is deliberately not re-checked: an order that exists must keep returning its
 * original product and frozen mapping version even after the product is
 * disabled or the mapping has rotated to a newer version.
 */
function replayExistingOrder(
  existing: BenefitOrder,
  productId: string,
  businessSource: string,
  businessOrderNo: string,
): BenefitOrder {
  if (existing.productId !== productId) {
    throw new OrderIntentConflictError(
      `业务单号 ${businessSource}/${businessOrderNo} 已存在且内部商品不同，未覆盖已有订单`,
    );
  }
  return existing;
}

export function createBenefitOrderRepository(db: AppDatabase): BenefitOrderRepository {
  return {
    createOrGetIntent(input) {
      const businessSource = normalizeBusinessSource(input.businessSource);
      const businessOrderNo = normalizeBusinessOrderNo(input.businessOrderNo);
      const productId = requireProductId(input.productId);

      // `immediate` takes SQLite's write lock before the active-version read.
      // BHB-007 activation transactions use the same mode, so the frozen
      // pointer and the order insert are serialized: this transaction observes
      // either the complete old snapshot or the complete new one, never a
      // product/mode/pointer mixture in between.
      return db.transaction(
        (tx) => {
          const existingRow = tx
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

          if (existingRow) {
            return {
              order: replayExistingOrder(
                toBenefitOrder(existingRow),
                productId,
                businessSource,
                businessOrderNo,
              ),
              created: false,
            };
          }

          const product = tx
            .select({ status: catalogProducts.status })
            .from(catalogProducts)
            .where(eq(catalogProducts.id, productId))
            .limit(1)
            .get();
          if (!product) {
            throw new OrderProductNotFoundError(`内部商品不存在：${productId}`);
          }
          if (product.status !== 'active') {
            throw new OrderProductNotActiveError(`内部商品已停用，不能创建新订单：${productId}`);
          }

          const mapping = tx
            .select({
              id: supplierProductMappings.id,
              activeVersionId: supplierProductMappings.activeVersionId,
            })
            .from(supplierProductMappings)
            .where(eq(supplierProductMappings.productId, productId))
            .limit(1)
            .get();
          if (!mapping?.activeVersionId) {
            throw new OrderMappingUnavailableError(
              `内部商品没有当前生效的供应商映射版本：${productId}`,
            );
          }

          const snapshot = tx
            .select()
            .from(supplierProductMappingVersions)
            .where(
              and(
                eq(supplierProductMappingVersions.id, mapping.activeVersionId),
                eq(supplierProductMappingVersions.mappingId, mapping.id),
              ),
            )
            .limit(1)
            .get();
          if (!snapshot) {
            // Migration 0004's pointer trigger and foreign key make this
            // unreachable; failing loudly beats reporting "no usable mapping".
            throw new Error(`Active supplier mapping version missing for mapping ${mapping.id}`);
          }

          const now = Date.now();
          const row: OrderRow = {
            id: randomUUID(),
            businessSource,
            businessOrderNo,
            productId,
            mappingVersionId: snapshot.id,
            // The order's mode is the snapshot's mode, never caller input.
            fulfillmentMode: snapshot.fulfillmentMode,
            status: 'pending',
            version: 1,
            createdAt: now,
            updatedAt: now,
          };

          // Migration 0005 triggers re-check this at the database boundary:
          // mapping version present, same product, same mode and still current.
          tx.insert(benefitOrders).values(row).run();
          // The initial status fact is committed atomically with the new
          // intent, so the history can never lag behind the order row.
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
