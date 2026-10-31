import type { Context } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../middleware/auth.js';

export interface ApiErrorBody {
  error: string;
  message: string;
}

/**
 * Stable machine-readable error code plus a short user-facing message. Error
 * bodies never echo submitted credentials or reveal whether an account exists.
 */
export function apiError(code: string, message: string): ApiErrorBody {
  return { error: code, message };
}

/** Every authenticated read (session, audit, runtime) must bypass caches. */
export const NO_STORE_HEADERS = { 'cache-control': 'no-store' } as const;

/** Field paths only: submitted values are never echoed back. */
export function invalidRequest(message: string, fields?: string[]) {
  const error = apiError('INVALID_REQUEST', message);
  return fields && fields.length > 0 ? { ...error, fields } : error;
}

export function issueFields(error: z.ZodError): string[] {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) fields.add(key);
      continue;
    }
    const [first] = issue.path;
    if (first !== undefined) fields.add(String(first));
  }
  return [...fields];
}

export async function readJson(
  c: Context<AppEnv>,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false };
  }
}
