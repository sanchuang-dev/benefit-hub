import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  activateMappingDraftRequestSchema,
  saveMappingDraftRequestSchema,
  validateMappingDraftRequestSchema,
  type MappingOverviewDto,
} from '@sanchuang-dev/benefit-contracts';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { requireRole, requireSession, type AppEnv } from '../../middleware/auth.js';
import { apiError, NO_STORE_HEADERS } from '../auth/http.js';
import { invalidRequest, issueFields, readJson } from './http.js';
import { getProduct } from './products.js';
import {
  MappingExistsError,
  MappingInputError,
  MappingNotFoundError,
  MappingNotValidatedError,
  MappingProductNotFoundError,
  MappingValidationError,
  MappingVersionConflictError,
} from './supplier-mapping.js';
import { createSupplierMappingRepository } from './supplier-mapping-repository.js';

/**
 * Maps mapping lifecycle failures to stable HTTP semantics. The response never
 * echoes SQL, stack traces, submitted values, or raw provider content; unknown
 * errors fall through to the global non-leaking 500 handler.
 */
function handleMappingError(c: Context<AppEnv>, error: unknown) {
  if (error instanceof MappingProductNotFoundError) {
    return c.json(apiError('PRODUCT_NOT_FOUND', '商品不存在'), 404, NO_STORE_HEADERS);
  }
  if (error instanceof MappingNotFoundError) {
    return c.json(apiError('MAPPING_NOT_FOUND', '供应商映射不存在'), 404, NO_STORE_HEADERS);
  }
  if (error instanceof MappingExistsError) {
    return c.json(
      apiError('MAPPING_ALREADY_EXISTS', '供应商映射已存在，请按当前草稿版本更新'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof MappingVersionConflictError) {
    return c.json(
      apiError('MAPPING_VERSION_CONFLICT', '映射草稿版本已变化，请刷新后重试'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof MappingNotValidatedError) {
    return c.json(
      apiError('MAPPING_NOT_VALIDATED', '当前草稿版本尚未通过本地校验，不能激活'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof MappingValidationError) {
    return c.json(
      {
        ...apiError('MAPPING_VALIDATION_FAILED', '映射草稿未通过本地校验'),
        issues: error.issues,
      },
      422,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof MappingInputError) {
    return c.json(apiError('INVALID_REQUEST', error.message), 400, NO_STORE_HEADERS);
  }
  throw error;
}

/**
 * Mapping management API. Reads require a valid session; every write requires
 * the `admin` role and takes its actor from the authenticated session only.
 * `validationScope`/`upstreamVerified` make local structural validation
 * impossible to confuse with upstream Yangmao verification.
 */
export function createCatalogMappingRoutes(deps: {
  db: AppDatabase;
  config: AppConfig;
}): Hono<AppEnv> {
  const { db, config } = deps;
  const router = new Hono<AppEnv>();
  const repository = createSupplierMappingRepository(db);
  const requireAdmin = [requireSession(db, config), requireRole('admin')] as const;

  function readOverview(productId: string): MappingOverviewDto {
    return {
      productId,
      validationScope: 'local',
      upstreamVerified: false,
      draft: repository.getDraft(productId),
      activeVersion: repository.getActiveVersion(productId),
      versions: repository.listVersions(productId),
    };
  }

  function requireProduct(c: Context<AppEnv>, productId: string) {
    if (getProduct(db, productId)) return null;
    return c.json(apiError('PRODUCT_NOT_FOUND', '商品不存在'), 404, NO_STORE_HEADERS);
  }

  router.get('/products/:id/mapping', requireSession(db, config), (c) => {
    const productId = c.req.param('id');
    const missing = requireProduct(c, productId);
    if (missing) return missing;

    // A product without any mapping is a valid empty state, not a fake 404.
    return c.json(readOverview(productId), 200, NO_STORE_HEADERS);
  });

  router.put('/products/:id/mapping/draft', ...requireAdmin, async (c) => {
    const productId = c.req.param('id');
    const missing = requireProduct(c, productId);
    if (missing) return missing;

    const body = await readJson(c);
    if (!body.ok) {
      return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    }

    const parsed = saveMappingDraftRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(
        invalidRequest('映射草稿参数不正确', issueFields(parsed.error)),
        400,
        NO_STORE_HEADERS,
      );
    }

    try {
      repository.saveDraft({ productId, ...parsed.data });
      // Both first create and updates fix the response on the latest overview;
      // BHB-010 can refresh from one response without a second request.
      return c.json(readOverview(productId), 200, NO_STORE_HEADERS);
    } catch (error) {
      return handleMappingError(c, error);
    }
  });

  router.post('/products/:id/mapping/validate', ...requireAdmin, async (c) => {
    const productId = c.req.param('id');
    const missing = requireProduct(c, productId);
    if (missing) return missing;

    const body = await readJson(c);
    if (!body.ok) {
      return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    }

    const parsed = validateMappingDraftRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(
        invalidRequest('映射校验参数不正确', issueFields(parsed.error)),
        400,
        NO_STORE_HEADERS,
      );
    }

    try {
      // This is BHB-007 local structural validation only; it never calls the
      // supplier, and the response keeps saying so explicitly.
      repository.validateDraft({ productId, expectedVersion: parsed.data.version });
      return c.json(readOverview(productId), 200, NO_STORE_HEADERS);
    } catch (error) {
      return handleMappingError(c, error);
    }
  });

  router.post('/products/:id/mapping/activate', ...requireAdmin, async (c) => {
    const productId = c.req.param('id');
    const missing = requireProduct(c, productId);
    if (missing) return missing;

    const body = await readJson(c);
    if (!body.ok) {
      return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    }

    const parsed = activateMappingDraftRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(
        invalidRequest('映射激活参数不正确', issueFields(parsed.error)),
        400,
        NO_STORE_HEADERS,
      );
    }

    try {
      repository.activateDraft({
        productId,
        expectedVersion: parsed.data.version,
        // Actor identity is server-side session state, never client input.
        actorAccountId: c.get('admin').id,
      });
      return c.json(readOverview(productId), 200, NO_STORE_HEADERS);
    } catch (error) {
      return handleMappingError(c, error);
    }
  });

  return router;
}
