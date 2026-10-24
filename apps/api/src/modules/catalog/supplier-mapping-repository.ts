import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client.js';
import {
  catalogProducts,
  supplierProductMappingVersions,
  supplierProductMappings,
} from '../../db/schema.js';
import { toFulfillmentMode, type FulfillmentMode } from '../orders/benefit-orders.js';
import {
  assertDeductionUnit,
  assertMappingFulfillmentMode,
  assertMappingProvider,
  collectMappingValidationIssues,
  MappingExistsError,
  MappingNotFoundError,
  MappingNotValidatedError,
  MappingProductNotFoundError,
  MappingValidationError,
  MappingVersionConflictError,
  normalizeSupplierProductCode,
  requireActivationActor,
  requireMappingProductId,
  requireMappingVersion,
  toDeductionUnit,
  toMappingProvider,
  type DeductionUnit,
  type MappingDraft,
  type MappingVersion,
} from './supplier-mapping.js';

export interface SaveMappingDraftInput {
  productId: string;
  /**
   * Omit (or pass null) to create the product's single mapping aggregate; pass
   * the current draft version to update it. A stale version fails instead of
   * overwriting a newer draft.
   */
  expectedVersion?: number | null;
  provider: string;
  productCode: string;
  fulfillmentMode: FulfillmentMode;
  deductionUnit: DeductionUnit;
}

export interface ValidateMappingDraftInput {
  productId: string;
  expectedVersion: number;
}

export interface ActivateMappingDraftInput {
  productId: string;
  expectedVersion: number;
  /** Admin account reference of the operator who explicitly activated. */
  actorAccountId: string;
}

/**
 * Persistence boundary for supplier product mappings. Business code depends on
 * this interface rather than on Drizzle or SQLite.
 *
 * The lifecycle is deliberately three separate intents:
 * 1. `saveDraft` persists an in-progress edit without touching the active
 *    version and clears any previous validation fact;
 * 2. `validateDraft` runs *local* rules against exactly the current draft
 *    version and records that this version passed;
 * 3. `activateDraft` requires that recorded fact, copies the draft into an
 *    immutable snapshot, and atomically switches the active pointer.
 *
 * Draft semantic acceptance (for example A/B/C vs D deduction pairing) is a
 * validation rule, not a storage rule: an intermediate draft can be saved and
 * corrected, but it can never become active without passing validation. Every
 * method is a short local operation; no method may wrap an external supplier
 * call in its transaction.
 */
export interface SupplierMappingRepository {
  getDraft(productId: string): MappingDraft | null;
  getActiveVersion(productId: string): MappingVersion | null;
  /** Ascending by version number; empty when the product has no mapping. */
  listVersions(productId: string): MappingVersion[];
  saveDraft(input: SaveMappingDraftInput): MappingDraft;
  validateDraft(input: ValidateMappingDraftInput): MappingDraft;
  activateDraft(input: ActivateMappingDraftInput): MappingVersion;
}

interface DraftRow {
  id: string;
  productId: string;
  provider: string;
  productCode: string;
  fulfillmentMode: string;
  deductionUnit: string;
  version: number;
  validatedVersion: number | null;
  validatedAt: number | null;
  activeVersionId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface VersionRow {
  id: string;
  mappingId: string;
  productId: string;
  versionNumber: number;
  provider: string;
  productCode: string;
  fulfillmentMode: string;
  deductionUnit: string;
  sourceDraftVersion: number;
  activatedBy: string;
  activatedAt: number;
}

function toMappingDraft(row: DraftRow): MappingDraft {
  return {
    mappingId: row.id,
    productId: row.productId,
    provider: toMappingProvider(row.provider),
    productCode: row.productCode,
    fulfillmentMode: toFulfillmentMode(row.fulfillmentMode),
    deductionUnit: toDeductionUnit(row.deductionUnit),
    version: row.version,
    validatedVersion: row.validatedVersion,
    validatedAt: row.validatedAt,
    activeVersionId: row.activeVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMappingVersion(row: VersionRow): MappingVersion {
  return {
    id: row.id,
    mappingId: row.mappingId,
    productId: row.productId,
    versionNumber: row.versionNumber,
    provider: toMappingProvider(row.provider),
    productCode: row.productCode,
    fulfillmentMode: toFulfillmentMode(row.fulfillmentMode),
    deductionUnit: toDeductionUnit(row.deductionUnit),
    sourceDraftVersion: row.sourceDraftVersion,
    activatedBy: row.activatedBy,
    activatedAt: row.activatedAt,
  };
}

function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('FOREIGN KEY constraint failed');
}

function isMappingProductUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('UNIQUE constraint failed: supplier_product_mappings.product_id')
  );
}

function isVersionNumberConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      'UNIQUE constraint failed: supplier_product_mapping_versions.mapping_id, supplier_product_mapping_versions.version_number',
    )
  );
}

export function createSupplierMappingRepository(db: AppDatabase): SupplierMappingRepository {
  return {
    getDraft(productId) {
      const row = db
        .select()
        .from(supplierProductMappings)
        .where(eq(supplierProductMappings.productId, requireMappingProductId(productId)))
        .limit(1)
        .get();
      return row ? toMappingDraft(row) : null;
    },

    getActiveVersion(productId) {
      const mapping = db
        .select()
        .from(supplierProductMappings)
        .where(eq(supplierProductMappings.productId, requireMappingProductId(productId)))
        .limit(1)
        .get();
      if (!mapping?.activeVersionId) return null;

      const row = db
        .select()
        .from(supplierProductMappingVersions)
        .where(
          and(
            eq(supplierProductMappingVersions.id, mapping.activeVersionId),
            eq(supplierProductMappingVersions.mappingId, mapping.id),
          ),
        )
        .limit(1)
        .get();
      if (!row) {
        // The database pointer trigger and foreign key make this unreachable;
        // failing loudly is better than reporting "no active version".
        throw new Error(`Active supplier mapping version missing for mapping ${mapping.id}`);
      }
      return toMappingVersion(row);
    },

    listVersions(productId) {
      const mapping = db
        .select({ id: supplierProductMappings.id })
        .from(supplierProductMappings)
        .where(eq(supplierProductMappings.productId, requireMappingProductId(productId)))
        .limit(1)
        .get();
      if (!mapping) return [];

      const rows = db
        .select()
        .from(supplierProductMappingVersions)
        .where(eq(supplierProductMappingVersions.mappingId, mapping.id))
        .orderBy(asc(supplierProductMappingVersions.versionNumber))
        .all();
      return rows.map(toMappingVersion);
    },

    saveDraft(input) {
      const productId = requireMappingProductId(input.productId);
      const content = {
        provider: assertMappingProvider(input.provider),
        productCode: normalizeSupplierProductCode(input.productCode),
        fulfillmentMode: assertMappingFulfillmentMode(input.fulfillmentMode),
        deductionUnit: assertDeductionUnit(input.deductionUnit),
      };
      const now = Date.now();
      const expectedVersion = input.expectedVersion;

      if (expectedVersion === null || expectedVersion === undefined) {
        const row: DraftRow = {
          id: randomUUID(),
          productId,
          ...content,
          version: 1,
          validatedVersion: null,
          validatedAt: null,
          activeVersionId: null,
          createdAt: now,
          updatedAt: now,
        };

        return db.transaction(
          (tx) => {
            try {
              tx.insert(supplierProductMappings).values(row).run();
            } catch (error) {
              if (isForeignKeyViolation(error)) {
                throw new MappingProductNotFoundError(`内部商品不存在：${productId}`);
              }
              if (isMappingProductUniqueViolation(error)) {
                throw new MappingExistsError(
                  `内部商品已存在供应商映射，请按当前草稿版本更新：${productId}`,
                );
              }
              throw error;
            }
            return toMappingDraft(row);
          },
          { behavior: 'immediate' },
        );
      }

      const version = requireMappingVersion(expectedVersion);
      return db.transaction(
        (tx) => {
          const updated = tx
            .update(supplierProductMappings)
            .set({
              ...content,
              version: version + 1,
              // Any edit creates a new draft version; the old audit fact no
              // longer describes what would be activated.
              validatedVersion: null,
              validatedAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(supplierProductMappings.productId, productId),
                eq(supplierProductMappings.version, version),
              ),
            )
            .run();

          if (updated.changes === 0) {
            const current = tx
              .select({ version: supplierProductMappings.version })
              .from(supplierProductMappings)
              .where(eq(supplierProductMappings.productId, productId))
              .limit(1)
              .get();
            if (!current) throw new MappingNotFoundError(`供应商映射不存在：${productId}`);
            throw new MappingVersionConflictError(
              `映射草稿版本已变化（当前版本 ${current.version}，提交版本 ${version}）`,
            );
          }

          const row = tx
            .select()
            .from(supplierProductMappings)
            .where(eq(supplierProductMappings.productId, productId))
            .limit(1)
            .get();
          if (!row) throw new MappingNotFoundError(`供应商映射不存在：${productId}`);
          return toMappingDraft(row);
        },
        { behavior: 'immediate' },
      );
    },

    validateDraft(input) {
      const productId = requireMappingProductId(input.productId);
      const expectedVersion = requireMappingVersion(input.expectedVersion);
      const now = Date.now();

      return db.transaction(
        (tx) => {
          const row = tx
            .select()
            .from(supplierProductMappings)
            .where(eq(supplierProductMappings.productId, productId))
            .limit(1)
            .get();
          if (!row) throw new MappingNotFoundError(`供应商映射不存在：${productId}`);
          if (row.version !== expectedVersion) {
            throw new MappingVersionConflictError(
              `映射草稿版本已变化（当前版本 ${row.version}，提交版本 ${expectedVersion}）`,
            );
          }

          const product = tx
            .select({ id: catalogProducts.id })
            .from(catalogProducts)
            .where(eq(catalogProducts.id, row.productId))
            .limit(1)
            .get();
          const issues = collectMappingValidationIssues(row, {
            internalProductExists: Boolean(product),
          });
          if (issues.length > 0) throw new MappingValidationError(issues);

          // Conditional on the same draft version, so a concurrent edit can
          // never inherit a validation that was performed against older content.
          const updated = tx
            .update(supplierProductMappings)
            .set({ validatedVersion: expectedVersion, validatedAt: now })
            .where(
              and(
                eq(supplierProductMappings.productId, productId),
                eq(supplierProductMappings.version, expectedVersion),
              ),
            )
            .run();
          if (updated.changes === 0) {
            const current = tx
              .select({ version: supplierProductMappings.version })
              .from(supplierProductMappings)
              .where(eq(supplierProductMappings.productId, productId))
              .limit(1)
              .get();
            if (!current) throw new MappingNotFoundError(`供应商映射不存在：${productId}`);
            throw new MappingVersionConflictError(
              `映射草稿版本已变化（当前版本 ${current.version}，提交版本 ${expectedVersion}）`,
            );
          }

          const refreshed = tx
            .select()
            .from(supplierProductMappings)
            .where(eq(supplierProductMappings.productId, productId))
            .limit(1)
            .get();
          if (!refreshed) throw new MappingNotFoundError(`供应商映射不存在：${productId}`);
          return toMappingDraft(refreshed);
        },
        { behavior: 'immediate' },
      );
    },

    activateDraft(input) {
      const productId = requireMappingProductId(input.productId);
      const expectedVersion = requireMappingVersion(input.expectedVersion);
      const activatedBy = requireActivationActor(input.actorAccountId);
      const now = Date.now();

      return db.transaction(
        (tx) => {
          const row = tx
            .select()
            .from(supplierProductMappings)
            .where(eq(supplierProductMappings.productId, productId))
            .limit(1)
            .get();
          if (!row) throw new MappingNotFoundError(`供应商映射不存在：${productId}`);
          if (row.version !== expectedVersion) {
            throw new MappingVersionConflictError(
              `映射草稿版本已变化（当前版本 ${row.version}，提交版本 ${expectedVersion}）`,
            );
          }
          if (row.validatedVersion !== row.version) {
            throw new MappingNotValidatedError('当前草稿版本尚未通过本地校验，不能激活');
          }

          // Re-check locally even though validation recorded success: the row
          // was read from storage and must remain safe to snapshot.
          const product = tx
            .select({ id: catalogProducts.id })
            .from(catalogProducts)
            .where(eq(catalogProducts.id, row.productId))
            .limit(1)
            .get();
          const issues = collectMappingValidationIssues(row, {
            internalProductExists: Boolean(product),
          });
          if (issues.length > 0) throw new MappingValidationError(issues);

          const highest = tx
            .select({
              value: sql<number>`COALESCE(MAX(${supplierProductMappingVersions.versionNumber}), 0)`,
            })
            .from(supplierProductMappingVersions)
            .where(eq(supplierProductMappingVersions.mappingId, row.id))
            .get();

          const version: VersionRow = {
            id: randomUUID(),
            mappingId: row.id,
            productId: row.productId,
            versionNumber: (highest?.value ?? 0) + 1,
            provider: toMappingProvider(row.provider),
            productCode: row.productCode,
            fulfillmentMode: toFulfillmentMode(row.fulfillmentMode),
            deductionUnit: toDeductionUnit(row.deductionUnit),
            sourceDraftVersion: row.version,
            activatedBy,
            activatedAt: now,
          };

          try {
            tx.insert(supplierProductMappingVersions).values(version).run();
          } catch (error) {
            if (isVersionNumberConflict(error)) {
              throw new MappingVersionConflictError('映射版本已被并发激活，请刷新后重试');
            }
            throw error;
          }

          // The conditional version check is the activation serialization
          // point: two callers holding the same draft version cannot both
          // switch the pointer, and this statement runs in the same transaction
          // as the snapshot insert.
          const updated = tx
            .update(supplierProductMappings)
            .set({
              activeVersionId: version.id,
              version: row.version + 1,
              // Activation consumes the validated draft version. A later
              // activation must validate again explicitly.
              validatedVersion: null,
              validatedAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(supplierProductMappings.id, row.id),
                eq(supplierProductMappings.version, expectedVersion),
              ),
            )
            .run();
          if (updated.changes === 0) {
            throw new MappingVersionConflictError('映射版本已被并发激活，请刷新后重试');
          }

          return toMappingVersion(version);
        },
        { behavior: 'immediate' },
      );
    },
  };
}
