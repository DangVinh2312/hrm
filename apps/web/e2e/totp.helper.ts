import { createHmac } from 'node:crypto';

/**
 * What an authenticator app does with the setup key the page shows (RFC 6238 over RFC 4226:
 * HMAC-SHA1, 6 digits, 30 s). Test-only and independent of the API code it checks; the step comes
 * from this machine's clock like a phone's, and the API accepts the DB step ±1.
 */
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new TypeError('Invalid base32 setup key');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

export function totp(setupKey: string, step: bigint): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(step);
  const mac = createHmac('sha1', base32Decode(setupKey)).update(message).digest();
  const offset = mac.readUInt8(19) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Current 30 s step, waiting first while within 6 s of a step edge so ±1 codes stay valid. */
export async function stableStep(): Promise<bigint> {
  for (;;) {
    const seconds = Date.now() / 1000;
    if (seconds % 30 < 24) return BigInt(Math.floor(seconds / 30));
    await new Promise((resolve) => setTimeout(resolve, (30 - (seconds % 30)) * 1000 + 200));
  }
}
