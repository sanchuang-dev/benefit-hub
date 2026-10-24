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
  {
    id: '0002_catalog_products',
    sql: `
      CREATE TABLE IF NOT EXISTS catalog_products (
        id TEXT PRIMARY KEY NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        short_description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        display_price_cents INTEGER,
        estimated_cost_cents INTEGER,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (display_price_cents IS NULL OR display_price_cents >= 0),
        CHECK (estimated_cost_cents IS NULL OR estimated_cost_cents >= 0)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_catalog_products_code
        ON catalog_products (code);
      CREATE INDEX IF NOT EXISTS idx_catalog_products_status_created
        ON catalog_products (status, created_at DESC);

      CREATE TABLE IF NOT EXISTS catalog_product_events (
        id TEXT PRIMARY KEY NOT NULL,
        product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE RESTRICT,
        actor_account_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'enabled', 'disabled')),
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_product_events_product
        ON catalog_product_events (product_id, created_at);
    `,
  },
  {
    id: '0003_benefit_orders',
    sql: `
      CREATE TABLE IF NOT EXISTS benefit_orders (
        id TEXT PRIMARY KEY NOT NULL,
        business_source TEXT NOT NULL,
        business_order_no TEXT NOT NULL,
        product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE RESTRICT,
        fulfillment_mode TEXT NOT NULL CHECK (fulfillment_mode IN ('A', 'B', 'C', 'D')),
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'processing', 'awaiting_claim', 'partially_completed', 'completed', 'failed', 'unknown')
        ),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (length(business_source) BETWEEN 1 AND 64),
        CHECK (length(business_order_no) BETWEEN 1 AND 128)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_benefit_orders_business_identity
        ON benefit_orders (business_source, business_order_no);
      CREATE INDEX IF NOT EXISTS idx_benefit_orders_product_created
        ON benefit_orders (product_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_benefit_orders_status_created
        ON benefit_orders (status, created_at DESC);

      CREATE TABLE IF NOT EXISTS fulfillment_attempts (
        id TEXT PRIMARY KEY NOT NULL,
        order_id TEXT NOT NULL REFERENCES benefit_orders(id) ON DELETE RESTRICT,
        operation TEXT NOT NULL CHECK (operation IN ('grant', 'query', 'reissue')),
        upstream_request_no TEXT,
        upstream_order_no TEXT,
        result TEXT NOT NULL CHECK (result IN ('accepted', 'rejected', 'unknown')),
        observed_status TEXT CHECK (
          observed_status IS NULL
          OR observed_status IN ('pending', 'processing', 'awaiting_claim', 'partially_completed', 'completed', 'failed', 'unknown')
        ),
        occurred_at INTEGER NOT NULL,
        last_verified_at INTEGER,
        CHECK (upstream_request_no IS NULL OR length(upstream_request_no) BETWEEN 1 AND 128),
        CHECK (upstream_order_no IS NULL OR length(upstream_order_no) BETWEEN 1 AND 128)
      );

      CREATE INDEX IF NOT EXISTS idx_fulfillment_attempts_order
        ON fulfillment_attempts (order_id, occurred_at);
    `,
  },
];
