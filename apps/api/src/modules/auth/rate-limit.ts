export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface FailureRateLimiter {
  check(key: string): RateLimitDecision;
  recordFailure(key: string): void;
  reset(key: string): void;
  size(): number;
}

export interface FailureRateLimiterOptions {
  maxFailures: number;
  windowMs: number;
  now?: () => number;
}

const MAX_TRACKED_KEYS = 5_000;

/**
 * In-memory failure counter for the single-instance first phase. Limits are per
 * key (normalized account, and separately the client address). State is not
 * shared across restarts; a restart therefore only shortens a lockout, it never
 * grants a persisted credential.
 */
export function createFailureRateLimiter(options: FailureRateLimiterOptions): FailureRateLimiter {
  const now = options.now ?? Date.now;
  const failures = new Map<string, number[]>();

  const activeTimestamps = (key: string, at: number): number[] => {
    const timestamps = failures.get(key);
    if (!timestamps) return [];
    const cutoff = at - options.windowMs;
    const active = timestamps.filter((timestamp) => timestamp > cutoff);
    if (active.length === 0) failures.delete(key);
    else if (active.length !== timestamps.length) failures.set(key, active);
    return active;
  };

  const pruneIfLarge = (at: number): void => {
    if (failures.size <= MAX_TRACKED_KEYS) return;
    // Deleting entries while iterating a Map is well-defined.
    for (const key of failures.keys()) activeTimestamps(key, at);
  };

  return {
    check(key) {
      const at = now();
      const active = activeTimestamps(key, at);
      if (active.length < options.maxFailures) return { allowed: true, retryAfterSeconds: 0 };

      const oldest = active[0] as number;
      const retryAfterMs = Math.max(oldest + options.windowMs - at, 0);
      return { allowed: false, retryAfterSeconds: Math.max(Math.ceil(retryAfterMs / 1000), 1) };
    },

    recordFailure(key) {
      const at = now();
      pruneIfLarge(at);
      const active = activeTimestamps(key, at);
      active.push(at);
      failures.set(key, active);
    },

    reset(key) {
      failures.delete(key);
    },

    size() {
      return failures.size;
    },
  };
}
