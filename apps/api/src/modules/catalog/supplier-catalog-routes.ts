import type { Context } from 'hono';
import { Hono } from 'hono';
import { YangmaoInriceError } from '@sanchuang-dev/provider-yangmao';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { logEvent } from '../../log.js';
import { activeYangmaoReadConfig, SupplierCredentialUnavailableError } from '../suppliers/connection.js';
import { requireSession, type AppEnv } from '../../middleware/auth.js';
import { apiError, NO_STORE_HEADERS } from '../auth/http.js';
import {
  createYangmaoInriceReader,
  toSupplierCatalogDto,
  toSupplierProductDetailDto,
} from './supplier-catalog.js';

/**
 * Stable failure semantics for a read-only supplier catalogue. No DTO, error
 * message or log line carries credentials, signatures, raw vendor bodies or
 * vendor product details; only the stable internal error code is logged.
 */
function handleSupplierReadError(c: Context<AppEnv>, error: unknown) {
  if (!(error instanceof YangmaoInriceError)) throw error;

  logEvent('supplier_catalog.read_failed', {
    provider: 'yangmao',
    code: error.code,
    httpStatus: error.httpStatus ?? null,
    vendorCode: error.vendorCode ?? null,
  });

  switch (error.code) {
    case 'YANGMAO_INRICE_PRODUCT_CODE_INVALID':
      return c.json(apiError('INVALID_REQUEST', '商品编码不正确'), 400, NO_STORE_HEADERS);
    case 'YANGMAO_INRICE_CONFIG_INVALID':
      return c.json(
        apiError('SUPPLIER_NOT_CONFIGURED', '上力供应商商品读取尚未配置'),
        503,
        NO_STORE_HEADERS,
      );
    case 'YANGMAO_INRICE_AUTH_FAILED':
      return c.json(
        apiError('SUPPLIER_AUTH_FAILED', '上力供应商鉴权失败，请联系管理员检查只读凭证'),
        502,
        NO_STORE_HEADERS,
      );
    case 'YANGMAO_INRICE_FORBIDDEN':
      return c.json(
        apiError('SUPPLIER_FORBIDDEN', '上力供应商拒绝访问，请联系管理员检查只读凭证'),
        502,
        NO_STORE_HEADERS,
      );
    case 'YANGMAO_INRICE_TIMEOUT':
      return c.json(
        apiError('SUPPLIER_TIMEOUT', '上力供应商响应超时，请稍后重试'),
        504,
        NO_STORE_HEADERS,
      );
    default:
      // HTTP, business, malformed-response and transport failures are all
      // non-success reads. They must never be rendered as an empty catalogue.
      return c.json(
        apiError('SUPPLIER_READ_FAILED', '上力供应商商品读取失败，请稍后重试'),
        502,
        NO_STORE_HEADERS,
      );
  }
}

/**
 * Minimal same-origin read surface for the supplier products tab. It only
 * forwards to the existing server-only Yangmao D adapter; it never accepts a
 * caller-supplied URL/host, never dispatches, and never persists the result.
 * Credentials come exclusively from server environment configuration, and a
 * missing/incomplete configuration fails explicitly instead of returning [].
 */
export function createSupplierCatalogRoutes(deps: {
  db: AppDatabase;
  config: AppConfig;
}): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const requireAuthenticated = requireSession(deps.db, deps.config);

  const unconfigured = () =>
    apiError(
      'SUPPLIER_NOT_CONFIGURED',
      '上力商品查询尚未配置；请在供应商管理中保存接入凭证后重试',
    );

  router.get('/supplier-products', requireAuthenticated, async (c) => {
    try {
      const reader = createYangmaoInriceReader(activeYangmaoReadConfig(deps.db, deps.config));
      if (!reader) return c.json(unconfigured(), 503, NO_STORE_HEADERS);
      const catalog = await reader.listProducts({ signal: c.req.raw.signal });
      return c.json(toSupplierCatalogDto(catalog), 200, NO_STORE_HEADERS);
    } catch (error) {
      if (error instanceof SupplierCredentialUnavailableError) {
        return c.json(apiError('SUPPLIER_KEY_UNAVAILABLE', '已存储的供应商凭证暂不可读取，请联系管理员核实服务器加密密钥'), 503, NO_STORE_HEADERS);
      }
      return handleSupplierReadError(c, error);
    }
  });

  router.get('/supplier-products/:productCode', requireAuthenticated, async (c) => {
    try {
      const reader = createYangmaoInriceReader(activeYangmaoReadConfig(deps.db, deps.config));
      if (!reader) return c.json(unconfigured(), 503, NO_STORE_HEADERS);
      const detail = await reader.getProductDetail(c.req.param('productCode'), {
        signal: c.req.raw.signal,
      });
      return c.json({ product: toSupplierProductDetailDto(detail) }, 200, NO_STORE_HEADERS);
    } catch (error) {
      if (error instanceof SupplierCredentialUnavailableError) {
        return c.json(apiError('SUPPLIER_KEY_UNAVAILABLE', '已存储的供应商凭证暂不可读取，请联系管理员核实服务器加密密钥'), 503, NO_STORE_HEADERS);
      }
      return handleSupplierReadError(c, error);
    }
  });

  return router;
}
