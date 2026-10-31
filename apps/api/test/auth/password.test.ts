import { describe, expect, it } from 'vitest';
import {
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
  verifyPasswordOrDummy,
} from '../../src/modules/auth/password.js';

describe('password hashing', () => {
  it('stores a self-describing scrypt hash that verifies the original password only', async () => {
    const digest = await hashPassword('correct-horse-battery');
    expect(digest.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(digest).not.toContain('correct-horse-battery');

    expect(await verifyPassword('correct-horse-battery', digest)).toBe(true);
    expect(await verifyPassword('correct-horse-battery!', digest)).toBe(false);
    expect(digest.split('$')).toHaveLength(6);
  });

  it('uses a unique salt per hash', async () => {
    const [first, second] = await Promise.all([
      hashPassword('same-password-value'),
      hashPassword('same-password-value'),
    ]);
    expect(first).not.toBe(second);
    expect(await verifyPassword('same-password-value', first)).toBe(true);
    expect(await verifyPassword('same-password-value', second)).toBe(true);
  });

  it('treats malformed or unsupported stored hashes as a failed verification', async () => {
    for (const stored of ['', 'plaintext', 'bcrypt$12$abc', 'scrypt$3000$8$1$abcd$efgh', 'scrypt$x$8$1$a$b']) {
      expect(await verifyPassword('whatever-password', stored)).toBe(false);
    }
  });

  it('runs the dummy verification path for unknown accounts and still fails', async () => {
    expect(await verifyPasswordOrDummy('anything-at-all', null)).toBe(false);
    const digest = await hashPassword('known-password-123');
    expect(await verifyPasswordOrDummy('known-password-123', digest)).toBe(true);
  });

  it('applies the administrator password policy', () => {
    expect(checkPasswordPolicy('short-pass', 'ops.admin')).toContain('至少');
    expect(checkPasswordPolicy('ops.admin-password', 'ops.admin')).toContain('账号名');
    expect(checkPasswordPolicy(' leading-space-pass', 'ops.admin')).toContain('空白');
    expect(checkPasswordPolicy('a'.repeat(257), 'ops.admin')).toContain('不能超过');
    expect(checkPasswordPolicy('valid-password-123', 'ops.admin')).toBeNull();
  });
});
