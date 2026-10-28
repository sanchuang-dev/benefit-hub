import type { Context } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../middleware/auth.js';
import { apiError } from './auth/http.js';

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
