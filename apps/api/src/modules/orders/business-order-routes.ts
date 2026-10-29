import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  createBusinessOrderRequestSchema,
  createPrepaidGrantRequestSchema,
  businessOrderNoSchema,
  recoverPrepaidGrantRequestSchema,
  type BusinessOrderDto,
  type PrepaidGrantResponse,
} from '@sanchuang-dev/benefit-contracts';
import { YangmaoOpenV1Error } from '@sanchuang-dev/provider-yangmao';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import type { AppEnv } from '../../middleware/auth.js';
import { apiError, NO_STORE_HEADERS } from '../auth/http.js';
import { invalidRequest, issueFields, readJson } from '../http.js';
import {
  createPrepaidGrantService,
  PurchaseNotEligibleError,
  SupplierKeyUnavailableError,
  SupplierNotConfiguredError,
  type PrepaidGrantOutcome,
} from './a-prepaid-grant.js';
import {
  GrantInProgressError,
  GrantInputConflictError,
  GrantNotFoundError,
  GrantNotRetryableError,
  GrantStateConflictError,
  OrderApplicationDisabledError,
  OrderCredentialRevokedError,
  OrderInputError,
  OrderIntentConflictError,
  OrderMappingUnavailableError,
  OrderModeUnsupportedError,
  OrderNotFoundError,
  OrderNotGrantableError,
  OrderProductNotActiveError,
  OrderProductNotFoundError,
  OrderProductNotAuthorizedError,
  OrderVersionConflictError,
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

/** A-mode grant/recover subpaths are Bearer-authenticated machine writes. */
const BUSINESS_ORDER_GRANT_PATH =
  /^\/api\/v1\/business\/orders\/[A-Za-z0-9._:-]{1,128}\/(grant|recover)$/;

/**
 * Exact machine POST paths exempt from the browser double-submit CSRF token.
 * Every one of them requires a server-verified Bearer credential; no cookie
 * flow exists here. Keep in sync with `app.ts`.
 */
export function isBusinessMachinePostPath(path: string): boolean {
  return path === BUSINESS_ORDER_COLLECTION_PATH || BUSINESS_ORDER_GRANT_PATH.test(path);
}

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
  if (error instanceof OrderCredentialRevokedError) {
    return c.json(apiError('UNAUTHORIZED', '缺少或无效的服务凭证'), 401, NO_STORE_HEADERS);
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
  if (error instanceof OrderNotFoundError) {
    return c.json(apiError('ORDER_NOT_FOUND', '订单不存在'), 404, NO_STORE_HEADERS);
  }
  if (error instanceof OrderModeUnsupportedError) {
    return c.json(
      apiError('ORDER_MODE_UNSUPPORTED', '该订单冻结的履约模式不是上力 A 预充值礼包'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof OrderNotGrantableError) {
    return c.json(
      apiError('ORDER_NOT_GRANTABLE', '订单当前状态不允许发起上力下单'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof OrderVersionConflictError || error instanceof GrantStateConflictError) {
    return c.json(
      apiError('ORDER_STATE_CONFLICT', '订单或上力下单记录已变化，请重新查询后再操作'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof GrantInputConflictError) {
    return c.json(
      apiError('GRANT_INPUT_CONFLICT', '相同订单已用不同手机号或推广码发起过下单'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof GrantInProgressError) {
    return c.json(
      apiError('GRANT_IN_PROGRESS', '该订单的上力下单仍在处理中，请稍后取回结果'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof GrantNotRetryableError) {
    return c.json(
      apiError('GRANT_NOT_RETRYABLE', '该订单已被上力明确拒绝，不会自动重试'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof GrantNotFoundError) {
    return c.json(
      apiError('GRANT_NOT_FOUND', '该订单尚未发起过上力下单'),
      404,
      NO_STORE_HEADERS,
    );
  }
  throw error;
}

/**
 * Grant-specific failures. Anything not handled here is an existing order
 * failure, so the same stable mapping is reused instead of duplicated.
 */
function handleGrantError(c: Context<AppEnv>, error: unknown) {
  if (error instanceof PurchaseNotEligibleError) {
    return c.json(
      apiError('PURCHASE_NOT_ELIGIBLE', '该手机号存在限领或未领取权益，未发起上力下单'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof SupplierNotConfiguredError) {
    return c.json(
      apiError('SUPPLIER_NOT_CONFIGURED', '上力接口凭证尚未保存'),
      503,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof SupplierKeyUnavailableError) {
    return c.json(
      apiError('SUPPLIER_KEY_UNAVAILABLE', '上力凭证加密主密钥不可用，未发起上力下单'),
      503,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof YangmaoOpenV1Error) {
    // Only the observed numeric codes are echoed; vendor messages, payloads,
    // phone numbers and signatures never reach the caller.
    if (error.code === 'YANGMAO_OPEN_V1_TIMEOUT') {
      return c.json(
        apiError('SUPPLIER_TIMEOUT', '上力下单结果未知，不要重复下单；请用同一订单取回或核实'),
        504,
        NO_STORE_HEADERS,
      );
    }
    if (error.code === 'YANGMAO_OPEN_V1_AUTH_FAILED' || error.code === 'YANGMAO_OPEN_V1_FORBIDDEN') {
      return c.json(
        {
          ...apiError('SUPPLIER_AUTH_FAILED', '上力鉴权或权限被拒绝，未发起后续操作'),
          ...(error.vendorCode === undefined ? {} : { vendorCode: error.vendorCode }),
          ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
        },
        502,
        NO_STORE_HEADERS,
      );
    }
    if (error.code === 'YANGMAO_OPEN_V1_BUSINESS_FAILED') {
      return c.json(
        {
          ...apiError('SUPPLIER_BUSINESS_FAILED', '上力返回业务错误，未确认成功'),
          ...(error.vendorCode === undefined ? {} : { vendorCode: error.vendorCode }),
        },
        502,
        NO_STORE_HEADERS,
      );
    }
    if (error.code === 'YANGMAO_OPEN_V1_RESPONSE_INVALID') {
      return c.json(
        apiError('SUPPLIER_RESPONSE_UNVERIFIED', '上力响应格式与已确认字段不符，结果按未知处理'),
        502,
        NO_STORE_HEADERS,
      );
    }
    if (error.code === 'YANGMAO_OPEN_V1_CONFIG_INVALID') {
      return c.json(
        apiError('SUPPLIER_NOT_CONFIGURED', '上力接口配置无效'),
        503,
        NO_STORE_HEADERS,
      );
    }
    if (error.code === 'YANGMAO_OPEN_V1_PHONE_INVALID') {
      return c.json(invalidRequest('手机号格式不正确', ['phone']), 400, NO_STORE_HEADERS);
    }
    return c.json(
      {
        ...apiError('SUPPLIER_UNAVAILABLE', '上力请求失败或结果未知，请用同一订单核实'),
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      },
      502,
      NO_STORE_HEADERS,
    );
  }
  return handleOrderError(c, error);
}

function toPrepaidGrantResponse(outcome: PrepaidGrantOutcome): PrepaidGrantResponse {
  return {
    order: toBusinessOrderDto(outcome.order),
    grant: {
      state: outcome.grant.state,
      requestId: outcome.grant.requestId,
      upstreamOrderNo: outcome.grant.upstreamOrderNo,
      attemptedAt: outcome.grant.attemptedAt,
      updatedAt: outcome.grant.updatedAt,
    },
    ...(outcome.claimUrl === undefined ? {} : { claimUrl: outcome.claimUrl }),
    ...(outcome.observedAt === undefined ? {} : { observedAt: outcome.observedAt }),
  };
}

function readOrderId(c: Context<AppEnv>): string | null {
  const orderId = c.req.param('orderId');
  // Keep this identical to the CSRF-exempt path pattern so an accepted id can
  // never be rejected earlier by the browser-write gate.
  return typeof orderId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(orderId)
    ? orderId
    : null;
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
  const grantService = createPrepaidGrantService(deps);

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
        applicationCredentialId: c.get('businessCredentialId'),
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

  /**
   * BHB-012-C: execute an already-authorized paid A-mode intent. The caller
   * explicitly asserts payment/authorization with `paymentReference`; provider,
   * mode and upstream product code come only from the order's frozen mapping.
   */
  router.post('/:orderId/grant', async (c) => {
    const orderId = readOrderId(c);
    if (!orderId) {
      return c.json(invalidRequest('订单 ID 不正确', ['orderId']), 400, NO_STORE_HEADERS);
    }

    const body = await readJson(c);
    if (!body.ok) {
      return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    }
    const parsed = createPrepaidGrantRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(
        invalidRequest('上力下单参数不正确', issueFields(parsed.error)),
        400,
        NO_STORE_HEADERS,
      );
    }

    try {
      const outcome = await grantService.grant({
        businessSource: c.get('businessSource'),
        orderId,
        phone: parsed.data.phone,
        refCode: parsed.data.refCode,
        paymentReference: parsed.data.paymentReference,
        signal: c.req.raw.signal,
      });
      return c.json(toPrepaidGrantResponse(outcome), 200, NO_STORE_HEADERS);
    } catch (error) {
      return handleGrantError(c, error);
    }
  });

  /**
   * Read-only link recovery by the persisted requestId. It never re-sends the
   * debit, so a lost response can be resolved without a second quota deduction.
   */
  router.post('/:orderId/recover', async (c) => {
    const orderId = readOrderId(c);
    if (!orderId) {
      return c.json(invalidRequest('订单 ID 不正确', ['orderId']), 400, NO_STORE_HEADERS);
    }

    const body = await readJson(c);
    if (!body.ok) {
      return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    }
    const parsed = recoverPrepaidGrantRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(
        invalidRequest('恢复参数不正确', issueFields(parsed.error)),
        400,
        NO_STORE_HEADERS,
      );
    }

    try {
      const outcome = await grantService.recover({
        businessSource: c.get('businessSource'),
        orderId,
        signal: c.req.raw.signal,
      });
      return c.json(toPrepaidGrantResponse(outcome), 200, NO_STORE_HEADERS);
    } catch (error) {
      return handleGrantError(c, error);
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
