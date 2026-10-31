import { and, desc, eq, gte, inArray, lte, notInArray, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  auditEventsQuerySchema,
  type AuditEventCategory,
  type AuditEventDto,
  type AuditEventListResponse,
} from '@sanchuang-dev/benefit-contracts';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { adminAccounts, authEvents } from '../../db/schema.js';
import { requireRole, requireSession, type AppEnv } from '../../middleware/auth.js';
import { listAccounts } from './accounts.js';
import { recordAuthEvent } from './audit.js';
import { NO_STORE_HEADERS, invalidRequest, issueFields } from '../http.js';

/**
 * Stable event codes the console knows how to label. Any future code is still
 * returned with category `other` rather than dropped, so an older console never
 * hides an audit fact it does not recognise yet.
 */
const AUTHENTICATION_EVENTS = [
  'login.succeeded',
  'login.failed',
  'login.rate_limited',
  'logout',
  'session.rejected',
] as const;

const ACCOUNT_EVENTS = [
  'admin_account.created',
  'admin_account.password_reset',
  'admin_account.disabled',
  'admin_accounts.listed',
] as const;

const KNOWN_EVENTS: readonly string[] = [...AUTHENTICATION_EVENTS, ...ACCOUNT_EVENTS];

const EVENT_CATEGORY: ReadonlyMap<string, AuditEventCategory> = new Map([
  ...AUTHENTICATION_EVENTS.map((event) => [event, 'authentication'] as const),
  ...ACCOUNT_EVENTS.map((event) => [event, 'account'] as const),
]);

function categoryOf(event: string): AuditEventCategory {
  return EVENT_CATEGORY.get(event) ?? 'other';
}

function categoryFilter(category: AuditEventCategory): SQL {
  if (category === 'authentication') return inArray(authEvents.event, [...AUTHENTICATION_EVENTS]);
  if (category === 'account') return inArray(authEvents.event, [...ACCOUNT_EVENTS]);
  return notInArray(authEvents.event, [...KNOWN_EVENTS]);
}

/**
 * Read-only administrative surface: account list plus the authentication/account
 * audit trail. Account lifecycle writes still live in the admin CLI, so the
 * console never claims a write it cannot perform; catalogue and application
 * write audits stay in their own owning modules until a later slice merges them
 * into this read model.
 */
export function createAdminAccountRoutes(deps: { db: AppDatabase; config: AppConfig }): Hono<AppEnv> {
  const { db, config } = deps;
  const router = new Hono<AppEnv>();

  router.get('/accounts', requireSession(db, config), requireRole('admin'), (c) => {
    recordAuthEvent(db, 'admin_accounts.listed', { accountId: c.get('admin').id });
    return c.json({ accounts: listAccounts(db) }, 200, NO_STORE_HEADERS);
  });

  router.get('/audit-events', requireSession(db, config), requireRole('admin'), (c) => {
    const parsed = auditEventsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(invalidRequest('查询参数不正确', issueFields(parsed.error)), 400, NO_STORE_HEADERS);
    }

    const query = parsed.data;
    const filters: SQL[] = [];
    if (query.category) filters.push(categoryFilter(query.category));
    if (query.event) filters.push(eq(authEvents.event, query.event));
    if (query.accountId) filters.push(eq(authEvents.accountId, query.accountId));
    if (query.from !== undefined) filters.push(gte(authEvents.createdAt, query.from));
    if (query.to !== undefined) filters.push(lte(authEvents.createdAt, query.to));
    const where = filters.length > 0 ? and(...filters) : undefined;

    const totalRow = db
      .select({ total: sql<number>`COUNT(*)` })
      .from(authEvents)
      .where(where)
      .get();
    const total = totalRow?.total ?? 0;

    const rows = db
      .select({
        id: authEvents.id,
        event: authEvents.event,
        accountId: authEvents.accountId,
        detail: authEvents.detail,
        createdAt: authEvents.createdAt,
        username: adminAccounts.username,
        displayName: adminAccounts.displayName,
      })
      .from(authEvents)
      .leftJoin(adminAccounts, eq(adminAccounts.id, authEvents.accountId))
      .where(where)
      // Newest first; id is a UUID tiebreaker for rows inserted in one tick.
      .orderBy(desc(authEvents.createdAt), desc(authEvents.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .all();

    const events: AuditEventDto[] = rows.map((row) => ({
      id: row.id,
      event: row.event,
      category: categoryOf(row.event),
      account:
        row.accountId && row.username
          ? {
              id: row.accountId,
              username: row.username,
              displayName: row.displayName ?? row.username,
            }
          : null,
      detail: row.detail,
      createdAt: row.createdAt,
    }));

    // Listing audit facts is itself a read and is intentionally not recorded:
    // an operator paging through the trail must not flood it with read events.
    const body: AuditEventListResponse = {
      events,
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
    return c.json(body, 200, NO_STORE_HEADERS);
  });

  return router;
}
