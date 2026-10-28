import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import type { AppEnv } from '../../middleware/auth.js';
import { findApplicationBySource } from '../applications/applications.js';
import {
  findAuthenticatedApplicationCredential,
  hasAnyApplicationCredential,
} from '../applications/credentials.js';
import { apiError, NO_STORE_HEADERS } from '../auth/http.js';

/**
 * Reads a single `Authorization: Bearer <token>` value. Anything else (another
 * scheme, extra parameters, empty token, multiple headers) is rejected.
 */
export function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([!-~]+)$/i.exec(header);
  return match ? match[1]! : null;
}

/**
 * Machine-to-machine authentication for the downstream order API.
 *
 * This is deliberately separate from the human admin session: no browser
 * cookie, admin session or CSRF token is accepted or required here, and the
 * credential alone decides *which* business source the caller acts as. The
 * source is taken from the server-side credential (registered application
 * credential or environment client map), never from the request.
 *
 * Two credential origins are supported:
 * - a credential issued per registered application and stored as a SHA-256
 *   digest in SQLite (the normal path);
 * - the legacy `BENEFIT_ORDER_CLIENTS_JSON` map, kept for already integrated
 *   callers. When its `businessSource` is registered as an application, the
 *   environment credential is subject to that application's enabled state (and,
 *   on creation, its product allowlist) exactly like an issued credential, so
 *   it can never bypass database configuration.
 *
 * Missing service configuration fails closed with 503 before any route or
 * repository code runs. A missing, unknown or revoked bearer returns one generic
 * 401 without revealing whether the source or token exists. A verified caller
 * whose application is disabled gets 403 and cannot create or read orders.
 */
export function requireBusinessClient(
  db: AppDatabase,
  config: AppConfig,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const configured = config.businessOrderClients;
    if (!configured && !hasAnyApplicationCredential(db)) {
      return c.json(
        apiError('SERVICE_UNAVAILABLE', '业务订单接口尚未配置服务凭证'),
        503,
        NO_STORE_HEADERS,
      );
    }

    const token = readBearerToken(c.req.header('authorization'));
    if (!token) {
      return c.json(apiError('UNAUTHORIZED', '缺少或无效的服务凭证'), 401, NO_STORE_HEADERS);
    }

    // Digest both sides to fixed-length values, then compare every configured
    // environment client without early exit. Length differences therefore
    // cannot leak through timing, and a match cannot be attributed to a specific
    // entry.
    const providedDigest = createHash('sha256').update(token, 'utf8').digest();
    let matchedSource: string | null = null;
    for (const client of configured?.clients ?? []) {
      if (timingSafeEqual(providedDigest, client.tokenSha256)) {
        matchedSource = client.businessSource;
      }
    }

    if (matchedSource) {
      // A registered source is governed by its configuration even when the
      // credential still comes from the environment.
      const application = findApplicationBySource(db, matchedSource);
      if (application && application.status !== 'enabled') {
        return c.json(
          apiError('APPLICATION_DISABLED', '应用已停用，不能调用业务订单接口'),
          403,
          NO_STORE_HEADERS,
        );
      }
      c.set('businessSource', matchedSource);
      c.set('businessCredentialId', null);
      await next();
      return;
    }

    const credential = findAuthenticatedApplicationCredential(db, providedDigest.toString('hex'));
    if (!credential) {
      return c.json(apiError('UNAUTHORIZED', '缺少或无效的服务凭证'), 401, NO_STORE_HEADERS);
    }
    if (credential.applicationStatus !== 'enabled') {
      return c.json(
        apiError('APPLICATION_DISABLED', '应用已停用，不能调用业务订单接口'),
        403,
        NO_STORE_HEADERS,
      );
    }

    c.set('businessSource', credential.businessSource);
    c.set('businessCredentialId', credential.credentialId);
    await next();
  };
}
