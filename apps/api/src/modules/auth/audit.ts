import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../db/client.js';
import { authEvents } from '../../db/schema.js';

export type AuthEventName =
  | 'login.succeeded'
  | 'login.failed'
  | 'login.rate_limited'
  | 'logout'
  | 'session.rejected'
  | 'admin_account.created'
  | 'admin_account.password_reset'
  | 'admin_account.disabled'
  | 'admin_accounts.listed';

export interface AuthEventInput {
  accountId?: string | null;
  /** Stable reason/operation code only. Never a password, token, or raw input. */
  detail?: string;
}

export function recordAuthEvent(db: AppDatabase, event: AuthEventName, input: AuthEventInput = {}): void {
  db.insert(authEvents)
    .values({
      id: randomUUID(),
      event,
      accountId: input.accountId ?? null,
      detail: input.detail ?? null,
      createdAt: Date.now(),
    })
    .run();
}
