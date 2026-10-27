import { describe, expect, it } from 'vitest';
import {
  buildInriceStringToSign,
  createInriceSignature,
  INRICE_LIST_SIGNED_BODY,
} from '../src/inrice-signature.js';

/**
 * Fixed vectors were derived independently of this implementation with
 * OpenSSL, so a bug in the signing code cannot make the expectation agree:
 *
 *   printf '1793059200000\n{}' \
 *     | openssl dgst -sha256 -hmac 'test-secret-do-not-use' -binary \
 *     | openssl base64 -A
 *
 * 1793059200000 is 2026-10-27T00:00:00Z in milliseconds. The secret is a
 * public test fixture, not a vendor credential.
 */
const FIXED_TIMESTAMP = '1793059200000';
const FIXTURE_SECRET = 'test-secret-do-not-use';
const LIST_VECTOR = 'WGOyr6kPjYGHpUQA7bSFkUA3oOMmxjKlWwxbj5SxsW4=';
const NON_EMPTY_BODY_VECTOR = 'eOVy6IqBgy5DvtxzeXmkfiYT1/RjiR+Ll3H+HvM/lrk=';

describe('D-mode (X-Signature) signing', () => {
  it('signs the list payload as timestamp + newline + compact empty JSON', () => {
    expect(buildInriceStringToSign(FIXED_TIMESTAMP, INRICE_LIST_SIGNED_BODY)).toBe(
      '1793059200000\n{}',
    );
    expect(createInriceSignature(FIXTURE_SECRET, FIXED_TIMESTAMP, INRICE_LIST_SIGNED_BODY)).toBe(
      LIST_VECTOR,
    );
  });

  it('signs a non-empty compact payload byte-for-byte', () => {
    const compactJson = '{"productCode":"SKU-1"}';
    expect(buildInriceStringToSign(FIXED_TIMESTAMP, compactJson)).toBe(
      '1793059200000\n{"productCode":"SKU-1"}',
    );
    expect(createInriceSignature(FIXTURE_SECRET, FIXED_TIMESTAMP, compactJson)).toBe(
      NON_EMPTY_BODY_VECTOR,
    );
  });

  it('produces Base64 HMAC output rather than the A/B/C uppercase hex X-Sign', () => {
    const signature = createInriceSignature(FIXTURE_SECRET, FIXED_TIMESTAMP, '{}');

    expect(signature).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(signature).not.toMatch(/^[0-9A-F]{64}$/);
    expect(Buffer.from(signature, 'base64')).toHaveLength(32);
  });

  it('changes with the timestamp even for the same payload', () => {
    const other = createInriceSignature(FIXTURE_SECRET, '1793059200001', '{}');
    expect(other).not.toBe(LIST_VECTOR);
  });
});
