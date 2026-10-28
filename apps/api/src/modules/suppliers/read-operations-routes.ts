import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { createYangmaoOpenV1Client, YangmaoOpenV1Error } from '@sanchuang-dev/provider-yangmao';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { requireRole, requireSession, type AppEnv } from '../../middleware/auth.js';
import { apiError, NO_STORE_HEADERS } from '../auth/http.js';
import { invalidRequest, issueFields, readJson } from '../http.js';
import { activeYangmaoReadConfig, SupplierCredentialUnavailableError } from './connection.js';

/**
 * Three documented vendor READ operations behind existing admin authentication.
 * They never create an order, voucher or dispatch; using POST here is only
 * to keep phone/order/voucher identifiers out of browser URLs and access logs.
 */
const eligibilityInput = z.object({ phone: z.string().regex(/^1\d{10}$/) }).strict();
const prepaidQueryInput = z.object({ requestId: z.string().regex(/^[!-~]{1,64}$/) }).strict();
const voucherQueryInput = z.object({ code: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/) }).strict();

function readFailure(c: Context<AppEnv>, error: unknown) {
  if (error instanceof SupplierCredentialUnavailableError) {
    return c.json(apiError('SUPPLIER_KEY_UNAVAILABLE', '上力凭证加密主密钥不可用'), 503, NO_STORE_HEADERS);
  }
  if (!(error instanceof YangmaoOpenV1Error)) throw error;
  if (error.code === 'YANGMAO_OPEN_V1_TIMEOUT') {
    return c.json(apiError('SUPPLIER_TIMEOUT', '上力只读查询超时，不代表查询结果为空'), 504, NO_STORE_HEADERS);
  }
  if (error.code === 'YANGMAO_OPEN_V1_RESPONSE_INVALID') {
    return c.json(apiError('SUPPLIER_RESPONSE_UNVERIFIED', '上力响应格式与已确认字段不符，请核对接口合同'), 502, NO_STORE_HEADERS);
  }
  if (error.code === 'YANGMAO_OPEN_V1_AUTH_FAILED' || error.code === 'YANGMAO_OPEN_V1_FORBIDDEN') {
    return c.json({ ...apiError('SUPPLIER_AUTH_FAILED', '上力鉴权或权限被拒'), vendorCode: error.vendorCode ?? null }, 502, NO_STORE_HEADERS);
  }
  if (error.code === 'YANGMAO_OPEN_V1_BUSINESS_FAILED') {
    // Only the observed numeric upstream code is safe to expose; never leak vendor
    // message, personal data, request bodies, signatures or voucher codes.
    return c.json({ ...apiError('SUPPLIER_BUSINESS_FAILED', '上力返回业务错误'), vendorCode: error.vendorCode ?? null }, 502, NO_STORE_HEADERS);
  }
  return c.json(apiError('SUPPLIER_READ_FAILED', '上力只读查询失败'), 502, NO_STORE_HEADERS);
}

export function createSupplierReadOperationRoutes(deps: {
  db: AppDatabase;
  config: AppConfig;
}): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.use('*', requireSession(deps.db, deps.config), requireRole('admin'));

  async function execute<T extends z.ZodTypeAny>(
    c: Context<AppEnv>,
    input: T,
    operation: (client: ReturnType<typeof createYangmaoOpenV1Client>, data: z.infer<T>) => Promise<unknown>,
    responseKey: 'eligibility' | 'order' | 'voucher',
  ) {
    const body = await readJson(c);
    if (!body.ok) return c.json(invalidRequest('请求格式错误'), 400, NO_STORE_HEADERS);
    const parsed = input.safeParse(body.value);
    if (!parsed.success) return c.json(invalidRequest('字段无效', issueFields(parsed.error)), 400, NO_STORE_HEADERS);
    try {
      const config = activeYangmaoReadConfig(deps.db, deps.config);
      if (!config) {
        return c.json(apiError('SUPPLIER_NOT_CONFIGURED', '上力接口凭证尚未保存'), 503, NO_STORE_HEADERS);
      }
      const client = createYangmaoOpenV1Client(config);
      const result = await operation(client, parsed.data);
      return c.json({ [responseKey]: result }, 200, NO_STORE_HEADERS);
    } catch (error) {
      return readFailure(c, error);
    }
  }

  router.post('/yangmao/purchase-check', (c) =>
    execute(c, eligibilityInput, (client, data) => client.checkPurchase(data.phone, { signal: c.req.raw.signal }), 'eligibility'),
  );
  router.post('/yangmao/prepaid/orders/query', (c) =>
    execute(c, prepaidQueryInput, (client, data) => client.queryPrepaidOrder(data.requestId, { signal: c.req.raw.signal }), 'order'),
  );
  router.post('/yangmao/gift-vouchers/query', (c) =>
    execute(c, voucherQueryInput, (client, data) => client.queryGiftVoucher(data.code, { signal: c.req.raw.signal }), 'voucher'),
  );

  return router;
}
