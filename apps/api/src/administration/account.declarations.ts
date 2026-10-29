import type { SystemDeclarations } from '../authorization/core/authorization.declarations.js';
import type { ProductStorageBindings } from '../authorization/product-sql.compiler.js';
import { ProductObligation, ProductValidator } from '../authorization/product-capability.types.js';
import {
  AccountAction,
  AccountPolicy,
  AccountResource,
  AccountTemplate,
} from './account-authorization.types.js';

/** Account administration fragment: data only, composed into the release in authorization/. */
export const accountDeclarations: Pick<
  SystemDeclarations,
  'resources' | 'policies' | 'templates' | 'boundaries'
> = {
  resources: [
    {
      key: AccountResource.Account,
      keyKind: 'uuid',
      fields: {
        state: { kind: 'string' },
        email: { kind: 'string', nullable: true },
        // 'pending' | 'expired' while an email enrollment waits for its first login.
        enrollment: { kind: 'string', nullable: true },
      },
      actions: {
        // An IAM principal needs a grant and an explicit boundary; Root bypasses both.
        [AccountAction.Suspend]: {
          policy: { key: AccountPolicy.FreshAuthentication, version: 1 },
          boundary: 'required',
        },
        // Un-suspend: same gate as suspend; no default grant, no boundary shipped yet.
        [AccountAction.Reactivate]: {
          policy: { key: AccountPolicy.FreshAuthentication, version: 1 },
          boundary: 'required',
        },
        // Creates a principal: fresh-auth, audited, boundary required.
        [AccountAction.Provision]: {
          policy: { key: AccountPolicy.FreshAuthentication, version: 1 },
          boundary: 'required',
        },
        // Account list with emails: audited; reading acts on no principal, so boundary optional.
        [AccountAction.Read]: {
          policy: { key: AccountPolicy.AuditedRead, version: 1 },
          boundary: 'optional',
        },
        // Roles and rules of one IAM account: a read, audited like the account list,
        // acting on no principal. No default grant, like account.read.
        [AccountAction.ReadPermissions]: {
          policy: { key: AccountPolicy.AuditedRead, version: 1 },
          boundary: 'optional',
        },
      },
    },
  ],
  policies: [
    {
      key: AccountPolicy.FreshAuthentication,
      version: 1,
      contextRequirements: [{ validator: ProductValidator.Fresh, parameters: {} }],
      requiredScope: { op: 'constant', value: true },
      obligations: [{ handler: ProductObligation.Audit }],
    },
    {
      key: AccountPolicy.AuditedRead,
      version: 1,
      contextRequirements: [],
      requiredScope: { op: 'constant', value: true },
      obligations: [{ handler: ProductObligation.Audit }],
    },
  ],
  templates: [
    {
      key: AccountTemplate.AllAccounts,
      version: 1,
      resource: AccountResource.Account,
      parameters: {},
      expression: { op: 'constant', value: true },
    },
  ],
  boundaries: [],
};

export const accountBinding: ProductStorageBindings['resources'][number] = {
  resource: AccountResource.Account,
  // IAM accounts only (owner-rights projection, migration 013): Root and absent ids look the same
  // to every account action, and no login reads app_user.email_canonical directly.
  table: 'account_directory',
  objectIdColumn: 'id',
  keyColumn: 'id',
  columns: { state: 'state', email: 'email', enrollment: 'enrollment' },
  projection: ['email', 'state', 'enrollment'],
};
