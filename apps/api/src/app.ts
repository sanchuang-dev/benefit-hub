import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { AppConfig } from './config.js';
import type { AppDatabase } from './db/client.js';
import { logEvent } from './log.js';
import type { AppEnv } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { createAdminAccountRoutes } from './modules/auth/admin-routes.js';
import { apiError } from './modules/auth/http.js';
import { createAuthRoutes } from './modules/auth/routes.js';

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
    return c.json(apiError('INTERNAL_ERROR', '服务器内部错误'), 500);
  });

  app.use(
    '/api/v1/*',
    secureHeaders({
      xFrameOptions: 'DENY',
      xContentTypeOptions: 'nosniff',
      referrerPolicy: 'no-referrer',
    }),
  );
  app.use('/api/v1/*', csrfProtection());

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

  app.all('/api/*', (c) => c.json(apiError('NOT_FOUND', '接口不存在'), 404));

  return app;
}
