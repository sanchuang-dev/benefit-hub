import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client.js';
import {
  benefitOrderGiftVouchers,
  benefitOrderGrants,
  benefitOrders,
  benefitOrderStatusEvents,
  businessApplicationCredentials,
  businessApplicationProducts,
  businessApplications,
  catalogProducts,
  fulfillmentAttempts,
  supplierProductMappingVersions,
  supplierProductMappings,
} from '../../db/schema.js';
import {
  assertAttemptOperation,
  assertAttemptResult,
  assertOrderStatus,
  GrantNotFoundError,
  GrantStateConflictError,
  GiftVoucherNotFoundError,
  GiftVoucherStateConflictError,
  normalizeBusinessOrderNo,
  normalizeBusinessSource,
  normalizeUpstreamRef,
  OrderApplicationDisabledError,
  OrderCredentialRevokedError,
  OrderInputError,
  OrderIntentConflictError,
  OrderMappingUnavailableError,
  OrderNotFoundError,
  OrderNotGrantableError,
  OrderProductNotActiveError,
  OrderProductNotFoundError,
  OrderProductNotAuthorizedError,
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
  type GiftVoucherState,
  type OrderStatus,
  type OrderStatusEvent,
  type PrepaidGrantState,
  type PrepaidOrderGrant,
} from './benefit-orders.js';

/**
 * Creating a new order only needs the caller's business identity and the
 * internal product. Fulfillment mode is deliberately not an input: it is frozen
 * from the product's active mapping snapshot inside the repository transaction.
 */
export interface CreateOrderIntentInput {
  businessSource: string;
  /** Present only for a DB-issued Bearer verified by machine auth, never supplied by the caller. */
  applicationCredentialId?: string | null;
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

export interface ReserveGrantInput {
  orderId: string;
  /** Recheck the authenticated DB credential under the same write lock as the reservation. */
  applicationCredentialId?: string | null;
  /** Version observed before the reservation; a concurrent change fails. */
  expectedVersion: number;
  requestId: string;
  refCode: string;
  phoneHmac: string;
  paymentReference: string;
  occurredAt: number;
}

export interface ReserveGrantResult {
  grant: PrepaidOrderGrant;
  order: BenefitOrder;
  /** False when another reservation already existed for this order. */
  created: boolean;
}

/**
 * Settles a durable A-mode operation. `attempt` settles the signed supplier
 * POST and requires a still-`reserved` row; `recovery` records a read-only
 * query and may upgrade `reserved`/`unknown` to `accepted`, but never rewrites
 * an already accepted or rejected operation into something else.
 */
export interface SettleGrantInput {
  orderId: string;
  /** Current order version; ignored when the status is unchanged. */
  expectedVersion: number;
  kind: 'attempt' | 'recovery';
  grantState: 'accepted' | 'unknown' | 'rejected';
  upstreamOrderNo?: string | null;
  orderStatus: OrderStatus;
  operation: AttemptOperation;
  result: AttemptResult;
  occurredAt: number;
  lastVerifiedAt: number | null;
}

export interface SettleGrantResult {
  grant: PrepaidOrderGrant;
  order: BenefitOrder;
}

/**
 * Durable C-mode voucher operation. `phoneHmac` is a keyed digest, never a
 * phone number; `encryptedVoucher` is an AES-GCM envelope containing the issued
 * voucher code, claim link and raw expiry scalar. This object is server-only:
 * build an explicit safe DTO instead of serializing the last two fields.
 */
export interface GiftVoucherOperation {
  orderId: string;
  requestId: string;
  state: GiftVoucherState;
  packCount: number;
  refCode: string;
  phoneHmac: string | null;
  encryptedVoucher: string | null;
  packTotal: number | null;
  packRemaining: number | null;
  lastObservedAt: number | null;
  attemptedAt: number;
  updatedAt: number;
}

export interface ReserveGiftVoucherInput {
  orderId: string;
  /** Recheck the authenticated DB credential under the same write lock. */
  applicationCredentialId?: string | null;
  /** Version observed before the reservation; a concurrent change fails. */
  expectedVersion: number;
  requestId: string;
  packCount: number;
  refCode: string;
  /** Null when the caller did not supply a recipient phone. */
  phoneHmac: string | null;
  occurredAt: number;
}

export interface ReserveGiftVoucherResult {
  voucher: GiftVoucherOperation;
  order: BenefitOrder;
  /** False when another reservation already existed for this order. */
  created: boolean;
}

/**
 * Settles a durable C-mode operation. `attempt` settles the signed supplier
 * POST and requires a still-`reserved` row; `recovery` records a read-only
 * query and may confirm `issued` facts, but never rewrites an explicit
 * rejection or downgrades an issued voucher.
 */
export interface SettleGiftVoucherInput {
  orderId: string;
  /** Current order version; ignored when the status is unchanged. */
  expectedVersion: number;
  kind: 'attempt' | 'recovery';
  state: 'issued' | 'unknown' | 'rejected';
  /** New protected envelope; omitted to keep the previously stored facts. */
  encryptedVoucher?: string;
  packTotal?: number;
  packRemaining?: number;
  lastObservedAt?: number;
  orderStatus: OrderStatus;
  operation: AttemptOperation;
  result: AttemptResult;
  occurredAt: number;
  lastVerifiedAt: number | null;
}

export interface SettleGiftVoucherResult {
  voucher: GiftVoucherOperation;
  order: BenefitOrder;
}

/**
 * Operator list query. Every filter is independent and already validated at the
 * HTTP boundary; the repository only applies exact, index-friendly predicates.
 * `createdFrom`/`createdTo` are inclusive UTC epoch-millisecond bounds.
 */
export interface ListOrdersForOperationsQuery {
  page: number;
  pageSize: number;
  businessSource?: string;
  businessOrderNo?: string;
  status?: OrderStatus;
  createdFrom?: number;
  createdTo?: number;
}

export interface OperationsOrderListRow {
  order: BenefitOrder;
  /** Current internal product name, not a creation-time historical snapshot. */
  currentProductName: string;
}

export interface OperationsOrderListResult {
  orders: OperationsOrderListRow[];
  total: number;
}

/** Current internal product row; deliberately separate from frozen provenance. */
export interface OperationsOrderProduct {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'disabled';
}

/** Immutable mapping snapshot referenced by the order's own `mappingVersionId`. */
export interface OperationsOrderFrozenMapping {
  id: string;
  mappingId: string;
  versionNumber: number;
  provider: string;
  productCode: string;
  fulfillmentMode: FulfillmentMode;
  deductionUnit: 'pack' | 'amount';
  activatedAt: number;
}

export interface OperationsOrderDetail {
  order: BenefitOrder;
  currentProduct: OperationsOrderProduct;
  frozenMapping: OperationsOrderFrozenMapping | null;
  /** A-mode operation identity, when one was ever reserved. */
  grant: PrepaidOrderGrant | null;
  /** C-mode operation identity, when one was ever reserved. */
  giftVoucher: GiftVoucherOperation | null;
  statusEvents: OrderStatusEvent[];
  attempts: FulfillmentAttempt[];
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
   * A registered application governs its source: a disabled registration fails
   * before anything else, and a genuinely new order must use a product on the
   * application's configured allowlist. Those reads happen inside the same
   * IMMEDIATE transaction as the insert, so a concurrent disable or allowlist
   * change either commits before this check or waits until after it. Sources
   * without a registered application keep the legacy compatibility path.
   *
   * Replay of an already accepted order is resolved before product-eligibility
   * checks: an equivalent existing order is returned with its original frozen
   * product, mode and mapping version even if the product has since been
   * disabled, removed from the allowlist or its mapping rotated. A different
   * `productId` for the same business identity fails with
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
   * Reads the one durable A-mode operation for an order, if any. This is a
   * local read only; it never contacts the supplier.
   */
  getGrant(orderId: string): PrepaidOrderGrant | null;
  /**
   * Persists the operation identity and flips the order to `processing` before
   * any supplier call. The insert and status change share one short IMMEDIATE
   * transaction; the caller must make the supplier HTTP call only afterwards,
   * with no transaction open. Re-reserving an existing operation returns it
   * unchanged (`created: false`) so a concurrent caller cannot double-send.
   */
  reserveGrant(input: ReserveGrantInput): ReserveGrantResult;
  /**
   * Atomically settles the operation, the order status and one attempt fact.
   * A terminal `accepted`/`rejected` operation is never rewritten.
   */
  settleGrant(input: SettleGrantInput): SettleGrantResult;
  /**
   * Reads the one durable C-mode voucher operation for an order, if any.
   * Local read only; it never contacts the supplier.
   */
  getGiftVoucher(orderId: string): GiftVoucherOperation | null;
  /**
   * Persists the C-mode operation identity and flips the order to `processing`
   * before any supplier call, in one short IMMEDIATE transaction. Re-reserving
   * an existing operation returns it unchanged (`created: false`).
   */
  reserveGiftVoucher(input: ReserveGiftVoucherInput): ReserveGiftVoucherResult;
  /**
   * Atomically settles the C-mode operation, order status and one attempt fact.
   * An `issued`/`rejected` operation is never rewritten by a recovery read.
   */
  settleGiftVoucher(input: SettleGiftVoucherInput): SettleGiftVoucherResult;
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
  /**
   * Operator-only paginated listing across all business sources. Ordered by
   * `createdAt DESC, id DESC` so equal timestamps still page deterministically.
   */
  listForOperations(query: ListOrdersForOperationsQuery): OperationsOrderListResult;
  /**
   * Operator-only detail assembled from persisted local facts. The product row
   * is current; supplier provenance comes only from the order's frozen snapshot.
   */
  getForOperations(orderId: string): OperationsOrderDetail | null;
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

interface GrantRow {
  orderId: string;
  requestId: string;
  state: string;
  upstreamOrderNo: string | null;
  refCode: string;
  phoneHmac: string;
  paymentReference: string;
  attemptedAt: number;
  updatedAt: number;
}

interface GiftVoucherRow {
  orderId: string;
  requestId: string;
  state: string;
  packCount: number;
  refCode: string;
  phoneHmac: string | null;
  encryptedVoucher: string | null;
  packTotal: number | null;
  packRemaining: number | null;
  lastObservedAt: number | null;
  attemptedAt: number;
  updatedAt: number;
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

/**
 * Stored enum columns are constrained by SQLite CHECKs. Reading anything else
 * is data corruption, not a reason to render a guessed operator-facing value.
 */
const GRANT_STATE_SET = new Set(['reserved', 'accepted', 'unknown', 'rejected']);
function toPrepaidGrantState(value: string): PrepaidGrantState {
  if (GRANT_STATE_SET.has(value)) return value as PrepaidGrantState;
  throw new Error(`Unknown benefit order grant state stored in database: ${value}`);
}
function toPrepaidGrant(row: GrantRow): PrepaidOrderGrant {
  return {
    orderId: row.orderId,
    requestId: row.requestId,
    state: toPrepaidGrantState(row.state),
    upstreamOrderNo: row.upstreamOrderNo,
    refCode: row.refCode,
    phoneHmac: row.phoneHmac,
    paymentReference: row.paymentReference,
    attemptedAt: row.attemptedAt,
    updatedAt: row.updatedAt,
  };
}

function loadGrantRow(db: AppDatabase, orderId: string): GrantRow | undefined {
  return db
    .select()
    .from(benefitOrderGrants)
    .where(eq(benefitOrderGrants.orderId, orderId))
    .limit(1)
    .get();
}

const GIFT_VOUCHER_STATE_SET = new Set(['reserved', 'issued', 'unknown', 'rejected']);
function toGiftVoucherState(value: string): GiftVoucherState {
  if (GIFT_VOUCHER_STATE_SET.has(value)) return value as GiftVoucherState;
  throw new Error(`Unknown benefit order gift voucher state stored in database: ${value}`);
}

function toGiftVoucherOperation(row: GiftVoucherRow): GiftVoucherOperation {
  return {
    orderId: row.orderId,
    requestId: row.requestId,
    state: toGiftVoucherState(row.state),
    packCount: row.packCount,
    refCode: row.refCode,
    phoneHmac: row.phoneHmac,
    encryptedVoucher: row.encryptedVoucher,
    packTotal: row.packTotal,
    packRemaining: row.packRemaining,
    lastObservedAt: row.lastObservedAt,
    attemptedAt: row.attemptedAt,
    updatedAt: row.updatedAt,
  };
}

function loadGiftVoucherRow(db: AppDatabase, orderId: string): GiftVoucherRow | undefined {
  return db
    .select()
    .from(benefitOrderGiftVouchers)
    .where(eq(benefitOrderGiftVouchers.orderId, orderId))
    .limit(1)
    .get();
}

function toStoredProductStatus(value: string): 'active' | 'disabled' {
  if (value === 'active' || value === 'disabled') return value;
  throw new Error(`Unknown catalog product status stored in database: ${value}`);
}

function toStoredDeductionUnit(value: string): 'pack' | 'amount' {
  if (value === 'pack' || value === 'amount') return value;
  throw new Error(`Unknown deduction unit stored in database: ${value}`);
}

function loadStatusEvents(db: AppDatabase, orderId: string): OrderStatusEvent[] {
  const rows = db
    .select()
    .from(benefitOrderStatusEvents)
    .where(eq(benefitOrderStatusEvents.orderId, orderId))
    .orderBy(asc(benefitOrderStatusEvents.version))
    .all();
  return rows.map(toOrderStatusEvent);
}

function loadAttempts(db: AppDatabase, orderId: string): FulfillmentAttempt[] {
  const rows = db
    .select()
    .from(fulfillmentAttempts)
    .where(eq(fulfillmentAttempts.orderId, orderId))
    .orderBy(asc(fulfillmentAttempts.occurredAt), asc(fulfillmentAttempts.id))
    .all();
  return rows.map(toFulfillmentAttempt);
}


function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('FOREIGN KEY constraint failed');
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

const GRANT_SUCCESS_STATUSES = new Set<string>(['awaiting_claim', 'partially_completed', 'completed']);

/** Same bounded visible-ASCII shape the supplier accepts for C identifiers. */
const GIFT_VOUCHER_REQUEST_ID_PATTERN = /^[!-~]{1,64}$/;

type OrderWriteTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/**
 * Re-verifies the authenticated application credential, enabled state and
 * product allowlist inside the same IMMEDIATE transaction that records a
 * potentially billable supplier attempt. Reused by every mode so a revocation
 * or allowlist change can never be bypassed by a between-request gap.
 */
export function assertApplicationWriteAccess(
  tx: OrderWriteTransaction,
  input: {
    businessSource: string;
    productId: string;
    applicationCredentialId?: string | null;
  },
): void {
  const application = tx
    .select({ id: businessApplications.id, status: businessApplications.status })
    .from(businessApplications)
    .where(eq(businessApplications.businessSource, input.businessSource))
    .limit(1)
    .get();
  if (input.applicationCredentialId != null) {
    const credential = tx
      .select({ applicationId: businessApplicationCredentials.applicationId })
      .from(businessApplicationCredentials)
      .where(
        and(
          eq(businessApplicationCredentials.id, input.applicationCredentialId),
          isNull(businessApplicationCredentials.revokedAt),
        ),
      )
      .limit(1)
      .get();
    if (!application || !credential || credential.applicationId !== application.id) {
      throw new OrderCredentialRevokedError('应用服务凭证已失效');
    }
  }
  if (application && application.status !== 'enabled') {
    throw new OrderApplicationDisabledError('应用已停用，不能发起上力下单');
  }
  if (application) {
    const permitted = tx
      .select({ productId: businessApplicationProducts.productId })
      .from(businessApplicationProducts)
      .where(
        and(
          eq(businessApplicationProducts.applicationId, application.id),
          eq(businessApplicationProducts.productId, input.productId),
        ),
      )
      .limit(1)
      .get();
    if (!permitted) {
      throw new OrderProductNotAuthorizedError('该应用未被授权使用此内部商品');
    }
  }
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
          // Registered-application enforcement is part of the same serialized
          // unit as the insert: a concurrent `disable`/allowlist write cannot
          // slip between this check and the order row.
          const application = tx
            .select({ id: businessApplications.id, status: businessApplications.status })
            .from(businessApplications)
            .where(eq(businessApplications.businessSource, businessSource))
            .limit(1)
            .get();

          // Authentication happens before async request-body parsing. A credential
          // can be revoked while the request waits for its body, so re-check the
          // exact verified credential under the same write lock as the order insert.
          // Legacy environment clients have no DB credential id and retain their
          // existing application-status/allowlist checks below.
          if (input.applicationCredentialId != null) {
            const credential = tx
              .select({ applicationId: businessApplicationCredentials.applicationId })
              .from(businessApplicationCredentials)
              .where(
                and(
                  eq(businessApplicationCredentials.id, input.applicationCredentialId),
                  isNull(businessApplicationCredentials.revokedAt),
                ),
              )
              .limit(1)
              .get();
            if (!application || !credential || credential.applicationId !== application.id) {
              throw new OrderCredentialRevokedError('应用服务凭证已失效');
            }
          }

          if (application && application.status !== 'enabled') {
            throw new OrderApplicationDisabledError(
              `应用已停用，不能创建新订单：${businessSource}`,
            );
          }

          // Replay is resolved before product eligibility: an already accepted
          // order is never invalidated or rewritten by a later allowlist change,
          // product disable or mapping rotation.
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

          if (application) {
            const authorized = tx
              .select({ productId: businessApplicationProducts.productId })
              .from(businessApplicationProducts)
              .where(
                and(
                  eq(businessApplicationProducts.applicationId, application.id),
                  eq(businessApplicationProducts.productId, productId),
                ),
              )
              .limit(1)
              .get();
            if (!authorized) {
              throw new OrderProductNotAuthorizedError(
                `内部商品不在该应用的商品授权范围内，不能创建新订单：${productId}`,
              );
            }
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

    getGrant(orderId) {
      const row = loadGrantRow(db, requireOrderId(orderId));
      return row ? toPrepaidGrant(row) : null;
    },

    reserveGrant(input) {
      const orderId = requireOrderId(input.orderId);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new OrderInputError('订单版本号需为大于 0 的整数');
      }
      const occurredAt = requireTimestamp(input.occurredAt, '发生时间');

      return db.transaction(
        (tx) => {
          const orderRow = tx
            .select()
            .from(benefitOrders)
            .where(eq(benefitOrders.id, orderId))
            .limit(1)
            .get();
          if (!orderRow) throw new OrderNotFoundError(`订单不存在：${orderId}`);

          // The initial machine-auth middleware and the live purchase-check can
          // be separated by network latency. Recheck the verified credential,
          // app status and product allowlist inside this same IMMEDIATE write
          // transaction, immediately before recording any potentially billable
          // supplier attempt. The operator's revocation/disable/allowlist write
          // and this reservation cannot cross each other.
          assertApplicationWriteAccess(tx, {
            businessSource: orderRow.businessSource,
            productId: orderRow.productId,
            applicationCredentialId: input.applicationCredentialId,
          });

          const existing = tx
            .select()
            .from(benefitOrderGrants)
            .where(eq(benefitOrderGrants.orderId, orderId))
            .limit(1)
            .get();
          if (existing) {
            return {
              grant: toPrepaidGrant(existing),
              order: toBenefitOrder(orderRow),
              created: false,
            };
          }

          if (orderRow.version !== input.expectedVersion) {
            throw new OrderVersionConflictError(
              `订单版本已变化（当前版本 ${orderRow.version}，提交版本 ${input.expectedVersion}）`,
            );
          }
          if (orderRow.status !== 'pending') {
            throw new OrderNotGrantableError(
              `订单当前状态不允许发起上力下单：${orderRow.status}`,
            );
          }

          const row: GrantRow = {
            orderId,
            requestId: input.requestId,
            state: 'reserved',
            upstreamOrderNo: null,
            refCode: input.refCode,
            phoneHmac: input.phoneHmac,
            paymentReference: input.paymentReference,
            attemptedAt: occurredAt,
            updatedAt: occurredAt,
          };

          try {
            tx.insert(benefitOrderGrants).values(row).run();
          } catch (error) {
            // A concurrent reservation for the same order lost the insert race.
            // Return the winner instead of sending a second supplier call.
            if (isUniqueViolation(error)) {
              const raced = tx
                .select()
                .from(benefitOrderGrants)
                .where(eq(benefitOrderGrants.orderId, orderId))
                .limit(1)
                .get();
              if (raced) {
                return {
                  grant: toPrepaidGrant(raced),
                  order: toBenefitOrder(orderRow),
                  created: false,
                };
              }
            }
            throw error;
          }

          const updated = tx
            .update(benefitOrders)
            .set({ status: 'processing', version: input.expectedVersion + 1, updatedAt: occurredAt })
            .where(
              and(
                eq(benefitOrders.id, orderId),
                eq(benefitOrders.version, input.expectedVersion),
              ),
            )
            .run();
          if (updated.changes === 0) {
            throw new OrderVersionConflictError('订单版本已变化，未发起上力下单');
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

          // The pre-send attempt is itself a durable fact: if the process dies
          // before the response, the local record still says "unknown".
          tx.insert(fulfillmentAttempts)
            .values({
              id: randomUUID(),
              orderId,
              operation: 'grant',
              upstreamRequestNo: row.requestId,
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
          if (!refreshed) throw new OrderNotFoundError(`订单不存在：${orderId}`);

          return { grant: toPrepaidGrant(row), order: toBenefitOrder(refreshed), created: true };
        },
        { behavior: 'immediate' },
      );
    },

    settleGrant(input) {
      const orderId = requireOrderId(input.orderId);
      const orderStatus = assertOrderStatus(input.orderStatus);
      const operation = assertAttemptOperation(input.operation);
      const result = assertAttemptResult(input.result);
      const occurredAt = requireTimestamp(input.occurredAt, '发生时间');
      const lastVerifiedAt =
        input.lastVerifiedAt === null
          ? null
          : requireTimestamp(input.lastVerifiedAt, '最近核实时间');
      const upstreamOrderNo = normalizeUpstreamRef(input.upstreamOrderNo, '上游订单号');

      return db.transaction(
        (tx) => {
          const orderRow = tx
            .select()
            .from(benefitOrders)
            .where(eq(benefitOrders.id, orderId))
            .limit(1)
            .get();
          if (!orderRow) throw new OrderNotFoundError(`订单不存在：${orderId}`);

          const grantRow = tx
            .select()
            .from(benefitOrderGrants)
            .where(eq(benefitOrderGrants.orderId, orderId))
            .limit(1)
            .get();
          if (!grantRow) throw new GrantNotFoundError(`订单没有上力下单记录：${orderId}`);

          const currentState = toPrepaidGrantState(grantRow.state);
          let nextState: PrepaidGrantState = currentState;

          if (input.kind === 'attempt') {
            if (currentState !== 'reserved') {
              throw new GrantStateConflictError(
                `上力下单记录已处于 ${currentState}，不能再次结算原始请求`,
              );
            }
            nextState = input.grantState;
          } else {
            // A recovery read may only upgrade an indeterminate operation. It
            // never rewrites an explicit rejection or downgrades acceptance.
            if (currentState === 'rejected') {
              throw new GrantStateConflictError('上力下单记录已明确拒绝，不再执行查询恢复');
            }
            if (currentState === 'accepted') nextState = 'accepted';
            else nextState = input.grantState === 'accepted' ? 'accepted' : 'unknown';
          }

          if (upstreamOrderNo != null && grantRow.upstreamOrderNo != null &&
              upstreamOrderNo !== grantRow.upstreamOrderNo) {
            throw new GrantStateConflictError('上游订单号与已记录的订单不一致，拒绝覆盖');
          }
          const settledUpstreamOrderNo = upstreamOrderNo ?? grantRow.upstreamOrderNo;

          if (nextState !== currentState || settledUpstreamOrderNo !== grantRow.upstreamOrderNo) {
            tx.update(benefitOrderGrants)
              .set({
                state: nextState,
                upstreamOrderNo: settledUpstreamOrderNo,
                updatedAt: occurredAt,
              })
              .where(eq(benefitOrderGrants.orderId, orderId))
              .run();
          }

          let settledOrder = toBenefitOrder(orderRow);
          if (settledOrder.status !== orderStatus) {
            if (GRANT_SUCCESS_STATUSES.has(settledOrder.status) &&
                (orderStatus === 'unknown' || orderStatus === 'failed')) {
              throw new GrantStateConflictError('已受理的订单不能被查询结果降级为未知或失败');
            }
            if (settledOrder.version !== input.expectedVersion) {
              throw new OrderVersionConflictError(
                `订单版本已变化（当前版本 ${settledOrder.version}，提交版本 ${input.expectedVersion}）`,
              );
            }
            const updated = tx
              .update(benefitOrders)
              .set({
                status: orderStatus,
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
            if (updated.changes === 0) {
              throw new OrderVersionConflictError('订单版本已变化，未记录上力结果');
            }
            tx.insert(benefitOrderStatusEvents)
              .values({
                id: randomUUID(),
                orderId,
                status: orderStatus,
                version: input.expectedVersion + 1,
                createdAt: occurredAt,
              })
              .run();

            const refreshed = tx
              .select()
              .from(benefitOrders)
              .where(eq(benefitOrders.id, orderId))
              .limit(1)
              .get();
            if (!refreshed) throw new OrderNotFoundError(`订单不存在：${orderId}`);
            settledOrder = toBenefitOrder(refreshed);
          }

          tx.insert(fulfillmentAttempts)
            .values({
              id: randomUUID(),
              orderId,
              operation,
              upstreamRequestNo: grantRow.requestId,
              upstreamOrderNo: settledUpstreamOrderNo,
              result,
              observedStatus: orderStatus,
              occurredAt,
              lastVerifiedAt,
            })
            .run();

          const refreshedGrant = tx
            .select()
            .from(benefitOrderGrants)
            .where(eq(benefitOrderGrants.orderId, orderId))
            .limit(1)
            .get();
          if (!refreshedGrant) throw new GrantNotFoundError(`订单没有上力下单记录：${orderId}`);

          return { grant: toPrepaidGrant(refreshedGrant), order: settledOrder };
        },
        { behavior: 'immediate' },
      );
    },

    getGiftVoucher(orderId) {
      const row = loadGiftVoucherRow(db, requireOrderId(orderId));
      return row ? toGiftVoucherOperation(row) : null;
    },

    reserveGiftVoucher(input) {
      const orderId = requireOrderId(input.orderId);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new OrderInputError('订单版本号需为大于 0 的整数');
      }
      const occurredAt = requireTimestamp(input.occurredAt, '发生时间');
      if (!GIFT_VOUCHER_REQUEST_ID_PATTERN.test(input.requestId)) {
        throw new OrderInputError('上游请求号需为 1-64 位可见 ASCII 字符');
      }
      if (!Number.isInteger(input.packCount) || input.packCount < 1 || input.packCount > 12) {
        throw new OrderInputError('礼包个数需为 1-12 的整数');
      }
      if (!GIFT_VOUCHER_REQUEST_ID_PATTERN.test(input.refCode)) {
        throw new OrderInputError('推广码需为 1-64 位可见 ASCII 字符');
      }
      if (input.phoneHmac !== null && !/^[0-9a-f]{64}$/.test(input.phoneHmac)) {
        throw new OrderInputError('手机号摘要格式不正确');
      }

      return db.transaction(
        (tx) => {
          const orderRow = tx
            .select()
            .from(benefitOrders)
            .where(eq(benefitOrders.id, orderId))
            .limit(1)
            .get();
          if (!orderRow) throw new OrderNotFoundError(`订单不存在：${orderId}`);

          // Same write-lock recheck as A mode: a revocation, disable or
          // allowlist change must be visible before a supplier write is recorded.
          assertApplicationWriteAccess(tx, {
            businessSource: orderRow.businessSource,
            productId: orderRow.productId,
            applicationCredentialId: input.applicationCredentialId,
          });

          const existing = tx
            .select()
            .from(benefitOrderGiftVouchers)
            .where(eq(benefitOrderGiftVouchers.orderId, orderId))
            .limit(1)
            .get();
          if (existing) {
            return {
              voucher: toGiftVoucherOperation(existing),
              order: toBenefitOrder(orderRow),
              created: false,
            };
          }

          if (orderRow.version !== input.expectedVersion) {
            throw new OrderVersionConflictError(
              `订单版本已变化（当前版本 ${orderRow.version}，提交版本 ${input.expectedVersion}）`,
            );
          }
          if (orderRow.status !== 'pending') {
            throw new OrderNotGrantableError(`订单当前状态不允许发起上力发券：${orderRow.status}`);
          }

          const row: GiftVoucherRow = {
            orderId,
            requestId: input.requestId,
            state: 'reserved',
            packCount: input.packCount,
            refCode: input.refCode,
            phoneHmac: input.phoneHmac,
            encryptedVoucher: null,
            packTotal: null,
            packRemaining: null,
            lastObservedAt: null,
            attemptedAt: occurredAt,
            updatedAt: occurredAt,
          };

          try {
            tx.insert(benefitOrderGiftVouchers).values(row).run();
          } catch (error) {
            if (isUniqueViolation(error)) {
              const raced = tx
                .select()
                .from(benefitOrderGiftVouchers)
                .where(eq(benefitOrderGiftVouchers.orderId, orderId))
                .limit(1)
                .get();
              if (raced) {
                return {
                  voucher: toGiftVoucherOperation(raced),
                  order: toBenefitOrder(orderRow),
                  created: false,
                };
              }
            }
            throw error;
          }

          const updated = tx
            .update(benefitOrders)
            .set({ status: 'processing', version: input.expectedVersion + 1, updatedAt: occurredAt })
            .where(
              and(
                eq(benefitOrders.id, orderId),
                eq(benefitOrders.version, input.expectedVersion),
              ),
            )
            .run();
          if (updated.changes === 0) {
            throw new OrderVersionConflictError('订单版本已变化，未发起上力发券');
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

          // Pre-send durable fact: a crash before the response still leaves an
          // explicit unknown attempt tied to the stable requestId.
          tx.insert(fulfillmentAttempts)
            .values({
              id: randomUUID(),
              orderId,
              operation: 'grant',
              upstreamRequestNo: row.requestId,
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
          if (!refreshed) throw new OrderNotFoundError(`订单不存在：${orderId}`);

          return { voucher: toGiftVoucherOperation(row), order: toBenefitOrder(refreshed), created: true };
        },
        { behavior: 'immediate' },
      );
    },

    settleGiftVoucher(input) {
      const orderId = requireOrderId(input.orderId);
      const orderStatus = assertOrderStatus(input.orderStatus);
      const operation = assertAttemptOperation(input.operation);
      const result = assertAttemptResult(input.result);
      const occurredAt = requireTimestamp(input.occurredAt, '发生时间');
      const lastVerifiedAt =
        input.lastVerifiedAt === null
          ? null
          : requireTimestamp(input.lastVerifiedAt, '最近核实时间');
      if (
        input.packTotal !== undefined &&
        (!Number.isInteger(input.packTotal) || input.packTotal < 1)
      ) {
        throw new OrderInputError('礼包总个数需为大于 0 的整数');
      }
      if (
        input.packRemaining !== undefined &&
        (!Number.isInteger(input.packRemaining) || input.packRemaining < 0)
      ) {
        throw new OrderInputError('礼包剩余个数需为非负整数');
      }
      if (input.lastObservedAt !== undefined) {
        requireTimestamp(input.lastObservedAt, '供应商观察时间');
      }

      return db.transaction(
        (tx) => {
          const orderRow = tx
            .select()
            .from(benefitOrders)
            .where(eq(benefitOrders.id, orderId))
            .limit(1)
            .get();
          if (!orderRow) throw new OrderNotFoundError(`订单不存在：${orderId}`);

          const voucherRow = tx
            .select()
            .from(benefitOrderGiftVouchers)
            .where(eq(benefitOrderGiftVouchers.orderId, orderId))
            .limit(1)
            .get();
          if (!voucherRow) {
            throw new GiftVoucherNotFoundError(`订单没有上力发券记录：${orderId}`);
          }

          const currentState = toGiftVoucherState(voucherRow.state);
          let nextState: GiftVoucherState = currentState;

          if (input.kind === 'attempt') {
            if (currentState !== 'reserved') {
              throw new GiftVoucherStateConflictError(
                `上力发券记录已处于 ${currentState}，不能再次结算原始请求`,
              );
            }
            nextState = input.state;
          } else {
            // A recovery read may only confirm an indeterminate operation. It
            // never rewrites a rejection or downgrades an issued voucher.
            if (currentState === 'rejected') {
              throw new GiftVoucherStateConflictError('上力发券记录已明确拒绝，不再执行查询恢复');
            }
            nextState = currentState === 'issued'
              ? 'issued'
              : input.state === 'issued' ? 'issued' : 'unknown';
          }

          const encryptedVoucher = input.encryptedVoucher ?? voucherRow.encryptedVoucher;
          if (nextState === 'issued' && encryptedVoucher === null) {
            throw new GiftVoucherStateConflictError('已签发的礼包券缺少受保护数据，拒绝记录成功');
          }

          const packTotal = input.packTotal ?? voucherRow.packTotal;
          const packRemaining = input.packRemaining ?? voucherRow.packRemaining;
          if (packTotal !== null && packRemaining !== null && packRemaining > packTotal) {
            throw new GiftVoucherStateConflictError('供应商礼包剩余份额不能超过总份额');
          }
          const lastObservedAt = input.lastObservedAt ?? voucherRow.lastObservedAt;

          if (
            nextState !== currentState ||
            encryptedVoucher !== voucherRow.encryptedVoucher ||
            packTotal !== voucherRow.packTotal ||
            packRemaining !== voucherRow.packRemaining ||
            lastObservedAt !== voucherRow.lastObservedAt
          ) {
            tx.update(benefitOrderGiftVouchers)
              .set({
                state: nextState,
                encryptedVoucher,
                packTotal,
                packRemaining,
                lastObservedAt,
                updatedAt: occurredAt,
              })
              .where(eq(benefitOrderGiftVouchers.orderId, orderId))
              .run();
          }

          let settledOrder = toBenefitOrder(orderRow);
          if (settledOrder.status !== orderStatus) {
            if (
              (settledOrder.status === 'completed' && orderStatus !== 'completed') ||
              (
                settledOrder.status === 'partially_completed' &&
                orderStatus !== 'partially_completed' &&
                orderStatus !== 'completed'
              ) ||
              (
                GRANT_SUCCESS_STATUSES.has(settledOrder.status) &&
                (orderStatus === 'unknown' || orderStatus === 'failed')
              )
            ) {
              throw new GiftVoucherStateConflictError(
                '已确认的订单履约结果不能被发券查询降级',
              );
            }
            if (settledOrder.version !== input.expectedVersion) {
              throw new OrderVersionConflictError(
                `订单版本已变化（当前版本 ${settledOrder.version}，提交版本 ${input.expectedVersion}）`,
              );
            }
            const updated = tx
              .update(benefitOrders)
              .set({
                status: orderStatus,
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
            if (updated.changes === 0) {
              throw new OrderVersionConflictError('订单版本已变化，未记录上力发券结果');
            }
            tx.insert(benefitOrderStatusEvents)
              .values({
                id: randomUUID(),
                orderId,
                status: orderStatus,
                version: input.expectedVersion + 1,
                createdAt: occurredAt,
              })
              .run();

            const refreshed = tx
              .select()
              .from(benefitOrders)
              .where(eq(benefitOrders.id, orderId))
              .limit(1)
              .get();
            if (!refreshed) throw new OrderNotFoundError(`订单不存在：${orderId}`);
            settledOrder = toBenefitOrder(refreshed);
          }

          tx.insert(fulfillmentAttempts)
            .values({
              id: randomUUID(),
              orderId,
              operation,
              upstreamRequestNo: voucherRow.requestId,
              // C issuance has no separate upstream order number.
              upstreamOrderNo: null,
              result,
              observedStatus: orderStatus,
              occurredAt,
              lastVerifiedAt,
            })
            .run();

          const refreshedVoucher = tx
            .select()
            .from(benefitOrderGiftVouchers)
            .where(eq(benefitOrderGiftVouchers.orderId, orderId))
            .limit(1)
            .get();
          if (!refreshedVoucher) {
            throw new GiftVoucherNotFoundError(`订单没有上力发券记录：${orderId}`);
          }

          return {
            voucher: toGiftVoucherOperation(refreshedVoucher),
            order: settledOrder,
          };
        },
        { behavior: 'immediate' },
      );
    },

    updateStatus(input) {
      const orderId = requireOrderId(input.orderId);      const status = assertOrderStatus(input.status);
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
      return loadStatusEvents(db, requireOrderId(orderId));
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
      return loadAttempts(db, requireOrderId(orderId));
    },

    listForOperations(query) {
      const conditions = [];
      if (query.businessSource !== undefined) {
        conditions.push(eq(benefitOrders.businessSource, query.businessSource));
      }
      if (query.businessOrderNo !== undefined) {
        conditions.push(eq(benefitOrders.businessOrderNo, query.businessOrderNo));
      }
      if (query.status !== undefined) {
        conditions.push(eq(benefitOrders.status, query.status));
      }
      if (query.createdFrom !== undefined) {
        conditions.push(gte(benefitOrders.createdAt, query.createdFrom));
      }
      if (query.createdTo !== undefined) {
        conditions.push(lte(benefitOrders.createdAt, query.createdTo));
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      // The count is a separate bounded aggregate over the same predicates, so
      // the UI total is the real filtered total rather than the current page.
      const total =
        db.select({ value: count() }).from(benefitOrders).where(where).get()?.value ?? 0;

      // Existing indexes cover the source/identity and status+creation filters.
      // There is deliberately no new `created_at` index in this slice, so the
      // unfiltered ordering still needs SQLite's sort; that remains a separate
      // migration decision rather than being smuggled into a read-only card.
      const rows = db
        .select({ order: benefitOrders, currentProductName: catalogProducts.name })
        .from(benefitOrders)
        .innerJoin(catalogProducts, eq(catalogProducts.id, benefitOrders.productId))
        .where(where)
        .orderBy(desc(benefitOrders.createdAt), desc(benefitOrders.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .all();

      return {
        orders: rows.map((row) => ({
          order: toBenefitOrder(row.order),
          currentProductName: row.currentProductName,
        })),
        total,
      };
    },

    getForOperations(orderId) {
      const row = db
        .select()
        .from(benefitOrders)
        .where(eq(benefitOrders.id, requireOrderId(orderId)))
        .limit(1)
        .get();
      if (!row) return null;
      const order = toBenefitOrder(row);

      const productRow = db
        .select({
          id: catalogProducts.id,
          code: catalogProducts.code,
          name: catalogProducts.name,
          status: catalogProducts.status,
        })
        .from(catalogProducts)
        .where(eq(catalogProducts.id, order.productId))
        .limit(1)
        .get();
      if (!productRow) {
        // The foreign key makes this unreachable; a fabricated product name
        // would be worse than an explicit server-side failure.
        throw new Error(`Order ${order.id} references a missing catalog product`);
      }

      const frozenRow =
        order.mappingVersionId === null
          ? undefined
          : db
              .select({
                id: supplierProductMappingVersions.id,
                mappingId: supplierProductMappingVersions.mappingId,
                versionNumber: supplierProductMappingVersions.versionNumber,
                provider: supplierProductMappingVersions.provider,
                productCode: supplierProductMappingVersions.productCode,
                fulfillmentMode: supplierProductMappingVersions.fulfillmentMode,
                deductionUnit: supplierProductMappingVersions.deductionUnit,
                activatedAt: supplierProductMappingVersions.activatedAt,
              })
              .from(supplierProductMappingVersions)
              .where(eq(supplierProductMappingVersions.id, order.mappingVersionId))
              .limit(1)
              .get();
      if (order.mappingVersionId !== null && !frozenRow) {
        // The frozen reference is a foreign key; never fall back to the current
        // active mapping, because that would rewrite history.
        throw new Error(`Order ${order.id} references a missing mapping version`);
      }

      const grantRow = loadGrantRow(db, order.id);
      const giftVoucherRow = loadGiftVoucherRow(db, order.id);

      return {
        order,
        currentProduct: {
          ...productRow,
          status: toStoredProductStatus(productRow.status),
        },
        frozenMapping: frozenRow
          ? {
              ...frozenRow,
              fulfillmentMode: toFulfillmentMode(frozenRow.fulfillmentMode),
              deductionUnit: toStoredDeductionUnit(frozenRow.deductionUnit),
            }
          : null,
        grant: grantRow ? toPrepaidGrant(grantRow) : null,
        giftVoucher: giftVoucherRow ? toGiftVoucherOperation(giftVoucherRow) : null,
        statusEvents: loadStatusEvents(db, order.id),
        attempts: loadAttempts(db, order.id),
      };
    },
  };
}
