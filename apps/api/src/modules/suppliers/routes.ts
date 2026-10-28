import { Hono } from 'hono';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { requireSession, type AppEnv } from '../../middleware/auth.js';
import { NO_STORE_HEADERS } from '../auth/http.js';

/**
 * Operational provider registration is not the same as a live provider probe.
 * A complete server-side credential configuration establishes only that a
 * signed read can be attempted, not that a vendor call has succeeded.
 */
function yangmaoSummary(config: AppConfig) {
  return {
    key: 'yangmao' as const,
    name: '上力',
    catalogRead: {
      supported: true,
      configured: config.yangmaoInrice !== null,
    },
    fulfillmentEnabled: false,
  };
}

/** Read-only supplier registry; no secret, remote URL, or vendor call escapes. */
export function createSupplierManagementRoutes(deps: {
  db: AppDatabase;
  config: AppConfig;
}): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.use('*', requireSession(deps.db, deps.config));

  router.get('/', (c) =>
    c.json({ suppliers: [yangmaoSummary(deps.config)] }, 200, NO_STORE_HEADERS),
  );

  router.get('/yangmao', (c) =>
    c.json({ supplier: yangmaoSummary(deps.config) }, 200, NO_STORE_HEADERS),
  );

  return router;
}
