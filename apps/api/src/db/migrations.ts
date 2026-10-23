/**
 * Ordered, append-only migrations. Each entry is applied once inside a
 * transaction and recorded in `schema_migrations`.
 *
 * Rules for this list:
 * - never edit an applied migration; add a new one instead;
 * - only additive/forward changes (no automatic downgrade or data deletion);
 * - SQL lives in TypeScript so the compiled image always ships the migration.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    id: '0001_admin_auth',
    sql: `
      CREATE TABLE IF NOT EXISTS admin_accounts (
        id TEXT PRIMARY KEY NOT NULL,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
        password_hash TEXT NOT NULL,
        disabled_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_admin_sessions_account
        ON admin_sessions (account_id);
      CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
        ON admin_sessions (expires_at);

      CREATE TABLE IF NOT EXISTS auth_events (
        id TEXT PRIMARY KEY NOT NULL,
        event TEXT NOT NULL,
        account_id TEXT,
        detail TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_events_created
        ON auth_events (created_at);
    `,
  },
];
