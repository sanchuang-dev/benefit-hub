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
  });
});
