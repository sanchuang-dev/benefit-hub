/**
 * Public entry for `@sanchuang-dev/provider-yangmao`.
 *
 * This package is server-only: it signs requests with the AppSecret. Never
 * import it from `apps/admin` or any browser bundle.
 */
export {
  YANGMAO_INRICE_ERROR_CODES,
  YangmaoInriceError,
  type YangmaoInriceErrorCode,
  type YangmaoInriceErrorDetails,
} from './inrice-errors.js';
export {
  buildInriceProductDetailSignedBody,
  buildInriceStringToSign,
  createInriceSignature,
  INRICE_LIST_SIGNED_BODY,
  INRICE_PRODUCTS_PATH,
  INRICE_PRODUCT_DETAIL_PATH,
} from './inrice-signature.js';
export type {
  YangmaoInriceCatalog,
  YangmaoInriceProduct,
} from './inrice-products.js';
export type {
  YangmaoInriceProductDetail,
} from './inrice-product-detail.js';
export {
  createYangmaoInriceCatalogClient,
  DEFAULT_INRICE_TIMEOUT_MS,
  type YangmaoInriceCatalogClientOptions,
  type YangmaoInriceCatalogReader,
  type YangmaoInriceReadOptions,
  type YangmaoInriceListOptions,
  type YangmaoInriceTransport,
} from './inrice-catalog-client.js';
