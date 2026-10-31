import { and, eq, gte, lt, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  ATTEMPT_RESULTS,
  ORDER_STATUSES,
  OVERVIEW_TIMEZONE,
  OVERVIEW_TREND_DAYS,
  overviewWindowSchema,
  type AttemptResult,
  type OperationsOverviewDto,
  type OrderStatus,
  type OverviewAttemptCounts,
  type OverviewDailyPointDto,
  type OverviewHourlyPointDto,
  type OverviewStatusCounts,
  type OverviewSupplyDto,
  type OverviewWindow,
  type OverviewWindowMeta,
} from '@sanchuang-dev/benefit-contracts';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { benefitOrders, fulfillmentAttempts, supplierConnections } from '../../db/schema.js';
import { requireSession, type AppEnv } from '../../middleware/auth.js';
import { NO_STORE_HEADERS, invalidRequest } from '../http.js';
import { supplierConnectionSummary } from '../suppliers/connection.js';

/**
 * The console is read in Asia/Shanghai, and China has no DST, so a fixed +08:00
 * offset is enough. A timezone database would add a dependency for no gain and
 * would make a day boundary drift with the host's TZ setting.
 */
const BJ_OFFSET = 8 * 3_600_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

const bjDayStart = (ms: number) => Math.floor((ms + BJ_OFFSET) / DAY) * DAY - BJ_OFFSET;
const bjDayLabel = (ms: number) => new Date(ms + BJ_OFFSET).toISOString().slice(0, 10);

/** Calendar days covered by each window; the current Beijing day is always day one. */
const WINDOW_DAYS: Record<OverviewWindow, number> = { today: 1, '7d': 7, '30d': 30 };

/**
 * Buckets are computed in SQLite rather than by loading rows into Node: the
 * aggregate must stay honest as history grows, and `created_at` is always a
 * non-negative UTC epoch millisecond, so integer division is a floor here. The
 * hour expression keeps the double modulo so it stays correct even if a
 * hand-edited negative timestamp ever reaches the table.
 */
const dayIndex = sql<number>`CAST((${benefitOrders.createdAt} + ${BJ_OFFSET}) / ${DAY} AS INTEGER)`;
const hourOfDay = sql<number>`CAST((((${benefitOrders.createdAt} + ${BJ_OFFSET}) % ${DAY}) + ${DAY}) % ${DAY} / ${HOUR} AS INTEGER)`;
const rowCount = sql<number>`COUNT(*)`;
const completedOrderCount = sql<number>`SUM(CASE WHEN ${benefitOrders.status} = 'completed' THEN 1 ELSE 0 END)`;

interface WindowBounds {
  meta: OverviewWindowMeta;
  previousFrom: number;
  previousTo: number;
}

/**
 * `from` is inclusive and `to` is the server clock, both as UTC epoch
 * milliseconds.
 *
 * The comparison window depends on what "previous" means for the selected
 * window, and the UI labels it accordingly:
 * - `today` compares against the *same elapsed span of yesterday*
 *   (`[from - DAY, to - DAY)`), because a boss reading "较昨日同时段" would
 *   otherwise be shown yesterday's last few hours instead of the same morning.
 * - `7d`/`30d` compare against the immediately preceding window of the same
 *   length (`[from - duration, from)`), which is the only adjacent baseline
 *   that exists for a rolling range.
 *
 * Both are half-open at the top, so an order created exactly at `from` belongs
 * to the current window only and is never counted twice.
 */
function resolveWindow(window: OverviewWindow, asOf: number): WindowBounds {
  const from = bjDayStart(asOf) - (WINDOW_DAYS[window] - 1) * DAY;
  if (window === 'today') {
    return {
      meta: { key: window, from, to: asOf, timezone: OVERVIEW_TIMEZONE },
      previousFrom: from - DAY,
      previousTo: asOf - DAY,
    };
  }
  return {
    meta: { key: window, from, to: asOf, timezone: OVERVIEW_TIMEZONE },
    previousFrom: from - (asOf - from),
    previousTo: from,
  };
}

function emptyStatusCounts(): OverviewStatusCounts {
  return {
    pending: 0,
    processing: 0,
    awaiting_claim: 0,
    partially_completed: 0,
    completed: 0,
    failed: 0,
    unknown: 0,
  };
}

/**
 * Every documented status key is present even when nothing matched, so the UI
 * can render a stable table instead of guessing which keys were omitted. A
 * persisted value outside the contract is dropped rather than invented into a
 * bucket; the column CHECK constraint already prevents it.
 */
function orderStatusCounts(db: AppDatabase, from: number, to: number) {
  const counts = emptyStatusCounts();
  let total = 0;
  const rows = db
    .select({ status: benefitOrders.status, value: rowCount })
    .from(benefitOrders)
    .where(and(gte(benefitOrders.createdAt, from), lte(benefitOrders.createdAt, to)))
    .groupBy(benefitOrders.status)
    .all();
  for (const row of rows) {
    total += row.value;
    if ((ORDER_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as OrderStatus] = row.value;
    }
  }
  return { counts, total };
}

/**
 * The trend chart always spans the last 30 Beijing days regardless of the
 * selected window, so a day without orders must still be emitted as an
 * explicit zero instead of collapsing into the gap between neighbours.
 */
function dailySeries(db: AppDatabase, asOf: number): OverviewDailyPointDto[] {
  const firstDay = bjDayStart(asOf) - (OVERVIEW_TREND_DAYS - 1) * DAY;
  const rows = db
    .select({ bucket: dayIndex, total: rowCount, completed: completedOrderCount })
    .from(benefitOrders)
    .where(and(gte(benefitOrders.createdAt, firstDay), lte(benefitOrders.createdAt, asOf)))
    .groupBy(dayIndex)
    .all();
  const byDay = new Map(rows.map((row) => [row.bucket, row]));

  const series: OverviewDailyPointDto[] = [];
  for (let offset = 0; offset < OVERVIEW_TREND_DAYS; offset += 1) {
    const dayStart = firstDay + offset * DAY;
    const bucket = byDay.get(Math.floor((dayStart + BJ_OFFSET) / DAY));
    series.push({
      day: bjDayLabel(dayStart),
      total: bucket?.total ?? 0,
      completed: bucket?.completed ?? 0,
    });
  }
  return series;
}

/** All 24 Beijing hours in ascending order; the window only supplies the counts. */
function hourlyProfile(db: AppDatabase, from: number, to: number): OverviewHourlyPointDto[] {
  const rows = db
    .select({ bucket: hourOfDay, total: rowCount })
    .from(benefitOrders)
    .where(and(gte(benefitOrders.createdAt, from), lte(benefitOrders.createdAt, to)))
    .groupBy(hourOfDay)
    .all();
  const byHour = new Map(rows.map((row) => [row.bucket, row.total]));

  const hourly: OverviewHourlyPointDto[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    hourly.push({ hour, total: byHour.get(hour) ?? 0 });
  }
  return hourly;
}

/**
 * Attempt facts are counted by when they were observed, not by when their order
 * was created, because an old order can still produce a fresh attempt. `total`
 * sums every persisted row; the three named keys are the contract's results.
 */
function attemptCounts(db: AppDatabase, from: number, to: number): OverviewAttemptCounts {
  const counts: OverviewAttemptCounts = { total: 0, accepted: 0, rejected: 0, unknown: 0 };
  const rows = db
    .select({ result: fulfillmentAttempts.result, value: rowCount })
    .from(fulfillmentAttempts)
    .where(
      and(gte(fulfillmentAttempts.occurredAt, from), lte(fulfillmentAttempts.occurredAt, to)),
    )
    .groupBy(fulfillmentAttempts.result)
    .all();
  for (const row of rows) {
    counts.total += row.value;
    if ((ATTEMPT_RESULTS as readonly string[]).includes(row.result)) {
      counts[row.result as AttemptResult] = row.value;
    }
  }
  return counts;
}

/**
 * Readiness only: the supplier module stays the single owner of how a
 * connection is judged, and this route adds the stored row's timestamp so the
 * console can show how old the configuration is. No credential is touched.
 */
function supplyState(db: AppDatabase, config: AppConfig): OverviewSupplyDto {
  const summary = supplierConnectionSummary(db, config);
  const connection = db
    .select({ updatedAt: supplierConnections.updatedAt })
    .from(supplierConnections)
    .where(eq(supplierConnections.provider, summary.key))
    .get();
  return {
    provider: summary.key,
    displayName: summary.name,
    catalogConfigured: summary.catalogRead.configured,
    // The supplier module builds `source` from exactly these three literals but
    // declares it as `string`; narrow here instead of duplicating its decision.
    credentialSource: summary.catalogRead.source as OverviewSupplyDto['credentialSource'],
    connectionUpdatedAt: connection?.updatedAt ?? null,
  };
}

function buildOverview(
  db: AppDatabase,
  config: AppConfig,
  window: OverviewWindow,
  asOf: number,
): OperationsOverviewDto {
  const { meta, previousFrom, previousTo } = resolveWindow(window, asOf);
  const { counts: byStatus, total } = orderStatusCounts(db, meta.from, meta.to);
  const previousTotal =
    db
      .select({ value: rowCount })
      .from(benefitOrders)
      .where(
        and(
          gte(benefitOrders.createdAt, previousFrom),
          lt(benefitOrders.createdAt, previousTo),
        ),
      )
      .get()?.value ?? 0;

  const terminalTotal = byStatus.completed + byStatus.failed + byStatus.partially_completed;

  return {
    asOf,
    window: meta,
    orders: {
      total,
      completed: byStatus.completed,
      failed: byStatus.failed,
      terminalTotal,
      // `null` rather than 0: "nothing finished yet" is not a 0% success rate.
      completedRateBp:
        terminalTotal === 0 ? null : Math.round((byStatus.completed / terminalTotal) * 10_000),
      previousTotal,
    },
    byStatus,
    series: dailySeries(db, asOf),
    hourly: hourlyProfile(db, meta.from, meta.to),
    attempts: attemptCounts(db, meta.from, meta.to),
    supply: supplyState(db, config),
  };
}

/**
 * Read-only operator cockpit aggregate (BHB overview step 2).
 *
 * Any authenticated session may read it, including the read-only operator role,
 * because it exposes no write path and no admin-only field. Every number comes
 * from local persisted facts inside the requested window; nothing is estimated,
 * sampled or carried over, and this route performs no outbound call.
 */
export function createOperationsOverviewRoutes(deps: {
  db: AppDatabase;
  config: AppConfig;
}): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.use('*', requireSession(deps.db, deps.config));

  router.get('/overview', (c) => {
    const parsed = overviewWindowSchema.safeParse(c.req.query('window') ?? 'today');
    if (!parsed.success) {
      return c.json(invalidRequest('查询参数不正确', ['window']), 400, NO_STORE_HEADERS);
    }

    // The clock is read once per request so `asOf`, the window end and the
    // partial-day bucket all describe the same instant.
    const overview = buildOverview(deps.db, deps.config, parsed.data, Date.now());
    return c.json({ overview }, 200, NO_STORE_HEADERS);
  });

  return router;
}
