import { MAPPING_PROVIDERS } from '@sanchuang-dev/benefit-contracts';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { AppDatabase } from '../../db/client.js';
import { requireRole, requireSession, type AppEnv } from '../../middleware/auth.js';
import { NO_STORE_HEADERS, apiError, invalidRequest, issueFields, readJson } from '../http.js';
import { supplierConnectionSummary } from '../suppliers/connection.js';
import {
  createProduct,
  getProduct,
  listProducts,
  MAPPING_STATES,
  PRODUCT_CODE_PATTERN,
  PRODUCT_SORT_FIELDS,
  PRODUCT_SORT_ORDERS,
  PRODUCT_STATUSES,
  ProductCodeConflictError,
  ProductInputError,
  ProductNotFoundError,
  ProductVersionConflictError,
  setProductStatus,
  toProductDto,
  toProductListItemDto,
  updateProduct,
  type ProductStatus,
} from './products.js';

const MAX_CENTS = Number.MAX_SAFE_INTEGER;
const MAX_PAGE_SIZE = 100;

const codeSchema = z
  .string()
  .trim()
  .regex(PRODUCT_CODE_PATTERN, '商品编码需为 2-64 位字母、数字或 . _ -');
const nameSchema = z.string().trim().min(1, '请输入商品名称').max(80, '商品名称最长 80 个字符');
const descriptionSchema = z.string().trim().max(200, '商品描述最长 200 个字符');
const centsSchema = z.number().int('金额必须为整数分').min(0, '金额不能为负').max(MAX_CENTS);
/** Only decimal non-negative integer cents are valid on the HTTP query wire.
 * Number coercion would silently turn an empty query value into zero and accept
 * hex or exponent notation, obscuring a malformed filter as a real price.
 */
const queryCentsSchema = z
  .string()
  .regex(/^\d+$/, '金额必须为十进制非负整数分')
  .transform(Number)
  .pipe(z.number().int('金额必须为整数分').min(0).max(MAX_CENTS));
const versionSchema = z.number().int().min(1);

const createProductSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    shortDescription: descriptionSchema.optional(),
    displayPriceCents: centsSchema.nullable().optional(),
    estimatedCostCents: centsSchema.nullable().optional(),
  })
  .strict();

const updateProductSchema = z
  .object({
    version: versionSchema,
    code: codeSchema.optional(),
    name: nameSchema.optional(),
    shortDescription: descriptionSchema.optional(),
    displayPriceCents: centsSchema.nullable().optional(),
    estimatedCostCents: centsSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
    message: '至少提供一个可编辑字段',
  });

const statusActionSchema = z.object({ version: versionSchema }).strict();

/**
 * Query parameters are strings on the wire. Unknown parameters are ignored so
 * cache-busting keys do not turn a read into a 400; invalid values still fail.
 * `supplier` is restricted to the providers the mapping contract accepts, and
 * `sortBy` to the repository's static column whitelist.
 *
 * Sort direction alone is rejected: it has no meaning without a field, and
 * silently ignoring it would let a caller believe it sorted. When only `sortBy`
 * is supplied the direction defaults to ascending.
 */
const listQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
    keyword: z.string().trim().max(64).optional(),
    status: z.enum(PRODUCT_STATUSES).optional(),
    supplier: z.enum(MAPPING_PROVIDERS).optional(),
    mappingState: z.enum(MAPPING_STATES).optional(),
    displayPriceMinCents: queryCentsSchema.optional(),
    displayPriceMaxCents: queryCentsSchema.optional(),
    sortBy: z.enum(PRODUCT_SORT_FIELDS).optional(),
    sortOrder: z.enum(PRODUCT_SORT_ORDERS).optional(),
  })
  .refine((value) => value.sortOrder === undefined || value.sortBy !== undefined, {
    path: ['sortOrder'],
    message: 'sortOrder 必须与 sortBy 一起使用',
  })
  .refine(
    (value) =>
      value.displayPriceMinCents === undefined ||
      value.displayPriceMaxCents === undefined ||
      value.displayPriceMinCents <= value.displayPriceMaxCents,
    { path: ['displayPriceMinCents'], message: 'displayPriceMinCents 不能大于 displayPriceMaxCents' },
  );

/**
 * Supplier options for the catalogue filter. `configured` is a server fact about
 * whether that supplier's catalogue read is usable, so the browser can show
 * "未配置" instead of guessing from credentials it never sees.
 */
function supplierFacets(db: AppDatabase, config: AppConfig) {
  const summary = supplierConnectionSummary(db, config);
  return [
    {
      key: summary.key,
      name: summary.name,
      configured: summary.catalogRead.configured,
    },
  ];
}

/**
 * Maps catalogue domain failures to stable HTTP error codes. Unexpected errors
 * are re-thrown so the application error handler returns a non-leaking 500.
 */
function handleProductError(c: Context<AppEnv>, error: unknown) {
  if (error instanceof ProductNotFoundError) {
    return c.json(apiError('PRODUCT_NOT_FOUND', '商品不存在'), 404, NO_STORE_HEADERS);
  }
  if (error instanceof ProductCodeConflictError) {
    return c.json(apiError('PRODUCT_CODE_CONFLICT', '商品编码已存在'), 409, NO_STORE_HEADERS);
  }
  if (error instanceof ProductVersionConflictError) {
    return c.json(
      apiError('PRODUCT_VERSION_CONFLICT', '商品已被他人更新，请刷新后按最新版本重试'),
      409,
      NO_STORE_HEADERS,
    );
  }
  if (error instanceof ProductInputError) {
    return c.json(apiError('INVALID_REQUEST', error.message), 400, NO_STORE_HEADERS);
  }
  throw error;
}

/**
 * Internal product catalogue API. Reads require a valid session; every write
 * additionally requires the `admin` role and is audited server-side. The
 * browser UI (BHB-004) is a separate slice; nothing here creates supplier
 * mappings or grants.
 */
export function createCatalogRoutes(deps: { db: AppDatabase; config: AppConfig }): Hono<AppEnv> {
  const { db, config } = deps;
  const router = new Hono<AppEnv>();
  const requireAdmin = [requireSession(db, config), requireRole('admin')] as const;

  router.get('/products', requireSession(db, config), (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(invalidRequest('查询参数不正确', issueFields(parsed.error)), 400, NO_STORE_HEADERS);
    }

    const keyword = parsed.data.keyword || undefined;
    const result = listProducts(db, {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      keyword,
      status: parsed.data.status,
      supplier: parsed.data.supplier,
      mappingState: parsed.data.mappingState,
      displayPriceMinCents: parsed.data.displayPriceMinCents,
      displayPriceMaxCents: parsed.data.displayPriceMaxCents,
      sortBy: parsed.data.sortBy,
      sortOrder: parsed.data.sortOrder,
    });

    return c.json(
      {
        // List rows carry a mapping read projection; the detail/write DTOs do not.
        products: result.products.map(toProductListItemDto),
        suppliers: supplierFacets(db, config),
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        total: result.total,
      },
      200,
      NO_STORE_HEADERS,
    );
  });

  router.get('/products/:id', requireSession(db, config), (c) => {
    const product = getProduct(db, c.req.param('id'));
    if (!product) {
      return c.json(apiError('PRODUCT_NOT_FOUND', '商品不存在'), 404, NO_STORE_HEADERS);
    }
    return c.json({ product: toProductDto(product) }, 200, NO_STORE_HEADERS);
  });

  router.post('/products', ...requireAdmin, async (c) => {
    const body = await readJson(c);
    if (!body.ok) {
      return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    }

    const parsed = createProductSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(invalidRequest('商品参数不正确', issueFields(parsed.error)), 400, NO_STORE_HEADERS);
    }

    try {
      const product = createProduct(db, {
        ...parsed.data,
        actorAccountId: c.get('admin').id,
      });
      return c.json({ product: toProductDto(product) }, 201, NO_STORE_HEADERS);
    } catch (error) {
      return handleProductError(c, error);
    }
  });

  router.patch('/products/:id', ...requireAdmin, async (c) => {
    const body = await readJson(c);
    if (!body.ok) {
      return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    }

    const parsed = updateProductSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(invalidRequest('商品参数不正确', issueFields(parsed.error)), 400, NO_STORE_HEADERS);
    }

    const { version, ...changes } = parsed.data;
    try {
      const product = updateProduct(db, c.req.param('id'), version, changes, c.get('admin').id);
      return c.json({ product: toProductDto(product) }, 200, NO_STORE_HEADERS);
    } catch (error) {
      return handleProductError(c, error);
    }
  });

  async function changeStatus(c: Context<AppEnv>, id: string, status: ProductStatus) {
    const body = await readJson(c);
    if (!body.ok) {
      return c.json(invalidRequest('请求格式不正确'), 400, NO_STORE_HEADERS);
    }

    const parsed = statusActionSchema.safeParse(body.value);
    if (!parsed.success) {
      return c.json(invalidRequest('商品参数不正确', issueFields(parsed.error)), 400, NO_STORE_HEADERS);
    }

    try {
      const product = setProductStatus(db, id, status, parsed.data.version, c.get('admin').id);
      return c.json({ product: toProductDto(product) }, 200, NO_STORE_HEADERS);
    } catch (error) {
      return handleProductError(c, error);
    }
  }

  router.post('/products/:id/enable', ...requireAdmin, (c) => changeStatus(c, c.req.param('id'), 'active'));
  router.post('/products/:id/disable', ...requireAdmin, (c) => changeStatus(c, c.req.param('id'), 'disabled'));

  return router;
}
