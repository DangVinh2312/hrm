import { createHash } from 'node:crypto';
import { canonicalJson } from '../core/policy.validator.js';
import {
  ReleaseRejectedError,
  type DefaultGrant,
  type RejectReason,
} from './release-content.helper.js';

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export const utf8 = (value: string) => Buffer.from(value, 'utf8');

export const reject = (reason: RejectReason, detail: string): never => {
  throw new ReleaseRejectedError(reason, detail);
};

export const definitionHash = (value: unknown) => sha256(canonicalJson(value));

/** Deterministic id for a code-owned default grant (UUID layout, version nibble 5). */
export function grantId(grant: DefaultGrant): string {
  const h = sha256(canonicalJson(grant));
  const variant = (8 | (parseInt(h[16]!, 16) & 3)).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
