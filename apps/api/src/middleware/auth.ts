import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/client.js';
import { recordAuthEvent } from '../modules/auth/audit.js';
import type { AdminRole } from '../modules/auth/accounts.js';
import { apiError, NO_STORE_HEADERS } from '../modules/auth/http.js';
import type { SessionPrincipal } from '../modules/auth/principal.js';
import { findValidSession, SESSION_COOKIE_NAME } from '../modules/auth/session.js';

export interface AppEnv {
  Variables: {
    admin: SessionPrincipal;
    sessionExpiresAt: number;
  };
}

export function clearSessionCookie(c: Context, config: AppConfig): void {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    secure: config.cookieSecure,
    sameSite: 'Strict',
    path: '/',
  });
}

/**
 * Server-side authentication boundary. Every protected route must pass through
 * here; hiding UI controls is never treated as authorization.
 */
export function requireSession(db: AppDatabase, config: AppConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (!token) {
      return c.json(apiError('UNAUTHENTICATED', '请先登录'), 401, NO_STORE_HEADERS);
    }

    const session = findValidSession(db, token);
    if (!session) {
      clearSessionCookie(c, config);
      recordAuthEvent(db, 'session.rejected');
      return c.json(apiError('SESSION_EXPIRED', '登录已过期，请重新登录'), 401, NO_STORE_HEADERS);
    }

    c.set('admin', session.principal);
    c.set('sessionExpiresAt', session.expiresAt);
    await next();
  };
}

/** Coarse two-level authorization; must be enforced server-side per operation. */
export function requireRole(role: AdminRole): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const admin = c.get('admin');
    if (!admin || admin.role !== role) {
      return c.json(apiError('FORBIDDEN', '当前身份无权执行该操作'), 403, NO_STORE_HEADERS);
    }
    await next();
  };
}
