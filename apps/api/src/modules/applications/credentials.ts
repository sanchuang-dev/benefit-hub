import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import type { ApplicationCredentialStatus } from '@sanchuang-dev/benefit-contracts';
import type { AppDatabase } from '../../db/client.js';
import {
  businessApplicationCredentialEvents,
  businessApplicationCredentials,
  businessApplications,
} from '../../db/schema.js';
import { ApplicationNotFoundError } from './applications.js';

/**
 * Upper bound of simultaneously active credentials per application. Rotation
 * needs one overlap window (issue new, switch the caller, revoke old), while an
 * unbounded set would make revocation ambiguous and widen the credential blast
 * radius.
 */
export const MAX_ACTIVE_CREDENTIALS_PER_APPLICATION = 5;

/** Opaque prefix so operators can recognize the token type without the digest. */
const CREDENTIAL_PREFIX = 'bhk_';

export class ApplicationCredentialNotFoundError extends Error {}
export class ApplicationCredentialLimitError extends Error {}

/** Non-sensitive credential state. `token_sha256` never leaves this module. */
export interface ApplicationCredential {
  id: string;
  applicationId: string;
  status: ApplicationCredentialStatus;
  issuedAt: number;
  revokedAt: number | null;
}

export interface IssuedApplicationCredential {
  credential: ApplicationCredential;
  /** Full bearer token; returned once and never stored in plaintext. */
  secret: string;
}

/** Verified machine identity plus the application state needed for enforcement. */
export interface AuthenticatedApplicationCredential {
  credentialId: string;
  applicationId: string;
  businessSource: string;
  applicationStatus: string;
}

interface CredentialRow {
  id: string;
  applicationId: string;
  issuedAt: number;
  revokedAt: number | null;
}

type Transaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

function toCredential(row: CredentialRow): ApplicationCredential {
  return {
    id: row.id,
    applicationId: row.applicationId,
    status: row.revokedAt === null ? 'active' : 'revoked',
    issuedAt: row.issuedAt,
    revokedAt: row.revokedAt,
  };
}

export function digestCredential(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function generateSecret(): string {
  return `${CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function recordEvent(
  tx: Transaction,
  input: {
    credentialId: string;
    applicationId: string;
    actorAccountId: string;
    action: 'issued' | 'revoked';
    createdAt: number;
  },
): void {
  tx.insert(businessApplicationCredentialEvents)
    .values({ id: randomUUID(), ...input })
    .run();
}

function requireApplication(tx: Transaction, applicationId: string): { id: string } {
  const row = tx
    .select({ id: businessApplications.id })
    .from(businessApplications)
    .where(eq(businessApplications.id, applicationId))
    .limit(1)
    .get();
  if (!row) throw new ApplicationNotFoundError(`应用不存在：${applicationId}`);
  return row;
}

/**
 * Issues one additional credential for an application. The raw token is
 * generated server-side, bound to exactly one application, and only its SHA-256
 * digest is persisted. The insert, limit check and audit fact share one local
 * transaction; a digest collision is retried a bounded number of times and then
 * surfaced as a failure rather than silently reusing a token.
 */
export function issueApplicationCredential(
  db: AppDatabase,
  applicationId: string,
  actorAccountId: string,
): IssuedApplicationCredential {
  return db.transaction((tx) => {
    requireApplication(tx, applicationId);

    const active =
      tx
        .select({ value: count() })
        .from(businessApplicationCredentials)
        .where(
          and(
            eq(businessApplicationCredentials.applicationId, applicationId),
            isNull(businessApplicationCredentials.revokedAt),
          ),
        )
        .get()?.value ?? 0;
    if (active >= MAX_ACTIVE_CREDENTIALS_PER_APPLICATION) {
      throw new ApplicationCredentialLimitError(
        `单个应用最多保留 ${MAX_ACTIVE_CREDENTIALS_PER_APPLICATION} 个有效凭证，请先撤销不再使用的凭证`,
      );
    }

    const now = Date.now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const secret = generateSecret();
      const row: CredentialRow = {
        id: randomUUID(),
        applicationId,
        issuedAt: now,
        revokedAt: null,
      };

      try {
        tx.insert(businessApplicationCredentials)
          .values({
            id: row.id,
            applicationId,
            tokenSha256: digestCredential(secret),
            issuedBy: actorAccountId,
            issuedAt: now,
            revokedBy: null,
            revokedAt: null,
          })
          .run();
      } catch (error) {
        if (isDigestConflict(error)) continue;
        throw error;
      }

      recordEvent(tx, {
        credentialId: row.id,
        applicationId,
        actorAccountId,
        action: 'issued',
        createdAt: now,
      });
      return { credential: toCredential(row), secret };
    }

    throw new Error('Unable to generate a unique application credential digest');
  });
}

/**
 * Revokes one credential. Revocation is idempotent: repeating it returns the
 * existing revoked state without a second audit fact or a changed timestamp.
 * The credential must belong to the given application, so another application's
 * credential id cannot be probed or revoked.
 */
export function revokeApplicationCredential(
  db: AppDatabase,
  applicationId: string,
  credentialId: string,
  actorAccountId: string,
): ApplicationCredential {
  return db.transaction((tx) => {
    requireApplication(tx, applicationId);

    const current = tx
      .select({ id: businessApplicationCredentials.id, revokedAt: businessApplicationCredentials.revokedAt })
      .from(businessApplicationCredentials)
      .where(
        and(
          eq(businessApplicationCredentials.id, credentialId),
          eq(businessApplicationCredentials.applicationId, applicationId),
        ),
      )
      .limit(1)
      .get();
    if (!current) {
      throw new ApplicationCredentialNotFoundError(`服务凭证不存在：${credentialId}`);
    }
    if (current.revokedAt !== null) return requireCredential(tx, applicationId, credentialId);

    const now = Date.now();
    const updated = tx
      .update(businessApplicationCredentials)
      .set({ revokedAt: now, revokedBy: actorAccountId })
      .where(
        and(
          eq(businessApplicationCredentials.id, credentialId),
          eq(businessApplicationCredentials.applicationId, applicationId),
          isNull(businessApplicationCredentials.revokedAt),
        ),
      )
      .run();

    // A concurrent revocation already succeeded; report that same terminal fact
    // instead of inventing a second revocation timestamp.
    if (updated.changes === 0) return requireCredential(tx, applicationId, credentialId);

    recordEvent(tx, {
      credentialId,
      applicationId,
      actorAccountId,
      action: 'revoked',
      createdAt: now,
    });
    return requireCredential(tx, applicationId, credentialId);
  });
}

export function listApplicationCredentials(
  db: AppDatabase,
  applicationId: string,
): ApplicationCredential[] {
  const rows = db
    .select({
      id: businessApplicationCredentials.id,
      applicationId: businessApplicationCredentials.applicationId,
      issuedAt: businessApplicationCredentials.issuedAt,
      revokedAt: businessApplicationCredentials.revokedAt,
    })
    .from(businessApplicationCredentials)
    .where(eq(businessApplicationCredentials.applicationId, applicationId))
    .orderBy(desc(businessApplicationCredentials.issuedAt), desc(businessApplicationCredentials.id))
    .all();
  return rows.map(toCredential);
}

export function countActiveApplicationCredentials(
  db: AppDatabase,
  applicationId: string,
): number {
  return (
    db
      .select({ value: count() })
      .from(businessApplicationCredentials)
      .where(
        and(
          eq(businessApplicationCredentials.applicationId, applicationId),
          isNull(businessApplicationCredentials.revokedAt),
        ),
      )
      .get()?.value ?? 0
  );
}

/**
 * Resolves a presented bearer digest to its application identity. Only a
 * non-revoked credential matches; the application state is returned so the
 * caller can reject disabled registrations without a second, racy read.
 *
 * Equality on a SHA-256 digest is a hash lookup, not a secret comparison: an
 * attacker cannot learn the stored value or iterate towards it, and the token
 * itself is not present anywhere in the database.
 */
export function findAuthenticatedApplicationCredential(
  db: AppDatabase,
  digestHex: string,
): AuthenticatedApplicationCredential | null {
  const row = db
    .select({
      credentialId: businessApplicationCredentials.id,
      applicationId: businessApplications.id,
      businessSource: businessApplications.businessSource,
      applicationStatus: businessApplications.status,
    })
    .from(businessApplicationCredentials)
    .innerJoin(
      businessApplications,
      eq(businessApplications.id, businessApplicationCredentials.applicationId),
    )
    .where(
      and(
        eq(businessApplicationCredentials.tokenSha256, digestHex),
        isNull(businessApplicationCredentials.revokedAt),
      ),
    )
    .limit(1)
    .get();

  if (!row) return null;
  if (row.applicationStatus !== 'enabled' && row.applicationStatus !== 'disabled') {
    throw new Error(`Unknown application status stored in database: ${row.applicationStatus}`);
  }
  return row;
}

/**
 * True when the service has at least one issued application credential, revoked
 * or not. Used only to decide whether the machine order surface is configured at
 * all (503 otherwise). A revoked credential must still reach authentication and
 * produce the same generic 401 as an unknown token, not a misleading 503.
 */
export function hasAnyApplicationCredential(db: AppDatabase): boolean {
  const row = db
    .select({ id: businessApplicationCredentials.id })
    .from(businessApplicationCredentials)
    .limit(1)
    .get();
  return row !== undefined;
}

function requireCredential(
  tx: Transaction,
  applicationId: string,
  credentialId: string,
): ApplicationCredential {
  const row = tx
    .select({
      id: businessApplicationCredentials.id,
      applicationId: businessApplicationCredentials.applicationId,
      issuedAt: businessApplicationCredentials.issuedAt,
      revokedAt: businessApplicationCredentials.revokedAt,
    })
    .from(businessApplicationCredentials)
    .where(
      and(
        eq(businessApplicationCredentials.id, credentialId),
        eq(businessApplicationCredentials.applicationId, applicationId),
      ),
    )
    .limit(1)
    .get();
  if (!row) throw new ApplicationCredentialNotFoundError(`服务凭证不存在：${credentialId}`);
  return toCredential(row);
}

function isDigestConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('UNIQUE constraint failed: business_application_credentials.token_sha256')
  );
}
