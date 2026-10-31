import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppConfig } from '../config.js';
import { NO_STORE_HEADERS, apiError } from '../modules/http.js';

export const CSRF_COOKIE_NAME = 'bh_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function tokensMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Double-submit CSRF token. The cookie is readable by our own origin (not
 * HttpOnly) while the session cookie stays HttpOnly; a cross-site page can make
 * the browser send neither the matching header nor the SameSite=Strict session.
 */
export function issueCsrfToken(c: Context, config: AppConfig): string {
  const token = randomBytes(32).toString('base64url');
  setCookie(c, CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    secure: config.cookieSecure,
    sameSite: 'Strict',
    path: '/',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
  return token;
}

function originMatchesHost(c: Context): boolean {
  const origin = c.req.header('origin');
  // Non-browser callers may omit Origin; the double-submit token still applies.
  if (!origin) return true;
  const host = c.req.header('host');
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function csrfProtection(options: {
  /**
   * Narrow, explicit exemption for a route that authenticates every request with
   * a non-browser credential and has no cookie flow. It must match exactly one
   * method+path; the route's own authentication still applies.
   */
  isExempt?: (c: Context) => boolean;
} = {}): MiddlewareHandler {
  return async (c, next) => {
    if (options.isExempt?.(c)) {
      await next();
      return;
    }

    if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    if (!originMatchesHost(c)) {
      return c.json(apiError('CSRF_ORIGIN_REJECTED', '请求来源校验失败'), 403, NO_STORE_HEADERS);
    }

    const cookieToken = getCookie(c, CSRF_COOKIE_NAME);
    const headerToken = c.req.header(CSRF_HEADER_NAME);
    if (!cookieToken || !headerToken || !tokensMatch(cookieToken, headerToken)) {
      return c.json(
        apiError('CSRF_TOKEN_INVALID', '请求校验失败，请刷新页面后重试'),
        403,
        NO_STORE_HEADERS,
      );
    }

    await next();
  };
}
