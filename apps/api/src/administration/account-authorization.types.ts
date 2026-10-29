/** Keys of the `account` administration fragment; values are stored strings (never rename). */
export const AccountResource = { Account: 'account' } as const;

export type AccountResource = (typeof AccountResource)[keyof typeof AccountResource];

export const AccountAction = {
  Suspend: 'suspend',
  Reactivate: 'reactivate',
  Provision: 'provision',
  Read: 'read',
  /** Roles and rules of one IAM account: the account detail page. */
  ReadPermissions: 'readPermissions',
  /** Give or take one role of another IAM account (ADR-13). */
  AssignRole: 'assignRole',
  RevokeRole: 'revokeRole',
} as const;

export type AccountAction = (typeof AccountAction)[keyof typeof AccountAction];

export const AccountPolicy = {
  FreshAuthentication: 'freshAuthentication',
  AuditedRead: 'auditedRead',
} as const;

export type AccountPolicy = (typeof AccountPolicy)[keyof typeof AccountPolicy];

export const AccountTemplate = { AllAccounts: 'allAccounts' } as const;

export type AccountTemplate = (typeof AccountTemplate)[keyof typeof AccountTemplate];
