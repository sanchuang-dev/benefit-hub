import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
 * One row per business grant intent. `id` is our internal order id and is never
 * derived from a supplier order number. The unique
 * `business_source + business_order_no` index is the idempotency guarantee, so a
 * retry, restart, or concurrent caller cannot create a second order for the same
 * upstream business identity. `status` is our provider-agnostic status and
 * `version` is the optimistic concurrency token for status changes.
 *
 * Only the product reference is stored here: there is no supplier mapping or
 * mapping-version entity yet, so no placeholder foreign key is invented.
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
  },
  (table) => [
    uniqueIndex('ux_benefit_orders_business_identity').on(table.businessSource, table.businessOrderNo),
    index('idx_benefit_orders_product_created').on(table.productId, table.createdAt),
    index('idx_benefit_orders_status_created').on(table.status, table.createdAt),
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
