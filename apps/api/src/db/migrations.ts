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

      CREATE TABLE IF NOT EXISTS benefit_order_status_events (
        id TEXT PRIMARY KEY NOT NULL,
        order_id TEXT NOT NULL REFERENCES benefit_orders(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'processing', 'awaiting_claim', 'partially_completed', 'completed', 'failed', 'unknown')
        ),
        version INTEGER NOT NULL CHECK (version >= 1),
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_benefit_order_status_events_version
        ON benefit_order_status_events (order_id, version);
      CREATE INDEX IF NOT EXISTS idx_benefit_order_status_events_order_created
        ON benefit_order_status_events (order_id, created_at, version);

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
  {
    id: '0004_supplier_product_mappings',
    sql: `
      -- One mapping aggregate per internal product. The draft lives on this row
      -- so a product can never have two "current" drafts at the same time.
      -- Draft semantic acceptance (A/B/C vs D deduction pairing) is a local
      -- validation rule; accepted versions below are additionally constrained
      -- so a mismatched pairing can never become an active snapshot.
      CREATE TABLE IF NOT EXISTS supplier_product_mappings (
        id TEXT PRIMARY KEY NOT NULL,
        product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL CHECK (provider IN ('yangmao')),
        product_code TEXT NOT NULL CHECK (length(product_code) BETWEEN 1 AND 64),
        fulfillment_mode TEXT NOT NULL CHECK (fulfillment_mode IN ('A', 'B', 'C', 'D')),
        deduction_unit TEXT NOT NULL CHECK (deduction_unit IN ('pack', 'amount')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        validated_version INTEGER CHECK (
          validated_version IS NULL OR (validated_version >= 1 AND validated_version <= version)
        ),
        validated_at INTEGER,
        active_version_id TEXT REFERENCES supplier_product_mapping_versions(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (validated_version IS NULL AND validated_at IS NULL)
          OR (validated_version IS NOT NULL AND validated_at IS NOT NULL)
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_supplier_product_mappings_product
        ON supplier_product_mappings (product_id);

      -- Immutable activation snapshots. Version numbers are monotonic per
      -- mapping; the complete mapping content is copied so later draft edits
      -- can never rewrite history.
      CREATE TABLE IF NOT EXISTS supplier_product_mapping_versions (
        id TEXT PRIMARY KEY NOT NULL,
        mapping_id TEXT NOT NULL REFERENCES supplier_product_mappings(id) ON DELETE RESTRICT,
        product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE RESTRICT,
        version_number INTEGER NOT NULL CHECK (version_number >= 1),
        provider TEXT NOT NULL CHECK (provider IN ('yangmao')),
        product_code TEXT NOT NULL CHECK (length(product_code) BETWEEN 1 AND 64),
        fulfillment_mode TEXT NOT NULL CHECK (fulfillment_mode IN ('A', 'B', 'C', 'D')),
        deduction_unit TEXT NOT NULL CHECK (deduction_unit IN ('pack', 'amount')),
        source_draft_version INTEGER NOT NULL CHECK (source_draft_version >= 1),
        activated_by TEXT NOT NULL CHECK (length(activated_by) BETWEEN 1 AND 64),
        activated_at INTEGER NOT NULL,
        CHECK (
          (fulfillment_mode = 'D' AND deduction_unit = 'amount')
          OR (fulfillment_mode IN ('A', 'B', 'C') AND deduction_unit = 'pack')
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_supplier_product_mapping_versions_number
        ON supplier_product_mapping_versions (mapping_id, version_number);
      CREATE INDEX IF NOT EXISTS idx_supplier_product_mapping_versions_mapping
        ON supplier_product_mapping_versions (mapping_id, version_number);

      -- A snapshot redundantly carries product_id for direct historical reads.
      -- Keep that denormalized value tied to its mapping root at the DB
      -- boundary so future order-version references cannot observe a
      -- cross-product snapshot created by ad-hoc SQL or later code.
      CREATE TRIGGER IF NOT EXISTS trg_supplier_mapping_version_product_owner
      BEFORE INSERT ON supplier_product_mapping_versions
      BEGIN
        SELECT RAISE(ABORT, 'mapping snapshot product must match mapping product')
        WHERE NOT EXISTS (
          SELECT 1 FROM supplier_product_mappings
          WHERE id = NEW.mapping_id AND product_id = NEW.product_id
        );
      END;

      -- Accepted history is append-only at the database boundary, not only in
      -- repository code.
      CREATE TRIGGER IF NOT EXISTS trg_supplier_mapping_versions_no_update
      BEFORE UPDATE ON supplier_product_mapping_versions
      BEGIN
        SELECT RAISE(ABORT, 'supplier_product_mapping_versions rows are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_supplier_mapping_versions_no_delete
      BEFORE DELETE ON supplier_product_mapping_versions
      BEGIN
        SELECT RAISE(ABORT, 'supplier_product_mapping_versions rows are immutable');
      END;

      -- The active pointer must reference a version of the same mapping, so a
      -- bug or manual statement cannot point one product at another's history.
      CREATE TRIGGER IF NOT EXISTS trg_supplier_mapping_active_pointer_insert
      BEFORE INSERT ON supplier_product_mappings
      WHEN NEW.active_version_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'active version must belong to the same mapping')
        WHERE NOT EXISTS (
          SELECT 1 FROM supplier_product_mapping_versions
          WHERE id = NEW.active_version_id AND mapping_id = NEW.id
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_supplier_mapping_active_pointer_update
      BEFORE UPDATE OF active_version_id ON supplier_product_mappings
      WHEN NEW.active_version_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'active version must belong to the same mapping')
        WHERE NOT EXISTS (
          SELECT 1 FROM supplier_product_mapping_versions
          WHERE id = NEW.active_version_id AND mapping_id = NEW.id
        );
      END;
    `,
  },
  {
    id: '0005_benefit_order_mapping_version',
    sql: `
      -- Orders created from this slice onward freeze the supplier mapping
      -- snapshot that was active for their product at creation time. The column
      -- stays nullable only so pre-0005 orders remain readable: their value is
      -- deliberately never guessed or backfilled.
      ALTER TABLE benefit_orders
        ADD COLUMN mapping_version_id TEXT
          REFERENCES supplier_product_mapping_versions(id) ON DELETE RESTRICT;

      -- A genuinely new order must carry a complete frozen binding. The
      -- snapshot has to belong to the same internal product, carry the same
      -- fulfillment mode, and still be that product's current active version
      -- when the row is inserted. Legacy rows keep NULL and are exempt because
      -- this guard is INSERT-only.
      CREATE TRIGGER IF NOT EXISTS trg_benefit_orders_require_mapping_version
      BEFORE INSERT ON benefit_orders
      BEGIN
        SELECT RAISE(ABORT, 'new benefit order requires a mapping version')
        WHERE NEW.mapping_version_id IS NULL;

        SELECT RAISE(ABORT, 'mapping version must match order product and mode')
        WHERE NOT EXISTS (
          SELECT 1 FROM supplier_product_mapping_versions
          WHERE id = NEW.mapping_version_id
            AND product_id = NEW.product_id
            AND fulfillment_mode = NEW.fulfillment_mode
        );

        SELECT RAISE(ABORT, 'mapping version must be the current active version')
        WHERE NOT EXISTS (
          SELECT 1 FROM supplier_product_mappings
          WHERE product_id = NEW.product_id
            AND active_version_id = NEW.mapping_version_id
        );
      END;

      -- The frozen binding is immutable after creation, including for legacy
      -- rows: status, version and updated_at stay updateable, but no direct SQL
      -- or later code path may rebind an order to another product, mode or
      -- mapping snapshot. That keeps the order row and its snapshot consistent.
      CREATE TRIGGER IF NOT EXISTS trg_benefit_orders_frozen_binding_update
      BEFORE UPDATE OF product_id, fulfillment_mode, mapping_version_id ON benefit_orders
      BEGIN
        SELECT RAISE(ABORT, 'benefit order product, mode and mapping version are frozen');
      END;
    `,
  },

  {
    id: '0006_supplier_connections',
    sql: `
      CREATE TABLE IF NOT EXISTS supplier_connections (
        provider TEXT PRIMARY KEY NOT NULL CHECK (provider IN ('yangmao')),
        base_url TEXT NOT NULL,
        encrypted_credentials TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS supplier_connection_events (
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('yangmao')),
        actor_account_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('saved')),
        version INTEGER NOT NULL CHECK (version >= 1),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_supplier_connection_events_provider_time
        ON supplier_connection_events (provider, created_at);
    `,
  },
  {
    id: '0007_business_applications',
    sql: `
      -- Downstream application registry: operator configuration only. No token,
      -- secret or runtime authorization column exists here, and the unique
      -- source index makes the normalized business identity stable.
      CREATE TABLE IF NOT EXISTS business_applications (
        id TEXT PRIMARY KEY NOT NULL,
        business_source TEXT NOT NULL,
        name TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (length(business_source) BETWEEN 1 AND 64),
        CHECK (business_source GLOB '[a-z0-9]*'),
        CHECK (business_source NOT GLOB '*[^a-z0-9._-]*'),
        CHECK (length(name) BETWEEN 1 AND 80),
        CHECK (length(note) <= 200)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_business_applications_source
        ON business_applications (business_source);
      CREATE INDEX IF NOT EXISTS idx_business_applications_status_created
        ON business_applications (status, created_at DESC);

      -- One row per configured (application, internal product) pair. The
      -- composite primary key makes duplicates unrepresentable; both foreign
      -- keys keep the configuration pointed at persisted rows, so an arbitrary
      -- supplier product code can never be stored as an internal product id.
      CREATE TABLE IF NOT EXISTS business_application_products (
        application_id TEXT NOT NULL REFERENCES business_applications(id) ON DELETE RESTRICT,
        product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE RESTRICT,
        configured_at INTEGER NOT NULL,
        PRIMARY KEY (application_id, product_id)
      );

      CREATE INDEX IF NOT EXISTS idx_business_application_products_product
        ON business_application_products (product_id);

      -- Bounded operator audit facts; no request body, token or secret values.
      CREATE TABLE IF NOT EXISTS business_application_events (
        id TEXT PRIMARY KEY NOT NULL,
        application_id TEXT NOT NULL REFERENCES business_applications(id) ON DELETE RESTRICT,
        actor_account_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (
          action IN ('created', 'updated', 'enabled', 'disabled', 'products_updated')
        ),
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_business_application_events_application
        ON business_application_events (application_id, created_at);

      -- The registered source is the stable application identity. Operators may
      -- rename the display name and edit the note, but rebinding an existing row
      -- to another business source would silently change its meaning.
      CREATE TRIGGER IF NOT EXISTS trg_business_applications_source_immutable
      BEFORE UPDATE OF business_source ON business_applications
      BEGIN
        SELECT RAISE(ABORT, 'business application source is immutable');
      END;
    `,
  },
  {
    id: '0008_business_application_credentials',
    sql: `
      -- Machine credentials for a registered downstream application. Only the
      -- SHA-256 digest of the Bearer token is persisted, so no database or read
      -- path can reproduce the secret. Revocation is terminal and leaves the row
      -- (and its audit facts) intact.
      CREATE TABLE IF NOT EXISTS business_application_credentials (
        id TEXT PRIMARY KEY NOT NULL,
        application_id TEXT NOT NULL REFERENCES business_applications(id) ON DELETE RESTRICT,
        token_sha256 TEXT NOT NULL,
        issued_by TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        revoked_by TEXT,
        revoked_at INTEGER,
        CHECK (length(token_sha256) = 64),
        CHECK (token_sha256 NOT GLOB '*[^0-9a-f]*'),
        CHECK (
          (revoked_at IS NULL AND revoked_by IS NULL)
          OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
        ),
        CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_business_application_credentials_digest
        ON business_application_credentials (token_sha256);
      CREATE INDEX IF NOT EXISTS idx_business_application_credentials_application
        ON business_application_credentials (application_id, issued_at DESC);

      -- Append-only issuance/revocation audit; no token, digest or request body.
      CREATE TABLE IF NOT EXISTS business_application_credential_events (
        id TEXT PRIMARY KEY NOT NULL,
        credential_id TEXT NOT NULL REFERENCES business_application_credentials(id) ON DELETE RESTRICT,
        application_id TEXT NOT NULL REFERENCES business_applications(id) ON DELETE RESTRICT,
        actor_account_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('issued', 'revoked')),
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_business_application_credential_events_credential
        ON business_application_credential_events (credential_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_business_application_credential_events_application
        ON business_application_credential_events (application_id, created_at);

      -- A credential may never be rebound to another application, re-digested or
      -- back-dated; revocation is the only permitted update.
      CREATE TRIGGER IF NOT EXISTS trg_business_application_credentials_binding_immutable
      BEFORE UPDATE OF application_id, token_sha256, issued_by, issued_at
      ON business_application_credentials
      BEGIN
        SELECT RAISE(ABORT, 'application credential binding is immutable');
      END;

      -- Revocation is terminal: an already revoked credential stays revoked.
      CREATE TRIGGER IF NOT EXISTS trg_business_application_credentials_revoked_immutable
      BEFORE UPDATE ON business_application_credentials
      WHEN OLD.revoked_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'revoked application credential is immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_business_application_credentials_no_delete
      BEFORE DELETE ON business_application_credentials
      BEGIN
        SELECT RAISE(ABORT, 'application credentials are never deleted');
      END;
    `,
  },
];
