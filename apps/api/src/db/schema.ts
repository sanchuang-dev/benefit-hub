import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Admin accounts are intentionally minimal for the first slice: password login
 * plus a single `admin` / `viewer` distinction, no external identity provider.
 * `password_hash` must never leave the API module.
 */
export const adminAccounts = sqliteTable('admin_accounts', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: text('role').notNull(),
  passwordHash: text('password_hash').notNull(),
  disabledAt: integer('disabled_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Sessions store only a SHA-256 digest of the cookie token, so a database copy
 * cannot be replayed as a live credential. Expiry is absolute (`expires_at`);
 * restarting the process does not invalidate sessions.
 */
export const adminSessions = sqliteTable('admin_sessions', {
  id: text('id').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => adminAccounts.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  revokedAt: integer('revoked_at'),
});

/**
 * Minimal authentication audit trail. Rows intentionally carry no IP, user
 * agent, password, or token; `detail` holds stable reason codes only.
 */
export const authEvents = sqliteTable('auth_events', {
  id: text('id').primaryKey(),
  event: text('event').notNull(),
  accountId: text('account_id'),
  detail: text('detail'),
  createdAt: integer('created_at').notNull(),
});

/**
 * Internal benefit products. `id` is our own stable identifier and is
 * deliberately unrelated to any supplier product code; this slice has no
 * supplier mapping at all, so a stored product can never be treated as
 * fulfilable. `code` is the unique operator-facing business code (normalized to
 * upper case). `version` is the optimistic concurrency token: every accepted
 * write increments it so a stale edit is rejected instead of overwriting.
 */
export const catalogProducts = sqliteTable('catalog_products', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  shortDescription: text('short_description').notNull(),
  status: text('status').notNull(),
  displayPriceCents: integer('display_price_cents'),
  estimatedCostCents: integer('estimated_cost_cents'),
  version: integer('version').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Minimal operator audit facts for catalogue writes. It records who changed
 * which product and when, and nothing else: no request bodies, prices, or
 * credentials. Authentication events stay in `auth_events`.
 */
export const catalogProductEvents = sqliteTable('catalog_product_events', {
  id: text('id').primaryKey(),
  productId: text('product_id')
    .notNull()
    .references(() => catalogProducts.id, { onDelete: 'restrict' }),
  actorAccountId: text('actor_account_id').notNull(),
  action: text('action').notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * One supplier mapping aggregate per internal product: the current draft plus a
 * pointer to the active immutable version. The unique `product_id` index is the
 * database guarantee that a product can never have two competing mappings.
 *
 * `version` protects draft writes; `validated_version` records which draft
 * version passed *local* validation and is cleared by edits and activation, so
 * a stale validation can never authorise activation. `active_version_id` is
 * declared as plain text here because it references
 * `supplier_product_mapping_versions`, which in turn references this table;
 * migration 0004 adds the foreign key and the ownership trigger that keeps the
 * pointer on this mapping's own history.
 *
 * Draft rows may hold a not-yet-validated mode/deduction pairing so an operator
 * can save and correct an intermediate draft; the immutable version table below
 * enforces the pairing at the database boundary for anything that becomes active.
 */
export const supplierProductMappings = sqliteTable(
  'supplier_product_mappings',
  {
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    productCode: text('product_code').notNull(),
    fulfillmentMode: text('fulfillment_mode').notNull(),
    deductionUnit: text('deduction_unit').notNull(),
    version: integer('version').notNull(),
    validatedVersion: integer('validated_version'),
    validatedAt: integer('validated_at'),
    activeVersionId: text('active_version_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [uniqueIndex('ux_supplier_product_mappings_product').on(table.productId)],
);

/**
 * Immutable snapshot of one accepted mapping activation. Version numbers are
 * monotonic per mapping (`ux_..._number`). Migration 0004 adds triggers that
 * reject UPDATE/DELETE, so accepted history cannot be rewritten through any
 * repository or ad-hoc SQL path. The snapshot itself is the complete mapping
 * content; there are no credential, signature, phone, card-key, or raw supplier
 * response columns.
 */
export const supplierProductMappingVersions = sqliteTable(
  'supplier_product_mapping_versions',
  {
    id: text('id').primaryKey(),
    mappingId: text('mapping_id')
      .notNull()
      .references(() => supplierProductMappings.id, { onDelete: 'restrict' }),
    productId: text('product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'restrict' }),
    versionNumber: integer('version_number').notNull(),
    provider: text('provider').notNull(),
    productCode: text('product_code').notNull(),
    fulfillmentMode: text('fulfillment_mode').notNull(),
    deductionUnit: text('deduction_unit').notNull(),
    sourceDraftVersion: integer('source_draft_version').notNull(),
    activatedBy: text('activated_by').notNull(),
    activatedAt: integer('activated_at').notNull(),
  },
  (table) => [
    uniqueIndex('ux_supplier_product_mapping_versions_number').on(
      table.mappingId,
      table.versionNumber,
    ),
    index('idx_supplier_product_mapping_versions_mapping').on(
      table.mappingId,
      table.versionNumber,
    ),
  ],
);

/**
 * Downstream business application registry (BHB-014-A).
 *
 * This is the operator configuration plane only. Rows never hold a token,
 * secret, supplier credential or runtime authorization decision:
 * `business_source` is the stable normalized identity shared with the existing
 * machine order contract, and the unique index prevents two applications from
 * claiming the same source. `version` guards operator edits. Disabled rows stay
 * readable and re-enableable; there is no delete path.
 */
export const businessApplications = sqliteTable('business_applications', {
  id: text('id').primaryKey(),
  businessSource: text('business_source').notNull().unique(),
  name: text('name').notNull(),
  note: text('note').notNull(),
  status: text('status').notNull(),
  version: integer('version').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Configured internal-product allowlist for one application. The composite
 * primary key makes a duplicate pair unrepresentable, and both foreign keys
 * keep the pair pointed at persisted rows. This is configuration data for a
 * future runtime binding; nothing here grants a machine caller access today.
 */
export const businessApplicationProducts = sqliteTable(
  'business_application_products',
  {
    applicationId: text('application_id')
      .notNull()
      .references(() => businessApplications.id, { onDelete: 'restrict' }),
    productId: text('product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'restrict' }),
    configuredAt: integer('configured_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.applicationId, table.productId] }),
    index('idx_business_application_products_product').on(table.productId),
  ],
);

/**
 * Minimal operator audit facts for application configuration writes: who
 * changed which application and what kind of action occurred. No request
 * bodies, tokens, product codes or secrets are recorded here.
 */
export const businessApplicationEvents = sqliteTable(
  'business_application_events',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => businessApplications.id, { onDelete: 'restrict' }),
    actorAccountId: text('actor_account_id').notNull(),
    action: text('action').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_business_application_events_application').on(
      table.applicationId,
      table.createdAt,
    ),
  ],
);

/**
 * One issued machine Bearer credential for a registered application
 * (BHB-014-B).
 *
 * Only a SHA-256 digest of the token is stored, so a database copy cannot be
 * replayed as a live credential and no read path can return the secret. The
 * application binding is immutable; revocation is terminal (`revoked_at` is
 * never cleared) and takes effect on the next request. `issued_by` /
 * `revoked_by` hold admin account ids, never tokens.
 */
export const businessApplicationCredentials = sqliteTable(
  'business_application_credentials',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => businessApplications.id, { onDelete: 'restrict' }),
    tokenSha256: text('token_sha256').notNull().unique(),
    issuedBy: text('issued_by').notNull(),
    issuedAt: integer('issued_at').notNull(),
    revokedBy: text('revoked_by'),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    index('idx_business_application_credentials_application').on(
      table.applicationId,
      table.issuedAt,
    ),
  ],
);

/**
 * Append-only audit facts for credential issuance and revocation. No token,
 * digest, IP or request body is recorded.
 */
export const businessApplicationCredentialEvents = sqliteTable(
  'business_application_credential_events',
  {
    id: text('id').primaryKey(),
    credentialId: text('credential_id')
      .notNull()
      .references(() => businessApplicationCredentials.id, { onDelete: 'restrict' }),
    applicationId: text('application_id')
      .notNull()
      .references(() => businessApplications.id, { onDelete: 'restrict' }),
    actorAccountId: text('actor_account_id').notNull(),
    action: text('action').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_business_application_credential_events_credential').on(
      table.credentialId,
      table.createdAt,
    ),
  ],
);

/**
 * One row per business grant intent. `id` is our internal order id and is never
 * derived from a supplier order number. The unique
 * `business_source + business_order_no` index is the idempotency guarantee, so a
 * retry, restart, or concurrent caller cannot create a second order for the same
 * upstream business identity. `status` is our provider-agnostic status and
 * `version` is the optimistic concurrency token for status changes.
 *
 * Since migration 0005 a genuinely new order also freezes the supplier mapping
 * snapshot that was active for its product at creation time: `mapping_version_id`
 * references the immutable snapshot, and `fulfillment_mode` is copied from it
 * rather than chosen by the caller. Pre-0005 rows keep `mapping_version_id` NULL
 * because their creation predates the mapping-version mechanism; the value is
 * never guessed. Migration 0005 adds insert/update triggers that enforce the
 * complete binding at the database boundary.
 */
export const benefitOrders = sqliteTable(
  'benefit_orders',
  {
    id: text('id').primaryKey(),
    businessSource: text('business_source').notNull(),
    businessOrderNo: text('business_order_no').notNull(),
    productId: text('product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'restrict' }),
    fulfillmentMode: text('fulfillment_mode').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    mappingVersionId: text('mapping_version_id').references(
      () => supplierProductMappingVersions.id,
      { onDelete: 'restrict' },
    ),
  },
  (table) => [
    uniqueIndex('ux_benefit_orders_business_identity').on(table.businessSource, table.businessOrderNo),
    index('idx_benefit_orders_product_created').on(table.productId, table.createdAt),
    index('idx_benefit_orders_status_created').on(table.status, table.createdAt),
  ],
);

/**
 * Immutable history of accepted order status versions. The initial pending
 * state is version 1; every successful status update appends exactly one row in
 * the same local transaction as the conditional order update.
 */
export const benefitOrderStatusEvents = sqliteTable(
  'benefit_order_status_events',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => benefitOrders.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('ux_benefit_order_status_events_version').on(table.orderId, table.version),
    index('idx_benefit_order_status_events_order_created').on(
      table.orderId,
      table.createdAt,
      table.version,
    ),
  ],
);

/**
 * Facts about one upstream call/verification attempt. The model intentionally
 * has no column for credentials, phone numbers, card keys, or raw supplier
 * responses: `upstreamRequestNo` / `upstreamOrderNo` hold bounded supplier
 * references, while `result` and `observedStatus` hold our own normalized
 * observation. `result = accepted` means the supplier acknowledged the request,
 * never that the user received the benefit.
 */
export const fulfillmentAttempts = sqliteTable(
  'fulfillment_attempts',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => benefitOrders.id, { onDelete: 'restrict' }),
    operation: text('operation').notNull(),
    upstreamRequestNo: text('upstream_request_no'),
    upstreamOrderNo: text('upstream_order_no'),
    result: text('result').notNull(),
    observedStatus: text('observed_status'),
    occurredAt: integer('occurred_at').notNull(),
    lastVerifiedAt: integer('last_verified_at'),
  },
  (table) => [index('idx_fulfillment_attempts_order').on(table.orderId, table.occurredAt)],
);

/**
 * One durable A-mode supplier operation per benefit order (BHB-012-C).
 *
 * The row is inserted *before* the signed `POST /open/v1/prepaid/orders` call,
 * so a crash or timeout can never lose the fact that a debit may have happened.
 * `request_id` is derived deterministically from the frozen platform order and
 * is unique, so a retry can only recover the same vendor order. No phone number
 * or claim URL is stored: `phone_hmac` is a master-key keyed digest used solely
 * to reject a conflicting repeated input, and the claim link is fetched again
 * through the vendor's read-only query when needed.
 */
export const benefitOrderGrants = sqliteTable(
  'benefit_order_grants',
  {
    orderId: text('order_id')
      .primaryKey()
      .references(() => benefitOrders.id, { onDelete: 'restrict' }),
    requestId: text('request_id').notNull(),
    state: text('state').notNull(),
    upstreamOrderNo: text('upstream_order_no'),
    refCode: text('ref_code').notNull(),
    phoneHmac: text('phone_hmac').notNull(),
    paymentReference: text('payment_reference').notNull(),
    attemptedAt: integer('attempted_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('ux_benefit_order_grants_request').on(table.requestId),
    index('idx_benefit_order_grants_state_updated').on(table.state, table.updatedAt),
  ],
);

/**
 * One durable C-mode voucher operation per benefit order (BHB-012-E).
 *
 * The row is inserted *before* the signed `POST /open/v1/gift-vouchers` call,
 * so a crash or timeout can never lose the fact that the supplier may have
 * pre-deducted `packCount` packs. `request_id` is derived deterministically from
 * the platform order and is unique. The issued voucher code, claim link and raw
 * expiry scalar are stored only inside an AES-256-GCM envelope under the
 * existing master key: no column holds them in plaintext, and no phone number is
 * stored (only a keyed digest used to reject conflicting repeated input).
 */
export const benefitOrderGiftVouchers = sqliteTable(
  'benefit_order_gift_vouchers',
  {
    orderId: text('order_id')
      .primaryKey()
      .references(() => benefitOrders.id, { onDelete: 'restrict' }),
    requestId: text('request_id').notNull(),
    state: text('state').notNull(),
    packCount: integer('pack_count').notNull(),
    refCode: text('ref_code').notNull(),
    phoneHmac: text('phone_hmac'),
    encryptedVoucher: text('encrypted_voucher'),
    packTotal: integer('pack_total'),
    packRemaining: integer('pack_remaining'),
    lastObservedAt: integer('last_observed_at'),
    attemptedAt: integer('attempted_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('ux_benefit_order_gift_vouchers_request').on(table.requestId),
    index('idx_benefit_order_gift_vouchers_state_updated').on(table.state, table.updatedAt),
  ],
);


/**
 * B-mode direct-topup reservation and sanitized supplier summary.
 * The phone remains only a keyed HMAC; individual card identifiers and raw
 * supplier messages never enter this table.
 */
export const benefitOrderDirectTopups = sqliteTable(
  'benefit_order_direct_topups',
  {
    orderId: text('order_id').primaryKey().references(() => benefitOrders.id, { onDelete: 'restrict' }),
    requestId: text('request_id').notNull(),
    refCode: text('ref_code').notNull(),
    phoneHmac: text('phone_hmac').notNull(),
    paymentReference: text('payment_reference').notNull(),
    state: text('state').notNull(),
    upstreamOrderNo: text('upstream_order_no'),
    successCount: integer('success_count'),
    totalCount: integer('total_count'),
    itemsSummaryJson: text('items_summary_json'),
    lastVerifiedAt: integer('last_verified_at'),
    attemptedAt: integer('attempted_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('ux_benefit_order_direct_topups_request').on(table.requestId),
    index('idx_benefit_order_direct_topups_state_updated').on(table.state, table.updatedAt),
  ],
);

/** Encrypted server-side provider credentials. No plaintext secrets in DB. */
export const supplierConnections = sqliteTable('supplier_connections', {
  provider: text('provider').primaryKey(),
  baseUrl: text('base_url').notNull(),
  encryptedCredentials: text('encrypted_credentials').notNull(),
  version: integer('version').notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const supplierConnectionEvents = sqliteTable('supplier_connection_events', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  actorAccountId: text('actor_account_id').notNull(),
  action: text('action').notNull(),
  version: integer('version').notNull(),
  createdAt: integer('created_at').notNull(),
});
