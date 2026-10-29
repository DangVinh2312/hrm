import { createHash } from 'node:crypto';
import { canonicalJson } from '../core/policy.validator.js';
import { refKey, type ValidatedDeclarations } from '../core/authorization.declarations.js';
import type { GrantRuleFact } from './grant-set.helper.js';

/**
 * Pure rules of runtime roles. A runtime role is a key `custom.<name>`
 * and a set of grants, each one a `(permission, template key, template version)` the release
 * registered; nothing here reads a database or decides access. Declarations are the release the
 * runtime booted with (frozen), so the catalog the checks use is the one the planner uses.
 */

/** The prefix is reserved for runtime roles: the release refuses it, the database pins it. */
export const RUNTIME_ROLE_PREFIX = 'custom.';

export const MAX_RUNTIME_ROLES = 100;

export const MAX_ROLE_GRANTS = 300;
const MAX_LABEL_POINTS = 120;

const runtimeRoleKey = /^custom\.[a-z][a-z0-9_]{1,40}$/;

export const isRuntimeRoleKey = (value: unknown): value is string =>
  typeof value === 'string' && runtimeRoleKey.test(value);

/** Size of the `role_key` column. */
export const MAX_ROLE_KEY_BYTES = 96;

/** A role key as the caller names it for any role (code or runtime): 1..96 UTF-8 bytes, nothing else is known yet. */
export const isRoleKeyReference = (value: unknown): value is string =>
  typeof value === 'string' &&
  value !== '' &&
  Buffer.byteLength(value, 'utf8') <= MAX_ROLE_KEY_BYTES;

/** Trimmed label of 1..120 code points without control characters; `undefined` when invalid. */
export function roleLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const points = [...text];

  const control = (c: string) => (c.codePointAt(0) ?? 0) < 0x20 || c.codePointAt(0) === 0x7f;

  return text && points.length <= MAX_LABEL_POINTS && !points.some(control) ? text : undefined;
}

/** One grant of a role as the caller names it; parameters are always `{}` (see `checkRoleGrants`). */
export interface RoleGrantSpec {
  readonly permission: string;
  readonly template: { readonly key: string; readonly version: number };
}

export type GrantCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        'too_many' | 'unknown_permission' | 'unknown_template' | 'wrong_resource' | 'duplicate';
    };

const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/**
 * Every grant must name a declared permission (`resource.action`) and a registered template of
 * the SAME resource: the database foreign key only proves the template exists, so a template of
 * another resource would otherwise be stored and the planner would fail closed at request time.
 * shortcut: templates that declare parameters are refused (the release has none); supporting them
 * needs typed parameter values from the core, add it when the first such template ships.
 */
export function checkRoleGrants(
  declarations: ValidatedDeclarations,
  grants: readonly RoleGrantSpec[],
): GrantCheck {
  if (grants.length > MAX_ROLE_GRANTS) return { ok: false, reason: 'too_many' };
  const seen = new Set<string>();
  for (const grant of grants) {
    const dot = grant.permission.indexOf('.');
    const resource = dot > 0 ? grant.permission.slice(0, dot) : '';
    const action = grant.permission.slice(dot + 1);
    const declared = own(declarations.resources, resource);
    if (!declared || dot < 1 || action.includes('.') || !Object.hasOwn(declared.actions, action))
      return { ok: false, reason: 'unknown_permission' };
    const template = own(declarations.templates, refKey(grant.template));
    if (!template) return { ok: false, reason: 'unknown_template' };
    if (template.resource !== resource || Object.keys(template.parameters).length > 0)
      return { ok: false, reason: 'wrong_resource' };
    const id = canonicalJson([grant.permission, grant.template.key, grant.template.version]);
    if (seen.has(id)) return { ok: false, reason: 'duplicate' };
    seen.add(id);
  }
  return { ok: true };
}

/** The grants as the facts the grant-set comparison reads. */
export const grantsAsFacts = (grants: readonly RoleGrantSpec[]): GrantRuleFact[] =>
  grants.map((grant) => ({
    source: 'role',
    effect: 'allow',
    permission: grant.permission,
    template: { key: grant.template.key, version: grant.template.version },
    parameters: {},
  }));

/** SHA-256 of `[label, sorted canonical grants]`: the `expectedDigest` of an update and the audit evidence of a role. */
export function grantsDigest(label: string, grants: readonly RoleGrantSpec[]): string {
  const rows = grants
    .map((grant) => canonicalJson([grant.permission, grant.template.key, grant.template.version]))
    .sort();
  return createHash('sha256')
    .update(canonicalJson([label, rows]))
    .digest('hex');
}
