import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { migrations } from '../src/db/migrations.js';
import { createProduct } from '../src/modules/catalog/products.js';
import {
  OrderInputError,
  OrderIntentConflictError,
  OrderNotFoundError,
  OrderProductNotFoundError,
  OrderVersionConflictError,
  type OrderStatus,
} from '../src/modules/orders/benefit-orders.js';
import {
  createBenefitOrderRepository,
  type BenefitOrderRepository,
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

function countOrders(testServer: TestServer): number {
  const row = testServer.database.sqlite
    .prepare('SELECT COUNT(*) AS value FROM benefit_orders')
    .get() as { value: number };
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
    fulfillmentMode: 'B' as const,
  };
}

describe('benefit order persistence', () => {
  it('persists an order intent and keeps it readable after the database is reopened', () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
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
    });
    expect(created.order.id).not.toBe(created.order.businessOrderNo);
    expect(created.order.createdAt).toBe(created.order.updatedAt);
    expect(
      repository.listStatusEvents(created.order.id).map(({ status, version }) => ({ status, version })),
    ).toEqual([{ status: 'pending', version: 1 }]);

    // The row really lives in the SQLite file, not only in this process.
    const stored = server.database.sqlite
      .prepare(
        `SELECT business_source, business_order_no, product_id, fulfillment_mode, status, version
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

  it('rejects conflicting key parameters for the same business identity', () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
    const otherProduct = seedProduct(server, 'COFFEE-1');
    const repository = createBenefitOrderRepository(server.database.db);

    const first = repository.createOrGetIntent(orderInput(product.id));

    expect(() =>
      repository.createOrGetIntent({ ...orderInput(product.id), productId: otherProduct.id }),
    ).toThrowError(OrderIntentConflictError);
    expect(() =>
      repository.createOrGetIntent({ ...orderInput(product.id), fulfillmentMode: 'D' }),
    ).toThrowError(OrderIntentConflictError);

    // The first order fact is untouched: no silent overwrite of product or mode.
    expect(repository.getById(first.order.id)).toEqual(first.order);
    expect(countOrders(server)).toBe(1);
  });

  it('keeps business order numbers case-sensitive while normalizing the source key', () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
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
    const repository = createBenefitOrderRepository(server.database.db);

    repository.createOrGetIntent(orderInput(product.id));

    expect(() =>
      server?.database.sqlite
        .prepare(
          `INSERT INTO benefit_orders
             (id, business_source, business_order_no, product_id, fulfillment_mode, status, version, created_at, updated_at)
           VALUES ('direct-insert', 'local-life', 'LO-1001', ?, 'A', 'pending', 1, 0, 0)`,
        )
        .run(product.id),
    ).toThrowError(/UNIQUE constraint failed: benefit_orders.business_source, benefit_orders.business_order_no/);
    expect(countOrders(server)).toBe(1);
  });

  it('creates exactly one order when two connections race for the same business intent', async () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
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
      expect(countOrders(server)).toBe(1);
      expect(second.sqlite.prepare('SELECT COUNT(*) AS value FROM benefit_orders').get()).toEqual({
        value: 1,
      });
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

  it('rejects invalid business identity input instead of storing an unusable key', () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
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

describe('benefit order status concurrency', () => {
  it('updates status atomically and rejects a stale version without losing the newest state', () => {
    server = new TestServer();
    const product = seedProduct(server, 'TX-TRAVEL-10');
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
    const product = seedProduct(server, 'TX-TRAVEL-10');
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
    const product = seedProduct(server, 'TX-TRAVEL-10');
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
    const product = seedProduct(server, 'TX-TRAVEL-10');
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
    const product = seedProduct(server, 'TX-TRAVEL-10');
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
      const repository = createBenefitOrderRepository(handle.db);
      const { order } = repository.createOrGetIntent({
        businessSource: 'card-doctor',
        businessOrderNo: 'LEGACY-ORDER-1',
        productId: 'legacy-product',
        fulfillmentMode: 'A',
      });
      expect(order.productId).toBe('legacy-product');

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
      ]);
      expect(migrations.map((migration) => migration.id)).toEqual([
        '0001_admin_auth',
        '0002_catalog_products',
        '0003_benefit_orders',
        '0004_supplier_product_mappings',
      ]);
    } finally {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
