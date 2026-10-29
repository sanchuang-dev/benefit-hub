import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { claimUrlSchema } from '@sanchuang-dev/benefit-contracts';

/**
 * Protected storage for the two sensitive C-mode issuance results: the supplier
 * voucher code and the H5 claim link (which may carry recipient-specific
 * parameters). C mode needs the code to recover pack/quota state later, so it
 * cannot be discarded like the A-mode link; it must never be stored or logged in
 * plaintext.
 *
 * The envelope is AES-256-GCM under a subkey derived from the existing supplier
 * master key. The AAD is distinct from the credential envelope so a ciphertext
 * from one purpose can never be decrypted as the other.
 */
const AAD = Buffer.from('benefit-hub:gift-voucher:v1');
const FORMAT = 'v1';

const payloadSchema = z
  .object({
    voucherCode: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
    claimUrl: claimUrlSchema,
    /** Raw vendor scalar; the timestamp format is deliberately not interpreted. */
    expiresAt: z
      .union([z.string().min(1).max(128), z.number().finite().nonnegative()])
      .optional(),
  })
  .strict();

export interface GiftVoucherSecretData {
  voucherCode: string;
  claimUrl: string;
  expiresAt?: string | number;
}

export class GiftVoucherVaultUnavailableError extends Error {}

/** Domain-separated subkey so the master key is not used directly as an AES key. */
function encryptionKey(masterKey: Buffer): Buffer {
  if (masterKey.length !== 32) throw new GiftVoucherVaultUnavailableError();
  return createHmac('sha256', masterKey)
    .update('benefit-hub:gift-voucher:encryption-key:v1', 'utf8')
    .digest();
}

export function encryptGiftVoucherData(masterKey: Buffer, data: GiftVoucherSecretData): string {
  const key = encryptionKey(masterKey);
  const parsed = payloadSchema.safeParse(data);
  if (!parsed.success) throw new GiftVoucherVaultUnavailableError();

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(parsed.data), 'utf8'),
    cipher.final(),
  ]);
  return [
    FORMAT,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function decryptGiftVoucherData(
  masterKey: Buffer,
  ciphertext: string,
): GiftVoucherSecretData {
  const key = encryptionKey(masterKey);
  try {
    const [version, ivPart, tagPart, dataPart, extra] = ciphertext.split(':');
    if (version !== FORMAT || !ivPart || !tagPart || !dataPart || extra !== undefined) {
      throw Error('Bad envelope');
    }
    const iv = Buffer.from(ivPart, 'base64');
    const tag = Buffer.from(tagPart, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw Error('Bad envelope');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const raw = Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64')),
      decipher.final(),
    ]);
    const parsed = payloadSchema.safeParse(JSON.parse(raw.toString('utf8')));
    if (!parsed.success) throw Error('Bad payload');
    return {
      voucherCode: parsed.data.voucherCode,
      claimUrl: parsed.data.claimUrl,
      ...(parsed.data.expiresAt === undefined ? {} : { expiresAt: parsed.data.expiresAt }),
    };
  } catch {
    // Never echo ciphertext, vendor identifiers or the underlying crypto error.
    throw new GiftVoucherVaultUnavailableError();
  }
}
