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
});

export interface YangmaoInriceConfig {
  baseUrl: string;
  appKey: string;
  appSecret: string;
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
  };
}
