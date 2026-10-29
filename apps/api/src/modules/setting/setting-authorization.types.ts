/**
 * Keys of the setting fragment; values are the strings stored in the
 * manifest, the database and the audit log (never rename, add a member instead). The core only
 * sees `string`.
 */
export const SettingResource = { Setting: 'setting' } as const;

export type SettingResource = (typeof SettingResource)[keyof typeof SettingResource];

/**
 * `read`: rules and profile with versions, history and the security page; `readProfile`: only the
 * company name and default language, for every signed-in HR role; `updateRule` / `updateProfile`:
 * the two groups of the registry (Q3), each its own permission.
 */
export const SettingAction = {
  Read: 'read',
  ReadProfile: 'readProfile',
  UpdateRule: 'updateRule',
  UpdateProfile: 'updateProfile',
} as const;

export type SettingAction = (typeof SettingAction)[keyof typeof SettingAction];

export const SettingTemplate = { Setting: 'setting' } as const;

export type SettingTemplate = (typeof SettingTemplate)[keyof typeof SettingTemplate];
