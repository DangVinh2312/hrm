/**
 * Keys of the role fragment; values are the strings stored in the
 * manifest, the database and the audit log (never rename, add a member instead). The core only
 * sees `string`. Roles themselves are not resources: `role` is the singleton anchor the role
 * permissions apply to (like `setting`).
 */
export const RoleResource = { Role: 'role' } as const;

export type RoleResource = (typeof RoleResource)[keyof typeof RoleResource];

/**
 * `read`: the role matrix (roles and their grants); `create` / `update` / `delete`: runtime roles
 * (`custom.<name>`), the only ones that can be written through the API.
 */
export const RoleAction = {
  Read: 'read',
  Create: 'create',
  Update: 'update',
  Delete: 'delete',
} as const;

export type RoleAction = (typeof RoleAction)[keyof typeof RoleAction];

export const RoleTemplate = { Role: 'role' } as const;

export type RoleTemplate = (typeof RoleTemplate)[keyof typeof RoleTemplate];
