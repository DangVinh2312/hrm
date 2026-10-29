import type { SystemDeclarations } from '../../authorization/core/authorization.declarations.js';
import type { ProductReleaseSource } from '../../authorization/services/product-manifest.service.js';
import type { ProductResourceBinding } from '../../authorization/product-sql.compiler.js';
import {
  boundedAction,
  defaultGrant,
  optionalAction,
  permissionKey,
  scopeTemplate,
} from '../permission/permission-declaration.helper.js';
import { PermissionPolicy, PermissionRole } from '../permission/permission-authorization.types.js';
import { RoleAction, RoleResource, RoleTemplate } from './role-authorization.types.js';

/**
 * One singleton record, the role anchor, carries the role permissions. `read` acts on no principal
 * (`boundary: 'optional'`, shared `hrRead` policy, no `fresh@1`: the role matrix is configuration,
 * not personal data). The three writes use `hrFresh` (`fresh@1`); `create` adds a role nobody
 * holds yet (`optional`), `update` and `delete` change what current holders can do (`required`).
 * No default grant: only Root until a runtime role grants them.
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
      actions: {
        [RoleAction.Read]: optionalAction(PermissionPolicy.Read),
        [RoleAction.Create]: optionalAction(PermissionPolicy.Fresh),
        [RoleAction.Update]: boundedAction(PermissionPolicy.Fresh),
        [RoleAction.Delete]: boundedAction(PermissionPolicy.Fresh),
      },
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
