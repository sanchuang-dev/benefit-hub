import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { ApplicationStatus } from '@sanchuang-dev/benefit-contracts';
import type { AppDatabase } from '../../db/client.js';
import {
  businessApplicationEvents,
  businessApplicationProducts,
  businessApplications,
  catalogProducts,
} from '../../db/schema.js';

export type ApplicationAction =
  | 'created'
  | 'updated'
  | 'enabled'
  | 'disabled'
  | 'products_updated';

/**
 * Persisted application configuration. `businessSource` is normalized once at
 * creation and never edited afterwards; it is the shared identity grammar of
 * the existing downstream order contract, but this row is not a credential.
 */
export interface BusinessApplication {
  id: string;
  businessSource: string;
  name: string;
  note: string;
  status: ApplicationStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** Current internal-product fact read at request time, not a frozen snapshot. */
export interface ConfiguredApplicationProduct {
  productId: string;
  code: string;
  name: string;
  status: 'active' | 'disabled';
  configuredAt: number;
}

export class ApplicationInputError extends Error {}
export class ApplicationNotFoundError extends Error {}
export class ApplicationSourceConflictError extends Error {}
export class ApplicationVersionConflictError extends Error {}
export class ApplicationUnknownProductError extends Error {}
export class ApplicationProductNotActiveError extends Error {}

export function normalizeBusinessSource(raw: string): string {
  return raw.trim().toLowerCase();
}

function toStatus(value: string): ApplicationStatus {
  if (value === 'enabled' || value === 'disabled') return value;
  // A stored value outside the CHECK constraint is data corruption, not a
  // reason to guess a permissive state.
  throw new Error(`Unknown application status stored in database: ${value}`);
}

function toProductStatus(value: string): 'active' | 'disabled' {
  if (value === 'active' || value === 'disabled') return value;
  throw new Error(`Unknown product status stored in database: ${value}`);
}

interface ApplicationRow {
  id: string;
  businessSource: string;
  name: string;
  note: string;
  status: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

function toApplication(row: ApplicationRow): BusinessApplication {
  return {
    id: row.id,
    businessSource: row.businessSource,
    name: row.name,
    note: row.note,
    status: toStatus(row.status),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isSourceConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('UNIQUE constraint failed: business_applications.business_source')
  );
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export interface CreateApplicationInput {
  businessSource: string;
  name: string;
  note?: string;
  actorAccountId: string;
}

/**
 * Registers one application. The normalized source is the unique identity; the
 * insert and its audit fact share a transaction. No token is minted and no
 * machine caller becomes authorized by this row.
 */
export function createApplication(
  db: AppDatabase,
  input: CreateApplicationInput,
): BusinessApplication {
  const businessSource = normalizeBusinessSource(input.businessSource);
  if (businessSource.length === 0) throw new ApplicationInputError('应用来源标识不能为空');

  const now = Date.now();
  const row = {
    id: randomUUID(),
    businessSource,
    name: input.name.trim(),
    note: input.note?.trim() ?? '',
    status: 'enabled' as const,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  return db.transaction((tx) => {
    try {
      tx.insert(businessApplications).values(row).run();
    } catch (error) {
      if (isSourceConflict(error)) {
        throw new ApplicationSourceConflictError(`应用来源标识已存在：${businessSource}`);
      }
      throw error;
    }
    // New applications start enabled but with an empty allowlist; enabling a
    // shell configuration must not be mistaken for a usable machine identity.
    recordEvent(tx, row.id, input.actorAccountId, 'created', now);
    return toApplication(row);
  });
}

export interface UpdateApplicationInput {
  name?: string;
  note?: string;
}

/**
 * Renames/re-notes an application under optimistic concurrency. When the
 * submitted values already match the persisted row there is no write, no
 * version bump and no audit event, so an unchanged save cannot look like a new
 * configuration generation.
 */
export function updateApplication(
  db: AppDatabase,
  id: string,
  expectedVersion: number,
  input: UpdateApplicationInput,
  actorAccountId: string,
): BusinessApplication {
  return db.transaction((tx) => {
    const current = findApplicationRow(tx, id);
    if (!current) throw new ApplicationNotFoundError(`应用不存在：${id}`);
    if (current.version !== expectedVersion) {
      throw new ApplicationVersionConflictError(
        `应用版本已变化（当前版本 ${current.version}，提交版本 ${expectedVersion}）`,
      );
    }

    const changes: { name?: string; note?: string } = {};
    if (input.name !== undefined && input.name.trim() !== current.name) {
      changes.name = input.name.trim();
    }
    if (input.note !== undefined && input.note.trim() !== current.note) {
      changes.note = input.note.trim();
    }
    if (Object.keys(changes).length === 0) return toApplication(current);

    const now = Date.now();
    const updated = tx
      .update(businessApplications)
      .set({ ...changes, version: expectedVersion + 1, updatedAt: now })
      .where(
        and(
          eq(businessApplications.id, id),
          eq(businessApplications.version, expectedVersion),
        ),
      )
      .run();

    if (updated.changes === 0) {
      throw new ApplicationVersionConflictError('应用已被他人更新，请刷新后按最新版本重试');
    }

    recordEvent(tx, id, actorAccountId, 'updated', now);
    return requireApplication(tx, id);
  });
}

/**
 * Enables or disables a registered application. Disabling never deletes rows or
 * the configured allowlist, and repeating the current state is a no-op rather
 * than a version bump. Neither transition mints or revokes a machine token.
 */
export function setApplicationStatus(
  db: AppDatabase,
  id: string,
  status: ApplicationStatus,
  expectedVersion: number,
  actorAccountId: string,
): BusinessApplication {
  return db.transaction((tx) => {
    const current = findApplicationRow(tx, id);
    if (!current) throw new ApplicationNotFoundError(`应用不存在：${id}`);
    if (current.version !== expectedVersion) {
      throw new ApplicationVersionConflictError(
        `应用版本已变化（当前版本 ${current.version}，提交版本 ${expectedVersion}）`,
      );
    }
    if (current.status === status) return toApplication(current);

    const now = Date.now();
    const updated = tx
      .update(businessApplications)
      .set({ status, version: expectedVersion + 1, updatedAt: now })
      .where(
        and(
          eq(businessApplications.id, id),
          eq(businessApplications.version, expectedVersion),
        ),
      )
      .run();

    if (updated.changes === 0) {
      throw new ApplicationVersionConflictError('应用已被他人更新，请刷新后按最新版本重试');
    }

    recordEvent(tx, id, actorAccountId, status === 'enabled' ? 'enabled' : 'disabled', now);
    return requireApplication(tx, id);
  });
}

/**
 * Atomically replaces the complete configured internal-product set.
 *
 * Every submitted id must reference an existing `catalog_products` row, so a
 * supplier product code or free text can never be stored as an authorization
 * target. A product that is currently disabled may stay configured (it remains
 * inspectable and can be re-enabled), but it cannot be newly added. The whole
 * update shares one local transaction with its audit fact; no external call is
 * made and the configured set is not enforced on any machine caller yet.
 */
export function replaceApplicationProducts(
  db: AppDatabase,
  id: string,
  productIds: readonly string[],
  expectedVersion: number,
  actorAccountId: string,
): BusinessApplication {
  if (new Set(productIds).size !== productIds.length) {
    throw new ApplicationInputError('商品 ID 不能重复');
  }

  return db.transaction((tx) => {
    const current = findApplicationRow(tx, id);
    if (!current) throw new ApplicationNotFoundError(`应用不存在：${id}`);
    if (current.version !== expectedVersion) {
      throw new ApplicationVersionConflictError(
        `应用版本已变化（当前版本 ${current.version}，提交版本 ${expectedVersion}）`,
      );
    }

    const requestedIds = [...productIds];
    const productRows =
      requestedIds.length === 0
        ? []
        : tx
            .select({
              id: catalogProducts.id,
              status: catalogProducts.status,
            })
            .from(catalogProducts)
            .where(inArray(catalogProducts.id, requestedIds))
            .all();

    if (productRows.length !== requestedIds.length) {
      throw new ApplicationUnknownProductError('存在未登记的内部商品，未保存商品配置');
    }

    const existingRows = tx
      .select({ productId: businessApplicationProducts.productId })
      .from(businessApplicationProducts)
      .where(eq(businessApplicationProducts.applicationId, id))
      .all();
    const existingIds = new Set(existingRows.map((row) => row.productId));
    const requestedSet = new Set(requestedIds);

    const disabledNewProduct = productRows.find(
      (product) => !existingIds.has(product.id) && product.status !== 'active',
    );
    if (disabledNewProduct) {
      throw new ApplicationProductNotActiveError('已停用的内部商品不能被新增配置');
    }

    const unchanged =
      existingIds.size === requestedSet.size &&
      [...requestedSet].every((productId) => existingIds.has(productId));
    if (unchanged) return toApplication(current);

    const now = Date.now();
    const updated = tx
      .update(businessApplications)
      .set({ version: expectedVersion + 1, updatedAt: now })
      .where(
        and(
          eq(businessApplications.id, id),
          eq(businessApplications.version, expectedVersion),
        ),
      )
      .run();
    if (updated.changes === 0) {
      throw new ApplicationVersionConflictError('应用已被他人更新，请刷新后按最新版本重试');
    }

    if (requestedIds.length === 0) {
      tx.delete(businessApplicationProducts)
        .where(eq(businessApplicationProducts.applicationId, id))
        .run();
    } else {
      tx.delete(businessApplicationProducts)
        .where(
          and(
            eq(businessApplicationProducts.applicationId, id),
            notInArray(businessApplicationProducts.productId, requestedIds),
          ),
        )
        .run();
      tx.insert(businessApplicationProducts)
        .values(
          requestedIds.map((productId) => ({
            applicationId: id,
            productId,
            configuredAt: now,
          })),
        )
        .onConflictDoNothing()
        .run();
    }

    recordEvent(tx, id, actorAccountId, 'products_updated', now);
    return requireApplication(tx, id);
  });
}

export function getApplication(db: AppDatabase, id: string): BusinessApplication | null {
  const row = db
    .select()
    .from(businessApplications)
    .where(eq(businessApplications.id, id))
    .limit(1)
    .get();
  return row ? toApplication(row) : null;
}

export function listApplicationProducts(
  db: AppDatabase,
  applicationId: string,
): ConfiguredApplicationProduct[] {
  const rows = db
    .select({
      productId: catalogProducts.id,
      code: catalogProducts.code,
      name: catalogProducts.name,
      status: catalogProducts.status,
      configuredAt: businessApplicationProducts.configuredAt,
    })
    .from(businessApplicationProducts)
    .innerJoin(catalogProducts, eq(catalogProducts.id, businessApplicationProducts.productId))
    .where(eq(businessApplicationProducts.applicationId, applicationId))
    .orderBy(asc(catalogProducts.code))
    .all();

  return rows.map((row) => ({
    productId: row.productId,
    code: row.code,
    name: row.name,
    status: toProductStatus(row.status),
    configuredAt: row.configuredAt,
  }));
}

export interface ApplicationListQuery {
  page: number;
  pageSize: number;
  keyword?: string;
  status?: ApplicationStatus;
}

export interface ApplicationListRow {
  application: BusinessApplication;
  configuredProductCount: number;
}

export interface ApplicationListResult {
  applications: ApplicationListRow[];
  total: number;
}

/**
 * Bounded, server-side paginated registry query. Keyword matches the stable
 * source or display name and is escaped, so `%` and `_` are literal characters.
 */
export function listApplications(
  db: AppDatabase,
  query: ApplicationListQuery,
): ApplicationListResult {
  const conditions = [];
  if (query.status) conditions.push(eq(businessApplications.status, query.status));
  if (query.keyword) {
    const pattern = `%${escapeLike(query.keyword)}%`;
    conditions.push(
      or(
        sql`${businessApplications.businessSource} LIKE ${pattern} ESCAPE '\\'`,
        sql`${businessApplications.name} LIKE ${pattern} ESCAPE '\\'`,
      ),
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const total =
    db.select({ value: count() }).from(businessApplications).where(where).get()?.value ?? 0;

  const configuredProductCount = sql<number>`(
    SELECT COUNT(*) FROM ${businessApplicationProducts}
    WHERE ${businessApplicationProducts.applicationId} = ${businessApplications.id}
  )`;

  const rows = db
    .select({
      id: businessApplications.id,
      businessSource: businessApplications.businessSource,
      name: businessApplications.name,
      note: businessApplications.note,
      status: businessApplications.status,
      version: businessApplications.version,
      createdAt: businessApplications.createdAt,
      updatedAt: businessApplications.updatedAt,
      configuredProductCount,
    })
    .from(businessApplications)
    .where(where)
    .orderBy(desc(businessApplications.createdAt), asc(businessApplications.businessSource))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all();

  return {
    applications: rows.map((row) => ({
      application: toApplication(row),
      configuredProductCount: Number(row.configuredProductCount),
    })),
    total,
  };
}

type Transaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

function findApplicationRow(tx: Transaction, id: string): ApplicationRow | undefined {
  return tx
    .select()
    .from(businessApplications)
    .where(eq(businessApplications.id, id))
    .limit(1)
    .get();
}

function requireApplication(tx: Transaction, id: string): BusinessApplication {
  const row = findApplicationRow(tx, id);
  if (!row) throw new ApplicationNotFoundError(`应用不存在：${id}`);
  return toApplication(row);
}

function recordEvent(
  tx: Transaction,
  applicationId: string,
  actorAccountId: string,
  action: ApplicationAction,
  createdAt: number,
): void {
  tx.insert(businessApplicationEvents)
    .values({
      id: randomUUID(),
      applicationId,
      actorAccountId,
      action,
      createdAt,
    })
    .run();
}
