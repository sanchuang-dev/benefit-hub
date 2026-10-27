import {
  mappingOverviewSchema,
  type ActivateMappingDraftRequest,
  type MappingOverviewDto,
  type SaveMappingDraftRequest,
  type ValidateMappingDraftRequest,
} from '@sanchuang-dev/benefit-contracts';
import { apiRequest } from '../../shared/lib/api-client';

/**
 * A response that does not match the shared contract is a defect, not an empty
 * mapping. Keeping it as its own error type stops the panel from rendering the
 * misleading "not configured" state for a malformed or mismatched payload.
 */
export class MappingContractError extends Error {
  constructor(readonly problem: string) {
    super(`供应商映射响应不符合共享契约：${problem}`);
    this.name = 'MappingContractError';
  }
}

function mappingPath(productId: string): string {
  return `/api/v1/catalog/products/${encodeURIComponent(productId)}/mapping`;
}

/**
 * Every mapping endpoint returns the same authoritative overview, so one
 * parser guards reads and writes. A contract-valid body for another product
 * must never be shown for this one.
 */
function parseOverview(payload: unknown, productId: string): MappingOverviewDto {
  const parsed = mappingOverviewSchema.safeParse(payload);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    throw new MappingContractError(`字段 ${fields.join('、') || '(root)'} 不符合契约`);
  }

  if (parsed.data.productId !== productId) {
    throw new MappingContractError('返回的商品 ID 与请求不一致');
  }

  return parsed.data;
}

/**
 * Reads the current mapping overview through the shared BHB-009 contract. The
 * schema is owned by `@sanchuang-dev/benefit-contracts`; this feature must not
 * keep a second copy of the DTO or its field enums.
 */
export async function fetchMappingOverview(productId: string): Promise<MappingOverviewDto> {
  const payload = await apiRequest<unknown>(mappingPath(productId));
  return parseOverview(payload, productId);
}

/**
 * The request bodies are already typed by the shared contract schemas, and the
 * actor is never part of them: the API takes it from the admin session.
 */
export async function saveMappingDraft(
  productId: string,
  input: SaveMappingDraftRequest,
): Promise<MappingOverviewDto> {
  const payload = await apiRequest<unknown>(`${mappingPath(productId)}/draft`, {
    method: 'PUT',
    body: input,
  });
  return parseOverview(payload, productId);
}

export async function validateMappingDraft(
  productId: string,
  input: ValidateMappingDraftRequest,
): Promise<MappingOverviewDto> {
  const payload = await apiRequest<unknown>(`${mappingPath(productId)}/validate`, {
    method: 'POST',
    body: input,
  });
  return parseOverview(payload, productId);
}

export async function activateMappingDraft(
  productId: string,
  input: ActivateMappingDraftRequest,
): Promise<MappingOverviewDto> {
  const payload = await apiRequest<unknown>(`${mappingPath(productId)}/activate`, {
    method: 'POST',
    body: input,
  });
  return parseOverview(payload, productId);
}
