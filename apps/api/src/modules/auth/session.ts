import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client.js';
import { adminAccounts, adminSessions } from '../../db/schema.js';
import { toPrincipal, type SessionPrincipal } from './principal.js';

export const SESSION_COOKIE_NAME = 'bh_session';

export interface IssuedSession {
  token: string;
  expiresAt: number;
}

export interface ValidSession {
  sessionId: string;
  expiresAt: number;
  principal: SessionPrincipal;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues an opaque random bearer token. Only its SHA-256 digest is persisted, so
 * leaking the database alone does not yield a usable session cookie.
 */
export function createSession(
  db: AppDatabase,
  accountId: string,
  ttlMs: number,
  now = Date.now(),
): IssuedSession {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + ttlMs;
  db.insert(adminSessions)
    .values({
      id: randomUUID(),
      accountId,
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt,
    })
    .run();
  return { token, expiresAt };
}

export function findValidSession(db: AppDatabase, token: string, now = Date.now()): ValidSession | null {
  const row = db
    .select({
      sessionId: adminSessions.id,
      expiresAt: adminSessions.expiresAt,
      id: adminAccounts.id,
      username: adminAccounts.username,
      displayName: adminAccounts.displayName,
      role: adminAccounts.role,
    })
    .from(adminSessions)
    .innerJoin(adminAccounts, eq(adminSessions.accountId, adminAccounts.id))
    .where(
      and(
        eq(adminSessions.tokenHash, hashToken(token)),
        isNull(adminSessions.revokedAt),
        isNull(adminAccounts.disabledAt),
      ),
    )
    .limit(1)
    .get();

  if (!row || row.expiresAt <= now) return null;

  return {
    sessionId: row.sessionId,
    expiresAt: row.expiresAt,
    principal: toPrincipal(row),
  };
}

export function revokeSession(db: AppDatabase, token: string, now = Date.now()): void {
  db.update(adminSessions)
    .set({ revokedAt: now })
    .where(and(eq(adminSessions.tokenHash, hashToken(token)), isNull(adminSessions.revokedAt)))
    .run();
}

/** Removes sessions that expired long ago; audit rows remain untouched. */
export function purgeExpiredSessions(db: AppDatabase, now = Date.now()): void {
  db.delete(adminSessions).where(lt(adminSessions.expiresAt, now)).run();
}
