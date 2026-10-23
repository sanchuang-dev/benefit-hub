import { Hono } from 'hono';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { requireRole, requireSession, type AppEnv } from '../../middleware/auth.js';
import { listAccounts } from './accounts.js';
import { recordAuthEvent } from './audit.js';
import { NO_STORE_HEADERS } from './http.js';

/**
 * Minimal admin-only surface. It is deliberately read-only: this slice has no
 * management write API yet, and the next slice must gate future writes with the
 * same `requireSession` + `requireRole('admin')` chain.
 */
export function createAdminAccountRoutes(deps: { db: AppDatabase; config: AppConfig }): Hono<AppEnv> {
  const { db, config } = deps;
  const router = new Hono<AppEnv>();

  router.get('/accounts', requireSession(db, config), requireRole('admin'), (c) => {
    recordAuthEvent(db, 'admin_accounts.listed', { accountId: c.get('admin').id });
    return c.json({ accounts: listAccounts(db) }, 200, NO_STORE_HEADERS);
  });

  return router;
}
