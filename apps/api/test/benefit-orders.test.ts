import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { migrations } from '../src/db/migrations.js';
import { createProduct, getProduct, setProductStatus } from '../src/modules/catalog/products.js';
import { createSupplierMappingRepository } from '../src/modules/catalog/supplier-mapping-repository.js';
import {
  OrderInputError,
  OrderIntentConflictError,
  OrderMappingUnavailableError,
  OrderNotFoundError,
  OrderProductNotActiveError,
  OrderProductNotFoundError,
  OrderVersionConflictError,
  type FulfillmentMode,
  type OrderStatus,
} from '../src/modules/orders/benefit-orders.js';
import {
  createBenefitOrderRepository,
  type BenefitOrderRepository,
} from '../src/modules/orders/repository.js';
import { TestServer } from './helpers/test-server.js';

let server: TestServer | undefined;

const BETTER_SQLITE3_MODULE = createRequire(import.meta.url).resolve('better-sqlite3');

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

/**
 * Saves, validates and activates a mapping snapshot for the product. Calling it
 * again rotates to the next snapshot, exactly like an operator switching the
 * active mapping.
 */
function saveActivateMapping(
  testServer: TestServer,
  productId: string,
  options: { mode: FulfillmentMode; productCode?: string },
) {
  const repository = createSupplierMappingRepository(testServer.database.db);
  const current = repository.getDraft(productId);
  const draft = repository.saveDraft({
    productId,
    expectedVersion: current?.version ?? null,
    provider: 'yangmao',
    productCode: options.productCode ?? 'YM-1001',
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

function disableProduct(testServer: TestServer, productId: string) {
  const product = getProduct(testServer.database.db, productId);
  if (!product) throw new Error(`Missing product ${productId}`);
  return setProductStatus(testServer.database.db, productId, 'disabled', product.version, 'test-actor');
}

function countOrders(testServer: TestServer): number {
  const row = testServer.database.sqlite
    .prepare('SELECT COUNT(*) AS value FROM benefit_orders')
    .get() as { value: number };
  return row.value;
}

function countStatusEvents(testServer: TestServer, orderId: string): number {
  const row = testServer.database.sqlite
    .prepare('SELECT COUNT(*) AS value FROM benefit_order_status_events WHERE order_id = ?')
    .get(orderId) as { value: number };
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

function directInsertOrder(
  testServer: TestServer,
  values: {
    id: string;
    businessOrderNo: string;
    productId: string;
    fulfillmentMode: string;
    mappingVersionId: string | null;
  },
) {
  return testServer.database.sqlite
    .prepare(
      `INSERT INTO benefit_orders
         (id, business_source, business_order_no, product_id, fulfillment_mode,
          status, version, created_at, updated_at, mapping_version_id)
       VALUES (?, 'local-life', ?, ?, ?, 'pending', 1, 0, 0, ?)`,
    )
    .run(
      values.id,
      values.businessOrderNo,
      values.productId,
      values.fulfillmentMode,
      values.mappingVersionId,
    );
}

describe('benefit order persistence', () => {
  it('persists an order intent with its frozen mapping version across a database reopen', () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
    const mappingVersion = saveActivateMapping(server, product.id, { mode: 'B' });
    const repository = createBenefitOrderRepository(server.database.db);

    const created = repository.createOrGetIntent(orderInput(product.id));
    expect(created.created).toBe(true);
    expect(created.order).toMatchObject({
      businessSource: 'local-life',
      businessOrderNo: 'LO-1001',
      productId: product.id,
      fulfillmentMode: 'B',
      status: 'pending',
      version: 1,
      mappingVersionId: mappingVersion.id,
    });
    expect(created.order.id).not.toBe(created.order.businessOrderNo);
    expect(created.order.createdAt).toBe(created.order.updatedAt);
    expect(
      repository.listStatusEvents(created.order.id).map(({ status, version }) => ({ status, version })),
    ).toEqual([{ status: 'pending', version: 1 }]);

    // The row really lives in the SQLite file, not only in this process.
    const stored = server.database.sqlite
      .prepare(
        `SELECT business_source, business_order_no, product_id, fulfillment_mode, status, version,
                mapping_version_id
           FROM benefit_orders WHERE id = ?`,
      )
      .get(created.order.id);
    expect(stored).toEqual({
      business_source: 'local-life',
      business_order_no: 'LO-1001',
      product_id: product.id,
      fulfillment_mode: 'B',
      status: 'pending',
      version: 1,
      mapping_version_id: mappingVersion.id,
    });

    server.restart();
    expect(runMigrations(server.database.sqlite)).toEqual([]);

    const reopened = createBenefitOrderRepository(server.database.db);
    expect(reopened.getById(created.order.id)).toEqual(created.order);
    expect(reopened.findByIdentity('LOCAL-LIFE', 'LO-1001')).toEqual(created.order);
  });

  it('replays an equivalent request without creating another order or changing its state', () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
    saveActivateMapping(server, product.id, { mode: 'B' });
    const repository = createBenefitOrderRepository(server.database.db);

    const first = repository.createOrGetIntent(orderInput(product.id));
    const replayed = repository.createOrGetIntent({
      ...orderInput(product.id),
      businessSource: 'local-life',
    });

    expect(replayed.created).toBe(false);
    expect(replayed.order).toEqual(first.order);
    expect(countOrders(server)).toBe(1);
  });

  it('rejects conflicting product parameters for the same business identity', () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
    const otherProduct = seedProduct(server, 'COFFEE-1');
    saveActivateMapping(server, product.id, { mode: 'B' });
    saveActivateMapping(server, otherProduct.id, { mode: 'A' });
    const repository = createBenefitOrderRepository(server.database.db);

    const first = repository.createOrGetIntent(orderInput(product.id));

    expect(() =>
      repository.createOrGetIntent({ ...orderInput(product.id), productId: otherProduct.id }),
    ).toThrowError(OrderIntentConflictError);

    // The first order fact is untouched: no silent overwrite of the product or
    // its frozen mapping version.
    expect(repository.getById(first.order.id)).toEqual(first.order);
    expect(countOrders(server)).toBe(1);
  });

  it('keeps business order numbers case-sensitive while normalizing the source key', () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
    saveActivateMapping(server, product.id, { mode: 'B' });
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
    const product = seedProduct(server, 'TX-TRAVEL-10');
    const mappingVersion = saveActivateMapping(server, product.id, { mode: 'B' });
    const repository = createBenefitOrderRepository(server.database.db);

    repository.createOrGetIntent(orderInput(product.id));

    // A syntactically valid binding still cannot duplicate the business identity.
    expect(() =>
      directInsertOrder(server as TestServer, {
        id: 'direct-insert',
        businessOrderNo: 'LO-1001',
        productId: product.id,
        fulfillmentMode: mappingVersion.fulfillmentMode,
        mappingVersionId: mappingVersion.id,
      }),
    ).toThrowError(
      /UNIQUE constraint failed: benefit_orders.business_source, benefit_orders.business_order_no/,
    );
    expect(countOrders(server)).toBe(1);
  });

  it('creates exactly one order and one initial status fact when two connections race', async () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
    const mappingVersion = saveActivateMapping(server, product.id, { mode: 'B' });
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
      expect(left.order.mappingVersionId).toBe(mappingVersion.id);
      expect(right.order.mappingVersionId).toBe(mappingVersion.id);
      expect([left.created, right.created].filter(Boolean)).toHaveLength(1);
      expect(countOrders(server)).toBe(1);
      expect(countStatusEvents(server, left.order.id)).toBe(1);
      expect(second.sqlite.prepare('SELECT COUNT(*) AS value FROM benefit_orders').get()).toEqual({
        value: 1,
      });
      expect(
        second.sqlite
          .prepare('SELECT COUNT(*) AS value FROM benefit_order_status_events')
          .get(),
      ).toEqual({ value: 1 });
    } finally {
      second.close();
    }
  });

  it('rejects invalid business identity input instead of storing an unusable key', () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
    saveActivateMapping(server, product.id, { mode: 'B' });
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

describe('benefit order mapping version freeze', () => {
  it('only creates a new order for an active product with a current active mapping', () => {
    server = new TestServer();
    const repository = createBenefitOrderRepository(server.database.db);
    const unmapped = seedProduct(server, 'TX-NO-MAPPING');
    const draftOnly = seedProduct(server, 'TX-DRAFT-ONLY');
    const disabled = seedProduct(server, 'TX-DISABLED');

    // Unknown internal product.
    expect(() =>
      repository.createOrGetIntent({ ...orderInput('missing-product'), businessOrderNo: 'LO-404' }),
    ).toThrowError(OrderProductNotFoundError);

    // Product exists but has no mapping aggregate at all.
    expect(() => repository.createOrGetIntent(orderInput(unmapped.id, 'LO-NO-MAP'))).toThrowError(
      OrderMappingUnavailableError,
    );

    // A saved but never validated/activated draft is not a fulfilable mapping.
    const mappings = createSupplierMappingRepository(server.database.db);
    mappings.saveDraft({
      productId: draftOnly.id,
      provider: 'yangmao',
      productCode: 'YM-DRAFT-1',
      fulfillmentMode: 'B',
      deductionUnit: 'pack',
    });
    expect(() => repository.createOrGetIntent(orderInput(draftOnly.id, 'LO-DRAFT'))).toThrowError(
      OrderMappingUnavailableError,
    );

    // A disabled product cannot start new work even though its mapping exists.
    saveActivateMapping(server, disabled.id, { mode: 'C' });
    disableProduct(server, disabled.id);
    expect(() => repository.createOrGetIntent(orderInput(disabled.id, 'LO-DISABLED'))).toThrowError(
      OrderProductNotActiveError,
    );

    expect(countOrders(server)).toBe(0);
  });

  it('copies the fulfillment mode and mapping version from the active snapshot', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-FOOD-20');
    const mappingVersion = saveActivateMapping(server, product.id, {
      mode: 'D',
      productCode: 'YM-FOOD-D',
    });
    const repository = createBenefitOrderRepository(server.database.db);

    const { order } = repository.createOrGetIntent(orderInput(product.id));

    expect(order.mappingVersionId).toBe(mappingVersion.id);
    expect(order.fulfillmentMode).toBe('D');
    expect(order.fulfillmentMode).toBe(mappingVersion.fulfillmentMode);

    server.restart();
    const reopened = createBenefitOrderRepository(server.database.db);
    expect(reopened.getById(order.id)).toEqual(order);
  });

  it('freezes each order on the snapshot that was active when it was created', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    const firstVersion = saveActivateMapping(server, product.id, { mode: 'B' });
    const repository = createBenefitOrderRepository(server.database.db);

    const first = repository.createOrGetIntent(orderInput(product.id, 'LO-1001'));
    expect(first.order).toMatchObject({
      fulfillmentMode: 'B',
      mappingVersionId: firstVersion.id,
    });

    // Operator switches the active mapping to a different mode.
    const secondVersion = saveActivateMapping(server, product.id, {
      mode: 'D',
      productCode: 'YM-TRAVEL-D',
    });
    const second = repository.createOrGetIntent(orderInput(product.id, 'LO-1002'));

    expect(second.order).toMatchObject({
      fulfillmentMode: 'D',
      mappingVersionId: secondVersion.id,
    });
    expect(secondVersion.id).not.toBe(firstVersion.id);

    // The earlier order keeps its original snapshot and mode, before and after
    // a reopen; the rotation never rewrites history.
    expect(repository.getById(first.order.id)).toEqual(first.order);
    server.restart();
    const reopened = createBenefitOrderRepository(server.database.db);
    expect(reopened.getById(first.order.id)).toEqual(first.order);
    expect(reopened.getById(second.order.id)).toEqual(second.order);
    expect(reopened.findByIdentity('local-life', 'LO-1001')).toEqual(first.order);
  });

  it('replays the original order after mapping rotation and product disable', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    const firstVersion = saveActivateMapping(server, product.id, { mode: 'B' });
    const repository = createBenefitOrderRepository(server.database.db);

    const first = repository.createOrGetIntent(orderInput(product.id));
    saveActivateMapping(server, product.id, { mode: 'D', productCode: 'YM-TRAVEL-D' });
    disableProduct(server, product.id);

    // Replay is answered from the stored order before any current-state check.
    const replayed = repository.createOrGetIntent(orderInput(product.id));

    expect(replayed.created).toBe(false);
    expect(replayed.order).toEqual(first.order);
    expect(replayed.order.mappingVersionId).toBe(firstVersion.id);
    expect(replayed.order.fulfillmentMode).toBe('B');
    expect(countOrders(server)).toBe(1);
    expect(countStatusEvents(server, first.order.id)).toBe(1);

    // Eligibility still applies to genuinely new business identities.
    expect(() =>
      repository.createOrGetIntent(orderInput(product.id, 'LO-NEW-AFTER-DISABLE')),
    ).toThrowError(OrderProductNotActiveError);
    expect(countOrders(server)).toBe(1);
  });
});

describe('benefit order database binding guards', () => {
  it('rejects direct inserts without a complete, current mapping snapshot', () => {
    server = new TestServer();
    const firstProduct = seedProduct(server, 'YM-TRAVEL-10');
    const secondProduct = seedProduct(server, 'YM-FOOD-20');
    const firstVersion = saveActivateMapping(server, firstProduct.id, { mode: 'B' });
    const secondVersion = saveActivateMapping(server, secondProduct.id, { mode: 'A' });

    // Before rotation the first version is still current.
    expect(() =>
      directInsertOrder(server as TestServer, {
        id: 'missing-version',
        businessOrderNo: 'LO-DIRECT-1',
        productId: firstProduct.id,
        fulfillmentMode: 'B',
        mappingVersionId: null,
      }),
    ).toThrowError(/requires a mapping version/);

    expect(() =>
      directInsertOrder(server as TestServer, {
        id: 'wrong-product',
        businessOrderNo: 'LO-DIRECT-2',
        productId: firstProduct.id,
        fulfillmentMode: 'A',
        mappingVersionId: secondVersion.id,
      }),
    ).toThrowError(/must match order product and mode/);

    expect(() =>
      directInsertOrder(server as TestServer, {
        id: 'wrong-mode',
        businessOrderNo: 'LO-DIRECT-3',
        productId: firstProduct.id,
        fulfillmentMode: 'A',
        mappingVersionId: firstVersion.id,
      }),
    ).toThrowError(/must match order product and mode/);

    // Rotate, then the previous snapshot is no longer the current active one.
    const secondFirstProductVersion = saveActivateMapping(server, firstProduct.id, {
      mode: 'B',
      productCode: 'YM-TRAVEL-2',
    });
    expect(() =>
      directInsertOrder(server as TestServer, {
        id: 'stale-version',
        businessOrderNo: 'LO-DIRECT-4',
        productId: firstProduct.id,
        fulfillmentMode: 'B',
        mappingVersionId: firstVersion.id,
      }),
    ).toThrowError(/must be the current active version/);

    // The complete new binding is accepted.
    directInsertOrder(server as TestServer, {
      id: 'valid-direct',
      businessOrderNo: 'LO-DIRECT-5',
      productId: firstProduct.id,
      fulfillmentMode: 'B',
      mappingVersionId: secondFirstProductVersion.id,
    });
    expect(countOrders(server)).toBe(1);
  });

  it('freezes product, mode and mapping version after creation while allowing status updates', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    const otherProduct = seedProduct(server, 'YM-FOOD-20');
    const firstVersion = saveActivateMapping(server, product.id, { mode: 'B' });
    const secondVersion = saveActivateMapping(server, product.id, {
      mode: 'D',
      productCode: 'YM-TRAVEL-D',
    });
    saveActivateMapping(server, otherProduct.id, { mode: 'A' });
    const repository = createBenefitOrderRepository(server.database.db);
    const { order } = repository.createOrGetIntent(orderInput(product.id));

    expect(order.mappingVersionId).toBe(secondVersion.id);
    expect(order.fulfillmentMode).toBe('D');

    const sqlite = (server as TestServer).database.sqlite;
    expect(() =>
      sqlite
        .prepare('UPDATE benefit_orders SET product_id = ? WHERE id = ?')
        .run(otherProduct.id, order.id),
    ).toThrowError(/frozen/);
    expect(() =>
      sqlite
        .prepare("UPDATE benefit_orders SET fulfillment_mode = 'B' WHERE id = ?")
        .run(order.id),
    ).toThrowError(/frozen/);
    expect(() =>
      sqlite
        .prepare('UPDATE benefit_orders SET mapping_version_id = ? WHERE id = ?')
        .run(firstVersion.id, order.id),
    ).toThrowError(/frozen/);

    // Ordinary state progression stays writable, directly and via repository.
    sqlite
      .prepare("UPDATE benefit_orders SET status = 'processing', version = 2, updated_at = updated_at + 1 WHERE id = ?")
      .run(order.id);
    expect(repository.getById(order.id)).toMatchObject({
      status: 'processing',
      version: 2,
      productId: product.id,
      fulfillmentMode: 'D',
      mappingVersionId: secondVersion.id,
    });

    const completed = repository.updateStatus({
      orderId: order.id,
      expectedVersion: 2,
      status: 'completed',
    });
    expect(completed).toMatchObject({ status: 'completed', version: 3 });
    expect(completed.mappingVersionId).toBe(secondVersion.id);
  });

  it('stores no credential, contact, card-key or raw supplier response columns', () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
    saveActivateMapping(server, product.id, { mode: 'B' });
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
});

describe('benefit order status concurrency', () => {
  it('updates status atomically and rejects a stale version without losing the newest state', () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
    saveActivateMapping(server, product.id, { mode: 'B' });
    const repository = createBenefitOrderRepository(server.database.db);
    const { order } = repository.createOrGetIntent(orderInput(product.id));

    const processing = repository.updateStatus({
      orderId: order.id,
      expectedVersion: order.version,
      status: 'processing',
    });
    expect(processing).toMatchObject({ status: 'processing', version: 2 });
    expect(processing.updatedAt).toBeGreaterThanOrEqual(order.updatedAt);
    expect(processing.mappingVersionId).toBe(order.mappingVersionId);

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
      .prepare('SELECT status, version, mapping_version_id FROM benefit_orders WHERE id = ?')
      .get(order.id);
    expect(row).toEqual({
      status: 'awaiting_claim',
      version: 3,
      mapping_version_id: order.mappingVersionId,
    });
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
    const product = seedProduct(server, 'TX-TRAVEL-10');
    saveActivateMapping(server, product.id, { mode: 'B' });
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

describe('benefit order / mapping activation concurrency', () => {
  it('serializes a real cross-thread activation/create race without producing a mixed binding', async () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-RACE-REAL');
    const oldVersion = saveActivateMapping(server, product.id, {
      mode: 'B',
      productCode: 'YM-RACE-OLD',
    });

    const mappingRepository = createSupplierMappingRepository(server.database.db);
    const current = mappingRepository.getDraft(product.id);
    if (!current) throw new Error('Expected a mapping draft');
    const draft = mappingRepository.saveDraft({
      productId: product.id,
      expectedVersion: current.version,
      provider: 'yangmao',
      productCode: 'YM-RACE-NEW',
      fulfillmentMode: 'D',
      deductionUnit: 'amount',
    });
    mappingRepository.validateDraft({ productId: product.id, expectedVersion: draft.version });

    const orderConnection = openDatabase(server.file);
    const orderRepository = createBenefitOrderRepository(orderConnection.db);
    const startBarrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const startFlag = new Int32Array(startBarrier);
    const activatedVersionId = 'mapping-version-real-race';

    const worker = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads');
        const Database = require(workerData.betterSqliteModule);
        const db = new Database(workerData.file);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('foreign_keys = ON');
        db.pragma('busy_timeout = 5000');

        const startFlag = new Int32Array(workerData.startBarrier);
        parentPort.postMessage({ type: 'ready' });
        Atomics.wait(startFlag, 0, 0);

        try {
          db.exec('BEGIN IMMEDIATE');

          const mapping = db
            .prepare(
              'SELECT id, product_id, provider, product_code, fulfillment_mode, deduction_unit, version, validated_version FROM supplier_product_mappings WHERE product_id = ?',
            )
            .get(workerData.productId);
          if (!mapping) throw new Error('mapping missing');
          if (
            mapping.version !== workerData.expectedDraftVersion ||
            mapping.validated_version !== mapping.version
          ) {
            throw new Error('draft is not the expected validated version');
          }

          const highest = db
            .prepare(
              'SELECT COALESCE(MAX(version_number), 0) AS value FROM supplier_product_mapping_versions WHERE mapping_id = ?',
            )
            .get(mapping.id);
          const now = Date.now();

          db.prepare(
            "INSERT INTO supplier_product_mapping_versions (id, mapping_id, product_id, version_number, provider, product_code, fulfillment_mode, deduction_unit, source_draft_version, activated_by, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'test-actor', ?)",
          ).run(
            workerData.snapshotId,
            mapping.id,
            mapping.product_id,
            Number(highest.value) + 1,
            mapping.provider,
            mapping.product_code,
            mapping.fulfillment_mode,
            mapping.deduction_unit,
            mapping.version,
            now,
          );

          const updated = db.prepare(
            'UPDATE supplier_product_mappings SET active_version_id = ?, version = ?, validated_version = NULL, validated_at = NULL, updated_at = ? WHERE id = ? AND version = ?',
          ).run(
            workerData.snapshotId,
            mapping.version + 1,
            now,
            mapping.id,
            mapping.version,
          );
          if (updated.changes !== 1) throw new Error('activation lost its expected-version update');

          db.exec('COMMIT');
          parentPort.postMessage({
            type: 'activated',
            id: workerData.snapshotId,
            fulfillmentMode: mapping.fulfillment_mode,
          });
        } catch (error) {
          if (db.inTransaction) db.exec('ROLLBACK');
          parentPort.postMessage({
            type: 'worker-error',
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          db.close();
        }
      `,
      {
        eval: true,
        workerData: {
          betterSqliteModule: BETTER_SQLITE3_MODULE,
          file: server.file,
          productId: product.id,
          expectedDraftVersion: draft.version,
          snapshotId: activatedVersionId,
          startBarrier,
        },
      },
    );

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    let resolveActivated!: (value: { id: string; fulfillmentMode: string }) => void;
    let rejectActivated!: (error: Error) => void;
    const activated = new Promise<{ id: string; fulfillmentMode: string }>((resolve, reject) => {
      resolveActivated = resolve;
      rejectActivated = reject;
    });

    const exited = new Promise<void>((resolve, reject) => {
      worker.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`activation worker exited with code ${code}`));
      });
    });

    worker.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      const typed = message as {
        type: string;
        id?: string;
        fulfillmentMode?: string;
        message?: string;
      };
      if (typed.type === 'ready') {
        resolveReady();
      } else if (
        typed.type === 'activated' &&
        typeof typed.id === 'string' &&
        typeof typed.fulfillmentMode === 'string'
      ) {
        resolveActivated({ id: typed.id, fulfillmentMode: typed.fulfillmentMode });
      } else if (typed.type === 'worker-error') {
        rejectActivated(new Error(typed.message ?? 'activation worker failed'));
      }
    });
    worker.once('error', (error) => {
      rejectReady(error);
      rejectActivated(error);
    });

    try {
      await ready;

      // Both writers leave this barrier together. The worker executes the
      // BHB-007 activation transaction on its own thread/connection while this
      // thread immediately enters createOrGetIntent(), which also uses
      // BEGIN IMMEDIATE. Whichever writer acquires SQLite's lock first defines
      // the serialized order; neither can observe a half-switched pointer.
      Atomics.store(startFlag, 0, 1);
      Atomics.notify(startFlag, 0, 1);
      const created = orderRepository.createOrGetIntent(orderInput(product.id, 'LO-RACE-REAL'));
      const activation = await activated;
      await exited;

      expect(activation).toEqual({
        id: activatedVersionId,
        fulfillmentMode: 'D',
      });
      expect(created.created).toBe(true);
      expect(countOrders(server)).toBe(1);
      expect(countStatusEvents(server, created.order.id)).toBe(1);

      const bound = orderConnection.sqlite
        .prepare(
          `SELECT orders.product_id AS order_product_id,
                  orders.fulfillment_mode AS order_mode,
                  orders.mapping_version_id AS order_mapping_version_id,
                  version.product_id AS version_product_id,
                  version.fulfillment_mode AS version_mode
             FROM benefit_orders AS orders
             JOIN supplier_product_mapping_versions AS version
               ON version.id = orders.mapping_version_id
            WHERE orders.id = ?`,
        )
        .get(created.order.id) as
        | {
            order_product_id: string;
            order_mode: string;
            order_mapping_version_id: string;
            version_product_id: string;
            version_mode: string;
          }
        | undefined;

      expect(bound).toBeDefined();
      expect(bound?.order_product_id).toBe(product.id);
      expect(bound?.version_product_id).toBe(product.id);
      expect(bound?.order_mode).toBe(bound?.version_mode);
      expect(bound?.order_mapping_version_id).toBe(created.order.mappingVersionId);
      expect([oldVersion.id, activatedVersionId]).toContain(created.order.mappingVersionId);

      if (created.order.mappingVersionId === oldVersion.id) {
        expect(created.order.fulfillmentMode).toBe('B');
      } else {
        expect(created.order.mappingVersionId).toBe(activatedVersionId);
        expect(created.order.fulfillmentMode).toBe('D');
      }

      expect(
        orderConnection.sqlite
          .prepare('SELECT active_version_id FROM supplier_product_mappings WHERE product_id = ?')
          .get(product.id),
      ).toEqual({ active_version_id: activatedVersionId });

      const replayed = orderRepository.createOrGetIntent(orderInput(product.id, 'LO-RACE-REAL'));
      expect(replayed.created).toBe(false);
      expect(replayed.order).toEqual(created.order);
    } finally {
      orderConnection.close();
    }
  });
});

describe('fulfillment attempt facts', () => {
  it('appends and reads attempts in occurrence order without changing order status', () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
    saveActivateMapping(server, product.id, { mode: 'B' });
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
    const product = seedProduct(server, 'TX-TRAVEL-10');
    saveActivateMapping(server, product.id, { mode: 'B' });
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

  it('does not hold a database transaction across an external supplier call', async () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
    saveActivateMapping(server, product.id, { mode: 'B' });
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

describe('benefit order mapping version migration (0005)', () => {
  it('upgrades 0001-0004 data without losing rows and never backfills legacy orders', () => {
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

      // Representative state a deployed /data volume already contains before
      // this slice: auth, catalogue, a legacy order with history and an
      // attempt, plus an active mapping snapshot for the same product.
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
      handle.sqlite
        .prepare(
          `INSERT INTO supplier_product_mappings
             (id, product_id, provider, product_code, fulfillment_mode, deduction_unit,
              version, created_at, updated_at)
           VALUES ('legacy-mapping', 'legacy-product', 'yangmao', 'YM-LEGACY-1', 'A', 'pack',
                   1, 1000, 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO supplier_product_mapping_versions
             (id, mapping_id, product_id, version_number, provider, product_code,
              fulfillment_mode, deduction_unit, source_draft_version, activated_by, activated_at)
           VALUES ('legacy-version', 'legacy-mapping', 'legacy-product', 1, 'yangmao',
                   'YM-LEGACY-1', 'A', 'pack', 1, 'acc-legacy', 1000)`,
        )
        .run();
      handle.sqlite
        .prepare("UPDATE supplier_product_mappings SET active_version_id = 'legacy-version' WHERE id = 'legacy-mapping'")
        .run();

      expect(runMigrations(handle.sqlite)).toEqual([
        '0005_benefit_order_mapping_version',
        '0006_supplier_connections',
        '0007_business_applications',
        '0008_business_application_credentials',
        '0009_benefit_order_grants',
        '0010_benefit_order_gift_vouchers',
        '0011_benefit_order_direct_topups',
      ]);

      // Every pre-existing fact survives the additive migration.
      expect(
        handle.sqlite.prepare('SELECT username, role, password_hash FROM admin_accounts').get(),
      ).toEqual({ username: 'ops.admin', role: 'admin', password_hash: 'stored-hash' });
      expect(handle.sqlite.prepare('SELECT id FROM admin_sessions').get()).toEqual({
        id: 'ses-legacy',
      });
      expect(handle.sqlite.prepare('SELECT id FROM auth_events').get()).toEqual({
        id: 'auth-event-legacy',
      });
      expect(handle.sqlite.prepare('SELECT code FROM catalog_products').get()).toEqual({
        code: 'LEGACY-1',
      });
      expect(handle.sqlite.prepare('SELECT id FROM catalog_product_events').get()).toEqual({
        id: 'catalog-event-legacy',
      });
      expect(
        handle.sqlite
          .prepare(
            `SELECT business_source, business_order_no, product_id, fulfillment_mode,
                    status, version, mapping_version_id
               FROM benefit_orders WHERE id = 'order-legacy'`,
          )
          .get(),
      ).toEqual({
        business_source: 'local-life',
        business_order_no: 'LO-LEGACY-1',
        product_id: 'legacy-product',
        fulfillment_mode: 'A',
        status: 'processing',
        version: 2,
        // Historical orders are not assigned a guessed mapping version.
        mapping_version_id: null,
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
            `SELECT product_id, fulfillment_mode, active_version_id
               FROM supplier_product_mappings WHERE id = 'legacy-mapping'`,
          )
          .get(),
      ).toEqual({
        product_id: 'legacy-product',
        fulfillment_mode: 'A',
        active_version_id: 'legacy-version',
      });
      expect(
        handle.sqlite
          .prepare(
            `SELECT mapping_id, product_id, version_number, provider, product_code,
                    fulfillment_mode, deduction_unit, source_draft_version, activated_by, activated_at
               FROM supplier_product_mapping_versions WHERE id = 'legacy-version'`,
          )
          .get(),
      ).toEqual({
        mapping_id: 'legacy-mapping',
        product_id: 'legacy-product',
        version_number: 1,
        provider: 'yangmao',
        product_code: 'YM-LEGACY-1',
        fulfillment_mode: 'A',
        deduction_unit: 'pack',
        source_draft_version: 1,
        activated_by: 'acc-legacy',
        activated_at: 1000,
      });

      // A legacy order replays unchanged and can never be retrofitted with a
      // different product/mode/version through direct SQL.
      const repository = createBenefitOrderRepository(handle.db);
      const legacyReplay = repository.createOrGetIntent({
        businessSource: 'local-life',
        businessOrderNo: 'LO-LEGACY-1',
        productId: 'legacy-product',
      });
      expect(legacyReplay.created).toBe(false);
      expect(legacyReplay.order).toMatchObject({
        id: 'order-legacy',
        fulfillmentMode: 'A',
        mappingVersionId: null,
      });

      expect(() =>
        handle.sqlite
          .prepare("UPDATE benefit_orders SET product_id = 'other-product' WHERE id = 'order-legacy'")
          .run(),
      ).toThrowError(/frozen/);
      expect(() =>
        handle.sqlite
          .prepare("UPDATE benefit_orders SET fulfillment_mode = 'D' WHERE id = 'order-legacy'")
          .run(),
      ).toThrowError(/frozen/);
      expect(() =>
        handle.sqlite
          .prepare("UPDATE benefit_orders SET mapping_version_id = 'legacy-version' WHERE id = 'order-legacy'")
          .run(),
      ).toThrowError(/frozen/);
      expect(() =>
        handle.sqlite
          .prepare(
            `INSERT INTO benefit_orders
               (id, business_source, business_order_no, product_id, fulfillment_mode, status,
                version, created_at, updated_at)
             VALUES ('no-version', 'local-life', 'LO-NO-VERSION', 'legacy-product', 'A',
                     'pending', 1, 2000, 2000)`,
          )
          .run(),
      ).toThrowError(/requires a mapping version/);

      // Normal status progression on the legacy row is still allowed.
      handle.sqlite
        .prepare("UPDATE benefit_orders SET status = 'completed', version = 3, updated_at = 1400 WHERE id = 'order-legacy'")
        .run();

      // A genuinely new order on the same product freezes the existing active
      // snapshot and copies its mode.
      const created = repository.createOrGetIntent({
        businessSource: 'local-life',
        businessOrderNo: 'LO-NEW-1',
        productId: 'legacy-product',
      });
      expect(created.created).toBe(true);
      expect(created.order).toMatchObject({
        fulfillmentMode: 'A',
        mappingVersionId: 'legacy-version',
      });

      // Re-running the migration list is a no-op on every restart.
      expect(runMigrations(handle.sqlite)).toEqual([]);
      expect(
        handle.sqlite.prepare('SELECT id FROM schema_migrations ORDER BY id').all(),
      ).toEqual([
        { id: '0001_admin_auth' },
        { id: '0002_catalog_products' },
        { id: '0003_benefit_orders' },
        { id: '0004_supplier_product_mappings' },
        { id: '0005_benefit_order_mapping_version' },
        { id: '0006_supplier_connections' },
        { id: '0007_business_applications' },
        { id: '0008_business_application_credentials' },
        { id: '0009_benefit_order_grants' },
        { id: '0010_benefit_order_gift_vouchers' },
        { id: '0011_benefit_order_direct_topups' },
      ]);
      expect(migrations.map((migration) => migration.id)).toEqual([
        '0001_admin_auth',
        '0002_catalog_products',
        '0003_benefit_orders',
        '0004_supplier_product_mappings',
        '0005_benefit_order_mapping_version',
        '0006_supplier_connections',
        '0007_business_applications',
        '0008_business_application_credentials',
        '0009_benefit_order_grants',
        '0010_benefit_order_gift_vouchers',
        '0011_benefit_order_direct_topups',
      ]);
    } finally {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
