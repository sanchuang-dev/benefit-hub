import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { migrations } from '../src/db/migrations.js';
import { seedAccount, TestServer } from './helpers/test-server.js';

let server: TestServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('database migrations', () => {
  it('applies each migration exactly once', () => {
    server = new TestServer();
    const firstRun = runMigrations(server.database.sqlite);
    expect(firstRun).toEqual([]);

    const applied = server.database.sqlite
      .prepare('SELECT id FROM schema_migrations ORDER BY id')
      .all() as { id: string }[];
    expect(applied.map((row) => row.id)).toEqual(migrations.map((migration) => migration.id));
  });

  it('preserves existing accounts and sessions across restart and re-migration', async () => {
    server = new TestServer();
    await seedAccount(server, { username: 'ops.admin' });
    const before = server.database.sqlite
      .prepare('SELECT username FROM admin_accounts')
      .all() as { username: string }[];
    expect(before).toHaveLength(1);

    server.restart();
    expect(runMigrations(server.database.sqlite)).toEqual([]);

    const after = server.database.sqlite
      .prepare('SELECT username FROM admin_accounts')
      .all() as { username: string }[];
    expect(after).toEqual(before);
  });

  it('keeps the database in WAL mode on the persistent file', () => {
    server = new TestServer();
    const mode = server.database.sqlite.pragma('journal_mode', { simple: true });
    expect(String(mode).toLowerCase()).toBe('wal');
    expect(server.file.endsWith('benefit.sqlite')).toBe(true);
  });

  it('opens an existing database without losing schema', () => {
    server = new TestServer();
    server.closeDatabase();

    const reopened = openDatabase(server.file);
    const tables = reopened.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    reopened.close();

    const names = tables.map((table) => table.name);
    expect(names).toContain('admin_accounts');
    expect(names).toContain('admin_sessions');
    expect(names).toContain('auth_events');
    expect(names).toContain('catalog_products');
    expect(names).toContain('catalog_product_events');
    expect(names).toContain('benefit_orders');
    expect(names).toContain('benefit_order_status_events');
    expect(names).toContain('fulfillment_attempts');
    expect(names).toContain('supplier_product_mappings');
    expect(names).toContain('supplier_product_mapping_versions');
    expect(names).toContain('business_applications');
    expect(names).toContain('business_application_products');
    expect(names).toContain('business_application_events');
  });

  it('upgrades a pre-0006 database additively and keeps existing rows', () => {
    server = new TestServer();
    // Simulate a database created before the application registry existed by
    // removing only the new objects, then re-running the full migration list.
    server.database.sqlite.exec(`
      DROP TRIGGER IF EXISTS trg_business_applications_source_immutable;
      DROP TABLE IF EXISTS business_application_events;
      DROP TABLE IF EXISTS business_application_products;
      DROP TABLE IF EXISTS business_applications;
      DELETE FROM schema_migrations WHERE id = '0006_business_applications';
      INSERT INTO catalog_products
        (id, code, name, short_description, status, version, created_at, updated_at)
      VALUES ('legacy-product', 'LEGACY-1', '历史商品', '', 'active', 1, 1, 1);
    `);

    expect(runMigrations(server.database.sqlite)).toEqual(['0006_business_applications']);
    expect(runMigrations(server.database.sqlite)).toEqual([]);

    const products = server.database.sqlite
      .prepare('SELECT id FROM catalog_products WHERE id = ?')
      .all('legacy-product');
    expect(products).toHaveLength(1);
    expect(
      server.database.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'business_applications'")
        .get(),
    ).toEqual({ name: 'business_applications' });
  });
});
