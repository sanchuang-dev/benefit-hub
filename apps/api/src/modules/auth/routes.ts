import type { Context } from 'hono';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { clearSessionCookie, requireSession, type AppEnv } from '../../middleware/auth.js';
import { issueCsrfToken } from '../../middleware/csrf.js';
import { findAccountByUsername, normalizeUsername, publicAccount } from './accounts.js';
import { recordAuthEvent } from './audit.js';
import { apiError, NO_STORE_HEADERS } from './http.js';
import { verifyPasswordOrDummy } from './password.js';
import { createFailureRateLimiter } from './rate-limit.js';
import {
  createSession,
  purgeExpiredSessions,
  revokeSession,
  SESSION_COOKIE_NAME,
  type IssuedSession,
} from './session.js';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

function setSessionCookie(c: Context, session: IssuedSession, config: AppConfig): void {
  setCookie(c, SESSION_COOKIE_NAME, session.token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Strict',
    path: '/',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

/**
 * Rate-limit identity. `X-Forwarded-For` is trusted only when the deployment
 * sets TRUST_PROXY (Caddy in front of the container); otherwise a client could
 * rotate its own bucket. Direct connections fall back to the socket address.
 */
function clientAddress(c: Context, config: AppConfig): string {
  if (config.trustProxy) {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createAuthRoutes(deps: { db: AppDatabase; config: AppConfig }): Hono<AppEnv> {
  const { db, config } = deps;
  const router = new Hono<AppEnv>();

  const accountLimiter = createFailureRateLimiter({
    maxFailures: 5,
    windowMs: LOGIN_FAILURE_WINDOW_MS,
  });
  const addressLimiter = createFailureRateLimiter({
    maxFailures: 20,
    windowMs: LOGIN_FAILURE_WINDOW_MS,
  });

  router.get('/csrf', (c) => c.json({ csrfToken: issueCsrfToken(c, config) }, 200, NO_STORE_HEADERS));

  router.post('/login', async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(apiError('INVALID_REQUEST', '请求格式不正确'), 400, NO_STORE_HEADERS);
    }

    const parsed = loginSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(apiError('INVALID_REQUEST', '请输入账号和密码'), 400, NO_STORE_HEADERS);
    }

    const username = normalizeUsername(parsed.data.username);
    const accountKey = `account:${username}`;
    const addressKey = `address:${clientAddress(c, config)}`;

    const accountLimit = accountLimiter.reserve(accountKey);
    const addressLimit = addressLimiter.reserve(addressKey);
    if (!accountLimit.allowed || !addressLimit.allowed) {
      if (accountLimit.allowed) accountLimiter.settle(accountKey, false);
      if (addressLimit.allowed) addressLimiter.settle(addressKey, false);
      const retryAfterSeconds = Math.max(accountLimit.retryAfterSeconds, addressLimit.retryAfterSeconds, 1);
      recordAuthEvent(db, 'login.rate_limited', { detail: 'too_many_attempts' });
      return c.json(apiError('TOO_MANY_ATTEMPTS', '尝试次数过多，请稍后再试'), 429, {
        ...NO_STORE_HEADERS,
        'retry-after': String(retryAfterSeconds),
      });
    }

    let rejected = false;
    try {
      const account = findAccountByUsername(db, username);
      const passwordValid = await verifyPasswordOrDummy(parsed.data.password, account?.passwordHash ?? null);

      if (!account || account.disabled || !passwordValid) {
        rejected = true;
        recordAuthEvent(db, 'login.failed', {
          accountId: account?.id ?? null,
          detail: account?.disabled ? 'account_disabled' : 'invalid_credentials',
        });
        return c.json(apiError('INVALID_CREDENTIALS', '账号或密码不正确'), 401, NO_STORE_HEADERS);
      }

      accountLimiter.reset(accountKey);
      // Keep address-wide failure history: logging into a different valid
      // account must not wipe prior failures against other usernames.
      purgeExpiredSessions(db);

      const session = createSession(db, account.id, config.sessionTtlMs);
      setSessionCookie(c, session, config);
      const csrfToken = issueCsrfToken(c, config);
      recordAuthEvent(db, 'login.succeeded', { accountId: account.id });

      return c.json(
        {
          admin: publicAccount(account),
          session: { expiresAt: session.expiresAt },
          csrfToken,
        },
        200,
        NO_STORE_HEADERS,
      );
    } finally {
      accountLimiter.settle(accountKey, rejected);
      addressLimiter.settle(addressKey, rejected);
    }
  });

  router.post('/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (token) {
      revokeSession(db, token);
      recordAuthEvent(db, 'logout');
    }
    clearSessionCookie(c, config);
    return c.body(null, 204, NO_STORE_HEADERS);
  });

  router.get('/session', requireSession(db, config), (c) =>
    c.json(
      {
        admin: c.get('admin'),
        session: { expiresAt: c.get('sessionExpiresAt') },
      },
      200,
      NO_STORE_HEADERS,
    ),
  );

  return router;
}
