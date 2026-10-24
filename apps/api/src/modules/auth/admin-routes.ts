import { Hono } from 'hono';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { requireRole, requireSession, type AppEnv } from '../../middleware/auth.js';
import { listAccounts } from './accounts.js';
import { recordAuthEvent } from './audit.js';
import { NO_STORE_HEADERS } from './http.js';

/**
 * Minimal admin-only surface for account listing. Management writes use the
 * admin CLI; catalogue writes (BHB-003) reuse the same
 * `requireSession` + `requireRole('admin')` chain instead of a new identity
 * system.
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
