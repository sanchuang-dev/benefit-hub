import { z } from 'zod';

const environmentSchema = z.object({
  DATABASE_FILE: z.string().min(1),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.string().optional(),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(8),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});

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
  };
}
