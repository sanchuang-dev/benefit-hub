import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, or, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client.js';
import { catalogProductEvents, catalogProducts } from '../../db/schema.js';

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
}

export interface ProductListResult {
  products: CatalogProduct[];
  total: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * Paginated catalogue query. Keyword matches code, name, or short description
 * and is escaped, so `%`/`_` are literal characters rather than wildcards.
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
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const total = db.select({ value: count() }).from(catalogProducts).where(where).get()?.value ?? 0;
  const rows = db
    .select()
    .from(catalogProducts)
    .where(where)
    .orderBy(desc(catalogProducts.createdAt), asc(catalogProducts.code))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all();

  return { products: rows.map(toProduct), total };
}
