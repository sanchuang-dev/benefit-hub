/**
 * Supplier product mapping domain model and local validation rules.
 *
 * This slice stops at persistence and version activation. There is no supplier
 * HTTP client, signature, credential, or product-catalogue sync here, so a
 * "validated" draft means exactly one thing: it passed *local* structural
 * checks. It must never be presented or named as upstream-verified success.
 *
 * The A/B/C/D fulfilment shapes are owned by the shared contracts wire enum and
 * re-exported by the order domain (BHB-006); this module reuses that union rather
 * than keeping a second copy.
 */

import {
  DEDUCTION_UNITS,
  MAPPING_PROVIDERS,
  MAPPING_VALIDATION_ISSUES,
  SUPPLIER_PRODUCT_CODE_PATTERN,
  type DeductionUnit,
  type MappingProvider,
  type MappingValidationIssue,
} from '@sanchuang-dev/benefit-contracts';
import {
  FULFILLMENT_MODES,
  type FulfillmentMode,
} from '../orders/benefit-orders.js';

/**
 * Mapping wire values, the upstream product-code bound and local issue codes
 * live in the shared contracts package; this module re-exports them so existing
 * domain consumers keep one import path while the protocol has one owner.
 */
export {
  DEDUCTION_UNITS,
  MAPPING_PROVIDERS,
  MAPPING_VALIDATION_ISSUES,
  SUPPLIER_PRODUCT_CODE_PATTERN,
};
export type { DeductionUnit, MappingProvider, MappingValidationIssue };

/** Activation actor references are bounded visible identifiers, never secrets. */
const ACTOR_REFERENCE_PATTERN = /^[!-~]{1,64}$/;

/** The editable mapping content shared by drafts and immutable version snapshots. */
export interface MappingContent {
  provider: string;
  productCode: string;
  fulfillmentMode: string;
  deductionUnit: string;
}

/**
 * One internal product's current mapping root and draft. `version` is the
 * optimistic concurrency token for draft writes; `validatedVersion` records the
 * draft version that passed local validation and is cleared by any edit or
 * activation so an old validation can never authorise a newer draft.
 */
export interface MappingDraft {
  mappingId: string;
  productId: string;
  provider: MappingProvider;
  productCode: string;
  fulfillmentMode: FulfillmentMode;
  deductionUnit: DeductionUnit;
  version: number;
  validatedVersion: number | null;
  validatedAt: number | null;
  activeVersionId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * One immutable activation snapshot. Rows are append-only: the repository has
 * no update/delete operation and migration 0004 adds database triggers that
 * reject mutation of accepted history.
 */
export interface MappingVersion {
  id: string;
  mappingId: string;
  productId: string;
  versionNumber: number;
  provider: MappingProvider;
  productCode: string;
  fulfillmentMode: FulfillmentMode;
  deductionUnit: DeductionUnit;
  sourceDraftVersion: number;
  activatedBy: string;
  activatedAt: number;
}

const VALIDATION_ISSUE_LABELS: Record<MappingValidationIssue, string> = {
  product_missing: '内部商品不存在',
  provider_unsupported: '供应商不是本期支持的 yangmao',
  product_code_invalid: '上游商品编码需为 1-64 位字母、数字或 . _ -',
  fulfillment_mode_unsupported: '履约模式需为 A/B/C/D 之一',
  deduction_unit_mismatch: 'A/B/C 只能按礼包/次数扣减，D 只能按金额扣减',
};

export class MappingInputError extends Error {}
export class MappingNotFoundError extends Error {}
export class MappingProductNotFoundError extends Error {}
export class MappingExistsError extends Error {}
export class MappingVersionConflictError extends Error {}
export class MappingNotValidatedError extends Error {}

/** Local validation failed; `issues` holds stable codes, never submitted values. */
export class MappingValidationError extends Error {
  readonly issues: readonly MappingValidationIssue[];

  constructor(issues: readonly MappingValidationIssue[]) {
    super(`映射草稿未通过本地校验：${issues.map((issue) => VALIDATION_ISSUE_LABELS[issue]).join('；')}`);
    this.issues = [...issues];
  }
}

function deductionUnitForMode(mode: FulfillmentMode): DeductionUnit {
  return mode === 'D' ? 'amount' : 'pack';
}

function isKnownProvider(value: string): value is MappingProvider {
  return (MAPPING_PROVIDERS as readonly string[]).includes(value);
}

function isKnownFulfillmentMode(value: string): value is FulfillmentMode {
  return (FULFILLMENT_MODES as readonly string[]).includes(value);
}

function isKnownDeductionUnit(value: string): value is DeductionUnit {
  return (DEDUCTION_UNITS as readonly string[]).includes(value);
}

export interface MappingValidationContext {
  /** Whether the referenced internal catalogue product still exists. */
  internalProductExists: boolean;
}

/**
 * Local validation of stored mapping content. It intentionally accepts raw
 * strings: rows read from SQLite and future imported data are untrusted input,
 * and a corrupt value must produce an issue instead of a runtime type lie.
 *
 * The result is ordered deterministically so callers and tests can compare it.
 */
export function collectMappingValidationIssues(
  content: MappingContent,
  context: MappingValidationContext,
): MappingValidationIssue[] {
  const issues: MappingValidationIssue[] = [];
  if (!context.internalProductExists) issues.push('product_missing');
  if (!isKnownProvider(content.provider)) issues.push('provider_unsupported');
  if (!SUPPLIER_PRODUCT_CODE_PATTERN.test(content.productCode)) {
    issues.push('product_code_invalid');
  }
  const mode = isKnownFulfillmentMode(content.fulfillmentMode)
    ? content.fulfillmentMode
    : null;
  if (mode === null) {
    issues.push('fulfillment_mode_unsupported');
  }

  const unitKnown = isKnownDeductionUnit(content.deductionUnit);
  if (!unitKnown || (mode !== null && content.deductionUnit !== deductionUnitForMode(mode))) {
    issues.push('deduction_unit_mismatch');
  }
  return issues;
}

export function assertMappingProvider(raw: string): MappingProvider {
  if (!isKnownProvider(raw)) {
    throw new MappingInputError(`供应商需为 ${MAPPING_PROVIDERS.join('/')}（本期固定为羊毛）`);
  }
  return raw;
}

export function assertMappingFulfillmentMode(raw: string): FulfillmentMode {
  if (!isKnownFulfillmentMode(raw)) {
    throw new MappingInputError(`履约模式需为 ${FULFILLMENT_MODES.join('/')} 之一`);
  }
  return raw;
}

export function assertDeductionUnit(raw: string): DeductionUnit {
  if (!isKnownDeductionUnit(raw)) {
    throw new MappingInputError(`扣减单位需为 ${DEDUCTION_UNITS.join('/')} 之一`);
  }
  return raw;
}

/**
 * Trims and bounds the upstream product code at write time. Semantic pairing
 * with the fulfilment mode stays a validation-step concern so an in-progress
 * draft can be saved without pretending it is already accepted.
 */
export function normalizeSupplierProductCode(raw: string): string {
  if (typeof raw !== 'string') throw new MappingInputError('上游商品编码不能为空');
  const value = raw.trim();
  if (!SUPPLIER_PRODUCT_CODE_PATTERN.test(value)) {
    throw new MappingInputError('上游商品编码需为 1-64 位字母、数字或 . _ -，不允许空格或原始响应内容');
  }
  return value;
}

export function requireMappingProductId(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new MappingInputError('内部商品 ID 不能为空');
  }
  return raw.trim();
}

export function requireMappingVersion(raw: number, label = '映射草稿版本号'): number {
  if (!Number.isSafeInteger(raw) || raw < 1) {
    throw new MappingInputError(`${label}需为大于 0 的整数`);
  }
  return raw;
}

export function requireActivationActor(raw: string): string {
  if (typeof raw !== 'string' || !ACTOR_REFERENCE_PATTERN.test(raw)) {
    throw new MappingInputError('激活操作者引用需为 1-64 位可见 ASCII 字符');
  }
  return raw;
}

/** Stored values outside the documented sets are corruption, not a default. */
export function toMappingProvider(value: string): MappingProvider {
  if (!isKnownProvider(value)) {
    throw new Error(`Unknown supplier provider stored in mapping: ${value}`);
  }
  return value;
}

export function toDeductionUnit(value: string): DeductionUnit {
  if (!isKnownDeductionUnit(value)) {
    throw new Error(`Unknown deduction unit stored in mapping: ${value}`);
  }
  return value;
}
