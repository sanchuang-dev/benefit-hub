import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createYangmaoInriceCatalogClient } from '@sanchuang-dev/provider-yangmao';
import type { AppConfig, YangmaoInriceConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { supplierConnectionEvents, supplierConnections } from '../../db/schema.js';

const PROVIDER = 'yangmao' as const;
const AAD = Buffer.from('benefit-hub:supplier:yangmao:v1');
const FORMAT = 'v1';

export class SupplierCredentialUnavailableError extends Error {}
export class SupplierConnectionConflictError extends Error {}
export class SupplierConnectionInputError extends Error {}

export interface SupplierConnectionInput {
  baseUrl: string;
  appKey?: string;
  appSecret?: string;
  version: number;
  actorId: string;
}

/**
 * AES-256-GCM protects credentials in the SQLite backup. The master key is
 * injected independently of the DB, not returned to the admin UI, and must
 * survive deployments for all existing supplier records to remain readable.
 */
export function encryptSupplierCredentials(key: Buffer, values: { appKey: string; appSecret: string }): string {
  if (key.length !== 32) throw new SupplierCredentialUnavailableError();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(values), 'utf8'),
    cipher.final(),
  ]);
  return [FORMAT, iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptSupplierCredentials(key: Buffer | null, ciphertext: string): { appKey: string; appSecret: string } {
  if (!key || key.length !== 32) throw new SupplierCredentialUnavailableError();
  try {
    const [version, ivPart, tagPart, dataPart, extra] = ciphertext.split(':');
    if (version !== FORMAT || !ivPart || !tagPart || !dataPart || extra !== undefined) throw Error('Bad format');
    const iv = Buffer.from(ivPart, 'base64');
    const tag = Buffer.from(tagPart, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw Error('Bad encryption envelope');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const raw = Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64')), decipher.final()]);
    const values: unknown = JSON.parse(raw.toString('utf8'));
    if (!values || typeof values !== 'object' || !('appKey' in values) || !('appSecret' in values) ||
        typeof values.appKey !== 'string' || typeof values.appSecret !== 'string') throw Error('Bad credentials');
    return { appKey: values.appKey, appSecret: values.appSecret };
  } catch {
    // Deliberately suppress the ciphertext and underlying cryptographic error.
    throw new SupplierCredentialUnavailableError();
  }
}

function storedRow(db: AppDatabase) {
  return db.select().from(supplierConnections).where(eq(supplierConnections.provider, PROVIDER)).get();
}

export function supplierConnectionSummary(db: AppDatabase, config: AppConfig) {
  const row = storedRow(db);
  const source = row ? 'database' : config.yangmaoInrice ? 'environment' : 'none';
  const locked = Boolean(row && !config.supplierMasterKey);
  return {
    key: PROVIDER,
    name: '上力',
    catalogRead: {
      supported: true,
      configured: Boolean(row ? config.supplierMasterKey : config.yangmaoInrice),
      source,
      locked,
      canEdit: Boolean(config.supplierMasterKey),
    },
  };
}

/** Reads current DB credentials on each request: no container restart is needed. */
export function activeYangmaoReadConfig(db: AppDatabase, config: AppConfig): YangmaoInriceConfig | null {
  const row = storedRow(db);
  if (!row) return config.yangmaoInrice;
  const credentials = decryptSupplierCredentials(config.supplierMasterKey, row.encryptedCredentials);
  return { baseUrl: row.baseUrl, ...credentials };
}

/** Only admins can request this metadata; neither credential value leaves the API. */
export function supplierConnectionEditorDto(db: AppDatabase, config: AppConfig) {
  const row = storedRow(db);
  return {
    provider: PROVIDER,
    baseUrl: row?.baseUrl ?? config.yangmaoInrice?.baseUrl ?? '',
    version: row?.version ?? 0,
    source: row ? 'database' : config.yangmaoInrice ? 'environment' : 'none',
    hasCredentials: Boolean(row || config.yangmaoInrice),
    canSave: Boolean(config.supplierMasterKey),
  };
}

/** Always stores both credentials together. Missing fields may preserve previous DB values. */
export function saveSupplierConnection(db: AppDatabase, config: AppConfig, input: SupplierConnectionInput) {
  const key = config.supplierMasterKey;
  if (!key) throw new SupplierCredentialUnavailableError();

  // Restrict proxy destinations to the actually verified vendor dev host.
  // A new vendor host requires its own reviewed connector contract.
  let target: URL;
  try { target = new URL(input.baseUrl); }
  catch { throw new SupplierConnectionInputError(); }
  if (target.protocol !== 'https:' || target.hostname !== 'dev-api.isunpow.com' ||
      target.port !== '' || target.username || target.password || target.pathname !== '/' ||
      target.search || target.hash) throw new SupplierConnectionInputError();

  return db.transaction((tx) => {
    const current = tx.select().from(supplierConnections).where(eq(supplierConnections.provider, PROVIDER)).get();
    if ((current?.version ?? 0) !== input.version) throw new SupplierConnectionConflictError();
    const old = current ? decryptSupplierCredentials(key, current.encryptedCredentials) : null;
    const appKey = input.appKey || old?.appKey;
    const appSecret = input.appSecret || old?.appSecret;
    if (!appKey || !appSecret) throw new SupplierConnectionInputError();
    const nextConfig = { baseUrl: target.origin, appKey, appSecret };
    // Parse the local provider contract without calling the supplier.
    try { createYangmaoInriceCatalogClient(nextConfig); }
    catch { throw new SupplierConnectionInputError(); }

    const updatedAt = Date.now();
    const version = input.version + 1;
    const record = {
      provider: PROVIDER, baseUrl: target.origin,
      encryptedCredentials: encryptSupplierCredentials(key, { appKey, appSecret }),
      updatedAt, updatedBy: input.actorId, version,
    };
    if (current) {
      const changed = tx.update(supplierConnections)
        .set(record)
        .where(eq(supplierConnections.provider, PROVIDER)).run();
      if (changed.changes !== 1) throw new SupplierConnectionConflictError();
    } else {
      tx.insert(supplierConnections).values(record).run();
    }
    tx.insert(supplierConnectionEvents).values({
      id: randomUUID(), provider: PROVIDER, actorAccountId: input.actorId,
      action: 'saved', version, createdAt: updatedAt,
    }).run();
    return { version, baseUrl: target.origin, hasCredentials: true, canSave: true, source: 'database' as const };
  });
}
