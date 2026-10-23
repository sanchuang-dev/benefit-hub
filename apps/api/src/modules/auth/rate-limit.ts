export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface FailureRateLimiter {
  check(key: string): RateLimitDecision;
  recordFailure(key: string): void;
  reset(key: string): void;
  /** Atomically reserve a KDF slot until the attempt finishes. */
  reserve(key: string): RateLimitDecision;
  /** Releases a reserved slot and records a failure only when credentials were rejected. */
  settle(key: string, failed: boolean): void;
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
  const inFlight = new Map<string, number>();

  const activeTimestamps = (key: string, at: number): number[] => {
    const timestamps = failures.get(key);
    if (!timestamps) return [];
    const cutoff = at - options.windowMs;
    const active = timestamps.filter((timestamp) => timestamp > cutoff);
    if (active.length === 0) failures.delete(key);
    else if (active.length !== timestamps.length) failures.set(key, active);
    return active;
  };

  const pruneExpiredIfFull = (at: number): void => {
    if (failures.size + inFlight.size < MAX_TRACKED_KEYS) return;
    // A wave of distinct usernames must not grow the limiter without bound.
    for (const key of failures.keys()) activeTimestamps(key, at);
  };

  const atCapacityForNewKey = (key: string, at: number): boolean => {
    if (failures.has(key) || inFlight.has(key)) return false;
    pruneExpiredIfFull(at);
    // A conservative cap includes outstanding attempts so new usernames cannot
    // allocate unbounded keys while their scrypt verifications are pending.
    return failures.size + inFlight.size >= MAX_TRACKED_KEYS;
  };

  return {
    check(key) {
      const at = now();
      if (atCapacityForNewKey(key, at)) {
        // Fail closed rather than evicting another account's active lockout.
        return { allowed: false, retryAfterSeconds: Math.max(Math.ceil(options.windowMs / 1000), 1) };
      }
      const active = activeTimestamps(key, at);
      const outstanding = inFlight.get(key) ?? 0;
      if (active.length + outstanding < options.maxFailures) {
        return { allowed: true, retryAfterSeconds: 0 };
      }
      // A full set of in-flight slots can become available before the failure
      // window expires; we should not promise a 15-minute lockout in that case.
      if (active.length < options.maxFailures) {
        return { allowed: false, retryAfterSeconds: 1 };
      }
      const oldest = active[0] as number;
      const retryAfterMs = Math.max(oldest + options.windowMs - at, 0);
      return { allowed: false, retryAfterSeconds: Math.max(Math.ceil(retryAfterMs / 1000), 1) };
    },

    recordFailure(key) {
      const at = now();
      if (atCapacityForNewKey(key, at)) return;
      const active = activeTimestamps(key, at);
      active.push(at);
      failures.set(key, active);
    },

    reset(key) {
      failures.delete(key);
    },

    reserve(key) {
      // No await between the capacity check and increment: concurrent login
      // handlers cannot all pass an otherwise available slot.
      const decision = this.check(key);
      if (decision.allowed) inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
      return decision;
    },

    settle(key, failed) {
      const active = inFlight.get(key);
      if (active === undefined || active <= 0) {
        throw new Error('Cannot settle an unreserved login attempt');
      }
      if (active === 1) inFlight.delete(key);
      else inFlight.set(key, active - 1);
      if (failed) this.recordFailure(key);
    },

    size() {
      return failures.size;
    },
  };
}
