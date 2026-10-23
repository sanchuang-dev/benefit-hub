import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing uses scrypt from the Node.js standard library: it is a
 * memory-hard KDF with no extra native module in the runtime image. The
 * architecture note prefers Argon2id; scrypt is the documented interim choice
 * and the stored format is self-describing so a future migration can re-hash on
 * successful login.
 */
const PARAMS = { N: 1 << 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEM = 96 * 1024 * 1024;
const PREFIX = 'scrypt';

// Bounds keep a corrupted row from turning login into a memory/CPU bomb.
const LIMITS = { maxN: 1 << 20, maxR: 16, maxP: 4 } as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

function scryptAsync(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_LENGTH, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return scryptAsync(password, salt, { ...params, maxmem: MAX_MEM });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await derive(password, salt, PARAMS);
  return [
    PREFIX,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;

  const [rawN, rawR, rawP] = parts.slice(1, 4) as [string, string, string];
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 1024 || N > LIMITS.maxN || r < 1 || r > LIMITS.maxR || p < 1 || p > LIMITS.maxP) return null;
  // scrypt requires N to be a power of two.
  if ((N & (N - 1)) !== 0) return null;

  const salt = Buffer.from(parts[4] as string, 'base64url');
  const hash = Buffer.from(parts[5] as string, 'base64url');
  if (salt.length === 0 || hash.length === 0) return null;
  return { N, r, p, salt, hash };
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (!parsed) return false;

  const derived = await derive(password, parsed.salt, parsed);
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies a password against `encoded`, or against a throwaway hash when the
 * account does not exist. This keeps the unauthenticated response time roughly
 * constant so a missing account cannot be distinguished by timing.
 */
export async function verifyPasswordOrDummy(password: string, encoded: string | null): Promise<boolean> {
  if (encoded) return verifyPassword(password, encoded);

  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
  return false;
}

/**
 * Creation/reset policy for the only privileged credential in this slice.
 * Returns `null` when acceptable, otherwise a user-facing reason.
 */
export function checkPasswordPolicy(password: string, username: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少需要 ${PASSWORD_MIN_LENGTH} 个字符`;
  if (password.length > PASSWORD_MAX_LENGTH) return `密码不能超过 ${PASSWORD_MAX_LENGTH} 个字符`;
  if (password.trim().length !== password.length) return '密码首尾不能包含空白字符';
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return '密码不能包含账号名';
  }
  return null;
}
