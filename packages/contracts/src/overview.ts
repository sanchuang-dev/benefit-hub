/**
 * Wire contract for the operator overview ("cockpit") read surface.
 *
 * Every value here is aggregated from local persisted facts inside one requested
 * window. Nothing is estimated, projected or filled in: an empty window reports
 * zero counts, and a rate over zero terminal orders is `null` rather than `0` so
 * the UI can distinguish "nothing to rate" from "everything failed".
 *
 * `asOf` is the server clock at aggregation time and is the only freshness
 * timestamp the UI may present. The window is aligned to Beijing calendar days
 * because every operator reads the console in Asia/Shanghai (no DST), and a
 * client-side day boundary would disagree with this response near midnight.
 *
 * This surface never carries supplier-native status, credentials, phone numbers
 * or benefit codes; `attempts` counts our own normalized observations only, and
 * `accepted` there still means "supplier acknowledged", never "delivered".
 */

import { z } from 'zod';
import { ATTEMPT_RESULTS, ORDER_STATUSES } from './orders.js';

/** Supported operator windows. `today` means the current Beijing calendar day. */
export const OVERVIEW_WINDOWS = ['today', '7d', '30d'] as const;
export type OverviewWindow = (typeof OVERVIEW_WINDOWS)[number];
export const overviewWindowSchema = z.enum(OVERVIEW_WINDOWS);

/**
 * The one business timezone the aggregate is aligned to. China has no DST, so
 * the server can use a fixed +08:00 offset instead of a timezone database.
 */
export const OVERVIEW_TIMEZONE = 'Asia/Shanghai';

/** Trend chart horizon: a fixed 30 Beijing days ending at `asOf`. */
export const OVERVIEW_TREND_DAYS = 30;

const timestampSchema = z.number().int().nonnegative();
const countSchema = z.number().int().nonnegative();
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日历日需为 YYYY-MM-DD');

/** One entry per platform status; every key is always present. */
export const overviewStatusCountsSchema = z
  .object({
    pending: countSchema,
    processing: countSchema,
    awaiting_claim: countSchema,
    partially_completed: countSchema,
    completed: countSchema,
    failed: countSchema,
    unknown: countSchema,
  })
  .strict();
export type OverviewStatusCounts = z.infer<typeof overviewStatusCountsSchema>;

/** Orders created on one Beijing calendar day. */
export const overviewDailyPointSchema = z
  .object({ day: daySchema, total: countSchema, completed: countSchema })
  .strict();
export type OverviewDailyPointDto = z.infer<typeof overviewDailyPointSchema>;

/** Orders created in one Beijing hour-of-day (0-23), summed over the window. */
export const overviewHourlyPointSchema = z
  .object({ hour: z.number().int().min(0).max(23), total: countSchema })
  .strict();
export type OverviewHourlyPointDto = z.infer<typeof overviewHourlyPointSchema>;

/** Our normalized attempt observations; `accepted` is acknowledgement only. */
export const overviewAttemptCountsSchema = z
  .object({ total: countSchema, accepted: countSchema, rejected: countSchema, unknown: countSchema })
  .strict();
export type OverviewAttemptCounts = z.infer<typeof overviewAttemptCountsSchema>;

export const overviewWindowMetaSchema = z
  .object({
    key: overviewWindowSchema,
    /** Inclusive start, UTC epoch milliseconds. */
    from: timestampSchema,
    /** End, UTC epoch milliseconds (normally `asOf`). */
    to: timestampSchema,
    timezone: z.literal(OVERVIEW_TIMEZONE),
  })
  .strict();
export type OverviewWindowMeta = z.infer<typeof overviewWindowMetaSchema>;

/**
 * Order aggregates for the selected window.
 *
 * `terminalTotal` counts the outcomes that can be judged (`completed`, `failed`,
 * `partially_completed`); in-flight orders are deliberately excluded so the rate
 * is not diluted by work that has not finished yet. `completedRateBp` is basis
 * points (0-10000) and `null` when `terminalTotal` is 0.
 */
export const overviewOrderAggregateSchema = z
  .object({
    total: countSchema,
    completed: countSchema,
    failed: countSchema,
    terminalTotal: countSchema,
    completedRateBp: z.number().int().min(0).max(10_000).nullable(),
    /**
     * Comparison baseline, chosen per window so the label never lies:
     * `today` uses the same elapsed span of yesterday (`[from - DAY, to - DAY)`),
     * `7d`/`30d` use the immediately preceding window of the same length.
     */
    previousTotal: countSchema,
  })
  .strict();
export type OverviewOrderAggregate = z.infer<typeof overviewOrderAggregateSchema>;

/**
 * Supplier readiness, reported as integration facts only. `credentialSource`
 * mirrors the supplier management surface (`database` beats `environment`).
 */
export const overviewSupplySchema = z
  .object({
    provider: z.string().min(1).max(32),
    displayName: z.string().min(1).max(40),
    catalogConfigured: z.boolean(),
    credentialSource: z.enum(['database', 'environment', 'none']),
    /** Last time the stored connection was written; `null` when env-only/unset. */
    connectionUpdatedAt: timestampSchema.nullable(),
  })
  .strict();
export type OverviewSupplyDto = z.infer<typeof overviewSupplySchema>;

export const operationsOverviewSchema = z
  .object({
    asOf: timestampSchema,
    window: overviewWindowMetaSchema,
    orders: overviewOrderAggregateSchema,
    byStatus: overviewStatusCountsSchema,
    /** Fixed 30 points, oldest first, regardless of the selected window. */
    series: z.array(overviewDailyPointSchema).max(OVERVIEW_TREND_DAYS),
    /** 24 points for the selected window, indexed by Beijing hour-of-day. */
    hourly: z.array(overviewHourlyPointSchema).max(24),
    attempts: overviewAttemptCountsSchema,
    supply: overviewSupplySchema,
  })
  .strict();
export type OperationsOverviewDto = z.infer<typeof operationsOverviewSchema>;

export const operationsOverviewResponseSchema = z
  .object({ overview: operationsOverviewSchema })
  .strict();
export type OperationsOverviewResponse = z.infer<typeof operationsOverviewResponseSchema>;

/** Every platform status appears exactly once in a status breakdown. */
export function isCompleteStatusCounts(counts: OverviewStatusCounts): boolean {
  return ORDER_STATUSES.every((status) => Number.isInteger(counts[status]));
}

/** Exhaustive attempt results check; keeps the API from silently dropping one. */
export function isCompleteAttemptCounts(counts: OverviewAttemptCounts): boolean {
  return ATTEMPT_RESULTS.every((result) => Number.isInteger(counts[result]));
}
