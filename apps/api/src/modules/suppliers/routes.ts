import { Hono } from 'hono';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { requireRole, requireSession, type AppEnv } from '../../middleware/auth.js';
import { apiError, NO_STORE_HEADERS } from '../auth/http.js';
import { invalidRequest, issueFields, readJson } from '../http.js';
import {
  saveSupplierConnection,
  supplierConnectionEditorDto,
  supplierConnectionSummary,
  SupplierConnectionConflictError,
  SupplierConnectionInputError,
  SupplierCredentialUnavailableError,
} from './connection.js';

const configSchema = z.object({
  baseUrl: z.string().trim().url().max(240),
  appKey: z.string().min(1).max(256).optional(),
  appSecret: z.string().min(1).max(512).optional(),
  version: z.number().int().min(0),
}).strict();

/** Readable supplier registry plus admin-only encrypted credential management. */
export function createSupplierManagementRoutes(deps: {
  db: AppDatabase;
  config: AppConfig;
}): Hono<AppEnv> {
  const { db, config } = deps;
  const router = new Hono<AppEnv>();
  router.use('*', requireSession(db, config));
  const requireAdmin = requireRole('admin');

  router.get('/', (c) =>
    c.json({ suppliers: [supplierConnectionSummary(db, config)] }, 200, NO_STORE_HEADERS),
  );

  router.get('/yangmao', (c) =>
    c.json({ supplier: supplierConnectionSummary(db, config) }, 200, NO_STORE_HEADERS),
  );

  router.get('/yangmao/connection', requireAdmin, (c) =>
    c.json({ connection: supplierConnectionEditorDto(db, config) }, 200, NO_STORE_HEADERS),
  );

  router.put('/yangmao/connection', requireAdmin, async (c) => {
    const body = await readJson(c);
    if (!body.ok) return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    const parsed = configSchema.safeParse(body.value);
    if (!parsed.success) return c.json(invalidRequest('配置字段不正确', issueFields(parsed.error)), 400, NO_STORE_HEADERS);
    try {
      const saved = saveSupplierConnection(db, config, {
        ...parsed.data,
        actorId: c.get('admin').id,
      });
      return c.json({ connection: saved }, 200, NO_STORE_HEADERS);
    } catch (error) {
      if (error instanceof SupplierCredentialUnavailableError) {
        return c.json(apiError('SUPPLIER_KEY_UNAVAILABLE', '服务器加密密钥尚未配置，无法保存供应商凭证'), 503, NO_STORE_HEADERS);
      }
      if (error instanceof SupplierConnectionConflictError) {
        return c.json(apiError('SUPPLIER_CONNECTION_CONFLICT', '连接配置已经更新，请刷新后重试'), 409, NO_STORE_HEADERS);
      }
      if (error instanceof SupplierConnectionInputError) {
        return c.json(apiError('INVALID_REQUEST', '请检查测试 API 地址及凭证字段'), 400, NO_STORE_HEADERS);
      }
      throw error;
    }
  });

  return router;
}
