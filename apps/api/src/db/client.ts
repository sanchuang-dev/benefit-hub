import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';
import { migrations, type Migration } from './migrations.js';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  sqlite: Database.Database;
  db: AppDatabase;
  file: string;
  close: () => void;
}

/**
 * Opens the single application database. The file lives on the persistent
 * `/data` volume in production, never inside the image.
 */
export function openDatabase(file: string): DatabaseHandle {
  mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    file,
    close: () => sqlite.close(),
  };
}

/**
 * Applies pending migrations in order and returns the ids that ran. Safe to
 * call on every start: applied migrations are skipped, never re-run or undone.
 */
export function runMigrations(sqlite: Database.Database, list: readonly Migration[] = migrations): string[] {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    sqlite.prepare('SELECT id FROM schema_migrations').all().map((row) => (row as { id: string }).id),
  );
  const recorded = sqlite.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
  const executed: string[] = [];

  for (const migration of list) {
    if (applied.has(migration.id)) continue;
    sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      recorded.run(migration.id, Date.now());
    })();
    executed.push(migration.id);
  }

  return executed;
}
