import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { SystemRuntimeDto } from '@sanchuang-dev/benefit-contracts';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { requireSession, type AppEnv } from '../../middleware/auth.js';
import { NO_STORE_HEADERS } from '../http.js';
import {
  LOGIN_FAILURE_PER_ACCOUNT,
  LOGIN_FAILURE_PER_ADDRESS,
  LOGIN_FAILURE_WINDOW_MINUTES,
  PASSWORD_POLICY,
} from '../auth/policy.js';

/**
 * Process start, not module load relative to a request: `process.uptime()` is
 * monotonic enough for an operator reading "已运行", and computing it once keeps
 * two responses from drifting by a second.
 */
export const SERVER_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000);

const HOUR_MS = 3_600_000;

/**
 * Read-only runtime snapshot for the platform-governance page.
 *
 * This router deliberately returns configuration *facts*, not configuration
 * values: credential presence becomes a boolean, the downstream client map
 * becomes a count, and the build stamp is nullable. No secret, database path or
 * supplier endpoint ever crosses this boundary. It requires a session because
 * capability flags still describe the running deployment.
 */
export function createSystemRuntimeRoutes(deps: {
  db: AppDatabase;
  config: AppConfig;
}): Hono<AppEnv> {
  const { db, config } = deps;
  const router = new Hono<AppEnv>();

  router.get('/runtime', requireSession(db, config), (c) => {
    const generatedAt = Date.now();
    let healthy = true;
    let appliedMigrations = 0;
    let latestMigration: string | null = null;

    try {
      db.run(sql`SELECT 1`);
      // `schema_migrations` is created by the migrator and is intentionally not
      // part of the Drizzle schema. Insert order is application order, so the
      // last rowid is the newest applied migration.
      const rows = db.all<{ id: string }>(
        sql`SELECT id FROM schema_migrations ORDER BY rowid DESC LIMIT 1`,
      );
      const applied = db.get<{ total: number }>(
        sql`SELECT COUNT(*) AS total FROM schema_migrations`,
      );
      appliedMigrations = applied?.total ?? 0;
      latestMigration = rows[0]?.id ?? null;
    } catch {
      // A broken database is a real unavailable state, not an empty migration
      // list: report healthy=false and zero facts instead of guessing.
      healthy = false;
    }

    const runtime: SystemRuntimeDto = {
      service: 'benefit-hub',
      generatedAt,
      startedAt: SERVER_STARTED_AT,
      nodeVersion: process.version,
      build: config.buildInfo,
      database: {
        healthy,
        appliedMigrations,
        latestMigration,
      },
      security: {
        sessionTtlHours: Math.round(config.sessionTtlMs / HOUR_MS),
        cookieSecure: config.cookieSecure,
        trustProxy: config.trustProxy,
        loginFailure: {
          perAccount: LOGIN_FAILURE_PER_ACCOUNT,
          perAddress: LOGIN_FAILURE_PER_ADDRESS,
          windowMinutes: LOGIN_FAILURE_WINDOW_MINUTES,
        },
        password: PASSWORD_POLICY,
      },
      capabilities: {
        supplierReadCredentialsConfigured: config.yangmaoInrice !== null,
        supplierMasterKeyConfigured: config.supplierMasterKey !== null,
        businessOrderClientCount: config.businessOrderClients?.clients.length ?? 0,
      },
    };

    return c.json({ runtime }, 200, NO_STORE_HEADERS);
  });

  return router;
}
