import { createHash } from 'node:crypto';
import { BUSINESS_SOURCE_PATTERN } from '@sanchuang-dev/benefit-contracts';
import { z } from 'zod';

const environmentSchema = z.object({
  DATABASE_FILE: z.string().min(1),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.string().optional(),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(8),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  // Optional, server-only Yangmao D read credentials. They are never exposed to
  // the browser bundle; the API treats any missing or unreadable value as
  // "not configured" instead of falling back to a default or fixture secret.
  YANGMAO_INRICE_BASE_URL: z.string().optional(),
  YANGMAO_INRICE_APP_KEY: z.string().optional(),
  YANGMAO_INRICE_APP_SECRET: z.string().optional(),
  BENEFIT_SUPPLIER_MASTER_KEY: z.string().optional(),
  // Optional, server-only machine-to-machine order intake credentials. Absent
  // means the downstream order API is explicitly unavailable (503); a present
  // but malformed value is a startup error so a broken auth boundary can never
  // silently fall back to "anybody may write orders".
  BENEFIT_ORDER_CLIENTS_JSON: z.string().optional(),
  // Only product codes backed by verified supplier evidence may incur a B-mode debit.
  // A missing or invalid configuration fails closed; never derive this from display names.
  BENEFIT_B_TRAVEL_PRODUCTS_JSON: z.string().optional(),
  BENEFIT_B_LIVE_WRITE_ENABLED: z.enum(['true','false']).default('false'),
  // A prepaid order creation deducts one supplier pack quota. Code shipping and
  // authorizing a live quota write are separate decisions, so this is off by default.
  BENEFIT_A_LIVE_WRITE_ENABLED: z.enum(['true','false']).default('false'),
  // D dispatch deducts the supplier's monetary entitlement balance. Shipping
  // code and authorizing a real debit are separate decisions, so this is off by default.
  BENEFIT_D_LIVE_WRITE_ENABLED: z.enum(['true','false']).default('false'),
  // Optional build stamp injected by the deployment pipeline. These are facts
  // for the read-only "平台状态" card; absent values stay null so the console can
  // say "未注入" instead of inventing a version.
  BUILD_VERSION: z.string().trim().max(64).optional(),
  BUILD_COMMIT: z.string().trim().max(64).optional(),
  BUILD_TIME: z.string().trim().max(64).optional(),
});

export interface YangmaoInriceConfig {
  baseUrl: string;
  appKey: string;
  appSecret: string;
}

/**
 * Minimum length of a configured downstream service bearer token. Anything
 * shorter is rejected as configuration rather than accepted as a weak secret.
 */
export const BUSINESS_ORDER_CLIENT_TOKEN_MIN_LENGTH = 32;
const BUSINESS_ORDER_CLIENT_TOKEN_PATTERN = /^[!-~]{32,512}$/;

export interface BusinessOrderClient {
  /** Normalized `businessSource`; the only identity this token may act as. */
  businessSource: string;
  /**
   * SHA-256 digest of the bearer token. The raw token stays in the environment
   * only, so it cannot leak through an accidental config/DTO serialization.
   */
  tokenSha256: Buffer;
}

export interface BusinessOrderClientsConfig {
  clients: readonly BusinessOrderClient[];
}

/**
 * Deployment-provided build stamp. Every field is nullable because a local
 * checkout has no stamp; null means "unknown", never "version 0".
 */
export interface BuildInfo {
  version: string | null;
  commit: string | null;
  builtAt: number | null;
}

export interface AppConfig {
  databaseFile: string;
  host: string;
  port: number;
  /**
   * HttpOnly session cookies must be Secure in production. Local `http://`
   * debugging needs this off, so it is explicit rather than inferred per request.
   */
  cookieSecure: boolean;
  /**
   * Only trust `X-Forwarded-For` when the deployment terminates TLS in Caddy in
   * front of this container. Trusting it on a directly exposed port lets clients
   * forge their own rate-limit identity.
   */
  trustProxy: boolean;
  sessionTtlMs: number;
  /**
   * Present only when all three server-side Yangmao D read values are set.
   * A partial configuration stays null so the read endpoint reports an explicit
   * unavailability instead of attempting a signed request with a gap.
   */
  yangmaoInrice: YangmaoInriceConfig | null;
  supplierMasterKey: Buffer | null;
  /**
   * Present only when at least one downstream business client is configured.
   * A malformed configuration never reaches this state; `loadConfig` throws.
   */
  businessOrderClients: BusinessOrderClientsConfig | null;
  /** B-mode supplier-verified productCode -> evidence reference (server-only). */
  verifiedBTravelProducts: Readonly<Record<string, string>>;
  /** Explicit separate permission for the quota-deducting B write. Default false. */
  bLiveWritesEnabled: boolean;
  /** Explicit separate permission for the quota-deducting A prepaid write. Default false. */
  aLiveWritesEnabled: boolean;
  /** Explicit separate permission for the amount-deducting D dispatch. Default false. */
  dLiveWritesEnabled: boolean;
  /** Build stamp for the read-only runtime status card; null means not injected. */
  buildInfo: BuildInfo;
}

/**
 * All-or-nothing supplier configuration. Values are passed through unchanged so
 * the provider client can reject outer whitespace or control characters; blank
 * values are treated as absent rather than as a usable credential.
 */
function readYangmaoInriceConfig(env: NodeJS.ProcessEnv): YangmaoInriceConfig | null {
  const baseUrl = env.YANGMAO_INRICE_BASE_URL ?? '';
  const appKey = env.YANGMAO_INRICE_APP_KEY ?? '';
  const appSecret = env.YANGMAO_INRICE_APP_SECRET ?? '';

  if (baseUrl.trim() === '' && appKey.trim() === '' && appSecret.trim() === '') return null;
  if (baseUrl.trim() === '' || appKey.trim() === '' || appSecret.trim() === '') return null;

  return { baseUrl, appKey, appSecret };
}

/** Configuration errors never include a token value or the raw JSON blob. */
function businessOrderConfigError(detail: string): Error {
  return new Error(`Invalid environment configuration (BENEFIT_ORDER_CLIENTS_JSON: ${detail})`);
}

/**
 * Parses the optional `BENEFIT_ORDER_CLIENTS_JSON` map of
 * `businessSource -> bearer token`. The format is documented in
 * `docs/integrations/business-order-api.md`; tokens only ever exist server-side.
 *
 * Every malformed shape is rejected instead of partially accepted: invalid
 * JSON, a non-object, an empty map, invalid/duplicate source keys, weak or
 * non-string tokens, and the same token bound to two clients.
 */
function readBusinessOrderClientsConfig(
  env: NodeJS.ProcessEnv,
): BusinessOrderClientsConfig | null {
  const raw = env.BENEFIT_ORDER_CLIENTS_JSON ?? '';
  if (raw.trim() === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw businessOrderConfigError('不是合法的 JSON 对象');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw businessOrderConfigError('必须是 {"businessSource":"token"} 形式的 JSON 对象');
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw businessOrderConfigError('至少需要配置一个业务来源');
  }

  const bySource = new Map<string, BusinessOrderClient>();
  const usedTokens = new Set<string>();

  for (const [rawSource, rawToken] of entries) {
    const businessSource = rawSource.trim().toLowerCase();
    if (!BUSINESS_SOURCE_PATTERN.test(businessSource)) {
      throw businessOrderConfigError(
        '业务来源键不合法（需 1-64 位字母、数字或 . _ -，统一转为小写）',
      );
    }
    if (bySource.has(businessSource)) {
      throw businessOrderConfigError(`业务来源 ${businessSource} 重复（大小写不同也不行）`);
    }
    if (typeof rawToken !== 'string' || !BUSINESS_ORDER_CLIENT_TOKEN_PATTERN.test(rawToken)) {
      throw businessOrderConfigError(
        `业务来源 ${businessSource} 的令牌需为 ${BUSINESS_ORDER_CLIENT_TOKEN_MIN_LENGTH}-512 位可见 ASCII 字符且不含空格`,
      );
    }
    if (usedTokens.has(rawToken)) {
      throw businessOrderConfigError(`业务来源 ${businessSource} 的令牌与另一个业务来源重复`);
    }
    usedTokens.add(rawToken);
    bySource.set(businessSource, {
      businessSource,
      tokenSha256: createHash('sha256').update(rawToken, 'utf8').digest(),
    });
  }

  return { clients: [...bySource.values()] };
}

function readVerifiedBTravelProducts(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    throw new Error('Invalid BENEFIT_B_TRAVEL_PRODUCTS_JSON: malformed JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid BENEFIT_B_TRAVEL_PRODUCTS_JSON: expected code-to-evidence map');
  }
  const result: Record<string, string> = {};
  for (const [code, evidence] of Object.entries(value)) {
    if (!/^[!-~]{1,64}$/.test(code) || typeof evidence !== 'string' ||
        !/^[!-~]{8,256}$/.test(evidence)) {
      throw new Error('Invalid BENEFIT_B_TRAVEL_PRODUCTS_JSON: invalid evidence entry');
    }
    result[code] = evidence;
  }
  return result;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration (${details})`);
  }

  const value = parsed.data;
  return {
    databaseFile: value.DATABASE_FILE,
    host: value.HOST,
    port: value.PORT,
    cookieSecure: value.COOKIE_SECURE
      ? value.COOKIE_SECURE === 'true'
      : value.NODE_ENV === 'production',
    trustProxy: value.TRUST_PROXY === 'true',
    sessionTtlMs: value.SESSION_TTL_HOURS * 60 * 60 * 1000,
    yangmaoInrice: readYangmaoInriceConfig(env),
    supplierMasterKey: value.BENEFIT_SUPPLIER_MASTER_KEY && /^[a-fA-F0-9]{64}$/.test(value.BENEFIT_SUPPLIER_MASTER_KEY)
      ? Buffer.from(value.BENEFIT_SUPPLIER_MASTER_KEY, 'hex')
      : null,
    businessOrderClients: readBusinessOrderClientsConfig(env),
    verifiedBTravelProducts: readVerifiedBTravelProducts(value.BENEFIT_B_TRAVEL_PRODUCTS_JSON),
    bLiveWritesEnabled: value.BENEFIT_B_LIVE_WRITE_ENABLED === 'true',
    aLiveWritesEnabled: value.BENEFIT_A_LIVE_WRITE_ENABLED === 'true',
    dLiveWritesEnabled: value.BENEFIT_D_LIVE_WRITE_ENABLED === 'true',
    buildInfo: readBuildInfo(value),
  };
}

/**
 * Reads the optional deployment build stamp. A missing value is null; an
 * unparsable timestamp is also null rather than a fabricated build time.
 */
function readBuildInfo(value: {
  BUILD_VERSION?: string;
  BUILD_COMMIT?: string;
  BUILD_TIME?: string;
}): BuildInfo {
  const version = value.BUILD_VERSION || null;
  const commit = value.BUILD_COMMIT || null;
  const rawTime = value.BUILD_TIME;
  const builtAt = rawTime ? Date.parse(rawTime) : Number.NaN;
  return {
    version,
    commit,
    builtAt: Number.isFinite(builtAt) ? builtAt : null,
  };
}
