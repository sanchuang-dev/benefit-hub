/**
 * Wire contract for the downstream application registry (BHB-014-A) and its
 * machine credentials / runtime authorization (BHB-014-B).
 *
 * Operators register a business application identity, configure the internal
 * products it may order, and issue its machine Bearer credential. The stored
 * allowlist and enabled state are enforced on every `POST /api/v1/business/orders`
 * for that `businessSource`; a registered application is no longer merely
 * configuration. No read model or list ever contains a raw credential: the full
 * bearer token is returned by the issue operation exactly once.
 */

import { z } from 'zod';
import { BUSINESS_SOURCE_PATTERN, businessSourceSchema } from './orders.js';

export const APPLICATION_STATUSES = ['enabled', 'disabled'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export const applicationStatusSchema = z.enum(APPLICATION_STATUSES);

/** Operator-facing display name; no supplier or credential semantics. */
export const APPLICATION_NAME_MAX_LENGTH = 80;
/** Optional bounded internal note; never a place for secrets. */
export const APPLICATION_NOTE_MAX_LENGTH = 200;

const identifierSchema = z.string().min(1).max(128);
const versionNumberSchema = z.number().int().min(1);
const timestampSchema = z.number().int().nonnegative();

/**
 * Read model of one registered application. `businessSource` is the stable
 * normalized identity; it matches the existing downstream order source grammar
 * so machine authentication and registration share one identity namespace.
 *
 * `activeCredentialCount` counts credentials that have been issued and not
 * revoked. It is not the secret and never a substitute for it: effective machine
 * access additionally requires `status === 'enabled'`, a matching allowlist on
 * order creation, and the caller actually holding a live token.
 */
export const businessApplicationSchema = z
  .object({
    id: identifierSchema,
    businessSource: businessSourceSchema,
    name: z.string().min(1).max(APPLICATION_NAME_MAX_LENGTH),
    note: z.string().max(APPLICATION_NOTE_MAX_LENGTH),
    status: applicationStatusSchema,
    version: versionNumberSchema,
    configuredProductCount: z.number().int().nonnegative(),
    activeCredentialCount: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type BusinessApplicationDto = z.infer<typeof businessApplicationSchema>;

/**
 * Non-sensitive state of one issued machine credential. The database stores only
 * a SHA-256 digest of the bearer token, so no read path can return the secret;
 * `status` and the timestamps are the complete operator-visible fact.
 */
export const APPLICATION_CREDENTIAL_STATUSES = ['active', 'revoked'] as const;
export type ApplicationCredentialStatus = (typeof APPLICATION_CREDENTIAL_STATUSES)[number];
export const applicationCredentialStatusSchema = z.enum(APPLICATION_CREDENTIAL_STATUSES);

export const applicationCredentialSchema = z
  .object({
    id: identifierSchema,
    status: applicationCredentialStatusSchema,
    issuedAt: timestampSchema,
    revokedAt: timestampSchema.nullable(),
  })
  .strict();
export type ApplicationCredentialDto = z.infer<typeof applicationCredentialSchema>;

/**
 * The one and only response that carries a raw bearer token. `secret` must be
 * shown once in the issuing admin's browser session and never persisted,
 * logged, cached or re-derivable.
 */
export const issueApplicationCredentialResponseSchema = z
  .object({
    credential: applicationCredentialSchema,
    secret: z.string().min(32).max(512),
  })
  .strict();
export type IssueApplicationCredentialResponse = z.infer<
  typeof issueApplicationCredentialResponseSchema
>;

export const revokeApplicationCredentialResponseSchema = z
  .object({ credential: applicationCredentialSchema })
  .strict();
export type RevokeApplicationCredentialResponse = z.infer<
  typeof revokeApplicationCredentialResponseSchema
>;

/**
 * One internal product currently recorded as configured for an application.
 * `status` is the product's current status read at request time, not a
 * historical snapshot; `configuredAt` is when this pair was stored.
 */
export const applicationProductSchema = z
  .object({
    productId: identifierSchema,
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(80),
    status: z.enum(['active', 'disabled']),
    configuredAt: timestampSchema,
  })
  .strict();
export type ApplicationProductDto = z.infer<typeof applicationProductSchema>;

export const applicationListResponseSchema = z
  .object({
    applications: z.array(businessApplicationSchema),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().nonnegative(),
    /** The server enforces registered application state on the machine order API. */
    runtimeAuthorizationEnforced: z.literal(true),
  })
  .strict();
export type ApplicationListResponse = z.infer<typeof applicationListResponseSchema>;

export const applicationDetailResponseSchema = z
  .object({
    application: businessApplicationSchema,
    products: z.array(applicationProductSchema),
    credentials: z.array(applicationCredentialSchema),
    runtimeAuthorizationEnforced: z.literal(true),
  })
  .strict();
export type ApplicationDetailResponse = z.infer<typeof applicationDetailResponseSchema>;

/** The server normalizes and validates `businessSource`; it is immutable after creation. */
export const createApplicationRequestSchema = z
  .object({
    businessSource: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        BUSINESS_SOURCE_PATTERN,
        '应用来源标识需为 1-64 位小写字母、数字或 . _ -，且以字母或数字开头',
      ),
    name: z
      .string()
      .trim()
      .min(1, '请输入应用名称')
      .max(APPLICATION_NAME_MAX_LENGTH, `应用名称最长 ${APPLICATION_NAME_MAX_LENGTH} 个字符`),
    note: z
      .string()
      .trim()
      .max(APPLICATION_NOTE_MAX_LENGTH, `备注最长 ${APPLICATION_NOTE_MAX_LENGTH} 个字符`)
      .optional(),
  })
  .strict();
export type CreateApplicationRequest = z.infer<typeof createApplicationRequestSchema>;

/** Rename/note edit only; `businessSource` is never editable. */
export const updateApplicationRequestSchema = z
  .object({
    version: versionNumberSchema,
    name: z
      .string()
      .trim()
      .min(1, '请输入应用名称')
      .max(APPLICATION_NAME_MAX_LENGTH, `应用名称最长 ${APPLICATION_NAME_MAX_LENGTH} 个字符`)
      .optional(),
    note: z
      .string()
      .trim()
      .max(APPLICATION_NOTE_MAX_LENGTH, `备注最长 ${APPLICATION_NOTE_MAX_LENGTH} 个字符`)
      .optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.note !== undefined, {
    message: '至少提供一个可编辑字段',
  });
export type UpdateApplicationRequest = z.infer<typeof updateApplicationRequestSchema>;

/** Enable/disable share the same optimistic concurrency guard as an edit. */
export const applicationStatusChangeRequestSchema = z
  .object({ version: versionNumberSchema })
  .strict();
export type ApplicationStatusChangeRequest = z.infer<typeof applicationStatusChangeRequestSchema>;

/**
 * Replaces the complete configured internal-product set for an application in
 * one atomic write. Duplicate ids are rejected instead of silently collapsed,
 * and the server rejects ids that are not persisted internal products.
 */
export const setApplicationProductsRequestSchema = z
  .object({
    version: versionNumberSchema,
    productIds: z
      .array(identifierSchema)
      .max(500, '单个应用最多配置 500 个内部商品')
      .refine((ids) => new Set(ids).size === ids.length, '商品 ID 不能重复'),
  })
  .strict();
export type SetApplicationProductsRequest = z.infer<typeof setApplicationProductsRequestSchema>;

/** Stable machine-readable error codes for the application registry surface. */
export const APPLICATION_ERROR_CODES = [
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'APPLICATION_NOT_FOUND',
  'APPLICATION_SOURCE_CONFLICT',
  'APPLICATION_VERSION_CONFLICT',
  'APPLICATION_UNKNOWN_PRODUCT',
  'APPLICATION_CREDENTIAL_NOT_FOUND',
  'APPLICATION_CREDENTIAL_LIMIT_REACHED',
  'PRODUCT_NOT_ACTIVE',
] as const;
export type ApplicationErrorCode = (typeof APPLICATION_ERROR_CODES)[number];
