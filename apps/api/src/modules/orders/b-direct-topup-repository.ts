import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { YangmaoOpenV1DirectTopupResult } from '@sanchuang-dev/provider-yangmao';
import type { AppDatabase } from '../../db/client.js';
import {
  benefitOrderDirectTopupObservations,
  benefitOrderDirectTopups,
  benefitOrders,
  benefitOrderStatusEvents,
  fulfillmentAttempts,
} from '../../db/schema.js';
import {
  OrderInputError,
  OrderNotFoundError,
  OrderNotGrantableError,
  OrderVersionConflictError,
  normalizeUpstreamRef,
  type BenefitOrder,
  type OrderStatus,
} from './benefit-orders.js';
import { assertApplicationWriteAccess } from './repository.js';

export type DirectTopupState =
  | 'reserved' | 'unknown' | 'partial' | 'completed' | 'rejected' | 'retrying';

export interface DirectTopupOperation {
  orderId: string;
  requestId: string;
  refCode: string;
  phoneHmac: string;
  paymentReference: string;
  state: DirectTopupState;
  upstreamOrderNo: string | null;
  successCount: number | null;
  totalCount: number | null;
  /** Intentionally no supplier item ids, raw messages, or phone. */
  items: Array<{ claimed?: boolean; status?: string }>;
  observations: Array<{
    operation: 'grant' | 'reissue';
    upstreamOrderNo: string;
    successCount: number;
    totalCount: number;
    items: Array<{ claimed?: boolean; status?: string }>;
    observedAt: number;
  }>;
  lastVerifiedAt: number | null;
  attemptedAt: number;
  updatedAt: number;
}

export class DirectTopupConflictError extends Error {}
export class DirectTopupUnknownError extends Error {}
export class DirectTopupInProgressError extends Error {}

function toOperation(
  row: typeof benefitOrderDirectTopups.$inferSelect,
  observations: Array<typeof benefitOrderDirectTopupObservations.$inferSelect> = [],
): DirectTopupOperation {
  if (!['reserved', 'unknown', 'partial', 'completed', 'rejected', 'retrying'].includes(row.state)) {
    throw new DirectTopupConflictError('B 模式状态损坏');
  }
  const parsed: unknown = row.itemsSummaryJson === null ? [] : JSON.parse(row.itemsSummaryJson);
  if (!Array.isArray(parsed) || parsed.length > 100 || parsed.some((item) =>
    !item || typeof item !== 'object' ||
    (item.claimed !== undefined && typeof item.claimed !== 'boolean') ||
    (item.status !== undefined && (typeof item.status !== 'string' || item.status.length > 128))
  )) {
    throw new DirectTopupConflictError('B 模式履约摘要损坏');
  }
  return {
    ...row,
    state: row.state as DirectTopupState,
    items: parsed as DirectTopupOperation['items'],
    observations: observations.map((entry) => ({
      operation: entry.operation as 'grant' | 'reissue',
      upstreamOrderNo: entry.upstreamOrderNo,
      successCount: entry.successCount,
      totalCount: entry.totalCount,
      items: JSON.parse(entry.itemsSummaryJson) as DirectTopupOperation['items'],
      observedAt: entry.observedAt,
    })),
  };
}

export function createDirectTopupRepository(db: AppDatabase) {
  function get(orderId: string): DirectTopupOperation | null {
    const row = db.select().from(benefitOrderDirectTopups)
      .where(eq(benefitOrderDirectTopups.orderId, orderId)).limit(1).get();
    if (!row) return null;
    return toOperation(row, db.select().from(benefitOrderDirectTopupObservations)
      .where(eq(benefitOrderDirectTopupObservations.orderId, orderId))
      .orderBy(asc(benefitOrderDirectTopupObservations.observedAt),
        asc(benefitOrderDirectTopupObservations.id)).all());
  }

  /** Durable, immutable identity and pre-send unknown fact in one IMMEDIATE lock. */
  function reserve(input: {
    order: BenefitOrder;
    credentialId?: string | null;
    requestId: string;
    refCode: string;
    phoneHmac: string;
    paymentReference: string;
    occurredAt: number;
  }): { operation: DirectTopupOperation; created: boolean } {
    if (!/^[!-~]{1,64}$/.test(input.requestId) ||
        !/^[!-~]{1,64}$/.test(input.refCode) ||
        !/^[0-9a-f]{64}$/.test(input.phoneHmac) ||
        !/^[!-~]{1,128}$/.test(input.paymentReference)) {
      throw new OrderInputError('B 模式请求身份格式不正确');
    }
    return db.transaction((tx) => {
      const order = tx.select().from(benefitOrders)
        .where(eq(benefitOrders.id, input.order.id)).get();
      if (!order) throw new OrderNotFoundError('订单不存在');
      assertApplicationWriteAccess(tx, {
        businessSource: order.businessSource,
        productId: order.productId,
        applicationCredentialId: input.credentialId,
      });
      if (order.fulfillmentMode !== 'B' || order.mappingVersionId === null) {
        throw new DirectTopupConflictError('不是冻结的上力 B 模式订单');
      }
      const existing = tx.select().from(benefitOrderDirectTopups)
        .where(eq(benefitOrderDirectTopups.orderId, order.id)).get();
      if (existing) return { operation: toOperation(existing), created: false };
      if (order.status !== 'pending') {
        throw new OrderNotGrantableError('订单状态不允许 B 直充');
      }
      if (order.version !== input.order.version) {
        throw new OrderVersionConflictError('订单已变化');
      }
      tx.insert(benefitOrderDirectTopups).values({
        orderId: order.id,
        requestId: input.requestId,
        refCode: input.refCode,
        phoneHmac: input.phoneHmac,
        paymentReference: input.paymentReference,
        state: 'reserved',
        upstreamOrderNo: null,
        successCount: null,
        totalCount: null,
        itemsSummaryJson: null,
        lastVerifiedAt: null,
        attemptedAt: input.occurredAt,
        updatedAt: input.occurredAt,
      }).run();
      tx.update(benefitOrders).set({
        status: 'processing', version: order.version + 1, updatedAt: input.occurredAt,
      }).where(and(eq(benefitOrders.id, order.id),eq(benefitOrders.version,order.version))).run();
      tx.insert(benefitOrderStatusEvents).values({
        id: randomUUID(), orderId: order.id, status: 'processing',
        version: order.version + 1, createdAt: input.occurredAt,
      }).run();
      tx.insert(fulfillmentAttempts).values({
        id: randomUUID(), orderId: order.id, operation: 'grant',
        upstreamRequestNo: input.requestId, upstreamOrderNo: null,
        result: 'unknown', observedStatus: 'processing',
        occurredAt: input.occurredAt, lastVerifiedAt: null,
      }).run();
      const created = tx.select().from(benefitOrderDirectTopups)
        .where(eq(benefitOrderDirectTopups.orderId,order.id)).get();
      if (!created) throw new Error('B 预留记录丢失');
      return { operation: toOperation(created), created: true };
    }, { behavior: 'immediate' });
  }

  /** Only an explicitly observed partial result can be manually re-sent with
   * its ORIGINAL requestId. State transition is atomic under a write lock.
   * A timeout leaves unknown, never automatically reopens this lease.
   */
  function beginReissue(input: {
    order: BenefitOrder;
    credentialId?: string | null;
    occurredAt: number;
  }): DirectTopupOperation {
    return db.transaction((tx) => {
      const order = tx.select().from(benefitOrders).where(eq(benefitOrders.id,input.order.id)).get();
      if (!order) throw new OrderNotFoundError('订单不存在');
      assertApplicationWriteAccess(tx, {
        businessSource: order.businessSource,
        productId: order.productId,
        applicationCredentialId: input.credentialId,
      });
      if (order.version !== input.order.version) throw new OrderVersionConflictError('订单状态已变化');
      const current = tx.select().from(benefitOrderDirectTopups)
        .where(eq(benefitOrderDirectTopups.orderId,order.id)).get();
      if (!current || current.state !== 'partial' || order.status !== 'partially_completed') {
        throw new DirectTopupConflictError('仅允许对已确认部分成功的原单受控补发');
      }
      tx.update(benefitOrderDirectTopups).set({
        state: 'retrying', updatedAt: input.occurredAt,
      }).where(eq(benefitOrderDirectTopups.orderId,order.id)).run();
      tx.insert(fulfillmentAttempts).values({
        id: randomUUID(), orderId: order.id, operation: 'reissue',
        upstreamRequestNo: current.requestId,
        upstreamOrderNo: current.upstreamOrderNo,
        result: 'unknown', observedStatus: 'partially_completed',
        occurredAt: input.occurredAt, lastVerifiedAt: null,
      }).run();
      return toOperation({ ...current, state: 'retrying', updatedAt: input.occurredAt });
    }, { behavior: 'immediate' });
  }

  /** Atomic B outcome, order status and attempt record. No raw supplier payload
   * is stored. Recovery from timeout without vendor evidence stays unknown.
   */
  function settle(input: {
    orderId: string;
    kind: 'grant' | 'reissue';
    observed?: YangmaoOpenV1DirectTopupResult;
    definiteRejection?: boolean;
    occurredAt: number;
  }): { orderStatus: OrderStatus; operation: DirectTopupOperation } {
    return db.transaction((tx) => {
      const order = tx.select().from(benefitOrders).where(eq(benefitOrders.id,input.orderId)).get();
      const row = tx.select().from(benefitOrderDirectTopups)
        .where(eq(benefitOrderDirectTopups.orderId,input.orderId)).get();
      if (!order || !row) throw new OrderNotFoundError('B 直充订单不存在');
      if (row.state !== (input.kind === 'grant' ? 'reserved' : 'retrying')) {
        throw new DirectTopupConflictError('B 直充结果已结算，不能重复覆盖');
      }
      let state: DirectTopupState = 'unknown';
      let status: OrderStatus = input.kind === 'reissue' ? 'partially_completed' : 'unknown';
      if (input.observed) {
        if (row.upstreamOrderNo !== null && row.upstreamOrderNo !== input.observed.orderNo) {
          throw new DirectTopupConflictError('B 直充原上游订单号与补发返回不一致');
        }
        if (row.successCount !== null && input.observed.successCount < row.successCount) {
          throw new DirectTopupConflictError('补发不能倒退已成功的发券数');
        }
        if (row.totalCount !== null && input.observed.totalCount !== row.totalCount) {
          throw new DirectTopupConflictError('补发总券数与原结果不一致');
        }
        state = input.observed.allClaimed ? 'completed' : 'partial';
        status = input.observed.allClaimed ? 'completed' : 'partially_completed';
      } else if (input.definiteRejection && input.kind === 'grant') {
        state = 'rejected';
        status = 'failed';
      }
      const sanitizedItems = input.observed?.items.map((item) => ({
        ...(item.claimed === undefined ? {} : { claimed: item.claimed }),
        ...(item.status !== undefined &&
          /^(completed|failed|pending|processing|unknown|rejected)$/i.test(item.status)
          ? { status: item.status.toLowerCase() } : {}),
      }));
      // Every accepted supplier response gets its own append-only evidence.
      // Missing stable item IDs mean different snapshots MUST NOT be merged
      // based on array positions or shown as independent newly-issued cards.
      if (input.observed && sanitizedItems) {
        tx.insert(benefitOrderDirectTopupObservations).values({
          id: randomUUID(),
          orderId: input.orderId,
          operation: input.kind,
          upstreamOrderNo: input.observed.orderNo,
          successCount: input.observed.successCount,
          totalCount: input.observed.totalCount,
          itemsSummaryJson: JSON.stringify(sanitizedItems),
          observedAt: input.occurredAt,
        }).run();
      }
      const next = {
        state,
        updatedAt: input.occurredAt,
        ...(input.observed ? {
          upstreamOrderNo: normalizeUpstreamRef(input.observed.orderNo,'上游订单号'),
          successCount: input.observed.successCount,
          totalCount: input.observed.totalCount,
          // Never store raw supplier messages, voucher keys, or arbitrary fields.
          itemsSummaryJson: JSON.stringify(sanitizedItems),
          lastVerifiedAt: input.occurredAt,
        } : {}),
      };
      tx.update(benefitOrderDirectTopups).set(next)
        .where(eq(benefitOrderDirectTopups.orderId,input.orderId)).run();
      if (status !== order.status) {
        tx.update(benefitOrders).set({
          status, version: order.version + 1, updatedAt: input.occurredAt,
        }).where(eq(benefitOrders.id,input.orderId)).run();
        tx.insert(benefitOrderStatusEvents).values({
          id: randomUUID(), orderId: input.orderId, status,
          version: order.version + 1, createdAt: input.occurredAt,
        }).run();
      }
      tx.insert(fulfillmentAttempts).values({
        id: randomUUID(), orderId: input.orderId,
        operation: input.kind === 'grant' ? 'grant' : 'reissue',
        upstreamRequestNo: row.requestId,
        upstreamOrderNo: input.observed?.orderNo ?? row.upstreamOrderNo,
        result: input.observed ? 'accepted' : input.definiteRejection ? 'rejected' : 'unknown',
        observedStatus: status,
        occurredAt: input.occurredAt, lastVerifiedAt: input.observed ? input.occurredAt : null,
      }).run();
      const refreshed = tx.select().from(benefitOrderDirectTopups)
        .where(eq(benefitOrderDirectTopups.orderId,input.orderId)).get();
      if (!refreshed) throw new Error('B 结算记录丢失');
      const recorded = tx.select().from(benefitOrderDirectTopupObservations)
        .where(eq(benefitOrderDirectTopupObservations.orderId, input.orderId))
        .orderBy(asc(benefitOrderDirectTopupObservations.observedAt),
          asc(benefitOrderDirectTopupObservations.id)).all();
      return { orderStatus: status, operation: toOperation(refreshed, recorded) };
    }, { behavior: 'immediate' });
  }

  return { get, reserve, beginReissue, settle };
}
