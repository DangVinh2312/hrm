/** Keys of the `account` administration fragment; values are stored strings (never rename). */
export const AccountResource = { Account: 'account' } as const;

export type AccountResource = (typeof AccountResource)[keyof typeof AccountResource];

export const AccountAction = {
  Suspend: 'suspend',
  Provision: 'provision',
  Read: 'read',
} as const;

export type AccountAction = (typeof AccountAction)[keyof typeof AccountAction];

export const AccountPolicy = {
  FreshAuthentication: 'freshAuthentication',
  AuditedRead: 'auditedRead',
} as const;

export type AccountPolicy = (typeof AccountPolicy)[keyof typeof AccountPolicy];

export const AccountTemplate = { AllAccounts: 'allAccounts' } as const;

export type AccountTemplate = (typeof AccountTemplate)[keyof typeof AccountTemplate];
