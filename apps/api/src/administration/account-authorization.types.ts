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
  /** Bind or unbind the whole `accountAdministration@1` package on another IAM account (ADR-13). */
  BindBoundary: 'bindBoundary',
  UnbindBoundary: 'unbindBoundary',
} as const;

export type AccountAction = (typeof AccountAction)[keyof typeof AccountAction];

/** The switch that lets an IAM account use the account and role administration commands. */
export const AccountBoundary = { Administration: 'accountAdministration' } as const;

export type AccountBoundary = (typeof AccountBoundary)[keyof typeof AccountBoundary];

export const AccountPolicy = {
  FreshAuthentication: 'freshAuthentication',
  AuditedRead: 'auditedRead',
} as const;

export type AccountPolicy = (typeof AccountPolicy)[keyof typeof AccountPolicy];

export const AccountTemplate = { AllAccounts: 'allAccounts' } as const;

export type AccountTemplate = (typeof AccountTemplate)[keyof typeof AccountTemplate];
