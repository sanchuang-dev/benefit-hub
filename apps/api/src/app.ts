import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { AppConfig } from './config.js';
import type { AppDatabase } from './db/client.js';
import { logEvent } from './log.js';
import type { AppEnv } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { createAdminAccountRoutes } from './modules/auth/admin-routes.js';
import { apiError, NO_STORE_HEADERS } from './modules/auth/http.js';
import { createAuthRoutes } from './modules/auth/routes.js';
import { createCatalogMappingRoutes } from './modules/catalog/mapping-routes.js';
import { createCatalogRoutes } from './modules/catalog/routes.js';
import { createSupplierCatalogRoutes } from './modules/catalog/supplier-catalog-routes.js';
import { createSupplierManagementRoutes } from './modules/suppliers/routes.js';
import {
  BUSINESS_ORDER_COLLECTION_PATH,
  createBusinessOrderRoutes,
} from './modules/orders/business-order-routes.js';

export interface AppDependencies {
  db: AppDatabase;
  config: AppConfig;
}

/**
 * HTTP surface assembly. Route modules own their validation and authorization;
 * this factory only wires middleware and the small public metadata endpoints.
 */
export function createApp(deps: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    // Do not return stack traces or SQL to the client; keep details server-side.
    logEvent('request.error', { path: c.req.path, name: error.name });
    return c.json(apiError('INTERNAL_ERROR', '服务器内部错误'), 500, NO_STORE_HEADERS);
  });

  app.use(
    '*',
    secureHeaders({
      xFrameOptions: 'DENY',
      xContentTypeOptions: 'nosniff',
      referrerPolicy: 'no-referrer',
    }),
  );
  app.use(
    '/api/v1/*',
    csrfProtection({
      // Only the machine-to-machine order collection POST is exempt: it is
      // authenticated by a server-side Bearer service credential on every
      // request and has no browser cookie flow to protect. Every other API
      // write, including all admin/cookie mutations, keeps the CSRF gate.
      isExempt: (c) =>
        c.req.method === 'POST' && c.req.path === BUSINESS_ORDER_COLLECTION_PATH,
    }),
  );

  app.get('/healthz', (c) => {
    try {
      deps.db.run(sql`SELECT 1`);
    } catch {
      logEvent('health.database_unavailable');
      return c.json({ status: 'error', service: 'benefit-hub' }, 503);
    }
    return c.json({ status: 'ok', service: 'benefit-hub' });
  });

  app.get('/api/v1/system/status', (c) =>
    c.json({
      service: 'benefit-hub',
      phase: 'auth-enabled',
      // Supplier fulfillment stays disabled until a separately authorized slice.
      vendorFulfillmentEnabled: false,
      adminEnabled: true,
      authenticationRequired: true,
    }),
  );

  app.route('/api/v1/auth', createAuthRoutes(deps));
  app.route('/api/v1/admin', createAdminAccountRoutes(deps));
  app.route('/api/v1/catalog', createCatalogRoutes(deps));
  app.route('/api/v1/catalog', createCatalogMappingRoutes(deps));
  app.route('/api/v1/catalog', createSupplierCatalogRoutes(deps));
  app.route('/api/v1/suppliers', createSupplierManagementRoutes(deps));
  app.route('/api/v1/business/orders', createBusinessOrderRoutes(deps));

  app.all('/api/*', (c) => c.json(apiError('NOT_FOUND', '接口不存在'), 404));

  return app;
}
