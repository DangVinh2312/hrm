import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption of TOTP secrets at rest (ADR 0026 §3): AES-256-GCM with keys from the API env only.
 * The AAD binds the purpose label, the user and the key id, so a ciphertext copied to another
 * row or relabelled with another key id fails to open. Key material never appears in errors.
 */
export interface MfaKeyRing {
  readonly current: string;
  readonly ids: ReadonlySet<string>;

  /** Raw key by id; only `encryptTotpSecret`/`decryptTotpSecret` below should call it. */
  readonly key: (id: string) => Buffer | undefined;
}

export interface SealedTotpSecret {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly keyId: string;
}

export class MfaKeyRingError extends Error {}

const keyEntry = /^([a-z0-9-]{1,32}):([A-Za-z0-9+/]{43}=)$/;

function invalidKeyRing(): never {
  throw new MfaKeyRingError(
    'MFA_ENCRYPTION_KEYS must list unique <id>:<base64 32-byte key> entries and MFA_ENCRYPTION_KEY_ID must name one',
  );
}

/** `<keyId>:<base64 of 32 bytes>` entries separated by commas; `current` must be one of them. */
export function parseMfaKeyRing(keys: string | undefined, current: string | undefined): MfaKeyRing {
  if (!keys || !current || keys.length > 4096) invalidKeyRing();
  const map = new Map<string, Buffer>();
  for (const entry of keys.split(',')) {
    const [, id, encoded] = keyEntry.exec(entry) ?? [];
    if (id === undefined || encoded === undefined) invalidKeyRing();
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded || map.has(id)) invalidKeyRing();
    map.set(id, key);
  }
  if (!map.has(current)) invalidKeyRing();
  return { current, ids: new Set(map.keys()), key: (id) => map.get(id) };
}

const aad = (userId: string, keyId: string) => Buffer.from(`HRM-MFA-TOTP\0v1\0${userId}\0${keyId}`);

/** Seals with the current key and a fresh 12-byte nonce; the 16-byte tag ends the ciphertext. */
export function encryptTotpSecret(
  ring: MfaKeyRing,
  userId: string,
  secret: Uint8Array,
): SealedTotpSecret {
  const key = ring.key(ring.current);
  if (!key) throw new MfaKeyRingError('Current MFA key missing');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce).setAAD(aad(userId, ring.current));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext, nonce, keyId: ring.current };
}

/** Opens a sealed secret; unknown key id, wrong user, nonce or tampered bytes throw. */
export function decryptTotpSecret(
  ring: MfaKeyRing,
  userId: string,
  sealed: SealedTotpSecret,
): Buffer {
  const key = ring.key(sealed.keyId);
  if (!key || sealed.nonce.length !== 12 || sealed.ciphertext.length <= 16)
    throw new MfaKeyRingError('MFA secret cannot be opened');
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, { authTagLength: 16 })
    .setAAD(aad(userId, sealed.keyId))
    .setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16)),
      decipher.final(),
    ]);
  } catch {
    throw new MfaKeyRingError('MFA secret cannot be opened');
  }
}
