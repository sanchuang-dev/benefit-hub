import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { migrations } from '../src/db/migrations.js';
import { createProduct, setProductStatus } from '../src/modules/catalog/products.js';
import { createSupplierMappingRepository } from '../src/modules/catalog/supplier-mapping-repository.js';
import {
  OrderIntentConflictError,
  OrderMappingUnavailableError,
  OrderProductNotActiveError,
} from '../src/modules/orders/benefit-orders.js';
import { createBenefitOrderRepository } from '../src/modules/orders/repository.js';
import { activateMapping } from './helpers/mapping-fixtures.js';
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

function countRows(testServer: TestServer, table: string): number {
  const row = testServer.database.sqlite
    .prepare(`SELECT COUNT(*) AS value FROM ${table}`)
    .get() as { value: number };
  return row.value;
}

function orderInput(productId: string, businessOrderNo = 'LO-2001') {
  return { businessSource: 'local-life', businessOrderNo, productId };
}

interface DirectOrder {
  id: string;
  businessOrderNo: string;
  productId: string;
  mappingVersionId: string | null;
  fulfillmentMode: string;
}

/** Bypasses the repository to prove the migration-level guards stand alone. */
function insertOrderDirectly(testServer: TestServer, values: DirectOrder) {
  return testServer.database.sqlite
    .prepare(
      `INSERT INTO benefit_orders
         (id, business_source, business_order_no, product_id, mapping_version_id,
          fulfillment_mode, status, version, created_at, updated_at)
       VALUES (?, 'direct', ?, ?, ?, ?, 'pending', 1, 0, 0)`,
    )
    .run(
      values.id,
      values.businessOrderNo,
      values.productId,
      values.mappingVersionId,
      values.fulfillmentMode,
    );
}

describe('order creation freezes the active mapping version', () => {
  it('copies the frozen snapshot id and fulfilment mode onto a genuinely new order', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    // Mode D proves the order's mode comes from the snapshot, not from caller
    // input: the caller only supplies the business identity and product.
    const version = activateMapping(server.database.db, product.id, {
      productCode: 'YM-AMOUNT-1',
      fulfillmentMode: 'D',
    });
    const repository = createBenefitOrderRepository(server.database.db);

    const created = repository.createOrGetIntent(orderInput(product.id));
    expect(created.created).toBe(true);
    expect(created.order).toMatchObject({
      productId: product.id,
      mappingVersionId: version.id,
      fulfillmentMode: 'D',
      status: 'pending',
      version: 1,
    });
    expect(countRows(server, 'benefit_order_status_events')).toBe(1);

    // The frozen reference is the persisted fact, not only an in-memory value.
    expect(
      server.database.sqlite
        .prepare(
          'SELECT mapping_version_id, fulfillment_mode FROM benefit_orders WHERE id = ?',
        )
        .get(created.order.id),
    ).toEqual({ mapping_version_id: version.id, fulfillment_mode: 'D' });

    // Closing and reopening the file keeps the same frozen binding.
    server.restart();
    const reopened = createBenefitOrderRepository(server.database.db);
    expect(reopened.getById(created.order.id)).toEqual(created.order);
  });

  it('refuses a new order when the product or its active mapping is not usable', () => {
    server = new TestServer();
    const testServer = server;
    const unmapped = seedProduct(testServer, 'YM-NO-MAPPING');
    const draftOnly = seedProduct(testServer, 'YM-DRAFT-ONLY');
    const disabledMapped = seedProduct(testServer, 'YM-DISABLED');
    const repository = createBenefitOrderRepository(testServer.database.db);

    // A saved draft without an accepted activation is not a frozen
    // configuration, so it cannot satisfy a new order.
    const mappingRepository = createSupplierMappingRepository(testServer.database.db);
    mappingRepository.saveDraft({
      productId: draftOnly.id,
      provider: 'yangmao',
      productCode: 'YM-DRAFT-1',
      fulfillmentMode: 'B',
      deductionUnit: 'pack',
    });
    expect(mappingRepository.getActiveVersion(draftOnly.id)).toBeNull();

    expect(() =>
      repository.createOrGetIntent(orderInput(unmapped.id, 'LO-NO-MAPPING')),
    ).toThrowError(OrderMappingUnavailableError);
    expect(() =>
      repository.createOrGetIntent(orderInput(draftOnly.id, 'LO-DRAFT-ONLY')),
    ).toThrowError(OrderMappingUnavailableError);

    // A product disabled after its mapping activation is refused for a new
    // business identity, and no partial order/status fact is written.
    activateMapping(testServer.database.db, disabledMapped.id);
    const disabled = setProductStatus(testServer.database.db, disabledMapped.id, 'disabled', 1, 'test-actor');
    expect(disabled.status).toBe('disabled');
    expect(() =>
      repository.createOrGetIntent(orderInput(disabledMapped.id, 'LO-DISABLED')),
    ).toThrowError(OrderProductNotActiveError);

    expect(countRows(testServer, 'benefit_orders')).toBe(0);
    expect(countRows(testServer, 'benefit_order_status_events')).toBe(0);
    expect(repository.findByIdentity('local-life', 'LO-DISABLED')).toBeNull();
  });

  it('keeps an existing order on v1 after the mapping rotates, and binds v2 to a newer order', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    const firstVersion = activateMapping(server.database.db, product.id, {
      productCode: 'YM-1001',
      fulfillmentMode: 'B',
    });
    const repository = createBenefitOrderRepository(server.database.db);
    const first = repository.createOrGetIntent(orderInput(product.id, 'LO-V1'));

    const secondVersion = activateMapping(server.database.db, product.id, {
      productCode: 'YM-2002',
      fulfillmentMode: 'A',
    });
    expect(secondVersion.id).not.toBe(firstVersion.id);

    const second = repository.createOrGetIntent(orderInput(product.id, 'LO-V2'));
    expect(second.order.mappingVersionId).toBe(secondVersion.id);
    expect(second.order.fulfillmentMode).toBe('A');

    // The earlier order is untouched: the activation cannot rewrite history.
    expect(repository.getById(first.order.id)).toEqual(first.order);
    expect(repository.findByIdentity('local-life', 'LO-V1')).toEqual(first.order);
    expect(
      server.database.sqlite
        .prepare('SELECT mapping_version_id, fulfillment_mode FROM benefit_orders WHERE id = ?')
        .get(first.order.id),
    ).toEqual({ mapping_version_id: firstVersion.id, fulfillment_mode: 'B' });

    // BHB-006 status/attempt facts keep working on a frozen order and never
    // change the frozen mapping version.
    const processing = repository.updateStatus({
      orderId: first.order.id,
      expectedVersion: first.order.version,
      status: 'processing',
    });
    expect(processing.mappingVersionId).toBe(firstVersion.id);
    repository.appendAttempt({
      orderId: first.order.id,
      operation: 'query',
      result: 'unknown',
      occurredAt: 1_000,
    });
    expect(repository.listAttempts(first.order.id)).toHaveLength(1);

    // BHB-007 lifecycle continues to work after orders reference its history.
    expect(
      server.database.sqlite
        .prepare('SELECT active_version_id FROM supplier_product_mappings WHERE product_id = ?')
        .get(product.id),
    ).toEqual({ active_version_id: secondVersion.id });
  });

  it('replays the original order and mapping version after rotation and disable', () => {
    server = new TestServer();
    const product = seedProduct(server, 'YM-TRAVEL-10');
    const firstVersion = activateMapping(server.database.db, product.id);
    const repository = createBenefitOrderRepository(server.database.db);
    const first = repository.createOrGetIntent(orderInput(product.id, 'LO-REPLAY'));

    activateMapping(server.database.db, product.id, {
      productCode: 'YM-2002',
      fulfillmentMode: 'A',
    });
    setProductStatus(server.database.db, product.id, 'disabled', 1, 'test-actor');

    // Replay wins over every current-state eligibility check.
    const replayed = repository.createOrGetIntent(orderInput(product.id, 'LO-REPLAY'));
    expect(replayed.created).toBe(false);
    expect(replayed.order).toEqual(first.order);
    expect(replayed.order.mappingVersionId).toBe(firstVersion.id);
    expect(countRows(server, 'benefit_orders')).toBe(1);
    expect(countRows(server, 'benefit_order_status_events')).toBe(1);

    // The same business identity with a different product still conflicts
    // instead of creating or overwriting anything.
    const otherProduct = seedProduct(server, 'YM-FOOD-20');
    activateMapping(server.database.db, otherProduct.id);
    expect(() =>
      repository.createOrGetIntent(orderInput(otherProduct.id, 'LO-REPLAY')),
    ).toThrowError(OrderIntentConflictError);
    expect(repository.getById(first.order.id)).toEqual(first.order);
    expect(countRows(server, 'benefit_orders')).toBe(1);
  });
});

describe('order mapping-version database guards', () => {
  it('rejects inserts without a snapshot, with another product, a wrong mode or a stale version', () => {
    server = new TestServer();
    const testServer = server;
    const product = seedProduct(testServer, 'YM-TRAVEL-10');
    const otherProduct = seedProduct(testServer, 'YM-FOOD-20');
    const version = activateMapping(testServer.database.db, product.id, { fulfillmentMode: 'B' });
    const otherVersion = activateMapping(testServer.database.db, otherProduct.id, {
      fulfillmentMode: 'A',
    });
    const repository = createBenefitOrderRepository(testServer.database.db);
    const created = repository.createOrGetIntent(orderInput(product.id, 'LO-GUARD-1'));

    const invalidInsert = (label: string, values: DirectOrder, expected: RegExp) => {
      expect(() => insertOrderDirectly(testServer, values), label).toThrowError(expected);
    };

    invalidInsert(
      'missing version',
      {
        id: 'direct-null',
        businessOrderNo: 'LO-NULL',
        productId: product.id,
        mappingVersionId: null,
        fulfillmentMode: 'B',
      },
      /new benefit order requires a mapping version/,
    );
    invalidInsert(
      'other product snapshot',
      {
        id: 'direct-other-product',
        businessOrderNo: 'LO-OTHER-PRODUCT',
        productId: product.id,
        mappingVersionId: otherVersion.id,
        fulfillmentMode: 'B',
      },
      /order mapping version must belong to the same product/,
    );
    invalidInsert(
      'mode mismatch',
      {
        id: 'direct-wrong-mode',
        businessOrderNo: 'LO-WRONG-MODE',
        productId: product.id,
        mappingVersionId: version.id,
        fulfillmentMode: 'C',
      },
      /order fulfillment mode must match its mapping version/,
    );

    // After rotation, a racer holding the stale v1 read cannot commit a mixed
    // or superseded binding: the database requires the current pointer.
    const rotated = activateMapping(testServer.database.db, product.id, {
      productCode: 'YM-2002',
      fulfillmentMode: 'A',
    });
    expect(rotated.versionNumber).toBe(2);
    invalidInsert(
      'stale version',
      {
        id: 'direct-stale',
        businessOrderNo: 'LO-STALE',
        productId: product.id,
        mappingVersionId: version.id,
        fulfillmentMode: 'B',
      },
      /order mapping version must be the current active version/,
    );

    // The frozen binding cannot be rebound later, not even by direct SQL.
    expect(() =>
      testServer.database.sqlite
        .prepare('UPDATE benefit_orders SET mapping_version_id = ? WHERE id = ?')
        .run(rotated.id, created.order.id),
    ).toThrowError(/benefit order mapping version is frozen at creation/);
    expect(countRows(testServer, 'benefit_orders')).toBe(1);
    expect(repository.getById(created.order.id)?.mappingVersionId).toBe(version.id);
  });
});

describe('order mapping-version migration upgrade', () => {
  it('upgrades 0004 data to 0005 without backfilling or losing legacy rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'benefit-hub-order-freeze-'));
    const file = join(directory, 'benefit.sqlite');
    const handle = openDatabase(file);

    try {
      expect(runMigrations(handle.sqlite, migrations.slice(0, 4))).toEqual([
        '0001_admin_auth',
        '0002_catalog_products',
        '0003_benefit_orders',
        '0004_supplier_product_mappings',
      ]);

      // Representative state a deployed /data volume already contains: auth,
      // catalogue, a BHB-006 order with history/attempt, and BHB-007 mapping
      // history with an active pointer.
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
              version, validated_version, validated_at, active_version_id, created_at, updated_at)
           VALUES ('mapping-legacy', 'legacy-product', 'yangmao', 'YM-LEGACY', 'B', 'pack',
                   2, 2, 1000, NULL, 1000, 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO supplier_product_mapping_versions
             (id, mapping_id, product_id, version_number, provider, product_code,
              fulfillment_mode, deduction_unit, source_draft_version, activated_by, activated_at)
           VALUES ('mapping-version-legacy', 'mapping-legacy', 'legacy-product', 1, 'yangmao',
                   'YM-LEGACY', 'B', 'pack', 2, 'acc-legacy', 1000)`,
        )
        .run();
      handle.sqlite
        .prepare(
          `UPDATE supplier_product_mappings SET active_version_id = 'mapping-version-legacy'
             WHERE id = 'mapping-legacy'`,
        )
        .run();

      expect(runMigrations(handle.sqlite)).toEqual(['0005_benefit_order_mapping_version']);

      // The frozen reference is a real foreign key to immutable snapshots.
      expect(
        (
          handle.sqlite.prepare('PRAGMA foreign_key_list(benefit_orders)').all() as {
            from: string;
            table: string;
            on_delete: string;
          }[]
        ).map(({ from, table, on_delete }) => ({ from, table, on_delete })),
      ).toContainEqual({
        from: 'mapping_version_id',
        table: 'supplier_product_mapping_versions',
        on_delete: 'RESTRICT',
      });

      // Existing auth, catalogue, order, attempt and mapping facts survive.
      expect(handle.sqlite.prepare('SELECT id FROM admin_sessions').get()).toEqual({
        id: 'ses-legacy',
      });
      expect(handle.sqlite.prepare('SELECT id FROM auth_events').get()).toEqual({
        id: 'auth-event-legacy',
      });
      expect(handle.sqlite.prepare('SELECT status FROM catalog_products').get()).toEqual({
        status: 'active',
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
        // No guessed historical mapping version is invented.
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
          .prepare('SELECT result, observed_status FROM fulfillment_attempts WHERE id = ?')
          .get('attempt-legacy'),
      ).toEqual({ result: 'accepted', observed_status: 'processing' });
      expect(
        handle.sqlite
          .prepare('SELECT active_version_id FROM supplier_product_mappings WHERE id = ?')
          .get('mapping-legacy'),
      ).toEqual({ active_version_id: 'mapping-version-legacy' });
      expect(
        handle.sqlite.prepare('SELECT COUNT(*) AS value FROM supplier_product_mapping_versions').get(),
      ).toEqual({ value: 1 });

      const repository = createBenefitOrderRepository(handle.db);

      // Replaying a pre-0005 order keeps its null mapping version: history is
      // protected, not upgraded to a guessed version.
      const replayed = repository.createOrGetIntent({
        businessSource: 'local-life',
        businessOrderNo: 'LO-LEGACY-1',
        productId: 'legacy-product',
      });
      expect(replayed.created).toBe(false);
      expect(replayed.order.mappingVersionId).toBeNull();
      expect(replayed.order.status).toBe('processing');

      // A genuinely new order on the upgraded schema freezes the mapping
      // version that was already active before the upgrade.
      const created = repository.createOrGetIntent({
        businessSource: 'local-life',
        businessOrderNo: 'LO-NEW-AFTER-UPGRADE',
        productId: 'legacy-product',
      });
      expect(created.created).toBe(true);
      expect(created.order.mappingVersionId).toBe('mapping-version-legacy');
      expect(created.order.fulfillmentMode).toBe('B');

      expect(handle.sqlite.prepare('SELECT COUNT(*) AS value FROM benefit_orders').get()).toEqual({
        value: 2,
      });
      expect(
        handle.sqlite.prepare('SELECT COUNT(*) AS value FROM benefit_order_status_events').get(),
      ).toEqual({ value: 3 });

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
      ]);
    } finally {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
