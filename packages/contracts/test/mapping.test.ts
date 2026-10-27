import { describe, expect, it } from 'vitest';
import {
  activateMappingDraftRequestSchema,
  MAPPING_ERROR_CODES,
  MAPPING_VALIDATION_ISSUES,
  mappingDraftSchema,
  mappingErrorResponseSchema,
  mappingInvalidRequestSchema,
  mappingOverviewSchema,
  mappingValidationFailureSchema,
  mappingVersionSchema,
  saveMappingDraftRequestSchema,
  validateMappingDraftRequestSchema,
  type MappingDraftDto,
  type MappingOverviewDto,
  type MappingVersionDto,
} from '../src/index.js';

const draft: MappingDraftDto = {
  mappingId: 'mapping-1',
  productId: 'product-1',
  provider: 'yangmao',
  productCode: 'YM-1001',
  fulfillmentMode: 'B',
  deductionUnit: 'pack',
  version: 2,
  validatedVersion: 2,
  validatedAt: 1_700_000_000_000,
  activeVersionId: null,
  createdAt: 1_699_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const version: MappingVersionDto = {
  id: 'version-1',
  mappingId: 'mapping-1',
  productId: 'product-1',
  versionNumber: 1,
  provider: 'yangmao',
  productCode: 'YM-1001',
  fulfillmentMode: 'B',
  deductionUnit: 'pack',
  sourceDraftVersion: 2,
  activatedBy: 'account-1',
  activatedAt: 1_700_000_000_000,
};

describe('mapping wire enums and DTOs', () => {
  it('parses draft, activation history and an empty overview', () => {
    expect(mappingDraftSchema.parse(draft)).toEqual(draft);
    expect(mappingVersionSchema.parse(version)).toEqual(version);

    const empty: MappingOverviewDto = {
      productId: 'product-1',
      validationScope: 'local',
      upstreamVerified: false,
      draft: null,
      activeVersion: null,
      versions: [],
    };
    expect(mappingOverviewSchema.parse(empty)).toEqual(empty);

    expect(
      mappingOverviewSchema.parse({
        ...empty,
        draft,
        activeVersion: version,
        versions: [version],
      }),
    ).toMatchObject({ draft, activeVersion: version, versions: [version] });
  });

  it('rejects DTO enum values outside the frozen wire contract', () => {
    expect(mappingDraftSchema.safeParse({ ...draft, provider: 'other' }).success).toBe(false);
    expect(mappingDraftSchema.safeParse({ ...draft, fulfillmentMode: 'E' }).success).toBe(false);
    expect(mappingDraftSchema.safeParse({ ...draft, deductionUnit: 'points' }).success).toBe(false);
    expect(mappingDraftSchema.safeParse({ ...draft, version: 0 }).success).toBe(false);
    expect(mappingVersionSchema.safeParse({ ...version, activatedBy: '' }).success).toBe(false);
    expect(mappingDraftSchema.safeParse({ ...draft, unexpected: true }).success).toBe(false);
  });

  it('keeps local validation distinct from upstream verification in the overview', () => {
    const overview = {
      productId: 'product-1',
      validationScope: 'local' as const,
      upstreamVerified: false as const,
      draft: null,
      activeVersion: null,
      versions: [],
    };

    expect(mappingOverviewSchema.safeParse({ ...overview, upstreamVerified: true }).success).toBe(
      false,
    );
    expect(mappingOverviewSchema.safeParse({ ...overview, validationScope: 'upstream' }).success).toBe(
      false,
    );
    expect(mappingOverviewSchema.safeParse({ ...overview, upstreamVerified: undefined }).success).toBe(
      false,
    );
  });

  it('exposes the stable validation issue codes', () => {
    expect(MAPPING_VALIDATION_ISSUES).toEqual([
      'product_missing',
      'provider_unsupported',
      'product_code_invalid',
      'fulfillment_mode_unsupported',
      'deduction_unit_mismatch',
    ]);
  });
});

describe('mapping request schemas', () => {
  it('accepts create and update draft payloads and normalizes the product code', () => {
    const create = saveMappingDraftRequestSchema.parse({
      expectedVersion: null,
      provider: 'yangmao',
      productCode: '  YM-1001  ',
      fulfillmentMode: 'B',
      deductionUnit: 'pack',
    });
    expect(create).toEqual({
      expectedVersion: null,
      provider: 'yangmao',
      productCode: 'YM-1001',
      fulfillmentMode: 'B',
      deductionUnit: 'pack',
    });

    expect(
      saveMappingDraftRequestSchema.safeParse({
        expectedVersion: 3,
        provider: 'yangmao',
        productCode: 'YM-1001',
        fulfillmentMode: 'D',
        deductionUnit: 'amount',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields, invalid enums and invalid versions for save', () => {
    const valid = {
      expectedVersion: null,
      provider: 'yangmao',
      productCode: 'YM-1001',
      fulfillmentMode: 'B',
      deductionUnit: 'pack',
    };

    // The activation actor must never be accepted from a client payload.
    expect(
      saveMappingDraftRequestSchema.safeParse({ ...valid, actorAccountId: 'forged' }).success,
    ).toBe(false);
    expect(saveMappingDraftRequestSchema.safeParse({ ...valid, expectedVersion: undefined }).success).toBe(
      false,
    );
    expect(saveMappingDraftRequestSchema.safeParse({ ...valid, expectedVersion: 0 }).success).toBe(false);
    expect(saveMappingDraftRequestSchema.safeParse({ ...valid, expectedVersion: 1.5 }).success).toBe(
      false,
    );
    expect(saveMappingDraftRequestSchema.safeParse({ ...valid, provider: 'other' }).success).toBe(false);
    expect(saveMappingDraftRequestSchema.safeParse({ ...valid, fulfillmentMode: 'E' }).success).toBe(
      false,
    );
    expect(saveMappingDraftRequestSchema.safeParse({ ...valid, deductionUnit: 'points' }).success).toBe(
      false,
    );
    for (const productCode of ['', '   ', 'YM 1001', 'YM-1001 raw response', `YM-${'9'.repeat(62)}`]) {
      expect(saveMappingDraftRequestSchema.safeParse({ ...valid, productCode }).success).toBe(false);
    }
  });

  it('accepts only a version body for validate and activate', () => {
    expect(validateMappingDraftRequestSchema.parse({ version: 2 })).toEqual({ version: 2 });
    expect(activateMappingDraftRequestSchema.parse({ version: 2 })).toEqual({ version: 2 });

    expect(validateMappingDraftRequestSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(validateMappingDraftRequestSchema.safeParse({ version: '2' }).success).toBe(false);
    expect(validateMappingDraftRequestSchema.safeParse({ version: 2, actor: 'forged' }).success).toBe(
      false,
    );
    expect(activateMappingDraftRequestSchema.safeParse({ version: 2, activatedBy: 'forged' }).success).toBe(
      false,
    );
    expect(activateMappingDraftRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('mapping error contract', () => {
  it('freezes the stable error codes', () => {
    expect(MAPPING_ERROR_CODES).toEqual([
      'INVALID_REQUEST',
      'PRODUCT_NOT_FOUND',
      'MAPPING_NOT_FOUND',
      'MAPPING_ALREADY_EXISTS',
      'MAPPING_VERSION_CONFLICT',
      'MAPPING_NOT_VALIDATED',
      'MAPPING_VALIDATION_FAILED',
    ]);
  });

  it('accepts a validation failure with stable issue codes only', () => {
    const failure = {
      error: 'MAPPING_VALIDATION_FAILED',
      message: '映射草稿未通过本地校验',
      issues: ['deduction_unit_mismatch'],
    };
    expect(mappingValidationFailureSchema.parse(failure)).toEqual(failure);
    expect(mappingErrorResponseSchema.parse(failure)).toEqual(failure);

    expect(
      mappingValidationFailureSchema.safeParse({ ...failure, issues: ['raw submitted value'] }).success,
    ).toBe(false);
    expect(mappingValidationFailureSchema.safeParse({ ...failure, issues: [] }).success).toBe(false);
    expect(mappingValidationFailureSchema.safeParse({ ...failure, submitted: 'YM-1001' }).success).toBe(
      false,
    );
  });

  it('accepts an invalid-request error with field paths only', () => {
    const invalid = {
      error: 'INVALID_REQUEST',
      message: '映射草稿参数不正确',
      fields: ['expectedVersion'],
    };
    expect(mappingInvalidRequestSchema.parse(invalid)).toEqual(invalid);
    expect(mappingErrorResponseSchema.parse(invalid)).toEqual(invalid);
    expect(
      mappingInvalidRequestSchema.parse({
        error: 'INVALID_REQUEST',
        message: '请求格式不正确',
      }),
    ).toEqual({ error: 'INVALID_REQUEST', message: '请求格式不正确' });
    expect(
      mappingInvalidRequestSchema.safeParse({ ...invalid, submittedValue: 'YM-1001' }).success,
    ).toBe(false);
  });

  it('rejects issues on non-validation errors and unknown codes', () => {
    expect(
      mappingErrorResponseSchema.safeParse({
        error: 'MAPPING_VERSION_CONFLICT',
        message: '映射草稿版本已变化，请刷新后重试',
      }).success,
    ).toBe(true);
    expect(
      mappingErrorResponseSchema.safeParse({
        error: 'MAPPING_VERSION_CONFLICT',
        message: '映射草稿版本已变化，请刷新后重试',
        issues: ['deduction_unit_mismatch'],
      }).success,
    ).toBe(false);
    expect(
      mappingErrorResponseSchema.safeParse({ error: 'INTERNAL_ERROR', message: '服务器内部错误' })
        .success,
    ).toBe(false);
  });
});
