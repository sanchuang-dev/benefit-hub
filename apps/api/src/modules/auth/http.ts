export interface ApiErrorBody {
  error: string;
  message: string;
}

/**
 * Stable machine-readable error code plus a short user-facing message. Error
 * bodies never echo submitted credentials or reveal whether an account exists.
 */
export function apiError(code: string, message: string): ApiErrorBody {
  return { error: code, message };
}

export const NO_STORE_HEADERS = { 'cache-control': 'no-store' } as const;
