import type { Expr } from '../../authorization/core/authorization.types.js';
import { ProductValidator } from '../../authorization/product-capability.types.js';

/**
 * Builders shared by the authorization fragments of the business modules (ADR 0016, ADR 0035).
 * They only shape data for the declarations; nothing here decides access.
 */

/** The caller's own account: matches `identityId` of the row against the principal. */
export const selfScope: Expr = {
  op: 'eq',
  field: 'identityId',
  value: { from: 'principal', name: 'id' },
};

export const stateScope = (value: string): Expr => ({
  op: 'eq',
  field: 'state',
  value: { from: 'literal', value },
});

/** `relation` is the unversioned key (`employee.lead`); the declaration adds `@1`. */
export const relatedScope = (relation: string): Expr => ({
  op: 'exists',
  relation: `${relation}@1`,
  where: selfScope,
});

export const scopeTemplate = (key: string, resource: string, expression: Expr) => ({
  key,
  version: 1,
  resource,
  parameters: {},
  expression,
});

export const permissionPolicy = (key: string, requiredScope: Expr, fresh = false) => ({
  key,
  version: 1,
  contextRequirements: fresh ? [{ validator: ProductValidator.Fresh, parameters: {} }] : [],
  requiredScope,
  obligations: [],
});

export const optionalAction = (policyKey: string) => ({
  policy: { key: policyKey, version: 1 },
  boundary: 'optional' as const,
});

/** Acts on another principal's facts (ADR 0016 §7, TD6): an IAM caller needs a bound boundary. */
export const boundedAction = (policyKey: string) => ({
  policy: { key: policyKey, version: 1 },
  boundary: 'required' as const,
});

/** Resource → identity relation read from a current-assignment view (no resource → resource). */
export const identityRelation = (key: string, sourceType: string, binding: string) => ({
  key,
  version: 1,
  sourceType,
  target: { kind: 'identity' as const },
  binding: { kind: 'domain' as const, key: binding },
});

/** The permission key `resource.action` (e.g. `employee.read`). */
export const permissionKey = <R extends string, A extends string>(
  resource: R,
  action: A,
): `${R}.${A}` => `${resource}.${action}`;

export const defaultGrant = (permission: string, role: string, templateKey: string) => ({
  permission,
  role,
  template: { key: templateKey, version: 1 },
  parameters: {},
});
