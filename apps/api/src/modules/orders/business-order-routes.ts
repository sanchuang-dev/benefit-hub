import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  createBusinessOrderRequestSchema,
  businessOrderNoSchema,
  type BusinessOrderDto,
} from '@sanchuang-dev/benefit-contracts';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import type { AppEnv } from '../../middleware/auth.js';
import { apiError, NO_STORE_HEADERS } from '../auth/http.js';
import { invalidRequest, issueFields, readJson } from '../http.js';
import {
  OrderApplicationDisabledError,
  OrderInputError,
  OrderIntentConflictError,
  OrderMappingUnavailableError,
  OrderProductNotActiveError,
  OrderProductNotFoundError,
  OrderProductNotAuthorizedError,
  type BenefitOrder,
} from './benefit-orders.js';
import { createBenefitOrderRepository } from './repository.js';
import { requireBusinessClient } from './service-auth.js';

/**
 * Exact path whose Bearer-authenticated POST is exempt from the browser
 * double-submit CSRF token. Keep this in sync with `app.ts`; every other write
 * keeps the global CSRF gate.
 */
export const BUSINESS_ORDER_COLLECTION_PATH = '/api/v1/business/orders';

function toBusinessOrderDto(order: BenefitOrder): BusinessOrderDto {
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
  };
}

/**
 * Maps the existing order Repository errors to stable HTTP semantics. Messages
 * never echo the submitted body, another business's data or provider content;
 * genuinely unknown failures reach the global non-leaking 500 handler.
 */
function handleOrderError(c: Context<AppEnv>, error: unknown) {
  if (error instanceof OrderInputError) {
    return c.json(apiError('INVALID_REQUEST', error.message), 400, NO_STORE_HEADERS);
  }
  if (error instanceof OrderIntentConflictError) {
    return c.json(
      apiError('ORDER_INTENT_CONFLICT', '相同业务单号已存在且商品不同，未覆盖已有订单'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof OrderProductNotFoundError) {
    return c.json(apiError('PRODUCT_NOT_FOUND', '内部商品不存在'), 404, NO_STORE_HEADERS);
  }
  if (error instanceof OrderProductNotActiveError) {
    return c.json(
      apiError('PRODUCT_NOT_ACTIVE', '内部商品已停用，不能创建新订单'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof OrderApplicationDisabledError) {
    return c.json(
      apiError('APPLICATION_DISABLED', '应用已停用，不能创建新订单'),
      403,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof OrderProductNotAuthorizedError) {
    return c.json(
      apiError('PRODUCT_NOT_AUTHORIZED', '该应用未被授权使用此内部商品'),
      403,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof OrderMappingUnavailableError) {
    return c.json(
      apiError('ORDER_MAPPING_UNAVAILABLE', '内部商品尚无生效供应商映射，不能创建新订单'),
      409,
      NO_STORE_HEADERS,
    );
  }
  throw error;
}

/**
 * Reads the recovery query strictly: exactly one `businessOrderNo` and no other
 * parameter. In particular a caller cannot smuggle `businessSource`,
 * `fulfillmentMode` or `productId` into a read and hope they are honored.
 */
function readBusinessOrderNoQuery(
  c: Context<AppEnv>,
): { ok: true; value: string } | { ok: false; fields: string[] } {
  const params = new URL(c.req.url).searchParams;
  const unknown = [...new Set([...params.keys()].filter((key) => key !== 'businessOrderNo'))];
  if (unknown.length > 0) return { ok: false, fields: unknown };

  const values = params.getAll('businessOrderNo');
  if (values.length !== 1) return { ok: false, fields: ['businessOrderNo'] };

  const parsed = businessOrderNoSchema.safeParse(values[0]);
  if (!parsed.success) return { ok: false, fields: ['businessOrderNo'] };
  return { ok: true, value: parsed.data };
}

/**
 * Downstream business order intake (BHB-012-A / BHB-014-B).
 *
 * This surface only records a local order *intent*: creation is always
 * `pending`, never calls a supplier, and never deducts balance or dispatches a
 * benefit. All reads are scoped to the business source bound to the presented
 * service credential, so a second client cannot discover another business's
 * order even by guessing an internal id or business order number.
 *
 * The credential may be an application-issued Bearer persisted as a digest by
 * the admin console, or a legacy environment client; both resolve to exactly one
 * `businessSource`. Registered applications are additionally constrained by
 * their enabled state and product allowlist inside the create transaction.
 */
export function createBusinessOrderRoutes(deps: {
  db: AppDatabase;
  config: AppConfig;
}): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const repository = createBenefitOrderRepository(deps.db);

  // Machine credential first: no admin cookie/session is consulted at all.
  router.use('*', requireBusinessClient(deps.db, deps.config));

  router.post('/', async (c) => {
    const body = await readJson(c);
    if (!body.ok) {
      return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    }

    const parsed = createBusinessOrderRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(
        invalidRequest('业务订单参数不正确', issueFields(parsed.error)),
        400,
        NO_STORE_HEADERS,
      );
    }

    try {
      const result = repository.createOrGetIntent({
        // The only trusted source of caller identity is the verified credential.
        businessSource: c.get('businessSource'),
        businessOrderNo: parsed.data.businessOrderNo,
        productId: parsed.data.productId,
      });
      return c.json(
        { order: toBusinessOrderDto(result.order), created: result.created },
        result.created ? 201 : 200,
        NO_STORE_HEADERS,
      );
    } catch (error) {
      return handleOrderError(c, error);
    }
  });

  router.get('/', (c) => {
    const query = readBusinessOrderNoQuery(c);
    if (!query.ok) {
      return c.json(
        invalidRequest('查询参数不正确', query.fields),
        400,
        NO_STORE_HEADERS,
      );
    }

    try {
      const order = repository.findByIdentity(c.get('businessSource'), query.value);
      if (!order) {
        // Same response for "never existed" and "belongs to another business".
        return c.json(apiError('ORDER_NOT_FOUND', '订单不存在'), 404, NO_STORE_HEADERS);
      }
      return c.json({ order: toBusinessOrderDto(order) }, 200, NO_STORE_HEADERS);
    } catch (error) {
      return handleOrderError(c, error);
    }
  });

  router.get('/:orderId', (c) => {
    const orderId = c.req.param('orderId');

    try {
      const order = repository.getById(orderId);
      if (!order || order.businessSource !== c.get('businessSource')) {
        return c.json(apiError('ORDER_NOT_FOUND', '订单不存在'), 404, NO_STORE_HEADERS);
      }
      return c.json({ order: toBusinessOrderDto(order) }, 200, NO_STORE_HEADERS);
    } catch (error) {
      return handleOrderError(c, error);
    }
  });

  return router;
}
