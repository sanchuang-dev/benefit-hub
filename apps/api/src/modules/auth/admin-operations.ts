import type { AppDatabase } from '../../db/client.js';
import {
  createAccount,
  disableAccount,
  listAccounts,
  normalizeUsername,
  resetAccountPassword,
  type AdminPublicAccount,
  type AdminRole,
} from './accounts.js';
import { recordAuthEvent } from './audit.js';
import { checkPasswordPolicy, hashPassword } from './password.js';

/**
 * Operator-facing account lifecycle. These functions are used by the admin CLI
 * and by tests; they are never exposed over HTTP in this slice. Passwords arrive
 * from stdin at the edge and are only persisted as hashes.
 */
export class PasswordPolicyError extends Error {}

function assertPasswordPolicy(password: string, username: string): void {
  const problem = checkPasswordPolicy(password, username);
  if (problem) throw new PasswordPolicyError(problem);
}

export interface CreateAdminInput {
  username: string;
  password: string;
  role: AdminRole;
  displayName?: string;
}

export async function createAdminAccount(
  db: AppDatabase,
  input: CreateAdminInput,
): Promise<AdminPublicAccount> {
  const username = normalizeUsername(input.username);
  assertPasswordPolicy(input.password, username);

  const account = await createAccount(db, {
    username,
    password: input.password,
    role: input.role,
    displayName: input.displayName,
  });
  recordAuthEvent(db, 'admin_account.created', { accountId: account.id, detail: account.role });
  return account;
}

export async function resetAdminPassword(
  db: AppDatabase,
  username: string,
  password: string,
): Promise<void> {
  const target = normalizeUsername(username);
  assertPasswordPolicy(password, target);

  const passwordHash = await hashPassword(password);
  resetAccountPassword(db, target, passwordHash);
  recordAuthEvent(db, 'admin_account.password_reset', { detail: 'password_rotated' });
}

export function disableAdminAccount(db: AppDatabase, username: string): void {
  disableAccount(db, username);
  recordAuthEvent(db, 'admin_account.disabled', { detail: 'account_disabled' });
}

export function listAdminAccounts(db: AppDatabase): AdminPublicAccount[] {
  return listAccounts(db);
}
