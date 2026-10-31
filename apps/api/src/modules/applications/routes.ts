import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  applicationStatusChangeRequestSchema,
  applicationStatusSchema,
  createApplicationRequestSchema,
  setApplicationProductsRequestSchema,
  updateApplicationRequestSchema,
  type ApplicationCredentialDto,
  type ApplicationProductDto,
  type BusinessApplicationDto,
} from '@sanchuang-dev/benefit-contracts';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { requireRole, requireSession, type AppEnv } from '../../middleware/auth.js';
import { NO_STORE_HEADERS, apiError, invalidRequest, issueFields, readJson } from '../http.js';
import {
  ApplicationInputError,
  ApplicationNotFoundError,
  ApplicationProductNotActiveError,
  ApplicationSourceConflictError,
  ApplicationUnknownProductError,
  ApplicationVersionConflictError,
  createApplication,
  getApplication,
  listApplicationProducts,
  listApplications,
  replaceApplicationProducts,
  setApplicationStatus,
  updateApplication,
  type BusinessApplication,
  type ConfiguredApplicationProduct,
} from './applications.js';
import {
  ApplicationCredentialLimitError,
  ApplicationCredentialNotFoundError,
  countActiveApplicationCredentials,
  issueApplicationCredential,
  listApplicationCredentials,
  revokeApplicationCredential,
  type ApplicationCredential,
} from './credentials.js';

const MAX_PAGE_SIZE = 100;

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  keyword: z.string().trim().max(64).optional(),
  status: applicationStatusSchema.optional(),
});

const identifierSchema = z.string().trim().min(1).max(128);

function toApplicationDto(
  application: BusinessApplication,
  configuredProductCount: number,
  activeCredentialCount: number,
): BusinessApplicationDto {
  return {
    ...application,
    configuredProductCount,
    activeCredentialCount,
  };
}

function toProductDto(product: ConfiguredApplicationProduct): ApplicationProductDto {
  return {
    productId: product.productId,
    code: product.code,
    name: product.name,
    status: product.status,
    configuredAt: product.configuredAt,
  };
}

/** Allowlisted credential facts: status and timestamps, never a digest or secret. */
function toCredentialDto(credential: ApplicationCredential): ApplicationCredentialDto {
  return {
    id: credential.id,
    status: credential.status,
    issuedAt: credential.issuedAt,
    revokedAt: credential.revokedAt,
  };
}

/**
 * Maps application registry domain failures to stable HTTP semantics. Messages
 * never echo submitted bodies or another record's data; unexpected failures
 * reach the global non-leaking 500 handler.
 */
function handleApplicationError(c: Context<AppEnv>, error: unknown) {
  if (error instanceof ApplicationNotFoundError) {
    return c.json(apiError('APPLICATION_NOT_FOUND', '应用不存在'), 404, NO_STORE_HEADERS);
  }
  if (error instanceof ApplicationSourceConflictError) {
    return c.json(
      apiError('APPLICATION_SOURCE_CONFLICT', '应用来源标识已存在'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof ApplicationVersionConflictError) {
    return c.json(
      apiError('APPLICATION_VERSION_CONFLICT', '应用已被他人更新，请刷新后按最新版本重试'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof ApplicationUnknownProductError) {
    return c.json(
      { ...apiError('APPLICATION_UNKNOWN_PRODUCT', error.message), fields: ['productIds'] },
      400,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof ApplicationProductNotActiveError) {
    return c.json(
      { ...apiError('PRODUCT_NOT_ACTIVE', error.message), fields: ['productIds'] },
      400,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof ApplicationInputError) {
    return c.json(apiError('INVALID_REQUEST', error.message), 400, NO_STORE_HEADERS);
  }
  if (error instanceof ApplicationCredentialNotFoundError) {
    return c.json(
      apiError('APPLICATION_CREDENTIAL_NOT_FOUND', '服务凭证不存在'),
      404,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof ApplicationCredentialLimitError) {
    return c.json(
      apiError('APPLICATION_CREDENTIAL_LIMIT_REACHED', error.message),
      409,
      NO_STORE_HEADERS,
    );
  }
  throw error;
}

/**
 * Downstream application registry, product entitlement and machine credentials
 * (BHB-014-A/B).
 *
 * Reads accept any valid admin session; every write additionally requires the
 * `admin` role and the global CSRF gate. Responses are `no-store` and expose
 * only allowlisted configuration DTOs. Issued secrets appear once in the issue
 * response and are never persisted, logged or readable again.
 *
 * Registered applications are enforced by the machine order API: a disabled
 * application or a product outside the allowlist cannot create a new order.
 */
export function createApplicationRoutes(deps: {
  db: AppDatabase;
  config: AppConfig;
}): Hono<AppEnv> {
  const { db, config } = deps;
  const router = new Hono<AppEnv>();
  const requireAuthenticated = requireSession(db, config);
  const requireAdmin = requireRole('admin');

  router.use('*', requireAuthenticated);

  router.get('/', (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        invalidRequest('查询参数不正确', issueFields(parsed.error)),
        400,
        NO_STORE_HEADERS,
      );
    }

    const result = listApplications(db, {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      keyword: parsed.data.keyword || undefined,
      status: parsed.data.status,
    });

    return c.json(
      {
        applications: result.applications.map((row) =>
          toApplicationDto(
            row.application,
            row.configuredProductCount,
            row.activeCredentialCount,
          ),
        ),
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        total: result.total,
        runtimeAuthorizationEnforced: true,
      },
      200,
      NO_STORE_HEADERS,
    );
  });

  router.get('/:id', (c) => {
    const id = identifierSchema.safeParse(c.req.param('id'));
    if (!id.success) {
      return c.json(invalidRequest('应用 ID 不正确', ['id']), 400, NO_STORE_HEADERS);
    }

    const application = getApplication(db, id.data);
    if (!application) {
      return c.json(apiError('APPLICATION_NOT_FOUND', '应用不存在'), 404, NO_STORE_HEADERS);
    }
    const products = listApplicationProducts(db, application.id);
    const credentials = listApplicationCredentials(db, application.id);
    return c.json(
      {
        application: toApplicationDto(application, products.length, activeCount(credentials)),
        products: products.map(toProductDto),
        credentials: credentials.map(toCredentialDto),
        runtimeAuthorizationEnforced: true,
      },
      200,
      NO_STORE_HEADERS,
    );
  });

  router.post('/', requireAdmin, async (c) => {
    const body = await readJson(c);
    if (!body.ok) {
      return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    }
    const parsed = createApplicationRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(
        invalidRequest('应用参数不正确', issueFields(parsed.error)),
        400,
        NO_STORE_HEADERS,
      );
    }

    try {
      const application = createApplication(db, {
        ...parsed.data,
        actorAccountId: c.get('admin').id,
      });
      return c.json(
        { application: toApplicationDto(application, 0, 0) },
        201,
        NO_STORE_HEADERS,
      );
    } catch (error) {
      return handleApplicationError(c, error);
    }
  });

  router.patch('/:id', requireAdmin, async (c) => {
    const id = identifierSchema.safeParse(c.req.param('id'));
    if (!id.success) {
      return c.json(invalidRequest('应用 ID 不正确', ['id']), 400, NO_STORE_HEADERS);
    }
    const body = await readJson(c);
    if (!body.ok) {
      return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    }
    const parsed = updateApplicationRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(
        invalidRequest('应用参数不正确', issueFields(parsed.error)),
        400,
        NO_STORE_HEADERS,
      );
    }

    const { version, ...changes } = parsed.data;
    try {
      const application = updateApplication(db, id.data, version, changes, c.get('admin').id);
      return c.json(
        {
          application: toApplicationDto(
            application,
            countProducts(db, application.id),
            countActiveApplicationCredentials(db, application.id),
          ),
        },
        200,
        NO_STORE_HEADERS,
      );
    } catch (error) {
      return handleApplicationError(c, error);
    }
  });

  async function changeStatus(c: Context<AppEnv>, status: 'enabled' | 'disabled') {
    const id = identifierSchema.safeParse(c.req.param('id'));
    if (!id.success) {
      return c.json(invalidRequest('应用 ID 不正确', ['id']), 400, NO_STORE_HEADERS);
    }
    const body = await readJson(c);
    if (!body.ok) {
      return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    }
    const parsed = applicationStatusChangeRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(
        invalidRequest('应用参数不正确', issueFields(parsed.error)),
        400,
        NO_STORE_HEADERS,
      );
    }

    try {
      const application = setApplicationStatus(
        db,
        id.data,
        status,
        parsed.data.version,
        c.get('admin').id,
      );
      return c.json(
        {
          application: toApplicationDto(
            application,
            countProducts(db, application.id),
            countActiveApplicationCredentials(db, application.id),
          ),
        },
        200,
        NO_STORE_HEADERS,
      );
    } catch (error) {
      return handleApplicationError(c, error);
    }
  }

  router.post('/:id/enable', requireAdmin, (c) => changeStatus(c, 'enabled'));
  router.post('/:id/disable', requireAdmin, (c) => changeStatus(c, 'disabled'));

  router.put('/:id/products', requireAdmin, async (c) => {
    const id = identifierSchema.safeParse(c.req.param('id'));
    if (!id.success) {
      return c.json(invalidRequest('应用 ID 不正确', ['id']), 400, NO_STORE_HEADERS);
    }
    const body = await readJson(c);
    if (!body.ok) {
      return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    }
    const parsed = setApplicationProductsRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(
        invalidRequest('商品授权参数不正确', issueFields(parsed.error)),
        400,
        NO_STORE_HEADERS,
      );
    }

    try {
      const application = replaceApplicationProducts(
        db,
        id.data,
        parsed.data.productIds,
        parsed.data.version,
        c.get('admin').id,
      );
      const products = listApplicationProducts(db, application.id);
      return c.json(
        {
          application: toApplicationDto(
            application,
            products.length,
            countActiveApplicationCredentials(db, application.id),
          ),
          products: products.map(toProductDto),
          credentials: listApplicationCredentials(db, application.id).map(toCredentialDto),
          runtimeAuthorizationEnforced: true,
        },
        200,
        NO_STORE_HEADERS,
      );
    } catch (error) {
      return handleApplicationError(c, error);
    }
  });

  /**
   * Issues one additional machine credential. The response is the only place the
   * raw Bearer token ever appears; the database keeps its SHA-256 digest only.
   * Rotation is deliberately two operator steps (issue, then revoke the old one)
   * so the caller can switch over without an outage.
   */
  router.post('/:id/credentials', requireAdmin, (c) => {
    const id = identifierSchema.safeParse(c.req.param('id'));
    if (!id.success) {
      return c.json(invalidRequest('应用 ID 不正确', ['id']), 400, NO_STORE_HEADERS);
    }

    try {
      const issued = issueApplicationCredential(db, id.data, c.get('admin').id);
      return c.json(
        { credential: toCredentialDto(issued.credential), secret: issued.secret },
        201,
        NO_STORE_HEADERS,
      );
    } catch (error) {
      return handleApplicationError(c, error);
    }
  });

  router.post('/:id/credentials/:credentialId/revoke', requireAdmin, (c) => {
    const id = identifierSchema.safeParse(c.req.param('id'));
    const credentialId = identifierSchema.safeParse(c.req.param('credentialId'));
    if (!id.success || !credentialId.success) {
      return c.json(invalidRequest('服务凭证 ID 不正确', ['credentialId']), 400, NO_STORE_HEADERS);
    }

    try {
      const credential = revokeApplicationCredential(
        db,
        id.data,
        credentialId.data,
        c.get('admin').id,
      );
      return c.json({ credential: toCredentialDto(credential) }, 200, NO_STORE_HEADERS);
    } catch (error) {
      return handleApplicationError(c, error);
    }
  });

  return router;
}

function countProducts(db: AppDatabase, applicationId: string): number {
  return listApplicationProducts(db, applicationId).length;
}


function activeCount(credentials: readonly ApplicationCredential[]): number {
  return credentials.filter((credential) => credential.status === 'active').length;
}
