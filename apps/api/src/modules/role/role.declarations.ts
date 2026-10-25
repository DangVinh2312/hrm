import type { SystemDeclarations } from '../../authorization/core/authorization.declarations.js';
import type { ProductReleaseSource } from '../../authorization/services/product-manifest.service.js';
import type { ProductResourceBinding } from '../../authorization/product-sql.compiler.js';
import {
  defaultGrant,
  optionalAction,
  permissionKey,
  scopeTemplate,
} from '../permission/permission-declaration.helper.js';
import { PermissionPolicy, PermissionRole } from '../permission/permission-authorization.types.js';
import { RoleAction, RoleResource, RoleTemplate } from './role-authorization.types.js';

/**
 * Release 19 fragment (ADR 0041 §3, ADR 0046): one singleton record, the role anchor, carries
 * `role.read`. It acts on no principal, so `boundary: 'optional'`, and uses the shared `hrRead`
 * policy (no `fresh@1`, nothing is written). The role matrix is configuration, not personal data.
 */
export const roleDeclarations: Pick<
  SystemDeclarations,
  'resources' | 'policies' | 'templates' | 'boundaries'
> = {
  resources: [
    {
      key: RoleResource.Role,
      keyKind: 'uuid',
      fields: {},
      actions: { [RoleAction.Read]: optionalAction(PermissionPolicy.Read) },
    },
  ],
  policies: [],
  templates: [scopeTemplate(RoleTemplate.Role, RoleResource.Role, { op: 'constant', value: true })],
  boundaries: [],
};

/** The release gives the role matrix to the administrative role only; any other holder is a runtime grant. */
export const roleDefaultGrants: ProductReleaseSource['defaultGrants'] = [
  defaultGrant(
    permissionKey(RoleResource.Role, RoleAction.Read),
    PermissionRole.Admin,
    RoleTemplate.Role,
  ),
];

export const roleBinding: ProductResourceBinding = {
  resource: RoleResource.Role,
  table: 'role_anchor',
  objectIdColumn: 'object_id',
  keyColumn: 'id',
  columns: {},
  projection: [],
};
