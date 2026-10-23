import { describe, expect, it } from 'vitest';
import { createFailureRateLimiter } from '../src/modules/auth/rate-limit.js';

describe('login failure limiter cardinality', () => {
  it('never grows past the fixed key cap even with a flood of distinct account names', () => {
    let now = 10_000;
    const limiter = createFailureRateLimiter({
      maxFailures: 2,
      windowMs: 1_000,
      now: () => now,
    });

    for (let i = 0; i < 5_000; i += 1) {
      const key = `account:unknown-${i}`;
      expect(limiter.check(key).allowed).toBe(true);
      limiter.recordFailure(key);
    }
    expect(limiter.size()).toBe(5_000);

    expect(limiter.check('account:new').allowed).toBe(false);
    limiter.recordFailure('account:new');
    expect(limiter.size()).toBe(5_000);

    // The limit remains valid for tracked accounts and stale entries can expire.
    limiter.recordFailure('account:unknown-0');
    expect(limiter.check('account:unknown-0').allowed).toBe(false);

    now += 1_001;
    expect(limiter.check('account:new').allowed).toBe(true);
    expect(limiter.size()).toBe(0);
    limiter.recordFailure('account:new');
    expect(limiter.size()).toBe(1);
  });
});
