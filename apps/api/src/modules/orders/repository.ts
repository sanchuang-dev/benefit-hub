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
  OrderProductNotActiveError,
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
 * Creating a new order only needs the caller's business identity and the
 * internal product. Fulfillment mode is deliberately not an input: it is frozen
 * from the product's active mapping snapshot inside the repository transaction.
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
   * Replay is resolved before any current-state check: an equivalent existing
   * order is returned with its original frozen product, mode and mapping
   * version even if the product has since been disabled or the mapping has been
   * rotated. A different `productId` for the same business identity fails with
   * `OrderIntentConflictError` instead of overwriting.
   *
   * A genuinely new order requires an existing `active` internal product with a
   * current active mapping version. The mode and `mappingVersionId` are copied
   * from that immutable snapshot inside one short IMMEDIATE transaction, which
   * serializes against mapping activation.
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
  fulfillmentMode: string;
  status: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  mappingVersionId: string | null;
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
    fulfillmentMode: toFulfillmentMode(row.fulfillmentMode),
    status: toOrderStatus(row.status),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mappingVersionId: row.mappingVersionId,
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

      // IMMEDIATE takes the write lock at BEGIN, so replay detection, the
      // active-pointer read and the order insert form one serialized unit with
      // mapping activation. Two connections racing for the same business
      // identity therefore cannot both create a row, and a concurrent
      // activation either commits before this read or waits until after it.
      return db.transaction(
        (tx) => {
          // Replay is resolved before eligibility: an already accepted order is
          // never invalidated by a later product disable or mapping rotation.
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
                `业务单号 ${businessSource}/${businessOrderNo} 已存在且关键参数不同，未覆盖已有订单`,
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
            throw new OrderProductNotActiveError(`内部商品已停用，不能创建新订单：${productId}`);
          }

          const mapping = tx
            .select()
            .from(supplierProductMappings)
            .where(eq(supplierProductMappings.productId, productId))
            .limit(1)
            .get();
          if (!mapping?.activeVersionId) {
            throw new OrderMappingUnavailableError(
              `内部商品尚无生效供应商映射版本，不能创建新订单：${productId}`,
            );
          }

          const version = tx
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
          if (!version) {
            // The database pointer trigger and foreign key make this
            // unreachable; a silent "no mapping" fallback would hide corruption.
            throw new Error(`Active supplier mapping version missing for mapping ${mapping.id}`);
          }

          const row: OrderRow = {
            id: randomUUID(),
            businessSource,
            businessOrderNo,
            productId,
            // Frozen from the immutable snapshot, not chosen by the caller.
            fulfillmentMode: toFulfillmentMode(version.fulfillmentMode),
            status: 'pending',
            version: 1,
            createdAt: now,
            updatedAt: now,
            mappingVersionId: version.id,
          };

          // The initial status fact is committed atomically with the new intent,
          // so history can never lag behind the order row.
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
