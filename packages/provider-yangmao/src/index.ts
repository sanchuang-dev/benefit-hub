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
  buildInriceOrderQuerySignedBody,
  buildInriceProductDetailSignedBody,
  buildInriceStringToSign,
  createInriceSignature,
  INRICE_LIST_SIGNED_BODY,
  INRICE_ORDER_QUERY_PATH,
  INRICE_PRODUCTS_PATH,
  INRICE_PRODUCT_DETAIL_PATH,
  type InriceOrderQuerySignedInput,
} from './inrice-signature.js';
export type {
  YangmaoInriceCatalog,
  YangmaoInriceProduct,
} from './inrice-products.js';
export type {
  YangmaoInriceProductDetail,
} from './inrice-product-detail.js';
export {
  normalizeInriceOrderQueryInput,
  parseInriceOrderQueryData,
  type YangmaoInriceOrderData,
  type YangmaoInriceOrderQueryInput,
  type YangmaoInriceOrderQueryResult,
} from './inrice-order-query.js';
export {
  createYangmaoInriceCatalogClient,
  DEFAULT_INRICE_TIMEOUT_MS,
  type YangmaoInriceCatalogClientOptions,
  type YangmaoInriceCatalogReader,
  type YangmaoInriceOrderReader,
  type YangmaoInriceReadOptions,
  type YangmaoInriceListOptions,
  type YangmaoInriceTransport,
} from './inrice-catalog-client.js';
export {
  YANGMAO_OPEN_V1_ERROR_CODES,
  YangmaoOpenV1Error,
  type YangmaoOpenV1ErrorCode,
  type YangmaoOpenV1ErrorDetails,
} from './open-v1-errors.js';
export {
  buildDirectTopupSignedFields,
  buildGiftVoucherSignedFields,
  buildOpenV1StringToSign,
  buildPrepaidOrderSignedFields,
  buildPurchaseCheckSignedFields,
  createOpenV1Signature,
  OPEN_V1_DIRECT_TOPUP_PATH,
  OPEN_V1_GIFT_VOUCHER_PATH,
  OPEN_V1_PREPAID_ORDER_PATH,
  OPEN_V1_PREPAID_ORDER_QUERY_PATH,
  OPEN_V1_PURCHASE_CHECK_PATH,
  type OpenV1RequestIdentity,
  type OpenV1SigningFields,
  type OpenV1SigningValue,
} from './open-v1-signature.js';
export type {
  YangmaoOpenV1PurchaseEligibility,
} from './open-v1-purchase-check.js';
export {
  createYangmaoOpenV1Client,
  DEFAULT_OPEN_V1_TIMEOUT_MS,
  GIFT_VOUCHER_PACK_COUNT_MAX,
  GIFT_VOUCHER_PACK_COUNT_MIN,
  type YangmaoOpenV1ClientOptions,
  type YangmaoOpenV1PurchaseReader,
  type YangmaoOpenV1PrepaidOrderLookup,
  type YangmaoOpenV1PrepaidOrderResult,
  type YangmaoOpenV1CreatePrepaidOrderInput,
  type YangmaoOpenV1DirectTopupInput,
  type YangmaoOpenV1DirectTopupResult,
  type YangmaoOpenV1GiftVoucherLookup,
  type YangmaoOpenV1GiftVoucherResult,
  type YangmaoOpenV1CreateGiftVoucherInput,
  type YangmaoOpenV1ReadOptions,
  type YangmaoOpenV1Transport,
} from './open-v1-client.js';
