import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  base32Decode,
  base32Encode,
  formatRecoveryCode,
  hotp,
  matchTotp,
  newRecoveryCode,
  normalizeRecoveryCode,
  recoveryCodeHash,
  totpUri,
} from '../dist/auth/helpers/totp.helper.js';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  parseMfaKeyRing,
} from '../dist/auth/helpers/mfa-encryption.helper.js';

// RFC 4226 Appendix D and RFC 6238 Appendix B (SHA-1): the ASCII secret "12345678901234567890".
const rfcSecret = Buffer.from('12345678901234567890', 'ascii');
const userA = '0b5c3f7e-1d2a-4c3b-9e8f-112233445566';
const userB = '0b5c3f7e-1d2a-4c3b-9e8f-112233445567';
const keyA = Buffer.alloc(32, 7).toString('base64');
const keyB = Buffer.alloc(32, 9).toString('base64');

test('HOTP matches the RFC 4226 test vectors', () => {
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];
  expected.forEach((code, counter) => assert.equal(hotp(rfcSecret, BigInt(counter)), code));
});

test('TOTP matches the RFC 6238 SHA-1 vectors (8 digits, 30 s steps)', () => {
  const vectors: [bigint, string][] = [
    [59n, '94287082'],
    [1111111109n, '07081804'],
    [1111111111n, '14050471'],
    [1234567890n, '89005924'],
    [2000000000n, '69279037'],
    [20000000000n, '65353130'],
  ];
  for (const [seconds, code] of vectors) assert.equal(hotp(rfcSecret, seconds / 30n, 8), code);
});

test('HOTP counters are unsigned 64-bit bigints, never JS numbers', () => {
  assert.match(hotp(rfcSecret, 2n ** 64n - 1n), /^\d{6}$/);
  assert.throws(() => hotp(rfcSecret, 2n ** 64n));
  assert.throws(() => hotp(rfcSecret, -1n));
  assert.throws(() => Reflect.apply(hotp, undefined, [rfcSecret, 1]));
  assert.throws(() => Reflect.apply(hotp, undefined, [rfcSecret, 0n, 7]));
});

test('a TOTP code matches the DB step ±1 only and returns the matched step', () => {
  const step = 1234567890n / 30n;
  assert.equal(matchTotp(rfcSecret, hotp(rfcSecret, step), step), step);
  assert.equal(matchTotp(rfcSecret, hotp(rfcSecret, step - 1n), step), step - 1n);
  assert.equal(matchTotp(rfcSecret, hotp(rfcSecret, step + 1n), step), step + 1n);
  assert.equal(matchTotp(rfcSecret, hotp(rfcSecret, step - 2n), step), undefined);
  assert.equal(matchTotp(rfcSecret, hotp(rfcSecret, step + 2n), step), undefined);
  for (const bad of ['', '12345', '1234567', '12345a', ' 123456', '１２３４５６', 123456])
    assert.equal(matchTotp(rfcSecret, bad, step), undefined);
});

test('base32 follows RFC 4648 without padding and rejects non-canonical input', () => {
  const vectors: [string, string][] = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded);
    assert.deepEqual(base32Decode(encoded), Buffer.from(plain));
  }
  assert.equal(base32Encode(rfcSecret), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  for (const bad of ['MY======', 'my', 'M1', 'MZ', 'M', 'MZXW6YTBOJ'])
    assert.throws(() => base32Decode(bad));
});

test('otpauth URI carries the HRM issuer and an encoded email label', () => {
  assert.equal(
    totpUri(rfcSecret, 'a.b+tag@example.com'),
    'otpauth://totp/HRM:a.b%2Btag%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=HRM&algorithm=SHA1&digits=6&period=30',
  );
  assert.equal(
    totpUri(rfcSecret, null),
    'otpauth://totp/HRM?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=HRM&algorithm=SHA1&digits=6&period=30',
  );
});

test('recovery codes are 80-bit base32, normalized leniently, hashed per user', () => {
  const code = newRecoveryCode();
  assert.match(code, /^[A-Z2-7]{16}$/);
  assert.notEqual(newRecoveryCode(), code);
  const shown = formatRecoveryCode(code);
  assert.match(shown, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
  assert.equal(normalizeRecoveryCode(shown.toLowerCase()), code);
  assert.equal(normalizeRecoveryCode(` ${shown.replaceAll('-', ' ')} `), code);
  for (const bad of ['', code.slice(1), `${code}A`, `${code.slice(1)}1`, 'x'.repeat(65), 42])
    assert.equal(normalizeRecoveryCode(bad), undefined);
  const hash = recoveryCodeHash(userA, code);
  assert.equal(hash.length, 32);
  assert.deepEqual(recoveryCodeHash(userA, code), hash);
  assert.notDeepEqual(recoveryCodeHash(userB, code), hash);
});

test('MFA key ring is validated without echoing key material', () => {
  const ring = parseMfaKeyRing(`k1:${keyA},k2:${keyB}`, 'k2');
  assert.equal(ring.current, 'k2');
  assert.deepEqual([...ring.ids].sort(), ['k1', 'k2']);
  const invalid: [string | undefined, string | undefined][] = [
    [undefined, 'k1'],
    [`k1:${keyA}`, undefined],
    [`k1:${keyA}`, 'k2'],
    [`k1:${keyA},k1:${keyB}`, 'k1'],
    [`K1:${keyA}`, 'K1'],
    [`k1:${Buffer.alloc(31).toString('base64')}`, 'k1'],
    [`k1:${Buffer.alloc(33).toString('base64')}`, 'k1'],
    [`k1:${keyA.slice(0, -1)}`, 'k1'],
    [`k1:${keyA.replace('=', '')}`, 'k1'],
    [`k1:${keyA},`, 'k1'],
    [`${'k'.repeat(33)}:${keyA}`, 'k'.repeat(33)],
  ];
  for (const [keys, current] of invalid)
    assert.throws(
      () => parseMfaKeyRing(keys, current),
      (error: unknown) => error instanceof Error && !error.message.includes(keyA.slice(0, 8)),
    );
});

test('AES-256-GCM secret binds user, key id and purpose; tampering fails closed', () => {
  const ring = parseMfaKeyRing(`k1:${keyA},k2:${keyB}`, 'k1');
  const sealed = encryptTotpSecret(ring, userA, rfcSecret);
  assert.equal(sealed.keyId, 'k1');
  assert.equal(sealed.nonce.length, 12);
  assert.equal(sealed.ciphertext.length, rfcSecret.length + 16);
  assert.deepEqual(decryptTotpSecret(ring, userA, sealed), rfcSecret);
  assert.notDeepEqual(encryptTotpSecret(ring, userA, rfcSecret).nonce, sealed.nonce);
  // Wrong user (AAD), wrong key id (AAD and key), unknown key id, nonce and ciphertext changes.
  assert.throws(() => decryptTotpSecret(ring, userB, sealed));
  assert.throws(() => decryptTotpSecret(ring, userA, { ...sealed, keyId: 'k2' }));
  assert.throws(() => decryptTotpSecret(ring, userA, { ...sealed, keyId: 'k3' }));
  const nonce = Buffer.from(sealed.nonce);
  nonce.writeUInt8(nonce.readUInt8(0) ^ 1, 0);
  assert.throws(() => decryptTotpSecret(ring, userA, { ...sealed, nonce }));
  const ciphertext = Buffer.from(sealed.ciphertext);
  ciphertext.writeUInt8(ciphertext.readUInt8(ciphertext.length - 1) ^ 1, ciphertext.length - 1);
  assert.throws(() => decryptTotpSecret(ring, userA, { ...sealed, ciphertext }));
  assert.throws(() =>
    decryptTotpSecret(ring, userA, { ...sealed, nonce: Buffer.alloc(11), ciphertext }),
  );
  // Another ring with the same id but other key material cannot open it.
  const other = parseMfaKeyRing(`k1:${keyB}`, 'k1');
  assert.throws(() => decryptTotpSecret(other, userA, sealed));
});
