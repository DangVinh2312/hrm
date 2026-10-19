import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { canonicalJson } from '../core/policy.validator.js';
import {
  ReleaseRejectedError,
  type DefaultGrant,
  type RejectReason,
  type RelationSeed,
} from './release-content.helper.js';
import type { ProductReleaseManifest } from '../services/product-manifest.service.js';

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

export async function objectId(
  m: EntityManager,
  release: ProductReleaseManifest,
  end: RelationSeed['source'],
) {
  const kind = release.declarations.resources[end.type]!.keyKind;
  const rows = await m.query<{ id: string }[]>(
    `SELECT object_id::text AS id FROM object_ref WHERE type_key = $1 AND key_kind = $2 AND key_bytes = $3`,
    [utf8(end.type), kind, utf8(end.key.value)],
  );
  return rows[0]?.id;
}
