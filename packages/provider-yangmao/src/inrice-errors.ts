/**
 * Stable error codes for the Yangmao D (`/api/open/inrice/v1`) client.
 *
 * The public Error.message is always stable. A short, control-character-free
 * supplier business message may be attached separately as `vendorMessage`
 * for an explicitly privileged operator surface; it must never be logged,
 * persisted, or exposed through ordinary machine APIs.
 */
export const YANGMAO_INRICE_ERROR_CODES = [
  'YANGMAO_INRICE_CONFIG_INVALID',
  'YANGMAO_INRICE_PRODUCT_CODE_INVALID',
  'YANGMAO_INRICE_ORDER_QUERY_INVALID',
  'YANGMAO_INRICE_DISPATCH_INPUT_INVALID',
  'YANGMAO_INRICE_ORDER_NOT_FOUND',
  'YANGMAO_INRICE_AUTH_FAILED',
  'YANGMAO_INRICE_FORBIDDEN',
  'YANGMAO_INRICE_HTTP_ERROR',
  'YANGMAO_INRICE_BUSINESS_FAILED',
  'YANGMAO_INRICE_RESPONSE_INVALID',
  'YANGMAO_INRICE_TIMEOUT',
  'YANGMAO_INRICE_CANCELLED',
  'YANGMAO_INRICE_TRANSPORT_FAILED',
] as const;

export type YangmaoInriceErrorCode = (typeof YANGMAO_INRICE_ERROR_CODES)[number];

const STABLE_MESSAGES: Record<YangmaoInriceErrorCode, string> = {
  YANGMAO_INRICE_CONFIG_INVALID: '供应商客户端配置无效',
  YANGMAO_INRICE_PRODUCT_CODE_INVALID: '商品编码无效',
  YANGMAO_INRICE_ORDER_QUERY_INVALID: '订单查单条件无效',
  YANGMAO_INRICE_DISPATCH_INPUT_INVALID: '权益派发参数无效',
  YANGMAO_INRICE_ORDER_NOT_FOUND: '未找到供应商订单',
  YANGMAO_INRICE_AUTH_FAILED: '供应商鉴权失败',
  YANGMAO_INRICE_FORBIDDEN: '供应商拒绝访问',
  YANGMAO_INRICE_HTTP_ERROR: '供应商 HTTP 响应异常',
  YANGMAO_INRICE_BUSINESS_FAILED: '供应商业务处理失败',
  YANGMAO_INRICE_RESPONSE_INVALID: '供应商响应格式不符合约定',
  YANGMAO_INRICE_TIMEOUT: '供应商请求超时',
  YANGMAO_INRICE_CANCELLED: '供应商请求已取消',
  YANGMAO_INRICE_TRANSPORT_FAILED: '供应商网络请求失败',
};

export interface YangmaoInriceErrorDetails {
  /** Present only when the HTTP layer itself rejected the request. */
  httpStatus?: number;
  /** Present only when a well-formed response carried a non-zero `code`. */
  vendorCode?: number;
  /**
   * Sanitized supplier business message for privileged operator diagnostics.
   * Never contains credentials/signatures and is not part of Error.message.
   */
  vendorMessage?: string;
}

export class YangmaoInriceError extends Error {
  readonly code: YangmaoInriceErrorCode;
  readonly httpStatus?: number;
  readonly vendorCode?: number;
  readonly vendorMessage?: string;

  constructor(code: YangmaoInriceErrorCode, details: YangmaoInriceErrorDetails = {}) {
    super(STABLE_MESSAGES[code]);
    this.name = 'YangmaoInriceError';
    this.code = code;
    if (details.httpStatus !== undefined) this.httpStatus = details.httpStatus;
    if (details.vendorCode !== undefined) this.vendorCode = details.vendorCode;
    if (details.vendorMessage !== undefined) this.vendorMessage = details.vendorMessage;
  }
}
