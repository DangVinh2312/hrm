import { MAX_ROLE_GRANTS } from '../authorization/helpers/role-grant.helper.js';

export const productPermissionAuditKinds = [
  'permission.role-create',
  'permission.role-update',
  'permission.role-delete',
  'permission.role-assign',
  'permission.role-revoke',
  'permission.boundary-assign',
  'permission.boundary-revoke',
] as const;

export type ProductPermissionAuditKind = (typeof productPermissionAuditKinds)[number];

export const isPermissionAuditKind = (kind: string): kind is ProductPermissionAuditKind =>
  (productPermissionAuditKinds as readonly string[]).includes(kind);

/** What a role or boundary change may say about itself: identifiers and counts, never labels, emails or subjects. */
export interface ProductPermissionAuditDetail {
  readonly roleKey?: string;
  readonly grantCount?: number;
  readonly grantsDigest?: string;
  readonly boundaryKey?: string;
  readonly boundaryVersion?: number;
  readonly targetUserId?: string;
}

const identifier = /^[A-Za-z][A-Za-z0-9._-]{0,95}$/;
const sha256 = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const text = (value: unknown, pattern: RegExp): string => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError('Audit detail value');
  return value;
};

const count = (value: unknown, max: number, min: number): string => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new TypeError('Audit detail value');
  return String(value);
};

const fields: Readonly<Record<keyof ProductPermissionAuditDetail, (value: unknown) => string>> = {
  roleKey: (value) => text(value, identifier),
  grantCount: (value) => count(value, MAX_ROLE_GRANTS, 0),
  grantsDigest: (value) => text(value, sha256),
  boundaryKey: (value) => text(value, identifier),
  boundaryVersion: (value) => count(value, 2147483647, 1),
  targetUserId: (value) => text(value, uuid),
};

/** Metadata strings of a detail; any field outside the allowlist or in the wrong shape throws, so the audit fails and the command rolls back. */
export function permissionAuditMetadata(detail: unknown): Record<string, string> {
  if (detail === undefined) return {};
  if (typeof detail !== 'object' || detail === null) throw new TypeError('Audit detail');
  const metadata: Record<string, string> = {};
  for (const key of Object.keys(detail)) {
    if (!Object.hasOwn(fields, key)) throw new TypeError('Audit detail field');
    metadata[key] = fields[key as keyof ProductPermissionAuditDetail](
      (detail as Record<string, unknown>)[key],
    );
  }
  return metadata;
}
