import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP second factor (ADR 0026 §1, §7): RFC 6238 over RFC 4226 HOTP with HMAC-SHA1, 6 digits and
 * 30 s steps. The step comes from the DB clock (the caller reads it in SQL); nothing here reads
 * the machine clock. Counters are bigints: a step never round-trips through a JS number.
 */
export const TOTP_SECRET_BYTES = 20;

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const maxCounter = 2n ** 64n - 1n;

/** RFC 4648 base32, upper case, without padding (the form authenticator apps accept). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

/** Inverse of base32Encode; only its canonical output is accepted (no padding, no lower case). */
export function base32Decode(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    const index = base32Alphabet.indexOf(char);
    if (index < 0) throw new TypeError('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  // A canonical encoding ends with fewer than 5 spare bits, all zero.
  if (bits >= 5 || value !== 0) throw new TypeError('Invalid base32');
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP; `digits` 8 exists only for the RFC 6238 test vectors. */
export function hotp(secret: Uint8Array, counter: bigint, digits: 6 | 8 = 6): string {
  if (typeof counter !== 'bigint' || counter < 0n || counter > maxCounter)
    throw new TypeError('Invalid HOTP counter');
  if (digits !== 6 && digits !== 8) throw new TypeError('Invalid HOTP digits');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac.readUInt8(19) & 15;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The step of `step - 1`, `step` or `step + 1` whose code equals `code`, else undefined. The
 * caller still requires the matched step to exceed the last used one (replay, ADR 0026 §2).
 */
export function matchTotp(secret: Uint8Array, code: unknown, step: bigint): bigint | undefined {
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return undefined;
  const given = Buffer.from(code);
  let matched: bigint | undefined;
  // Every candidate is computed and compared, so timing does not reveal which step matched.
  for (const candidate of [step - 1n, step, step + 1n])
    if (candidate >= 0n && timingSafeEqual(Buffer.from(hotp(secret, candidate)), given))
      matched ??= candidate;
  return matched;
}

/** Authenticator URI; the label is `HRM:<email>`, or `HRM` for an account without email. */
export function totpUri(secret: Uint8Array, email: string | null): string {
  const label = email === null ? 'HRM' : `HRM:${encodeURIComponent(email)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=HRM&algorithm=SHA1&digits=6&period=30`;
}

/** One recovery code: 80 random bits as 16 base32 characters. */
export function newRecoveryCode(): string {
  return base32Encode(randomBytes(10));
}

/** Shown form `XXXX-XXXX-XXXX-XXXX`. */
export function formatRecoveryCode(code: string): string {
  return code.match(/.{4}/g)?.join('-') ?? code;
}

/** Typed input → canonical code: case, hyphens and spaces are ignored; anything else fails. */
export function normalizeRecoveryCode(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length > 64) return undefined;
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z2-7]{16}$/.test(code) ? code : undefined;
}

/** SHA-256 with a purpose label and the user id: 80 bits resist offline search without argon2. */
export function recoveryCodeHash(userId: string, code: string): Buffer {
  return createHash('sha256').update(`HRM-MFA-RECOVERY\0v1\0${userId}\0${code}`).digest();
}
