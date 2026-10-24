import type { AppDatabase } from '../../src/db/client.js';
import type {
  DeductionUnit,
  MappingVersion,
} from '../../src/modules/catalog/supplier-mapping.js';
import { createSupplierMappingRepository } from '../../src/modules/catalog/supplier-mapping-repository.js';
import type { FulfillmentMode } from '../../src/modules/orders/benefit-orders.js';

export interface ActivationContent {
  productCode?: string;
  fulfillmentMode?: FulfillmentMode;
  /** Defaults to the unit implied by the mode: A/B/C = pack, D = amount. */
  deductionUnit?: DeductionUnit;
}

/**
 * Saves, locally validates and activates one mapping draft snapshot. Calling
 * this again for the same product rotates the mapping to a new immutable
 * version, which is how tests prove that existing orders keep their frozen
 * version.
 */
export function activateMapping(
  db: AppDatabase,
  productId: string,
  content: ActivationContent = {},
): MappingVersion {
  const repository = createSupplierMappingRepository(db);
  const fulfillmentMode = content.fulfillmentMode ?? 'B';
  const draft = repository.getDraft(productId);
  const saved = repository.saveDraft({
    productId,
    expectedVersion: draft?.version ?? null,
    provider: 'yangmao',
    productCode: content.productCode ?? 'YM-1001',
    fulfillmentMode,
    deductionUnit: content.deductionUnit ?? (fulfillmentMode === 'D' ? 'amount' : 'pack'),
  });
  repository.validateDraft({ productId, expectedVersion: saved.version });
  return repository.activateDraft({
    productId,
    expectedVersion: saved.version,
    actorAccountId: 'test-actor',
  });
}
