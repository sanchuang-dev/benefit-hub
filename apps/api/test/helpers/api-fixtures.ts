import { expect } from 'vitest';
import {
  businessOrderErrorResponseSchema,
  type BusinessOrderErrorResponse,
} from '@sanchuang-dev/benefit-contracts';
import { loadConfig } from '../../src/config.js';
import { createProduct } from '../../src/modules/catalog/products.js';
import { createSupplierMappingRepository } from '../../src/modules/catalog/supplier-mapping-repository.js';
import type { FulfillmentMode } from '../../src/modules/orders/benefit-orders.js';
import type { TestServer } from './test-server.js';

/**
 * Fixtures and assertions shared by the API integration suites. They used to be
 * copied into every test file; keeping one copy means a contract change is
 * updated once instead of drifting across the suites.
 */

/** Builds the runtime client config a `TestServer` expects for order routes. */
export function clientsConfig(entries: Record<string, string>) {
  return loadConfig({
    DATABASE_FILE: ':memory:',
    BENEFIT_ORDER_CLIENTS_JSON: JSON.stringify(entries),
  }).businessOrderClients;
}

/** Seeds a product and activates a supplier mapping for it in one step. */
export function activateMapping(
  testServer: TestServer,
  productId: string,
  options: { mode: FulfillmentMode; productCode: string },
) {
  const repository = createSupplierMappingRepository(testServer.database.db);
  const current = repository.getDraft(productId);
  const draft = repository.saveDraft({
    productId,
    expectedVersion: current?.version ?? null,
    provider: 'yangmao',
    productCode: options.productCode,
    fulfillmentMode: options.mode,
    deductionUnit: options.mode === 'D' ? 'amount' : 'pack',
  });
  repository.validateDraft({ productId, expectedVersion: draft.version });
  return repository.activateDraft({
    productId,
    expectedVersion: draft.version,
    actorAccountId: 'test-actor',
  });
}

/** Seeds a draft product whose display name follows the shared test convention. */
export function seedProduct(testServer: TestServer, code: string) {
  return createProduct(testServer.database.db, {
    code,
    name: `测试商品 ${code}`,
    actorAccountId: 'test-actor',
  });
}

/** Returns a table's row count, for asserting that a write did not happen. */
export function countRows(testServer: TestServer, table: string): number {
  const row = testServer.database.sqlite
    .prepare(`SELECT COUNT(*) AS value FROM ${table}`)
    .get() as { value: number };
  return row.value;
}

/** Returns a table's column names, for asserting schema shape. */
export function columnsOf(testServer: TestServer, table: string): string[] {
  const rows = testServer.database.sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return rows.map((row) => row.name);
}

/** Parses a business-order error body through the shared contract schema. */
export function parseError(body: unknown): BusinessOrderErrorResponse {
  return businessOrderErrorResponseSchema.parse(body);
}

/** Builds request headers for the machine HTTP suites. */
export function bearer(token: string | null, extra: Record<string, string> = {}): Headers {
  const headers = new Headers({ 'content-type': 'application/json', ...extra });
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  return headers;
}

/** Path of a product's supplier mapping, optionally with a sub-action. */
export function mappingPath(productId: string, action = ''): string {
  return `/api/v1/catalog/products/${productId}/mapping${action}`;
}

/** Asserts the `no-store` cache contract shared by every read endpoint. */
export function expectNoStore(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
}

/** Asserts `no-store` plus the absence of a CORS grant on same-origin-only routes. */
export function expectNoStoreCors(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
}
