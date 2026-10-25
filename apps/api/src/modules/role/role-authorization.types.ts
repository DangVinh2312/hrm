/**
 * Keys of the role fragment (ADR 0041 §3, ADR 0046); values are the strings stored in the
 * manifest, the database and the audit log (never rename, add a member instead). The core only
 * sees `string`. Roles themselves are not resources: `role` is the singleton anchor the role
 * permissions apply to (like `setting`).
 */
export const RoleResource = { Role: 'role' } as const;

export type RoleResource = (typeof RoleResource)[keyof typeof RoleResource];

/** `read`: the role matrix (roles and their grants). Writes arrive with ADR 0041 wave 3b part 2. */
export const RoleAction = { Read: 'read' } as const;

export type RoleAction = (typeof RoleAction)[keyof typeof RoleAction];

export const RoleTemplate = { Role: 'role' } as const;

export type RoleTemplate = (typeof RoleTemplate)[keyof typeof RoleTemplate];
