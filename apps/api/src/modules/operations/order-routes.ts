import { Hono } from 'hono';
import { z } from 'zod';
import {
  BUSINESS_ORDER_NO_PATTERN,
  directTopupReissueRequestSchema,
  BUSINESS_SOURCE_PATTERN,
  OPERATIONS_ORDER_PAGE_SIZES,
  orderStatusSchema,
  type OperationsOrderDetailDto,
  type OperationsOrderListItemDto,
  type OperationsOrderPageSize,
} from '@sanchuang-dev/benefit-contracts';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { requireRole, requireSession, type AppEnv } from '../../middleware/auth.js';
import { NO_STORE_HEADERS, apiError, invalidRequest, issueFields, readJson } from '../http.js';
import { createDirectTopupService } from '../orders/b-direct-topup.js';
import { handleDirectTopupError } from '../orders/business-order-routes.js';
import {
  createBenefitOrderRepository,
  type OperationsOrderDetail,
  type OperationsOrderListRow,
} from '../orders/repository.js';

/**
 * UTC epoch milliseconds. Empty, signed, fractional or unsafe values are
 * rejected instead of silently becoming an unbounded query.
 */
const utcMillisSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})$/, '时间需为 UTC 毫秒时间戳')
  .transform((value) => Number(value))
  .refine(
    (value) => Number.isSafeInteger(value) && value >= 0,
    '时间需为安全的 UTC 毫秒时间戳',
  );

/**
 * Every filter is optional and independent. `pageSize` is restricted to the
 * documented 10/20/50 set, and an inverted time range fails explicitly rather
 * than returning a misleading empty page.
 */
const listQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000_000).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .refine(
        (value): value is OperationsOrderPageSize =>
          (OPERATIONS_ORDER_PAGE_SIZES as readonly number[]).includes(value),
        '每页条数需为 10/20/50',
      )
      .default(20),
    businessSource: z.string().trim().toLowerCase().regex(BUSINESS_SOURCE_PATTERN).optional(),
    businessOrderNo: z.string().trim().regex(BUSINESS_ORDER_NO_PATTERN).optional(),
    status: orderStatusSchema.optional(),
    createdFrom: utcMillisSchema.optional(),
    createdTo: utcMillisSchema.optional(),
  })
  .refine(
    (value) =>
      value.createdFrom === undefined ||
      value.createdTo === undefined ||
      value.createdFrom <= value.createdTo,
    { path: ['createdTo'], message: '结束时间不能早于开始时间' },
  );

function toListItemDto(row: OperationsOrderListRow): OperationsOrderListItemDto {
  const { order } = row;
  return {
    id: order.id,
    businessSource: order.businessSource,
    businessOrderNo: order.businessOrderNo,
    productId: order.productId,
    // Joined at read time: this is the product's current name, not a snapshot.
    productName: row.currentProductName,
    status: order.status,
    version: order.version,
    fulfillmentMode: order.fulfillmentMode,
    mappingVersionId: order.mappingVersionId,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function toDetailDto(detail: OperationsOrderDetail): OperationsOrderDetailDto {
  const { order } = detail;
  return {
    id: order.id,
    businessSource: order.businessSource,
    businessOrderNo: order.businessOrderNo,
    productId: order.productId,
    status: order.status,
    version: order.version,
    fulfillmentMode: order.fulfillmentMode,
    mappingVersionId: order.mappingVersionId,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    product: {
      id: detail.currentProduct.id,
      code: detail.currentProduct.code,
      name: detail.currentProduct.name,
      status: detail.currentProduct.status,
    },
    // Only the order's own immutable snapshot is exposed; never the product's
    // current active mapping, which may have rotated since creation.
    frozenMapping: detail.frozenMapping
      ? {
          id: detail.frozenMapping.id,
          mappingId: detail.frozenMapping.mappingId,
          versionNumber: detail.frozenMapping.versionNumber,
          provider: detail.frozenMapping.provider,
          productCode: detail.frozenMapping.productCode,
          fulfillmentMode: detail.frozenMapping.fulfillmentMode,
          deductionUnit: detail.frozenMapping.deductionUnit,
          activatedAt: detail.frozenMapping.activatedAt,
        }
      : null,
    grant: detail.grant
      ? {
          state: detail.grant.state,
          requestId: detail.grant.requestId,
          upstreamOrderNo: detail.grant.upstreamOrderNo,
          attemptedAt: detail.grant.attemptedAt,
          updatedAt: detail.grant.updatedAt,
        }
      : null,
    directTopup: detail.directTopup,
    giftVoucher: detail.giftVoucher
      ? {
          state: detail.giftVoucher.state,
          requestId: detail.giftVoucher.requestId,
          packCount: detail.giftVoucher.packCount,
          packTotal: detail.giftVoucher.packTotal,
          packRemaining: detail.giftVoucher.packRemaining,
          attemptedAt: detail.giftVoucher.attemptedAt,
          updatedAt: detail.giftVoucher.updatedAt,
          lastObservedAt: detail.giftVoucher.lastObservedAt,
        }
      : null,
    statusEvents: detail.statusEvents.map((event) => ({
      id: event.id,
      status: event.status,
      version: event.version,
      createdAt: event.createdAt,
    })),
    attempts: detail.attempts.map((attempt) => ({
      id: attempt.id,
      operation: attempt.operation,
      result: attempt.result,
      observedStatus: attempt.observedStatus,
      upstreamRequestNo: attempt.upstreamRequestNo,
      upstreamOrderNo: attempt.upstreamOrderNo,
      occurredAt: attempt.occurredAt,
      lastVerifiedAt: attempt.lastVerifiedAt,
    })),
  };
}

/**
 * Platform-local order operations reads (BHB-013-B1).
 *
 * Both routes require a valid admin session cookie; a machine service Bearer is
 * never consulted and therefore cannot become operator authorization. Reads are
 * side-effect free, cross-source by design (operators see every business),
 * `no-store`, and limited to persisted local facts. Nothing here calls a
 * supplier, changes an order, or claims that a local intent equals delivery.
 */
export function createOperationsOrderRoutes(deps: {
  db: AppDatabase;
  config: AppConfig;
}): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const repository = createBenefitOrderRepository(deps.db);
  const topupService = createDirectTopupService(deps);
  const requireAuthenticated = requireSession(deps.db, deps.config);

  router.get('/orders', requireAuthenticated, (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        invalidRequest('查询参数不正确', issueFields(parsed.error)),
        400,
        NO_STORE_HEADERS,
      );
    }

    const result = repository.listForOperations({
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      // Stored sources are normalized to lower case; the query schema accepts
      // operator input in any case instead of silently matching nothing.
      businessSource: parsed.data.businessSource,
      businessOrderNo: parsed.data.businessOrderNo,
      status: parsed.data.status,
      createdFrom: parsed.data.createdFrom,
      createdTo: parsed.data.createdTo,
    });

    return c.json(
      {
        orders: result.orders.map(toListItemDto),
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        total: result.total,
      },
      200,
      NO_STORE_HEADERS,
    );
  });

  router.get('/orders/:orderId', requireAuthenticated, (c) => {
    // Path ids are opaque internal identifiers, not free text. Rejecting a
    // malformed id explicitly avoids the repository's input error surfacing as
    // a generic 500 while still not confirming whether any order exists.
    const orderId = z.string().trim().min(1).max(128).safeParse(c.req.param('orderId'));
    if (!orderId.success) {
      return c.json(invalidRequest('订单 ID 不正确', ['orderId']), 400, NO_STORE_HEADERS);
    }

    const detail = repository.getForOperations(orderId.data);
    if (!detail) {
      return c.json(apiError('ORDER_NOT_FOUND', '订单不存在'), 404, NO_STORE_HEADERS);
    }
    return c.json({ order: toDetailDto(detail) }, 200, NO_STORE_HEADERS);
  });

  /**
   * Admin-only, CSRF-protected manual reissue. A second vendor write is
   * impossible until the persisted result is explicitly partial, the exact
   * original recipient/payment match, and both server-side B write gates pass.
   * This route never accepts the upstream requestId from the browser.
   */
  router.post('/orders/:orderId/direct-topup/reissue', requireAuthenticated,
    requireRole('admin'), async (c) => {
      const orderId = z.string().trim().min(1).max(128).safeParse(c.req.param('orderId'));
      if (!orderId.success) {
        return c.json(invalidRequest('订单 ID 不正确', ['orderId']), 400, NO_STORE_HEADERS);
      }
      const body = await readJson(c);
      if (!body.ok) return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
      const parsed = directTopupReissueRequestSchema.safeParse(body.value);
      if (!parsed.success) {
        return c.json(invalidRequest('补发参数不正确', issueFields(parsed.error)), 400, NO_STORE_HEADERS);
      }
      const detail = repository.getForOperations(orderId.data);
      if (!detail) return c.json(apiError('ORDER_NOT_FOUND', '订单不存在'), 404, NO_STORE_HEADERS);
      try {
        await topupService.reissue({
          businessSource: detail.order.businessSource, orderId: orderId.data,
          phone: parsed.data.phone, refCode: parsed.data.refCode,
          paymentReference: parsed.data.paymentReference, signal: c.req.raw.signal,
        });
        const refreshed = repository.getForOperations(orderId.data);
        if (!refreshed) throw new Error('B 直充补发订单不存在');
        return c.json({ order: toDetailDto(refreshed) }, 200, NO_STORE_HEADERS);
      } catch (error) {
        return handleDirectTopupError(c, error);
      }
    });

  return router;
}
