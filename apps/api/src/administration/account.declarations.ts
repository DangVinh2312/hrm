import type { SystemDeclarations } from '../authorization/core/authorization.declarations.js';
import type { ProductStorageBindings } from '../authorization/product-sql.compiler.js';

/** Account administration fragment: data only, composed into the release in authorization/. */
export const accountDeclarations: Pick<
  SystemDeclarations,
  'resources' | 'policies' | 'templates' | 'boundaries'
> = {
  resources: [
    {
      key: 'account',
      keyKind: 'uuid',
      fields: {
        state: { kind: 'string' },
        email: { kind: 'string', nullable: true },
        // 'pending' | 'expired' while an email enrollment waits for its first login (ADR 0020).
        enrollment: { kind: 'string', nullable: true },
      },
      actions: {
        // An IAM principal needs a grant and an explicit boundary; Root bypasses both (ADR 0012).
        suspend: { policy: { key: 'freshAuthentication', version: 1 }, boundary: 'required' },
        // Creates a principal (ADR 0020 §3): fresh-auth, audited, boundary required.
        provision: { policy: { key: 'freshAuthentication', version: 1 }, boundary: 'required' },
        // Account list with emails: audited; reading acts on no principal, so boundary optional.
        read: { policy: { key: 'auditedRead', version: 1 }, boundary: 'optional' },
      },
    },
  ],
  policies: [
    {
      key: 'freshAuthentication',
      version: 1,
      contextRequirements: [{ validator: 'fresh@1', parameters: {} }],
      requiredScope: { op: 'constant', value: true },
      obligations: [{ handler: 'audit@1' }],
    },
    {
      key: 'auditedRead',
      version: 1,
      contextRequirements: [],
      requiredScope: { op: 'constant', value: true },
      obligations: [{ handler: 'audit@1' }],
    },
  ],
  templates: [
    {
      key: 'allAccounts',
      version: 1,
      resource: 'account',
      parameters: {},
      expression: { op: 'constant', value: true },
    },
  ],
  boundaries: [],
};

export const accountBinding: ProductStorageBindings['resources'][number] = {
  resource: 'account',
  // IAM accounts only (owner-rights projection, migration 013): Root and absent ids look the same
  // to every account action, and no login reads app_user.email_canonical directly.
  table: 'account_directory',
  objectIdColumn: 'id',
  keyColumn: 'id',
  columns: { state: 'state', email: 'email', enrollment: 'enrollment' },
  projection: ['email', 'state', 'enrollment'],
};
