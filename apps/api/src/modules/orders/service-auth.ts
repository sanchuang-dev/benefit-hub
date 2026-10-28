import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppConfig } from '../../config.js';
import type { AppEnv } from '../../middleware/auth.js';
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
 * bearer token alone decides *which* business source the caller acts as. The
 * source is taken from the server-side credential map, never from the request.
 *
 * Missing service configuration fails closed with 503 before any route/repository
 * code runs. A missing, unknown or malformed bearer returns 401 without the
 * response revealing whether the source or token exists.
 */
export function requireBusinessClient(config: AppConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const configured = config.businessOrderClients;
    if (!configured) {
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
    // client without early exit. Length differences therefore cannot leak
    // through timing, and a match cannot be attributed to a specific entry.
    const providedDigest = createHash('sha256').update(token, 'utf8').digest();
    let matchedSource: string | null = null;
    for (const client of configured.clients) {
      if (timingSafeEqual(providedDigest, client.tokenSha256)) {
        matchedSource = client.businessSource;
      }
    }

    if (!matchedSource) {
      return c.json(apiError('UNAUTHORIZED', '缺少或无效的服务凭证'), 401, NO_STORE_HEADERS);
    }

    c.set('businessSource', matchedSource);
    await next();
  };
}
