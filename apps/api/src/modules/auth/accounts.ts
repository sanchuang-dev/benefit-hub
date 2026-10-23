import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client.js';
import { adminAccounts, adminSessions } from '../../db/schema.js';
import { hashPassword } from './password.js';

export const ADMIN_ROLES = ['admin', 'viewer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface AdminPublicAccount {
  id: string;
  username: string;
  displayName: string;
  role: AdminRole;
  createdAt: number;
  disabled: boolean;
}

/** Internal shape only. Never serialize `passwordHash` into an HTTP response. */
export interface AdminCredentialRecord extends AdminPublicAccount {
  passwordHash: string;
}

export class AccountConflictError extends Error {}
export class AccountNotFoundError extends Error {}

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

function toRole(value: string): AdminRole {
  if (value === 'admin' || value === 'viewer') return value;
  throw new Error(`Unknown admin role stored in database: ${value}`);
}

interface AccountRow {
  id: string;
  username: string;
  displayName: string;
  role: string;
  passwordHash: string;
  disabledAt: number | null;
  createdAt: number;
}

function mapAccountRow(row: AccountRow): AdminPublicAccount {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: toRole(row.role),
    createdAt: row.createdAt,
    disabled: row.disabledAt !== null,
  };
}

export function findAccountByUsername(db: AppDatabase, username: string): AdminCredentialRecord | null {
  const row = db
    .select()
    .from(adminAccounts)
    .where(eq(adminAccounts.username, normalizeUsername(username)))
    .limit(1)
    .get();
  if (!row) return null;
  return { ...mapAccountRow(row), passwordHash: row.passwordHash };
}

/** Drops the password hash before any record can reach an HTTP response. */
export function publicAccount(record: AdminCredentialRecord): AdminPublicAccount {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    role: record.role,
    createdAt: record.createdAt,
    disabled: record.disabled,
  };
}

export function listAccounts(db: AppDatabase): AdminPublicAccount[] {
  return db
    .select()
    .from(adminAccounts)
    .orderBy(asc(adminAccounts.username))
    .all()
    .map(mapAccountRow);
}

export interface CreateAccountInput {
  username: string;
  password: string;
  role: AdminRole;
  displayName?: string;
}

export async function createAccount(db: AppDatabase, input: CreateAccountInput): Promise<AdminPublicAccount> {
  const username = normalizeUsername(input.username);
  if (!isValidUsername(username)) {
    throw new Error('账号需为 3-64 位小写字母、数字或 . _ -');
  }

  const passwordHash = await hashPassword(input.password);
  const now = Date.now();
  const row = {
    id: randomUUID(),
    username,
    displayName: input.displayName?.trim() || username,
    role: input.role,
    passwordHash,
    disabledAt: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    db.insert(adminAccounts).values(row).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      throw new AccountConflictError(`账号已存在：${username}`);
    }
    throw error;
  }

  return mapAccountRow(row);
}

/**
 * Resets the password and revokes every active session for the account, so a
 * rotated credential cannot keep an old cookie alive.
 */
export function resetAccountPassword(db: AppDatabase, username: string, newPasswordHash: string): void {
  const target = normalizeUsername(username);
  const now = Date.now();
  db.transaction((tx) => {
    const account = tx
      .select({ id: adminAccounts.id })
      .from(adminAccounts)
      .where(eq(adminAccounts.username, target))
      .limit(1)
      .get();
    if (!account) throw new AccountNotFoundError(`账号不存在：${target}`);

    tx.update(adminAccounts)
      .set({ passwordHash: newPasswordHash, updatedAt: now })
      .where(eq(adminAccounts.id, account.id))
      .run();
    tx.update(adminSessions)
      .set({ revokedAt: now })
      .where(and(eq(adminSessions.accountId, account.id), isNull(adminSessions.revokedAt)))
      .run();
  });
}

export function disableAccount(db: AppDatabase, username: string): void {
  const target = normalizeUsername(username);
  const now = Date.now();
  db.transaction((tx) => {
    const row = tx
      .select({ id: adminAccounts.id })
      .from(adminAccounts)
      .where(eq(adminAccounts.username, target))
      .limit(1)
      .get();
    if (!row) throw new AccountNotFoundError(`账号不存在：${target}`);
    tx.update(adminAccounts)
      .set({ disabledAt: now, updatedAt: now })
      .where(eq(adminAccounts.id, row.id))
      .run();
    tx.update(adminSessions)
      .set({ revokedAt: now })
      .where(and(eq(adminSessions.accountId, row.id), isNull(adminSessions.revokedAt)))
      .run();
  });
}
