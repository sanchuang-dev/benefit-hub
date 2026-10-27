/**
 * Stable error codes for the Yangmao A/B/C (`/open/v1`) client.
 *
 * These are deliberately separate from `YANGMAO_INRICE_*` (D): the two signing
 * systems and endpoints must not be handled interchangeably. The message is
 * always a fixed sentence: supplier messages, phone numbers, response bodies,
 * credentials and signatures are never copied into a thrown error (and
 * therefore never into a log line).
 */
export const YANGMAO_OPEN_V1_ERROR_CODES = [
  'YANGMAO_OPEN_V1_CONFIG_INVALID',
  'YANGMAO_OPEN_V1_PHONE_INVALID',
  'YANGMAO_OPEN_V1_AUTH_FAILED',
  'YANGMAO_OPEN_V1_FORBIDDEN',
  'YANGMAO_OPEN_V1_HTTP_ERROR',
  'YANGMAO_OPEN_V1_BUSINESS_FAILED',
  'YANGMAO_OPEN_V1_RESPONSE_INVALID',
  'YANGMAO_OPEN_V1_TIMEOUT',
  'YANGMAO_OPEN_V1_CANCELLED',
  'YANGMAO_OPEN_V1_TRANSPORT_FAILED',
] as const;

export type YangmaoOpenV1ErrorCode = (typeof YANGMAO_OPEN_V1_ERROR_CODES)[number];

const STABLE_MESSAGES: Record<YangmaoOpenV1ErrorCode, string> = {
  YANGMAO_OPEN_V1_CONFIG_INVALID: '供应商客户端配置无效',
  YANGMAO_OPEN_V1_PHONE_INVALID: '手机号格式无效',
  YANGMAO_OPEN_V1_AUTH_FAILED: '供应商鉴权失败',
  YANGMAO_OPEN_V1_FORBIDDEN: '供应商拒绝访问',
  YANGMAO_OPEN_V1_HTTP_ERROR: '供应商 HTTP 响应异常',
  YANGMAO_OPEN_V1_BUSINESS_FAILED: '供应商业务处理失败',
  YANGMAO_OPEN_V1_RESPONSE_INVALID: '供应商响应格式不符合约定',
  YANGMAO_OPEN_V1_TIMEOUT: '供应商请求超时',
  YANGMAO_OPEN_V1_CANCELLED: '供应商请求已取消',
  YANGMAO_OPEN_V1_TRANSPORT_FAILED: '供应商网络请求失败',
};

export interface YangmaoOpenV1ErrorDetails {
  /** Present only when the HTTP layer itself rejected the request. */
  httpStatus?: number;
  /** Present only when a well-formed response carried a non-zero `code`. */
  vendorCode?: number;
}

export class YangmaoOpenV1Error extends Error {
  readonly code: YangmaoOpenV1ErrorCode;
  readonly httpStatus?: number;
  readonly vendorCode?: number;

  constructor(code: YangmaoOpenV1ErrorCode, details: YangmaoOpenV1ErrorDetails = {}) {
    super(STABLE_MESSAGES[code]);
    this.name = 'YangmaoOpenV1Error';
    this.code = code;
    if (details.httpStatus !== undefined) this.httpStatus = details.httpStatus;
    if (details.vendorCode !== undefined) this.vendorCode = details.vendorCode;
  }
}
