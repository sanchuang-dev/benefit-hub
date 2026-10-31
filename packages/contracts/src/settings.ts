/**
 * Wire contract for the platform-governance ("系统设置") read surfaces.
 *
 * These payloads are deliberately read-only and configuration-fact based:
 * - the runtime snapshot reports the *effective* server configuration, but only
 *   as booleans, counts, durations and version strings. No secret value, host
 *   path or database file ever crosses this boundary;
 * - the audit list exposes stable event codes plus the responsible operator,
 *   never request bodies, IP addresses, tokens or credentials.
 *
 * Counts and capability flags describe local facts only. `configured: false`
 * means "not configured", not "broken", and a missing build stamp is reported
 * as `null` instead of being invented as a version number.
 */

import { z } from 'zod';

const timestampSchema = z.number().int().nonnegative();
const nonNegativeCountSchema = z.number().int().nonnegative();

/* -------------------------------------------------------------------------- */
/* Audit trail                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Audit categories exposed by the console. `other` forwards stable event codes
 * this UI version does not know yet instead of dropping the row.
 */
export const AUDIT_EVENT_CATEGORIES = ['authentication', 'account', 'other'] as const;
export type AuditEventCategory = (typeof AUDIT_EVENT_CATEGORIES)[number];
export const auditEventCategorySchema = z.enum(AUDIT_EVENT_CATEGORIES);

/** Operator identity attached to an audit fact; `null` for unattributed events. */
export const auditEventAccountSchema = z
  .object({
    id: z.string().min(1).max(64),
    username: z.string().min(1).max(64),
    displayName: z.string().min(1).max(120),
  })
  .strict();
export type AuditEventAccountDto = z.infer<typeof auditEventAccountSchema>;

/**
 * One audit fact. `detail` is a stable reason/operation code, never raw input
 * and never a free-form message assembled from credentials.
 */
export const auditEventSchema = z
  .object({
    id: z.string().min(1).max(64),
    event: z.string().min(1).max(64),
    category: auditEventCategorySchema,
    account: auditEventAccountSchema.nullable(),
    detail: z.string().max(120).nullable(),
    createdAt: timestampSchema,
  })
  .strict();
export type AuditEventDto = z.infer<typeof auditEventSchema>;

/** Server-side validated audit query. Unknown keys are ignored by zod. */
export const auditEventsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  category: auditEventCategorySchema.optional(),
  event: z.string().min(1).max(64).optional(),
  accountId: z.string().min(1).max(64).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
});
export type AuditEventsQuery = z.infer<typeof auditEventsQuerySchema>;

export const auditEventListResponseSchema = z
  .object({
    events: z.array(auditEventSchema),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
    total: nonNegativeCountSchema,
  })
  .strict();
export type AuditEventListResponse = z.infer<typeof auditEventListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Runtime snapshot                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build stamp injected by the deployment pipeline. Every field is nullable:
 * a local checkout or an older image has no stamp and must say so instead of
 * presenting a fabricated version.
 */
export const systemBuildInfoSchema = z
  .object({
    version: z.string().max(64).nullable(),
    commit: z.string().max(64).nullable(),
    builtAt: timestampSchema.nullable(),
  })
  .strict();
export type SystemBuildInfoDto = z.infer<typeof systemBuildInfoSchema>;

/** Applied-migration fact, the only schema state the console may report. */
export const systemDatabaseInfoSchema = z
  .object({
    healthy: z.boolean(),
    appliedMigrations: nonNegativeCountSchema,
    latestMigration: z.string().max(120).nullable(),
  })
  .strict();
export type SystemDatabaseInfoDto = z.infer<typeof systemDatabaseInfoSchema>;

export const loginFailurePolicySchema = z
  .object({
    perAccount: z.number().int().min(1),
    perAddress: z.number().int().min(1),
    windowMinutes: z.number().int().min(1),
  })
  .strict();
export type LoginFailurePolicyDto = z.infer<typeof loginFailurePolicySchema>;

/**
 * Password policy as structured facts so the console can render it without
 * re-typing the rules in a second source of truth.
 */
export const passwordPolicySchema = z
  .object({
    minLength: z.number().int().min(1),
    maxLength: z.number().int().min(1),
    mustNotContainUsername: z.boolean(),
    noLeadingTrailingWhitespace: z.boolean(),
  })
  .strict();
export type PasswordPolicyDto = z.infer<typeof passwordPolicySchema>;

/** Effective security settings. Booleans/durations only; no secret values. */
export const systemSecurityPolicySchema = z
  .object({
    sessionTtlHours: z.number().int().min(1),
    cookieSecure: z.boolean(),
    trustProxy: z.boolean(),
    loginFailure: loginFailurePolicySchema,
    password: passwordPolicySchema,
  })
  .strict();
export type SystemSecurityPolicyDto = z.infer<typeof systemSecurityPolicySchema>;

/**
 * Capability flags derived from server-only configuration. Counts are the
 * number of configured entries, never the credentials themselves.
 */
export const systemCapabilitiesSchema = z
  .object({
    supplierReadCredentialsConfigured: z.boolean(),
    supplierMasterKeyConfigured: z.boolean(),
    businessOrderClientCount: nonNegativeCountSchema,
  })
  .strict();
export type SystemCapabilitiesDto = z.infer<typeof systemCapabilitiesSchema>;

export const systemRuntimeSchema = z
  .object({
    service: z.literal('benefit-hub'),
    generatedAt: timestampSchema,
    startedAt: timestampSchema,
    nodeVersion: z.string().min(1).max(40),
    build: systemBuildInfoSchema,
    database: systemDatabaseInfoSchema,
    security: systemSecurityPolicySchema,
    capabilities: systemCapabilitiesSchema,
  })
  .strict();
export type SystemRuntimeDto = z.infer<typeof systemRuntimeSchema>;

export const systemRuntimeResponseSchema = z.object({ runtime: systemRuntimeSchema }).strict();
export type SystemRuntimeResponse = z.infer<typeof systemRuntimeResponseSchema>;
