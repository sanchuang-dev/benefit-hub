import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { migrations } from '../src/db/migrations.js';
import { createProduct, setProductStatus } from '../src/modules/catalog/products.js';
import {
  createSupplierMappingRepository,
  type SupplierMappingRepository,
} from '../src/modules/catalog/supplier-mapping-repository.js';
import type { DeductionUnit, MappingVersion } from '../src/modules/catalog/supplier-mapping.js';
import {
  OrderInputError,
  OrderIntentConflictError,
  OrderMappingUnavailableError,
  OrderNotFoundError,
  OrderProductDisabledError,
  OrderProductNotFoundError,
  OrderVersionConflictError,
  type FulfillmentMode,
  type OrderStatus,
} from '../src/modules/orders/benefit-orders.js';
import {
  createBenefitOrderRepository,
  type BenefitOrderRepository,
  type CreateOrderIntentResult,
} from '../src/modules/orders/repository.js';
import { TestServer } from './helpers/test-server.js';

let server: TestServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function seedProduct(testServer: TestServer, code: string) {
  return createProduct(testServer.database.db, {
    code,
    name: `测试商品 ${code}`,
    actorAccountId: 'test-actor',
  });
}

interface MappingContent {
  productCode?: string;
  fulfillmentMode?: FulfillmentMode;
  deductionUnit?: DeductionUnit;
}

function mappingRepository(testServer: TestServer): SupplierMappingRepository {
  return createSupplierMappingRepository(testServer.database.db);
}

/**
 * Saves, validates and activates a mapping draft. When a draft already exists
 * this rotates it, which is exactly the BHB-007 transition an existing order
 * must survive unchanged.
 */
function activateNewMapping(
  testServer: TestServer,
  productId: string,
  content: MappingContent = {},
): MappingVersion {
  const repository = mappingRepository(testServer);
  const full = {
    productCode: 'YM-1001',
    fulfillmentMode: 'B' as FulfillmentMode,
    deductionUnit: 'pack' as DeductionUnit,
    ...content,
  };
  const draft = repository.getDraft(productId);
  const saved = draft
    ? repository.saveDraft({
        productId,
        expectedVersion: draft.version,
        provider: 'yangmao',
        ...full,
      })
    : repository.saveDraft({ productId, provider: 'yangmao', ...full });
  repository.validateDraft({ productId, expectedVersion: saved.version });
  return repository.activateDraft({
    productId,
    expectedVersion: saved.version,
    actorAccountId: 'test-actor',
  });
}

/** Product that is active and already has one current active mapping snapshot. */
function seedEligibleProduct(
  testServer: TestServer,
  code: string,
  content: MappingContent = {},
) {
  const product = seedProduct(testServer, code);
  const version = activateNewMapping(testServer, product.id, content);
  return { product, version };
}

function countOrders(testServer: TestServer): number {
  const row = testServer.database.sqlite
    .prepare('SELECT COUNT(*) AS value FROM benefit_orders')
    .get() as { value: number };
  return row.value;
}

function countStatusEvents(testServer: TestServer, orderId?: string): number {
  const row = orderId
    ? (testServer.database.sqlite
        .prepare('SELECT COUNT(*) AS value FROM benefit_order_status_events WHERE order_id = ?')
        .get(orderId) as { value: number })
    : (testServer.database.sqlite
        .prepare('SELECT COUNT(*) AS value FROM benefit_order_status_events')
        .get() as { value: number });
  return row.value;
}

function columnsOf(testServer: TestServer, table: string): string[] {
  const rows = testServer.database.sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return rows.map((row) => row.name);
}

function orderInput(productId: string, businessOrderNo = 'LO-1001') {
  return {
    businessSource: ' Local-Life ',
    businessOrderNo,
    productId,
  };
}

describe('benefit order persistence', () => {
  it('persists an order intent with the active mapping version and keeps it readable after reopen', () => {
    server = new TestServer();
    const { product, version } = seedEligibleProduct(server, 'TX-TRAVEL-10');
    const repository = createBenefitOrderRepository(server.database.db);

    const created = repository.createOrGetIntent(orderInput(product.id));
    expect(created.created).toBe(true);
    expect(created.order).toMatchObject({
      businessSource: 'local-life',
      businessOrderNo: 'LO-1001',
      productId: product.id,
      mappingVersionId: version.id,
      fulfillmentMode: 'B',
      status: 'pending',
      version: 1,
    });
    expect(created.order.id).not.toBe(created.order.businessOrderNo);
    expect(created.order.createdAt).toBe(created.order.updatedAt);
    expect(
      repository.listStatusEvents(created.order.id).map(({ status, version }) => ({ status, version })),
    ).toEqual([{ status: 'pending', version: 1 }]);

    // The row really lives in the SQLite file, not only in this process.
    const stored = server.database.sqlite
      .prepare(
        `SELECT business_source, business_order_no, product_id, mapping_version_id,
                fulfillment_mode, status, version
           FROM benefit_orders WHERE id = ?`,
      )
      .get(created.order.id);
    expect(stored).toEqual({
      business_source: 'local-life',
      business_order_no: 'LO-1001',
      product_id: product.id,
      mapping_version_id: version.id,
      fulfillment_mode: 'B',
      status: 'pending',
      version: 1,
    });

    server.restart();
    expect(runMigrations(server.database.sqlite)).toEqual([]);

    const reopened = createBenefitOrderRepository(server.database.db);
    expect(reopened.getById(created.order.id)).toEqual(created.order);
    expect(reopened.findByIdentity('LOCAL-LIFE', 'LO-1001')).toEqual(created.order);
  });

  it('replays an equivalent request without creating another order or changing its state', () => {
    server = new TestServer();
    const { product, version } = seedEligibleProduct(server, 'TX-TRAVEL-10');
    const repository = createBenefitOrderRepository(server.database.db);

    const first = repository.createOrGetIntent(orderInput(product.id));
    const replayed = repository.createOrGetIntent({
      ...orderInput(product.id),
      businessSource: 'local-life',
    });

    expect(replayed.created).toBe(false);
    expect(replayed.order).toEqual(first.order);
    expect(replayed.order.mappingVersionId).toBe(version.id);
    expect(countOrders(server)).toBe(1);
    expect(countStatusEvents(server)).toBe(1);
  });

  it('copies the frozen fulfillment mode from the active mapping snapshot', () => {
    server = new TestServer();
    const { product, version } = seedEligibleProduct(server, 'TX-AMOUNT-10', {
      productCode: 'YM-AMOUNT-1',
      fulfillmentMode: 'D',
      deductionUnit: 'amount',
    });
    const repository = createBenefitOrderRepository(server.database.db);

    const { order } = repository.createOrGetIntent(orderInput(product.id));

    expect(order.mappingVersionId).toBe(version.id);
    expect(order.fulfillmentMode).toBe('D');
  });

  it('rejects conflicting key parameters for the same business identity before any eligibility check', () => {
    server = new TestServer();
    const { product } = seedEligibleProduct(server, 'TX-TRAVEL-10');
    // The other product intentionally has no mapping: conflict detection must
    // not depend on the current eligibility of the requested replacement.
    const otherProduct = seedProduct(server, 'COFFEE-1');
    const repository = createBenefitOrderRepository(server.database.db);

    const first = repository.createOrGetIntent(orderInput(product.id));

    expect(() =>
      repository.createOrGetIntent({ ...orderInput(product.id), productId: otherProduct.id }),
    ).toThrowError(OrderIntentConflictError);

    // The first order fact is untouched: no silent overwrite of product or mode.
    expect(repository.getById(first.order.id)).toEqual(first.order);
    expect(countOrders(server)).toBe(1);
    expect(countStatusEvents(server)).toBe(1);
  });

  it('keeps business order numbers case-sensitive while normalizing the source key', () => {
    server = new TestServer();
    const { product } = seedEligibleProduct(server, 'TX-TRAVEL-10');
    const repository = createBenefitOrderRepository(server.database.db);

    const upper = repository.createOrGetIntent(orderInput(product.id, 'LO-ABC'));
    const lower = repository.createOrGetIntent(orderInput(product.id, 'lo-abc'));

    expect(upper.order.businessOrderNo).toBe('LO-ABC');
    expect(lower.created).toBe(true);
    expect(lower.order.id).not.toBe(upper.order.id);
    expect(countOrders(server)).toBe(2);
  });

  it('enforces business identity uniqueness in the database itself', () => {
    server = new TestServer();
    const { product, version } = seedEligibleProduct(server, 'TX-TRAVEL-10');
    const repository = createBenefitOrderRepository(server.database.db);

    repository.createOrGetIntent(orderInput(product.id));

    expect(() =>
      server?.database.sqlite
        .prepare(
          `INSERT INTO benefit_orders
             (id, business_source, business_order_no, product_id, mapping_version_id,
              fulfillment_mode, status, version, created_at, updated_at)
           VALUES ('direct-insert', 'local-life', 'LO-1001', ?, ?, 'B', 'pending', 1, 0, 0)`,
        )
        .run(product.id, version.id),
    ).toThrowError(/UNIQUE constraint failed: benefit_orders.business_source, benefit_orders.business_order_no/);
    expect(countOrders(server)).toBe(1);
  });

  it('creates exactly one order and one initial status fact when two connections race for the same intent', async () => {
    server = new TestServer();
    const { product, version } = seedEligibleProduct(server, 'TX-TRAVEL-10');
    const primary = createBenefitOrderRepository(server.database.db);
    const second = openDatabase(server.file);

    try {
      const concurrentRepository = createBenefitOrderRepository(second.db);
      const attempt = async (repository: BenefitOrderRepository) => {
        // Yield so both callers reach the database in an interleaved way.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return repository.createOrGetIntent(orderInput(product.id));
      };

      const [left, right] = await Promise.all([
        attempt(primary),
        attempt(concurrentRepository),
      ]);

      expect(left.order.id).toBe(right.order.id);
      expect([left.created, right.created].filter(Boolean)).toHaveLength(1);
      expect(left.order.mappingVersionId).toBe(version.id);
      expect(right.order.mappingVersionId).toBe(version.id);
      expect(countOrders(server)).toBe(1);
      expect(countStatusEvents(server)).toBe(1);
      expect(second.sqlite.prepare('SELECT COUNT(*) AS value FROM benefit_orders').get()).toEqual({
        value: 1,
      });
      expect(
        second.sqlite.prepare('SELECT COUNT(*) AS value FROM benefit_order_status_events').get(),
      ).toEqual({ value: 1 });
    } finally {
      second.close();
    }
  });

  it('rejects an order intent that references an unknown internal product', () => {
    server = new TestServer();
    const repository = createBenefitOrderRepository(server.database.db);

    expect(() =>
      repository.createOrGetIntent({ ...orderInput('missing-product'), businessOrderNo: 'LO-404' }),
    ).toThrowError(OrderProductNotFoundError);
    expect(countOrders(server)).toBe(0);
  });

  it('rejects a genuinely new order when the product has no mapping or no active version', () => {
    server = new TestServer();
    const unmappedProduct = seedProduct(server, 'NO-MAPPING-1');
    const draftOnlyProduct = seedProduct(server, 'DRAFT-ONLY-1');
    mappingRepository(server).saveDraft({
      productId: draftOnlyProduct.id,
      provider: 'yangmao',
      productCode: 'YM-DRAFT-1',
      fulfillmentMode: 'B',
      deductionUnit: 'pack',
    });
    const repository = createBenefitOrderRepository(server.database.db);

    expect(() => repository.createOrGetIntent(orderInput(unmappedProduct.id))).toThrowError(
      OrderMappingUnavailableError,
    );
    expect(() => repository.createOrGetIntent(orderInput(draftOnlyProduct.id))).toThrowError(
      OrderMappingUnavailableError,
    );
    expect(countOrders(server)).toBe(0);
    expect(countStatusEvents(server)).toBe(0);
  });

  it('rejects a genuinely new order for a disabled product even when a mapping is active', () => {
    server = new TestServer();
    const { product } = seedEligibleProduct(server, 'DISABLED-1');
    setProductStatus(server.database.db, product.id, 'disabled', product.version, 'test-actor');
    const repository = createBenefitOrderRepository(server.database.db);

    expect(() => repository.createOrGetIntent(orderInput(product.id))).toThrowError(
      OrderProductDisabledError,
    );
    expect(countOrders(server)).toBe(0);
    expect(countStatusEvents(server)).toBe(0);
  });

  it('rejects invalid business identity input instead of storing an unusable key', () => {
    server = new TestServer();
    const { product } = seedEligibleProduct(server, 'TX-TRAVEL-10');
    const repository = createBenefitOrderRepository(server.database.db);

    expect(() =>
      repository.createOrGetIntent({ ...orderInput(product.id), businessSource: '  ' }),
    ).toThrowError(OrderInputError);
    expect(() =>
      repository.createOrGetIntent({ ...orderInput(product.id), businessOrderNo: 'has space' }),
    ).toThrowError(OrderInputError);
    expect(countOrders(server)).toBe(0);
  });
});

describe('benefit order mapping version freezing', () => {
  it('keeps older orders on their original version after activation rotates the active mapping', () => {
    server = new TestServer();
    const product = seedProduct(server, 'ROTATE-1');
    const firstVersion = activateNewMapping(server, product.id, { fulfillmentMode: 'B' });
    const repository = createBenefitOrderRepository(server.database.db);

    const first = repository.createOrGetIntent(orderInput(product.id, 'LO-ROTATE-1'));
    expect(first.order).toMatchObject({
      mappingVersionId: firstVersion.id,
      fulfillmentMode: 'B',
    });

    const secondVersion = activateNewMapping(server, product.id, {
      productCode: 'YM-2002',
      fulfillmentMode: 'A',
    });
    const second = repository.createOrGetIntent(orderInput(product.id, 'LO-ROTATE-2'));

    expect(second.order).toMatchObject({
      mappingVersionId: secondVersion.id,
      fulfillmentMode: 'A',
    });
    expect(repository.getById(first.order.id)).toEqual(first.order);

    server.restart();
    const reopened = createBenefitOrderRepository(server.database.db);
    expect(reopened.getById(first.order.id)?.mappingVersionId).toBe(firstVersion.id);
    expect(reopened.getById(first.order.id)?.fulfillmentMode).toBe('B');
    expect(reopened.getById(second.order.id)?.mappingVersionId).toBe(secondVersion.id);
    expect(reopened.getById(second.order.id)?.fulfillmentMode).toBe('A');
  });

  it('replays an existing order after mapping rotation and product disable without rebinding it', () => {
    server = new TestServer();
    const product = seedProduct(server, 'REPLAY-1');
    const originalVersion = activateNewMapping(server, product.id, { fulfillmentMode: 'B' });
    const repository = createBenefitOrderRepository(server.database.db);

    const first = repository.createOrGetIntent(orderInput(product.id));
    expect(first.order.mappingVersionId).toBe(originalVersion.id);

    // Both current-state transitions happen after the order was created.
    activateNewMapping(server, product.id, { productCode: 'YM-2002', fulfillmentMode: 'A' });
    setProductStatus(server.database.db, product.id, 'disabled', product.version, 'test-actor');

    const replayed = repository.createOrGetIntent({
      businessSource: 'local-life',
      businessOrderNo: 'LO-1001',
      productId: product.id,
    });

    expect(replayed.created).toBe(false);
    expect(replayed.order).toEqual(first.order);
    expect(replayed.order.mappingVersionId).toBe(originalVersion.id);
    expect(replayed.order.fulfillmentMode).toBe('B');
    expect(countOrders(server)).toBe(1);
    expect(countStatusEvents(server, first.order.id)).toBe(1);
  });
});

describe('benefit order mapping binding boundaries', () => {
  function insertOrderRow(
    testServer: TestServer,
    options: {
      id: string;
      productId: string;
      mappingVersionId: string | null;
      fulfillmentMode: string;
    },
  ): void {
    testServer.database.sqlite
      .prepare(
        `INSERT INTO benefit_orders
           (id, business_source, business_order_no, product_id, mapping_version_id,
            fulfillment_mode, status, version, created_at, updated_at)
         VALUES (?, 'local-life', ?, ?, ?, ?, 'pending', 1, 0, 0)`,
      )
      .run(
        options.id,
        options.id,
        options.productId,
        options.mappingVersionId,
        options.fulfillmentMode,
      );
  }

  it('rejects direct inserts without a current same-product mode-matching snapshot', () => {
    server = new TestServer();
    const product = seedProduct(server, 'GUARD-1');
    const staleVersion = activateNewMapping(server, product.id, { fulfillmentMode: 'B' });
    const currentVersion = activateNewMapping(server, product.id, { fulfillmentMode: 'A' });
    const other = seedEligibleProduct(server, 'GUARD-2', { fulfillmentMode: 'A' });

    expect(() =>
      insertOrderRow(server as TestServer, {
        id: 'missing-version',
        productId: product.id,
        mappingVersionId: null,
        fulfillmentMode: 'A',
      }),
    ).toThrowError(/current active mapping snapshot/);

    expect(() =>
      insertOrderRow(server as TestServer, {
        id: 'other-product',
        productId: product.id,
        mappingVersionId: other.version.id,
        fulfillmentMode: 'A',
      }),
    ).toThrowError(/current active mapping snapshot/);

    expect(() =>
      insertOrderRow(server as TestServer, {
        id: 'wrong-mode',
        productId: product.id,
        mappingVersionId: currentVersion.id,
        fulfillmentMode: 'B',
      }),
    ).toThrowError(/current active mapping snapshot/);

    expect(() =>
      insertOrderRow(server as TestServer, {
        id: 'stale-version',
        productId: product.id,
        mappingVersionId: staleVersion.id,
        fulfillmentMode: 'B',
      }),
    ).toThrowError(/current active mapping snapshot/);

    insertOrderRow(server as TestServer, {
      id: 'valid-version',
      productId: product.id,
      mappingVersionId: currentVersion.id,
      fulfillmentMode: 'A',
    });
    expect(countOrders(server as TestServer)).toBe(1);
  });

  it('freezes product, mode and mapping version for every order row but allows status edits', () => {
    server = new TestServer();
    const { product, version } = seedEligibleProduct(server, 'GUARD-UPD-1');
    const other = seedEligibleProduct(server, 'GUARD-UPD-2', { fulfillmentMode: 'A' });
    const repository = createBenefitOrderRepository(server.database.db);
    const { order } = repository.createOrGetIntent(orderInput(product.id, 'LO-FROZEN-1'));

    expect(() =>
      server?.database.sqlite
        .prepare('UPDATE benefit_orders SET product_id = ? WHERE id = ?')
        .run(other.product.id, order.id),
    ).toThrowError(/frozen at creation/);
    expect(() =>
      server?.database.sqlite
        .prepare("UPDATE benefit_orders SET fulfillment_mode = 'A' WHERE id = ?")
        .run(order.id),
    ).toThrowError(/frozen at creation/);
    expect(() =>
      server?.database.sqlite
        .prepare('UPDATE benefit_orders SET mapping_version_id = ? WHERE id = ?')
        .run(other.version.id, order.id),
    ).toThrowError(/frozen at creation/);
    expect(() =>
      server?.database.sqlite
        .prepare('UPDATE benefit_orders SET mapping_version_id = NULL WHERE id = ?')
        .run(order.id),
    ).toThrowError(/frozen at creation/);

    // Normal progress remains writable.
    const updated = repository.updateStatus({
      orderId: order.id,
      expectedVersion: order.version,
      status: 'processing',
    });
    expect(updated).toMatchObject({
      status: 'processing',
      version: 2,
      productId: product.id,
      mappingVersionId: version.id,
      fulfillmentMode: 'B',
    });
    expect(
      server?.database.sqlite
        .prepare('UPDATE benefit_orders SET updated_at = updated_at WHERE id = ?')
        .run(order.id).changes,
    ).toBe(1);
    expect(repository.getById(order.id)).toEqual(updated);
  });
});

describe('benefit order status concurrency', () => {
  it('updates status atomically and rejects a stale version without losing the newest state', () => {
    server = new TestServer();
    const { product } = seedEligibleProduct(server, 'TX-TRAVEL-10');
    const repository = createBenefitOrderRepository(server.database.db);
    const { order } = repository.createOrGetIntent(orderInput(product.id));

    const processing = repository.updateStatus({
      orderId: order.id,
      expectedVersion: order.version,
      status: 'processing',
    });
    expect(processing).toMatchObject({ status: 'processing', version: 2 });
    expect(processing.updatedAt).toBeGreaterThanOrEqual(order.updatedAt);

    expect(() =>
      repository.updateStatus({
        orderId: order.id,
        expectedVersion: order.version,
        status: 'completed',
      }),
    ).toThrowError(OrderVersionConflictError);

    // The stale write must not have changed the accepted state.
    expect(repository.getById(order.id)).toEqual(processing);

    const awaiting = repository.updateStatus({
      orderId: order.id,
      expectedVersion: processing.version,
      status: 'awaiting_claim',
    });
    expect(awaiting).toMatchObject({ status: 'awaiting_claim', version: 3 });

    const row = server.database.sqlite
      .prepare('SELECT status, version FROM benefit_orders WHERE id = ?')
      .get(order.id);
    expect(row).toEqual({ status: 'awaiting_claim', version: 3 });
    expect(
      repository.listStatusEvents(order.id).map(({ status, version }) => ({ status, version })),
    ).toEqual([
      { status: 'pending', version: 1 },
      { status: 'processing', version: 2 },
      { status: 'awaiting_claim', version: 3 },
    ]);

    server.restart();
    const reopened = createBenefitOrderRepository(server.database.db);
    expect(
      reopened.listStatusEvents(order.id).map(({ status, version }) => ({ status, version })),
    ).toEqual([
      { status: 'pending', version: 1 },
      { status: 'processing', version: 2 },
      { status: 'awaiting_claim', version: 3 },
    ]);
  });

  it('reports a missing order and invalid status input with stable domain errors', () => {
    server = new TestServer();
    const { product } = seedEligibleProduct(server, 'TX-TRAVEL-10');
    const repository = createBenefitOrderRepository(server.database.db);
    const { order } = repository.createOrGetIntent(orderInput(product.id));

    expect(() =>
      repository.updateStatus({ orderId: 'missing-order', expectedVersion: 1, status: 'processing' }),
    ).toThrowError(OrderNotFoundError);

    expect(() =>
      repository.updateStatus({
        orderId: order.id,
        expectedVersion: 1,
        // Runtime input can bypass the union type, so the repository validates it.
        status: 'done' as unknown as OrderStatus,
      }),
    ).toThrowError(OrderInputError);

    expect(repository.getById(order.id)).toEqual(order);
  });
});

describe('fulfillment attempt facts', () => {
  it('appends and reads attempts in occurrence order without changing order status', () => {
    server = new TestServer();
    const { product } = seedEligibleProduct(server, 'TX-TRAVEL-10');
    const repository = createBenefitOrderRepository(server.database.db);
    const { order } = repository.createOrGetIntent(orderInput(product.id));

    const grant = repository.appendAttempt({
      orderId: order.id,
      operation: 'grant',
      result: 'unknown',
      upstreamRequestNo: 'req-1001',
      upstreamOrderNo: 'upstream-1001',
      occurredAt: 1_000,
    });
    const query = repository.appendAttempt({
      orderId: order.id,
      operation: 'query',
      result: 'accepted',
      upstreamRequestNo: 'req-1001',
      observedStatus: 'processing',
      occurredAt: 3_000,
      lastVerifiedAt: 3_500,
    });

    expect(grant).toMatchObject({
      orderId: order.id,
      operation: 'grant',
      result: 'unknown',
      upstreamRequestNo: 'req-1001',
      upstreamOrderNo: 'upstream-1001',
      observedStatus: null,
      occurredAt: 1_000,
      lastVerifiedAt: null,
    });
    expect(query).toMatchObject({
      operation: 'query',
      result: 'accepted',
      observedStatus: 'processing',
      occurredAt: 3_000,
      lastVerifiedAt: 3_500,
    });

    // An accepted upstream call is a fact, not a verified delivery.
    expect(repository.getById(order.id)?.status).toBe('pending');
    expect(repository.listAttempts(order.id)).toEqual([grant, query]);

    server.restart();
    const reopened = createBenefitOrderRepository(server.database.db);
    expect(reopened.listAttempts(order.id)).toEqual([grant, query]);
  });

  it('rejects attempts for unknown orders at both the repository and database boundary', () => {
    server = new TestServer();
    const { product } = seedEligibleProduct(server, 'TX-TRAVEL-10');
    const repository = createBenefitOrderRepository(server.database.db);
    const { order } = repository.createOrGetIntent(orderInput(product.id));

    expect(() =>
      repository.appendAttempt({ orderId: 'missing-order', operation: 'grant', result: 'unknown' }),
    ).toThrowError(OrderNotFoundError);

    expect(() =>
      server?.database.sqlite
        .prepare(
          `INSERT INTO fulfillment_attempts
             (id, order_id, operation, result, occurred_at)
           VALUES ('orphan-attempt', 'missing-order', 'grant', 'unknown', 0)`,
        )
        .run(),
    ).toThrowError(/FOREIGN KEY constraint failed/);

    expect(repository.listAttempts(order.id)).toEqual([]);
  });

  it('stores no sensitive columns and bounds upstream references', () => {
    server = new TestServer();
    const { product } = seedEligibleProduct(server, 'TX-TRAVEL-10');
    const repository = createBenefitOrderRepository(server.database.db);
    const { order } = repository.createOrGetIntent(orderInput(product.id));

    // The persisted model is the evidence: no credential, phone, card-key, or
    // raw supplier payload column exists for attempts to leak into.
    expect(columnsOf(server, 'benefit_orders')).toEqual([
      'id',
      'business_source',
      'business_order_no',
      'product_id',
      'fulfillment_mode',
      'status',
      'version',
      'created_at',
      'updated_at',
      'mapping_version_id',
    ]);
    expect(columnsOf(server, 'benefit_order_status_events')).toEqual([
      'id',
      'order_id',
      'status',
      'version',
      'created_at',
    ]);
    expect(columnsOf(server, 'fulfillment_attempts')).toEqual([
      'id',
      'order_id',
      'operation',
      'upstream_request_no',
      'upstream_order_no',
      'result',
      'observed_status',
      'occurred_at',
      'last_verified_at',
    ]);

    // A raw supplier payload cannot be stuffed into an upstream reference.
    expect(() =>
      server?.database.sqlite
        .prepare(
          `INSERT INTO fulfillment_attempts
             (id, order_id, operation, upstream_request_no, result, occurred_at)
           VALUES ('oversized-attempt', ?, 'grant', ?, 'unknown', 0)`,
        )
        .run(order.id, 'payload-'.repeat(40)),
    ).toThrowError(/CHECK constraint failed/);
  });

  it('does not hold a database transaction across an external supplier call', async () => {
    server = new TestServer();
    const { product } = seedEligibleProduct(server, 'TX-TRAVEL-10');
    const repository = createBenefitOrderRepository(server.database.db);
    const second = openDatabase(server.file);

    try {
      const { order } = repository.createOrGetIntent(orderInput(product.id));
      expect(server.database.sqlite.inTransaction).toBe(false);

      let inTransactionDuringCall: boolean | undefined;
      const supplierRequestNo = await (async () => {
        // Models the future supplier HTTP round-trip: no local transaction may
        // stay open while the request is in flight.
        await new Promise((resolve) => setTimeout(resolve, 20));
        inTransactionDuringCall = server?.database.sqlite.inTransaction;

        // A separate connection must be able to write during the call; an open
        // write transaction here would block until busy_timeout and then fail.
        const written = second.sqlite
          .prepare('UPDATE benefit_orders SET updated_at = updated_at WHERE id = ?')
          .run(order.id);
        expect(written.changes).toBe(1);
        return 'supplier-request-1';
      })();

      expect(inTransactionDuringCall).toBe(false);

      const attempt = repository.appendAttempt({
        orderId: order.id,
        operation: 'grant',
        result: 'accepted',
        upstreamRequestNo: supplierRequestNo,
      });
      expect(attempt.upstreamRequestNo).toBe('supplier-request-1');
      expect(server.database.sqlite.inTransaction).toBe(false);
    } finally {
      second.close();
    }
  });
});

describe('benefit order migration upgrade', () => {
  it('upgrades an existing authentication and catalogue database without losing rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'benefit-hub-upgrade-'));
    const file = join(directory, 'benefit.sqlite');
    const handle = openDatabase(file);

    try {
      expect(runMigrations(handle.sqlite, migrations.slice(0, 2))).toEqual([
        '0001_admin_auth',
        '0002_catalog_products',
      ]);

      // State a deployed /data volume would already contain before this slice.
      handle.sqlite
        .prepare(
          `INSERT INTO admin_accounts
             (id, username, display_name, role, password_hash, created_at, updated_at)
           VALUES ('acc-1', 'ops.admin', '运营管理员', 'admin', 'stored-hash', 1000, 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO admin_sessions (id, account_id, token_hash, created_at, expires_at)
           VALUES ('ses-1', 'acc-1', 'token-digest', 1000, 2000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO catalog_products
             (id, code, name, short_description, status, display_price_cents, estimated_cost_cents, version, created_at, updated_at)
           VALUES ('legacy-product', 'LEGACY-1', '历史商品', '', 'active', 100, 90, 1, 1000, 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO catalog_product_events (id, product_id, actor_account_id, action, created_at)
           VALUES ('event-1', 'legacy-product', 'acc-1', 'created', 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO auth_events (id, event, account_id, detail, created_at)
           VALUES ('auth-event-1', 'login', 'acc-1', 'ok', 1000)`,
        )
        .run();

      expect(runMigrations(handle.sqlite)).toEqual([
        '0003_benefit_orders',
        '0004_supplier_product_mappings',
        '0005_benefit_order_mapping_version',
      ]);

      // Existing tables and rows survive the additive migration untouched.
      const account = handle.sqlite
        .prepare('SELECT username, role, password_hash FROM admin_accounts')
        .get();
      expect(account).toEqual({
        username: 'ops.admin',
        role: 'admin',
        password_hash: 'stored-hash',
      });
      expect(handle.sqlite.prepare('SELECT id FROM admin_sessions').get()).toEqual({ id: 'ses-1' });
      expect(handle.sqlite.prepare('SELECT id FROM catalog_products').get()).toEqual({
        id: 'legacy-product',
      });
      expect(handle.sqlite.prepare('SELECT id FROM catalog_product_events').get()).toEqual({
        id: 'event-1',
      });
      expect(handle.sqlite.prepare('SELECT id FROM auth_events').get()).toEqual({
        id: 'auth-event-1',
      });

      const tables = (
        handle.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      ).map((row) => row.name);
      expect(tables).toContain('benefit_orders');
      expect(tables).toContain('benefit_order_status_events');
      expect(tables).toContain('fulfillment_attempts');

      // New persistence works against the upgraded schema and legacy product.
      // The product first needs a current active mapping snapshot.
      const mapping = createSupplierMappingRepository(handle.db);
      mapping.saveDraft({
        productId: 'legacy-product',
        provider: 'yangmao',
        productCode: 'YM-LEGACY-1',
        fulfillmentMode: 'A',
        deductionUnit: 'pack',
      });
      mapping.validateDraft({ productId: 'legacy-product', expectedVersion: 1 });
      const version = mapping.activateDraft({
        productId: 'legacy-product',
        expectedVersion: 1,
        actorAccountId: 'acc-1',
      });

      const repository = createBenefitOrderRepository(handle.db);
      const { order } = repository.createOrGetIntent({
        businessSource: 'card-doctor',
        businessOrderNo: 'LEGACY-ORDER-1',
        productId: 'legacy-product',
      });
      expect(order.productId).toBe('legacy-product');
      expect(order.mappingVersionId).toBe(version.id);
      expect(order.fulfillmentMode).toBe('A');

      // Re-running the migration list is a no-op on every restart.
      expect(runMigrations(handle.sqlite)).toEqual([]);
      expect(handle.sqlite.prepare('SELECT COUNT(*) AS value FROM benefit_orders').get()).toEqual({
        value: 1,
      });
      expect(
        handle.sqlite.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
      ).toEqual([
        { id: '0001_admin_auth' },
        { id: '0002_catalog_products' },
        { id: '0003_benefit_orders' },
        { id: '0004_supplier_product_mappings' },
        { id: '0005_benefit_order_mapping_version' },
      ]);
      expect(migrations.map((migration) => migration.id)).toEqual([
        '0001_admin_auth',
        '0002_catalog_products',
        '0003_benefit_orders',
        '0004_supplier_product_mappings',
        '0005_benefit_order_mapping_version',
      ]);
    } finally {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('adds the mapping version to a 0004 database while preserving legacy orders as NULL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'benefit-hub-order-mapping-upgrade-'));
    const file = join(directory, 'benefit.sqlite');
    const handle = openDatabase(file);

    try {
      expect(runMigrations(handle.sqlite, migrations.slice(0, 4))).toEqual([
        '0001_admin_auth',
        '0002_catalog_products',
        '0003_benefit_orders',
        '0004_supplier_product_mappings',
      ]);

      handle.sqlite
        .prepare(
          `INSERT INTO admin_accounts
             (id, username, display_name, role, password_hash, created_at, updated_at)
           VALUES ('acc-legacy', 'ops.admin', '运营管理员', 'admin', 'stored-hash', 1000, 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO admin_sessions (id, account_id, token_hash, created_at, expires_at)
           VALUES ('ses-legacy', 'acc-legacy', 'token-digest', 1000, 2000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO auth_events (id, event, account_id, detail, created_at)
           VALUES ('auth-event-legacy', 'login', 'acc-legacy', 'ok', 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO catalog_products
             (id, code, name, short_description, status, display_price_cents,
              estimated_cost_cents, version, created_at, updated_at)
           VALUES ('legacy-product', 'LEGACY-1', '历史商品', '', 'active', 100, 90, 1, 1000, 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO catalog_product_events (id, product_id, actor_account_id, action, created_at)
           VALUES ('catalog-event-legacy', 'legacy-product', 'acc-legacy', 'created', 1000)`,
        )
        .run();

      // A 0004 mapping already had an active snapshot before this migration.
      const mapping = createSupplierMappingRepository(handle.db);
      mapping.saveDraft({
        productId: 'legacy-product',
        provider: 'yangmao',
        productCode: 'YM-LEGACY-1',
        fulfillmentMode: 'A',
        deductionUnit: 'pack',
      });
      mapping.validateDraft({ productId: 'legacy-product', expectedVersion: 1 });
      const legacyVersion = mapping.activateDraft({
        productId: 'legacy-product',
        expectedVersion: 1,
        actorAccountId: 'acc-legacy',
      });

      // Pre-0005 order, status history and attempt facts written by the old schema.
      handle.sqlite
        .prepare(
          `INSERT INTO benefit_orders
             (id, business_source, business_order_no, product_id, fulfillment_mode, status,
              version, created_at, updated_at)
           VALUES ('order-legacy', 'local-life', 'LO-LEGACY-1', 'legacy-product', 'A',
                   'processing', 2, 1000, 1200)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO benefit_order_status_events (id, order_id, status, version, created_at)
           VALUES ('status-legacy-1', 'order-legacy', 'pending', 1, 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO benefit_order_status_events (id, order_id, status, version, created_at)
           VALUES ('status-legacy-2', 'order-legacy', 'processing', 2, 1200)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO fulfillment_attempts
             (id, order_id, operation, upstream_request_no, result, observed_status, occurred_at)
           VALUES ('attempt-legacy', 'order-legacy', 'query', 'req-legacy-1', 'accepted',
                   'processing', 1200)`,
        )
        .run();

      expect(runMigrations(handle.sqlite)).toEqual(['0005_benefit_order_mapping_version']);

      // Authentication, catalogue and mapping state all survive the additive
      // migration.
      expect(
        handle.sqlite
          .prepare('SELECT username, role, password_hash FROM admin_accounts')
          .get(),
      ).toEqual({ username: 'ops.admin', role: 'admin', password_hash: 'stored-hash' });
      expect(handle.sqlite.prepare('SELECT id FROM admin_sessions').get()).toEqual({
        id: 'ses-legacy',
      });
      expect(handle.sqlite.prepare('SELECT id FROM auth_events').get()).toEqual({
        id: 'auth-event-legacy',
      });
      expect(handle.sqlite.prepare('SELECT code, status FROM catalog_products').get()).toEqual({
        code: 'LEGACY-1',
        status: 'active',
      });
      expect(handle.sqlite.prepare('SELECT id FROM catalog_product_events').get()).toEqual({
        id: 'catalog-event-legacy',
      });

      // Every pre-existing fact survives, and the legacy order has no invented
      // mapping version.
      expect(
        handle.sqlite
          .prepare(
            `SELECT business_source, business_order_no, product_id, mapping_version_id,
                    fulfillment_mode, status, version
               FROM benefit_orders WHERE id = 'order-legacy'`,
          )
          .get(),
      ).toEqual({
        business_source: 'local-life',
        business_order_no: 'LO-LEGACY-1',
        product_id: 'legacy-product',
        mapping_version_id: null,
        fulfillment_mode: 'A',
        status: 'processing',
        version: 2,
      });
      expect(
        handle.sqlite
          .prepare(
            'SELECT status, version FROM benefit_order_status_events WHERE order_id = ? ORDER BY version',
          )
          .all('order-legacy'),
      ).toEqual([
        { status: 'pending', version: 1 },
        { status: 'processing', version: 2 },
      ]);
      expect(
        handle.sqlite
          .prepare(
            `SELECT operation, upstream_request_no, result, observed_status
               FROM fulfillment_attempts WHERE id = 'attempt-legacy'`,
          )
          .get(),
      ).toEqual({
        operation: 'query',
        upstream_request_no: 'req-legacy-1',
        result: 'accepted',
        observed_status: 'processing',
      });
      expect(
        handle.sqlite
          .prepare(
            `SELECT active_version_id FROM supplier_product_mappings WHERE product_id = 'legacy-product'`,
          )
          .get(),
      ).toEqual({ active_version_id: legacyVersion.id });
      expect(
        handle.sqlite
          .prepare('SELECT COUNT(*) AS value FROM supplier_product_mapping_versions')
          .get(),
      ).toEqual({ value: 1 });

      // The legacy order is replayed as-is even though a mapping is now active.
      const repository = createBenefitOrderRepository(handle.db);
      const replayed = repository.createOrGetIntent({
        businessSource: 'local-life',
        businessOrderNo: 'LO-LEGACY-1',
        productId: 'legacy-product',
      });
      expect(replayed.created).toBe(false);
      expect(replayed.order.mappingVersionId).toBeNull();

      // A genuinely new order binds the snapshot that is active after upgrade.
      const { order } = repository.createOrGetIntent({
        businessSource: 'local-life',
        businessOrderNo: 'LO-NEW-1',
        productId: 'legacy-product',
      });
      expect(order.mappingVersionId).toBe(legacyVersion.id);
      expect(order.fulfillmentMode).toBe('A');

      // A legacy NULL binding can never be retrofitted through UPDATE.
      expect(() =>
        handle.sqlite
          .prepare('UPDATE benefit_orders SET mapping_version_id = ? WHERE id = ?')
          .run(legacyVersion.id, 'order-legacy'),
      ).toThrowError(/frozen at creation/);
      expect(() =>
        handle.sqlite
          .prepare('UPDATE benefit_orders SET product_id = ? WHERE id = ?')
          .run('other-product', 'order-legacy'),
      ).toThrowError(/frozen at creation/);

      expect(runMigrations(handle.sqlite)).toEqual([]);
      expect(
        handle.sqlite
          .prepare("SELECT id FROM schema_migrations WHERE id = '0005_benefit_order_mapping_version'")
          .get(),
      ).toEqual({ id: '0005_benefit_order_mapping_version' });
    } finally {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

interface WorkerMessage {
  type: 'ready' | 'done' | 'error';
  result?: unknown;
  error?: string;
}

function nextWorkerMessage(worker: Worker): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMessage = (message: WorkerMessage) => {
      cleanup();
      if (message.type === 'error') reject(new Error(message.error ?? 'Worker task failed'));
      else resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      if (code === 0) return;
      cleanup();
      reject(new Error(`Worker exited with code ${code}`));
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

describe('order creation versus mapping activation concurrency', () => {
  it('binds a genuinely new order to one complete active snapshot while activation runs concurrently', async () => {
    server = new TestServer();
    const product = seedProduct(server, 'RACE-1');
    const firstVersion = activateNewMapping(server, product.id, {
      productCode: 'YM-1001',
      fulfillmentMode: 'B',
    });

    // Prepare a validated draft that the activation worker will snapshot.
    const mapping = mappingRepository(server);
    const draft = mapping.getDraft(product.id);
    if (!draft) throw new Error('Expected an existing mapping draft');
    const rotated = mapping.saveDraft({
      productId: product.id,
      expectedVersion: draft.version,
      provider: 'yangmao',
      productCode: 'YM-2002',
      fulfillmentMode: 'A',
      deductionUnit: 'pack',
    });
    mapping.validateDraft({ productId: product.id, expectedVersion: rotated.version });

    const workerUrl = new URL('./helpers/order-activation-race-bootstrap.mjs', import.meta.url);
    // Each worker opens its own SQLite connection and runs the real repository
    // modules; no test double replaces activation or order creation.
    const activationWorker = new Worker(workerUrl, {
      workerData: {
        task: {
          kind: 'activate-mapping',
          file: server.file,
          productId: product.id,
          expectedVersion: rotated.version,
        },
      },
    });
    const creationWorker = new Worker(workerUrl, {
      workerData: {
        task: {
          kind: 'create-order',
          file: server.file,
          productId: product.id,
          businessSource: 'race-source',
          businessOrderNo: 'RACE-ORDER-1',
        },
      },
    });

    try {
      const ready = await Promise.all([
        nextWorkerMessage(activationWorker),
        nextWorkerMessage(creationWorker),
      ]);
      expect(ready.map((message) => message.type)).toEqual(['ready', 'ready']);

      // Release both workers together so activation and creation genuinely
      // contend for SQLite's single writer slot on separate connections.
      activationWorker.postMessage('go');
      creationWorker.postMessage('go');

      const [activationMessage, creationMessage] = await Promise.all([
        nextWorkerMessage(activationWorker),
        nextWorkerMessage(creationWorker),
      ]);
      expect(activationMessage.type).toBe('done');
      expect(creationMessage.type).toBe('done');

      const activated = activationMessage.result as MappingVersion;
      const { order, created } = creationMessage.result as CreateOrderIntentResult;
      expect(created).toBe(true);
      expect([firstVersion.id, activated.id]).toContain(order.mappingVersionId);

      // The order carries exactly one complete snapshot: either the pre-race
      // version with its mode, or the newly activated version with its mode.
      if (order.mappingVersionId === firstVersion.id) {
        expect(order.fulfillmentMode).toBe('B');
      } else {
        expect(order.fulfillmentMode).toBe('A');
      }

      const stored = server.database.sqlite
        .prepare(
          `SELECT o.product_id, o.mapping_version_id, o.fulfillment_mode,
                  v.product_id AS snapshot_product_id, v.fulfillment_mode AS snapshot_mode
             FROM benefit_orders o
             JOIN supplier_product_mapping_versions v ON v.id = o.mapping_version_id
            WHERE o.id = ?`,
        )
        .get(order.id);
      expect(stored).toEqual({
        product_id: product.id,
        mapping_version_id: order.mappingVersionId,
        fulfillment_mode: order.fulfillmentMode,
        snapshot_product_id: product.id,
        snapshot_mode: order.fulfillmentMode,
      });
      expect(
        server.database.sqlite
          .prepare('SELECT active_version_id FROM supplier_product_mappings WHERE product_id = ?')
          .get(product.id),
      ).toEqual({ active_version_id: activated.id });
      expect(mappingRepository(server).listVersions(product.id).map((v) => v.versionNumber)).toEqual([
        1, 2,
      ]);
      expect(countOrders(server)).toBe(1);
      expect(countStatusEvents(server)).toBe(1);
    } finally {
      await Promise.all([activationWorker.terminate(), creationWorker.terminate()]);
    }
  });
});
