import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './password.js';

/**
 * Security policy constants shared by the enforcement path (login/creation) and
 * the read-only console snapshot. Keeping one definition means the "生效安全
 * 策略" card can never drift from what the server actually enforces.
 */
export const LOGIN_FAILURE_WINDOW_MINUTES = 15;
export const LOGIN_FAILURE_WINDOW_MS = LOGIN_FAILURE_WINDOW_MINUTES * 60 * 1000;
export const LOGIN_FAILURE_PER_ACCOUNT = 5;
export const LOGIN_FAILURE_PER_ADDRESS = 20;

export const PASSWORD_POLICY = {
  minLength: PASSWORD_MIN_LENGTH,
  maxLength: PASSWORD_MAX_LENGTH,
  mustNotContainUsername: true,
  noLeadingTrailingWhitespace: true,
} as const;
