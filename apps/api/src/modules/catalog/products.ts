import { randomUUID } from 'node:crypto';
import type { MappingProvider } from '@sanchuang-dev/benefit-contracts';
import { and, asc, count, desc, eq, or, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client.js';
import {
  catalogProductEvents,
  catalogProducts,
  supplierProductMappingVersions,
  supplierProductMappings,
} from '../../db/schema.js';
import { toFulfillmentMode } from '../orders/benefit-orders.js';
import { toMappingProvider } from './supplier-mapping.js';

export const PRODUCT_STATUSES = ['active', 'disabled'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/**
 * Operator-facing business code. Codes are normalized to upper case so
 * `tx-10` and `TX-10` cannot create two rows that only differ by case.
 */
export const PRODUCT_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/i;

export type ProductAction = 'created' | 'updated' | 'enabled' | 'disabled';

/**
 * Internal product shape. `id` is ours alone; nothing here refers to a supplier
 * SKU or mapping, and monetary amounts are integer minor units (cents).
 */
export interface CatalogProduct {
  id: string;
  code: string;
  name: string;
  shortDescription: string;
  status: ProductStatus;
  displayPriceCents: number | null;
  estimatedCostCents: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export type CatalogProductDto = CatalogProduct;

/**
 * Which mapping facts the catalogue table may show for one product:
 * `none` has no mapping row at all, `draft` has a mapping without an active
 * version, `active` has an accepted immutable version snapshot.
 */
export const MAPPING_STATES = ['none', 'draft', 'active'] as const;
export type MappingState = (typeof MAPPING_STATES)[number];

/**
 * Mapping summary attached to a catalogue list row. The mapping facts are owned
 * by the mapping module (`supplier-mapping-repository.ts`); this is only the
 * read projection the catalogue table needs, and every mapping write keeps going
 * through that module.
 */
export interface ProductMappingSummary {
  state: MappingState;
  provider: string | null;
  productCode: string | null;
  fulfillmentMode: string | null;
  versionNumber: number | null;
}

/**
 * Catalogue list row. `mapping` belongs to the list read model only: the detail
 * and write DTOs must stay mapping-free so they keep their original semantics.
 */
export type ProductListItem = CatalogProduct & { mapping: ProductMappingSummary };
export type ProductListItemDto = ProductListItem;

export function toProductListItemDto(item: ProductListItem): ProductListItemDto {
  return item;
}

export class ProductInputError extends Error {}
export class ProductNotFoundError extends Error {}
export class ProductCodeConflictError extends Error {}
export class ProductVersionConflictError extends Error {}

export function normalizeProductCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function assertProductCode(code: string): void {
  if (!PRODUCT_CODE_PATTERN.test(code)) {
    throw new ProductInputError('商品编码需为 2-64 位字母、数字或 . _ -');
  }
}

function toStatus(value: string): ProductStatus {
  if (value === 'active' || value === 'disabled') return value;
  // A stored value outside the CHECK constraint is data corruption, not a
  // silent fallback to an active product.
  throw new Error(`Unknown product status stored in database: ${value}`);
}

interface ProductRow {
  id: string;
  code: string;
  name: string;
  shortDescription: string;
  status: string;
  displayPriceCents: number | null;
  estimatedCostCents: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

function toProduct(row: ProductRow): CatalogProduct {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    shortDescription: row.shortDescription,
    status: toStatus(row.status),
    displayPriceCents: row.displayPriceCents,
    estimatedCostCents: row.estimatedCostCents,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toProductDto(product: CatalogProduct): CatalogProductDto {
  return product;
}

function isCodeConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed: catalog_products.code');
}

export interface CreateProductInput {
  code: string;
  name: string;
  shortDescription?: string;
  displayPriceCents?: number | null;
  estimatedCostCents?: number | null;
  actorAccountId: string;
}

/**
 * Creates an active internal product. The product itself is never fulfilable:
 * it has no supplier mapping, and enabling/disabling only affects whether a
 * future mapping may reference it.
 */
export function createProduct(db: AppDatabase, input: CreateProductInput): CatalogProduct {
  const code = normalizeProductCode(input.code);
  assertProductCode(code);

  const now = Date.now();
  const row = {
    id: randomUUID(),
    code,
    name: input.name.trim(),
    shortDescription: input.shortDescription?.trim() ?? '',
    status: 'active' as const,
    displayPriceCents: input.displayPriceCents ?? null,
    estimatedCostCents: input.estimatedCostCents ?? null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  return db.transaction((tx) => {
    try {
      tx.insert(catalogProducts).values(row).run();
    } catch (error) {
      if (isCodeConflict(error)) throw new ProductCodeConflictError(`商品编码已存在：${code}`);
      throw error;
    }
    tx.insert(catalogProductEvents)
      .values({
        id: randomUUID(),
        productId: row.id,
        actorAccountId: input.actorAccountId,
        action: 'created',
        createdAt: now,
      })
      .run();
    return toProduct(row);
  });
}

export interface UpdateProductInput {
  code?: string;
  name?: string;
  shortDescription?: string;
  displayPriceCents?: number | null;
  estimatedCostCents?: number | null;
}

/**
 * Applies an edit only when the caller's version still matches. The conditional
 * `WHERE id = ? AND version = ?` makes the version check atomic, so two
 * operators editing the same version cannot silently overwrite each other.
 */
export function updateProduct(
  db: AppDatabase,
  id: string,
  expectedVersion: number,
  input: UpdateProductInput,
  actorAccountId: string,
): CatalogProduct {
  const changes: UpdateProductInput = { ...input };
  if (changes.code !== undefined) {
    changes.code = normalizeProductCode(changes.code);
    assertProductCode(changes.code);
  }

  const now = Date.now();
  return db.transaction((tx) => {
    let updated;
    try {
      updated = tx
        .update(catalogProducts)
        .set({ ...changes, version: expectedVersion + 1, updatedAt: now })
        .where(and(eq(catalogProducts.id, id), eq(catalogProducts.version, expectedVersion)))
        .run();
    } catch (error) {
      if (isCodeConflict(error)) throw new ProductCodeConflictError(`商品编码已存在：${changes.code}`);
      throw error;
    }

    if (updated.changes === 0) {
      const current = tx
        .select({ version: catalogProducts.version })
        .from(catalogProducts)
        .where(eq(catalogProducts.id, id))
        .limit(1)
        .get();
      if (!current) throw new ProductNotFoundError(`商品不存在：${id}`);
      throw new ProductVersionConflictError(
        `商品版本已变化（当前版本 ${current.version}，提交版本 ${expectedVersion}）`,
      );
    }

    tx.insert(catalogProductEvents)
      .values({
        id: randomUUID(),
        productId: id,
        actorAccountId,
        action: 'updated',
        createdAt: now,
      })
      .run();

    const row = tx.select().from(catalogProducts).where(eq(catalogProducts.id, id)).limit(1).get();
    if (!row) throw new ProductNotFoundError(`商品不存在：${id}`);
    return toProduct(row);
  });
}

/**
 * Enables or disables a product with the same optimistic concurrency rule as an
 * edit. Disabling never removes history or the product row; a disabled product
 * must not be used by any future grant path.
 */
export function setProductStatus(
  db: AppDatabase,
  id: string,
  status: ProductStatus,
  expectedVersion: number,
  actorAccountId: string,
): CatalogProduct {
  const now = Date.now();
  return db.transaction((tx) => {
    const updated = tx
      .update(catalogProducts)
      .set({ status, version: expectedVersion + 1, updatedAt: now })
      .where(and(eq(catalogProducts.id, id), eq(catalogProducts.version, expectedVersion)))
      .run();

    if (updated.changes === 0) {
      const current = tx
        .select({ version: catalogProducts.version })
        .from(catalogProducts)
        .where(eq(catalogProducts.id, id))
        .limit(1)
        .get();
      if (!current) throw new ProductNotFoundError(`商品不存在：${id}`);
      throw new ProductVersionConflictError(
        `商品版本已变化（当前版本 ${current.version}，提交版本 ${expectedVersion}）`,
      );
    }

    tx.insert(catalogProductEvents)
      .values({
        id: randomUUID(),
        productId: id,
        actorAccountId,
        action: status === 'active' ? 'enabled' : 'disabled',
        createdAt: now,
      })
      .run();

    const row = tx.select().from(catalogProducts).where(eq(catalogProducts.id, id)).limit(1).get();
    if (!row) throw new ProductNotFoundError(`商品不存在：${id}`);
    return toProduct(row);
  });
}

export function getProduct(db: AppDatabase, id: string): CatalogProduct | null {
  const row = db.select().from(catalogProducts).where(eq(catalogProducts.id, id)).limit(1).get();
  return row ? toProduct(row) : null;
}

export interface ProductListQuery {
  page: number;
  pageSize: number;
  keyword?: string;
  status?: ProductStatus;
  /** Effective supplier: the active version's provider, otherwise the draft's. */
  supplier?: MappingProvider;
}

export interface ProductListResult {
  products: ProductListItem[];
  total: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** Columns selected for a list row, including the mapping read projection. */
interface ProductListRow extends ProductRow {
  draftProvider: string | null;
  draftProductCode: string | null;
  draftFulfillmentMode: string | null;
  draftActiveVersionId: string | null;
  activeProvider: string | null;
  activeProductCode: string | null;
  activeFulfillmentMode: string | null;
  activeVersionNumber: number | null;
}

function toMappingSummary(row: ProductListRow): ProductMappingSummary {
  if (row.draftProvider === null) {
    return {
      state: 'none',
      provider: null,
      productCode: null,
      fulfillmentMode: null,
      versionNumber: null,
    };
  }
  // A mapping row has NOT NULL content; NULL here means a half-joined row that
  // storage constraints should make impossible, so fail loudly.
  if (row.draftProductCode === null || row.draftFulfillmentMode === null) {
    throw new Error(`Incomplete supplier mapping row stored for product ${row.id}`);
  }

  if (row.draftActiveVersionId !== null) {
    if (
      row.activeProvider === null ||
      row.activeProductCode === null ||
      row.activeFulfillmentMode === null ||
      row.activeVersionNumber === null
    ) {
      throw new Error(`Active supplier mapping version missing for product ${row.id}`);
    }
    // The accepted snapshot owns the displayed facts; the edited draft must
    // never override what is actually active.
    return {
      state: 'active',
      provider: toMappingProvider(row.activeProvider),
      productCode: row.activeProductCode,
      fulfillmentMode: toFulfillmentMode(row.activeFulfillmentMode),
      versionNumber: row.activeVersionNumber,
    };
  }

  return {
    state: 'draft',
    provider: toMappingProvider(row.draftProvider),
    productCode: row.draftProductCode,
    fulfillmentMode: toFulfillmentMode(row.draftFulfillmentMode),
    versionNumber: null,
  };
}

/**
 * Paginated catalogue query. Keyword matches code, name, or short description
 * and is escaped, so `%`/`_` are literal characters rather than wildcards.
 *
 * This is deliberately a list read model: it left-joins the current mapping root
 * and its active version snapshot to show mapping facts, but mapping writes stay
 * in the mapping module. The same joins and WHERE are used by the count query so
 * `supplier` filtering — which must happen in SQL — changes `total` and paging
 * consistently instead of being applied to an already-paginated page in memory.
 */
export function listProducts(db: AppDatabase, query: ProductListQuery): ProductListResult {
  const conditions = [];
  if (query.status) conditions.push(eq(catalogProducts.status, query.status));
  if (query.keyword) {
    const pattern = `%${escapeLike(query.keyword)}%`;
    conditions.push(
      or(
        sql`${catalogProducts.code} LIKE ${pattern} ESCAPE '\\'`,
        sql`${catalogProducts.name} LIKE ${pattern} ESCAPE '\\'`,
        sql`${catalogProducts.shortDescription} LIKE ${pattern} ESCAPE '\\'`,
      ),
    );
  }
  if (query.supplier) {
    // Effective supplier semantics in one SQL predicate: the active snapshot
    // provider wins whenever a mapping has accepted a version, otherwise the
    // draft row's provider is used; a product without any mapping never matches.
    conditions.push(
      sql`COALESCE(${supplierProductMappingVersions.provider}, ${supplierProductMappings.provider}) = ${query.supplier}`,
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const total =
    db
      .select({ value: count() })
      .from(catalogProducts)
      .leftJoin(
        supplierProductMappings,
        eq(supplierProductMappings.productId, catalogProducts.id),
      )
      .leftJoin(
        supplierProductMappingVersions,
        and(
          eq(supplierProductMappingVersions.mappingId, supplierProductMappings.id),
          eq(supplierProductMappingVersions.id, supplierProductMappings.activeVersionId),
        ),
      )
      .where(where)
      .get()?.value ?? 0;

  const rows = db
    .select({
      id: catalogProducts.id,
      code: catalogProducts.code,
      name: catalogProducts.name,
      shortDescription: catalogProducts.shortDescription,
      status: catalogProducts.status,
      displayPriceCents: catalogProducts.displayPriceCents,
      estimatedCostCents: catalogProducts.estimatedCostCents,
      version: catalogProducts.version,
      createdAt: catalogProducts.createdAt,
      updatedAt: catalogProducts.updatedAt,
      draftProvider: supplierProductMappings.provider,
      draftProductCode: supplierProductMappings.productCode,
      draftFulfillmentMode: supplierProductMappings.fulfillmentMode,
      draftActiveVersionId: supplierProductMappings.activeVersionId,
      activeProvider: supplierProductMappingVersions.provider,
      activeProductCode: supplierProductMappingVersions.productCode,
      activeFulfillmentMode: supplierProductMappingVersions.fulfillmentMode,
      activeVersionNumber: supplierProductMappingVersions.versionNumber,
    })
    .from(catalogProducts)
    .leftJoin(
      supplierProductMappings,
      eq(supplierProductMappings.productId, catalogProducts.id),
    )
    .leftJoin(
      supplierProductMappingVersions,
      and(
        eq(supplierProductMappingVersions.mappingId, supplierProductMappings.id),
        eq(supplierProductMappingVersions.id, supplierProductMappings.activeVersionId),
      ),
    )
    .where(where)
    .orderBy(desc(catalogProducts.createdAt), asc(catalogProducts.code))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all();

  return {
    products: rows.map((row) => ({ ...toProduct(row), mapping: toMappingSummary(row) })),
    total,
  };
}
