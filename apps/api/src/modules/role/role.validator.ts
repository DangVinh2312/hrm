import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import type { ValidatedDeclarations } from '../../authorization/core/authorization.declarations.js';
import {
  MAX_ROLE_GRANTS,
  type RoleGrantSpec,
  checkRoleGrants,
  isRuntimeRoleKey,
  roleLabel,
} from '../../authorization/helpers/role-grant.helper.js';
import { canonicalJson } from '../../authorization/core/policy.validator.js';
import { inputBody } from '../../infrastructure/helpers/input-validation.helper.js';
import { lacksFinalDecision } from './role-risk.helper.js';
import type { RoleCreateInput, RoleUpdateInput } from './role.types.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_KEY_LENGTH = 160;
const MAX_VERSION = 2_147_483_647;

export function parseRoleKey(value: unknown): string {
  if (!isRuntimeRoleKey(value)) throw new ProductInvalidRequest('Invalid role key');
  return value;
}

function parseGrant(value: unknown): RoleGrantSpec {
  const grant = inputBody(value, ['permission', 'template']);
  const template = grant.template;
  if (
    typeof grant.permission !== 'string' ||
    grant.permission.length > MAX_KEY_LENGTH ||
    !isRecord(template)
  )
    throw new ProductInvalidRequest('Invalid grant');
  const { key, version } = inputBody(template, ['key', 'version']);
  if (
    typeof key !== 'string' ||
    key.length > MAX_KEY_LENGTH ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > MAX_VERSION
  )
    throw new ProductInvalidRequest('Invalid grant');
  return { permission: grant.permission, template: { key, version } };
}

/** At most 300 grants, counted before any element is read; a repeated grant is refused. */
function parseGrants(value: unknown): RoleGrantSpec[] {
  if (!Array.isArray(value) || value.length > MAX_ROLE_GRANTS)
    throw new ProductInvalidRequest('Invalid grants');
  const grants = value.map(parseGrant);
  const seen = new Set(
    grants.map((g) => canonicalJson([g.permission, g.template.key, g.template.version])),
  );
  if (seen.size !== grants.length) throw new ProductInvalidRequest('Duplicate grant');
  return grants;
}

function parseLabel(value: unknown): string {
  const label = roleLabel(value);
  if (label === undefined) throw new ProductInvalidRequest('Invalid label');
  return label;
}

export function parseRoleCreate(body: unknown): RoleCreateInput {
  const input = inputBody(body, ['key', 'label', 'grants']);
  return {
    key: parseRoleKey(input.key),
    label: parseLabel(input.label),
    grants: parseGrants(input.grants),
  };
}

/** PUT body for the key of the route; the key is immutable, so the body carries none. */
export function parseRoleUpdate(key: unknown, body: unknown): RoleUpdateInput {
  const roleKey = parseRoleKey(key);
  const input = inputBody(body, ['label', 'grants', 'expectedDigest']);
  if (typeof input.expectedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedDigest))
    throw new ProductInvalidRequest('Invalid digest');
  return {
    key: roleKey,
    label: parseLabel(input.label),
    grants: parseGrants(input.grants),
    expectedDigest: input.expectedDigest,
  };
}

/**
 * Catalog rules of a role: declared permission, template of the same resource, no `document`
 * (a fixture of the core, not assignable through the UI), and no `approvals` without `decideFinal`.
 */
export function checkRoleCatalog(
  declarations: ValidatedDeclarations,
  grants: readonly RoleGrantSpec[],
): void {
  if (!checkRoleGrants(declarations, grants).ok) throw new ProductInvalidRequest('Invalid grants');
  if (grants.some((grant) => grant.permission.startsWith('document.')))
    throw new ProductInvalidRequest('Invalid grants');
  if (lacksFinalDecision(grants)) throw new ProductInvalidRequest('Invalid grants');
}
