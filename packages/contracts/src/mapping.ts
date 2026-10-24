/**
 * Wire contract for supplier product mapping management (BHB-009).
 *
 * This package is the single protocol definition consumed by the mapping HTTP
 * API and the future operations console (BHB-010). It intentionally contains no
 * database row, Drizzle type, repository, Hono context, credential, or supplier
 * client. A draft that passes local validation is a *local structural* fact
 * only; nothing here may be read as proof that the Yangmao upstream accepted the
 * product code.
 */

import { z } from 'zod';

/** Providers accepted in phase one; only the real Yangmao integration exists. */
export const MAPPING_PROVIDERS = ['yangmao'] as const;
export type MappingProvider = (typeof MAPPING_PROVIDERS)[number];
export const mappingProviderSchema = z.enum(MAPPING_PROVIDERS);

/** A/B/C use gift-pack and count semantics; D uses monetary entitlement. */
export const FULFILLMENT_MODES = ['A', 'B', 'C', 'D'] as const;
export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number];
export const fulfillmentModeSchema = z.enum(FULFILLMENT_MODES);

/** `pack` quota and `amount` balance are separate ledgers and never mix. */
export const DEDUCTION_UNITS = ['pack', 'amount'] as const;
export type DeductionUnit = (typeof DEDUCTION_UNITS)[number];
export const deductionUnitSchema = z.enum(DEDUCTION_UNITS);

/**
 * Upstream product codes are bounded operator-supplied identifiers, not free
 * text. Case is preserved because it may matter upstream.
 */
export const SUPPLIER_PRODUCT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Local validation fact kinds. They are stable codes, never submitted values. */
export const MAPPING_VALIDATION_ISSUES = [
  'product_missing',
  'provider_unsupported',
  'product_code_invalid',
  'fulfillment_mode_unsupported',
  'deduction_unit_mismatch',
] as const;
export type MappingValidationIssue = (typeof MAPPING_VALIDATION_ISSUES)[number];
export const mappingValidationIssueSchema = z.enum(MAPPING_VALIDATION_ISSUES);

/**
 * Validation in this slice is local structural validation only. The literal
 * type makes "local" the only representable scope.
 */
export const MAPPING_VALIDATION_SCOPES = ['local'] as const;
export type MappingValidationScope = (typeof MAPPING_VALIDATION_SCOPES)[number];
export const mappingValidationScopeSchema = z.enum(MAPPING_VALIDATION_SCOPES);

const identifierSchema = z.string().min(1).max(128);
const versionNumberSchema = z.number().int().min(1);
const timestampSchema = z.number().int().nonnegative();

/** Read model of the current editable draft for one internal product. */
export const mappingDraftSchema = z
  .object({
    mappingId: identifierSchema,
    productId: identifierSchema,
    provider: mappingProviderSchema,
    productCode: z.string().min(1).max(64),
    fulfillmentMode: fulfillmentModeSchema,
    deductionUnit: deductionUnitSchema,
    version: versionNumberSchema,
    validatedVersion: versionNumberSchema.nullable(),
    validatedAt: timestampSchema.nullable(),
    activeVersionId: identifierSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type MappingDraftDto = z.infer<typeof mappingDraftSchema>;

/** One immutable activation snapshot. */
export const mappingVersionSchema = z
  .object({
    id: identifierSchema,
    mappingId: identifierSchema,
    productId: identifierSchema,
    versionNumber: versionNumberSchema,
    provider: mappingProviderSchema,
    productCode: z.string().min(1).max(64),
    fulfillmentMode: fulfillmentModeSchema,
    deductionUnit: deductionUnitSchema,
    sourceDraftVersion: versionNumberSchema,
    activatedBy: z.string().min(1).max(64),
    activatedAt: timestampSchema,
  })
  .strict();
export type MappingVersionDto = z.infer<typeof mappingVersionSchema>;

/**
 * Overview returned by every mapping read/write endpoint. `validationScope` and
 * `upstreamVerified` are part of the contract so a client cannot confuse a
 * locally validated draft with a verified supplier contract.
 */
export const mappingOverviewSchema = z
  .object({
    productId: identifierSchema,
    validationScope: mappingValidationScopeSchema,
    upstreamVerified: z.literal(false),
    draft: mappingDraftSchema.nullable(),
    activeVersion: mappingVersionSchema.nullable(),
    versions: z.array(mappingVersionSchema),
  })
  .strict();
export type MappingOverviewDto = z.infer<typeof mappingOverviewSchema>;

/** First create passes `null`; updating an existing draft passes its version. */
export const saveMappingDraftRequestSchema = z
  .object({
    expectedVersion: versionNumberSchema.nullable(),
    provider: mappingProviderSchema,
    productCode: z
      .string()
      .trim()
      .regex(SUPPLIER_PRODUCT_CODE_PATTERN, '上游商品编码需为 1-64 位字母、数字或 . _ -'),
    fulfillmentMode: fulfillmentModeSchema,
    deductionUnit: deductionUnitSchema,
  })
  .strict();
export type SaveMappingDraftRequest = z.infer<typeof saveMappingDraftRequestSchema>;

/** Local validation applies to exactly the submitted current draft version. */
export const validateMappingDraftRequestSchema = z
  .object({ version: versionNumberSchema })
  .strict();
export type ValidateMappingDraftRequest = z.infer<typeof validateMappingDraftRequestSchema>;

/** Activation actor is taken from the authenticated admin session, never here. */
export const activateMappingDraftRequestSchema = z
  .object({ version: versionNumberSchema })
  .strict();
export type ActivateMappingDraftRequest = z.infer<typeof activateMappingDraftRequestSchema>;

/** Stable machine-readable error codes for the mapping management API. */
export const MAPPING_ERROR_CODES = [
  'INVALID_REQUEST',
  'PRODUCT_NOT_FOUND',
  'MAPPING_NOT_FOUND',
  'MAPPING_ALREADY_EXISTS',
  'MAPPING_VERSION_CONFLICT',
  'MAPPING_NOT_VALIDATED',
  'MAPPING_VALIDATION_FAILED',
] as const;
export type MappingErrorCode = (typeof MAPPING_ERROR_CODES)[number];

const otherMappingErrorCodes = [
  'PRODUCT_NOT_FOUND',
  'MAPPING_NOT_FOUND',
  'MAPPING_ALREADY_EXISTS',
  'MAPPING_VERSION_CONFLICT',
  'MAPPING_NOT_VALIDATED',
] as const satisfies readonly MappingErrorCode[];

const errorEnvelopeSchema = z.object({ message: z.string().min(1) });

/** Contract parse/validation failures may name only the offending field paths. */
export const mappingInvalidRequestSchema = errorEnvelopeSchema
  .extend({
    error: z.literal('INVALID_REQUEST'),
    fields: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type MappingInvalidRequest = z.infer<typeof mappingInvalidRequestSchema>;

/**
 * A local validation failure may carry stable issue codes only. Other errors
 * must not include `issues`, and no error body may echo submitted values.
 */
export const mappingValidationFailureSchema = errorEnvelopeSchema
  .extend({
    error: z.literal('MAPPING_VALIDATION_FAILED'),
    issues: z.array(mappingValidationIssueSchema).min(1),
  })
  .strict();
export type MappingValidationFailure = z.infer<typeof mappingValidationFailureSchema>;

export const mappingErrorResponseSchema = z.discriminatedUnion('error', [
  mappingInvalidRequestSchema,
  mappingValidationFailureSchema,
  errorEnvelopeSchema.extend({ error: z.enum(otherMappingErrorCodes) }).strict(),
]);
export type MappingErrorResponse = z.infer<typeof mappingErrorResponseSchema>;
