import { describe, expect, it } from 'vitest';
import {
  buildOpenV1StringToSign,
  buildPurchaseCheckSignedFields,
  createOpenV1Signature,
  type OpenV1SigningFields,
} from '../src/open-v1-signature.js';

/**
 * Fixed vectors were derived independently of this implementation with
 * OpenSSL, so a bug in the signing code cannot make the expectation agree:
 *
 *   printf '%s' 'appKey=fixture-app-key&nonce=abc123def456&phone=13800138000&timestamp=1793059200000&appSecret=test-secret-do-not-use' \
 *     | openssl dgst -sha256 | tr 'a-f' 'A-F'
 *   printf '%s' 'a=x&b=3&appSecret=test-secret-do-not-use' \
 *     | openssl dgst -sha256 | tr 'a-f' 'A-F'
 *   printf '%s' 'a=中&appSecret=test-secret-do-not-use' \
 *     | openssl dgst -sha256 | tr 'a-f' 'A-F'
 *
 * 1793059200000 is 2026-10-27T00:00:00Z in milliseconds. The secret is a
 * public test fixture, not a vendor credential.
 */
const FIXED_TIMESTAMP = '1793059200000';
const FIXTURE_SECRET = 'test-secret-do-not-use';
const APP_KEY = 'fixture-app-key';
const NONCE = 'abc123def456';
const PHONE = '13800138000';

const PURCHASE_CHECK_STRING =
  'appKey=fixture-app-key&nonce=abc123def456&phone=13800138000' +
  '&timestamp=1793059200000&appSecret=test-secret-do-not-use';
const PURCHASE_CHECK_VECTOR =
  '39A5CD69E106D904F7F7E8888AB2427BF1DFDD1F027060D0822AE01CF13B3B58';
const NUMERIC_STRING = 'a=x&b=3&appSecret=test-secret-do-not-use';
const NUMERIC_VECTOR = '94439F9E087C8958F4A48D65C02E6AFD9AB12193DDBE34159C217E9344D9A9DB';
const UTF8_STRING = 'a=中&appSecret=test-secret-do-not-use';
const UTF8_VECTOR = '9C05D325B1D79171B3676758C2C67D98144D75C9DE5FA000E4B9111E265D9338';

describe('A/B/C (X-Sign) signing', () => {
  it('builds the documented string-to-sign and an uppercase hex SHA-256', () => {
    const fields = buildPurchaseCheckSignedFields(
      { appKey: APP_KEY, timestamp: FIXED_TIMESTAMP, nonce: NONCE },
      PHONE,
    );

    expect(buildOpenV1StringToSign(fields, FIXTURE_SECRET)).toBe(PURCHASE_CHECK_STRING);
    const signature = createOpenV1Signature(fields, FIXTURE_SECRET);
    expect(signature).toBe(PURCHASE_CHECK_VECTOR);
    expect(signature).toMatch(/^[0-9A-F]{64}$/);
    expect(signature).toHaveLength(64);
    // 64 hex chars decode as 48 base64 bytes; a D-style X-Signature would
    // instead be 44 Base64 chars carrying a 32-byte HMAC.
    expect(Buffer.from(signature, 'base64')).toHaveLength(48);
  });

  it('sorts fields by name regardless of insertion order', () => {
    const ascending = buildOpenV1StringToSign(
      { appKey: APP_KEY, nonce: NONCE, phone: PHONE, timestamp: FIXED_TIMESTAMP },
      FIXTURE_SECRET,
    );
    const shuffled = buildOpenV1StringToSign(
      { timestamp: FIXED_TIMESTAMP, phone: PHONE, nonce: NONCE, appKey: APP_KEY },
      FIXTURE_SECRET,
    );

    expect(shuffled).toBe(ascending);
    expect(ascending).toBe(PURCHASE_CHECK_STRING);
  });

  it('omits empty string fields exactly like the vendor algorithm', () => {
    const withEmpty = buildOpenV1StringToSign(
      {
        timestamp: FIXED_TIMESTAMP,
        appKey: APP_KEY,
        nonce: NONCE,
        phone: PHONE,
        refCode: '',
      },
      FIXTURE_SECRET,
    );

    expect(withEmpty).toBe(PURCHASE_CHECK_STRING);
    expect(withEmpty).not.toContain('refCode');
  });

  it('stringifies integer values and treats the string form identically', () => {
    const numeric = { b: 3, a: 'x' } as const;
    expect(buildOpenV1StringToSign(numeric, FIXTURE_SECRET)).toBe(NUMERIC_STRING);
    expect(createOpenV1Signature(numeric, FIXTURE_SECRET)).toBe(NUMERIC_VECTOR);
    expect(buildOpenV1StringToSign({ b: '3', a: 'x' }, FIXTURE_SECRET)).toBe(NUMERIC_STRING);
  });

  it('keeps string values byte-identical: no trimming, encoding or case changes', () => {
    const canonical = buildOpenV1StringToSign(
      { a: 'A b&c=d/中', b: 'x' },
      FIXTURE_SECRET,
    );

    expect(canonical).toBe('a=A b&c=d/中&b=x&appSecret=test-secret-do-not-use');
  });

  it('hashes UTF-8 bytes, matching the vendor UTF-8 contract', () => {
    expect(buildOpenV1StringToSign({ a: '中' }, FIXTURE_SECRET)).toBe(UTF8_STRING);
    expect(createOpenV1Signature({ a: '中' }, FIXTURE_SECRET)).toBe(UTF8_VECTOR);
  });

  it('signs only the four purchase-check fields, never the whole request body', () => {
    const fields = buildPurchaseCheckSignedFields(
      { appKey: APP_KEY, timestamp: FIXED_TIMESTAMP, nonce: NONCE },
      PHONE,
    );

    expect(Object.keys(fields).sort()).toEqual(['appKey', 'nonce', 'phone', 'timestamp']);
    expect(buildOpenV1StringToSign(fields, FIXTURE_SECRET)).toBe(PURCHASE_CHECK_STRING);
  });

  it.each([
    { name: 'nonce', fields: { appKey: APP_KEY, timestamp: FIXED_TIMESTAMP, nonce: 'abc123def457', phone: PHONE } },
    { name: 'phone', fields: { appKey: APP_KEY, timestamp: FIXED_TIMESTAMP, nonce: NONCE, phone: '13800138001' } },
    { name: 'timestamp', fields: { appKey: APP_KEY, timestamp: '1793059200001', nonce: NONCE, phone: PHONE } },
  ])('changes when $name changes', ({ fields }) => {
    expect(createOpenV1Signature(fields, FIXTURE_SECRET)).not.toBe(PURCHASE_CHECK_VECTOR);
  });

  it.each<{ name: string; fields: Record<string, unknown> }>([
    { name: 'non-integer number', fields: { packCount: 1.5 } },
    { name: 'unsafe integer', fields: { packCount: Number.MAX_SAFE_INTEGER + 1 } },
    { name: 'NaN', fields: { packCount: Number.NaN } },
    { name: 'boolean value', fields: { giftUnclaimed: true } },
    { name: 'reserved appSecret field', fields: { appSecret: 'x' } },
    { name: 'reserved sign field', fields: { sign: 'x' } },
    { name: 'reserved signature field', fields: { SIGNATURE: 'x' } },
    { name: 'invalid field name', fields: { 'a&b': 'x' } },
    { name: 'empty field name', fields: { '': 'x' } },
    { name: 'no participating fields', fields: {} },
  ])('rejects $name instead of guessing a canonical string', ({ fields }) => {
    expect(() =>
      buildOpenV1StringToSign(fields as OpenV1SigningFields, FIXTURE_SECRET),
    ).toThrowError(TypeError);
  });

  it('rejects an empty AppSecret rather than signing with a blank key', () => {
    expect(() =>
      buildOpenV1StringToSign(
        buildPurchaseCheckSignedFields(
          { appKey: APP_KEY, timestamp: FIXED_TIMESTAMP, nonce: NONCE },
          PHONE,
        ),
        '',
      ),
    ).toThrowError(TypeError);
  });
});
