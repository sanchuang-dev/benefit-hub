import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
