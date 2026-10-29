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
import { SettingAction, SettingResource, SettingTemplate } from './setting-authorization.types.js';

/**
 * Release 18 fragment: one singleton record, the settings anchor, carries
 * the four permissions. Reads use the shared `hrRead` policy and the two updates the shared
 * `hrWrite` policy: no `fresh@1` (the user chose plain permissions for HR rules and company
 * information), `boundary: 'optional'` (they act on no other principal). The security page is a
 * view of `read`; nothing in it is writable, so it has no update action.
 */
export const settingDeclarations: Pick<
  SystemDeclarations,
  'resources' | 'policies' | 'templates' | 'boundaries'
> = {
  resources: [
    {
      key: SettingResource.Setting,
      keyKind: 'uuid',
      fields: {},
      actions: {
        [SettingAction.Read]: optionalAction(PermissionPolicy.Read),
        [SettingAction.ReadProfile]: optionalAction(PermissionPolicy.Read),
        [SettingAction.UpdateRule]: optionalAction(PermissionPolicy.Write),
        [SettingAction.UpdateProfile]: optionalAction(PermissionPolicy.Write),
      },
    },
  ],
  policies: [],
  templates: [
    scopeTemplate(SettingTemplate.Setting, SettingResource.Setting, {
      op: 'constant',
      value: true,
    }),
  ],
  boundaries: [],
};

const settingGrant = (action: SettingAction, role: PermissionRole) =>
  defaultGrant(permissionKey(SettingResource.Setting, action), role, SettingTemplate.Setting);

/** Admin changes both groups and reads everything; COO reads; every HR role reads the profile. */
export const settingDefaultGrants: ProductReleaseSource['defaultGrants'] = [
  settingGrant(SettingAction.Read, PermissionRole.Coo),
  settingGrant(SettingAction.Read, PermissionRole.Admin),
  settingGrant(SettingAction.ReadProfile, PermissionRole.Employee),
  settingGrant(SettingAction.ReadProfile, PermissionRole.Coo),
  settingGrant(SettingAction.ReadProfile, PermissionRole.Admin),
  settingGrant(SettingAction.UpdateRule, PermissionRole.Admin),
  settingGrant(SettingAction.UpdateProfile, PermissionRole.Admin),
];

export const settingBinding: ProductResourceBinding = {
  resource: SettingResource.Setting,
  table: 'setting_anchor',
  objectIdColumn: 'object_id',
  keyColumn: 'id',
  columns: {},
  projection: [],
};
