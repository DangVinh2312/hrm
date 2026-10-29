import {
  accountLifecycleBody,
  guardRootActivationOidcBody,
  guardRootKindOidcBody,
  guardRootLifecycleMfaBody,
  guardRootNotIamSubjectBody,
  mfaEpochBody,
  productRowsIamBody,
  productStateBody,
  protectBindingRefBody,
  protectMfaRecoveryCodeBody,
  protectMfaTotpBody,
  provisionOidcAccountBody,
  reactivateIamAccountBody,
  requireEmailEpochBody,
  requireRootMarkerKindBody,
  resolveSessionOidcBody,
  sharedFenceBody,
  tokenConsumptionBody,
} from './migrations/001-product-baseline.migration.js';
import type { ProductDatabasePurpose } from './helpers/product-database.helper.js';

export type RuntimePurpose = Exclude<ProductDatabasePurpose, 'migration'>;
const authorityTables = [
  'resource_type',
  'permission_policy',
  'permission_catalog',
  'scope_template',
  'role_definition',
  'user_role',
  'policy_rule',
  'object_ref',
  'record_exception',
  'resource_relation_definition',
  'relation_edge',
  'user_relation',
  'permission_boundary',
  'permission_boundary_entry',
  'user_boundary',
];

const tables = (privileges: readonly string[], names: readonly string[]) =>
  names.flatMap((name) => privileges.map((p) => `table:${name}:${p}`));

const columns = (privilege: string, table: string, names: readonly string[]) =>
  names.map((name) => `column:${table}.${name}:${privilege}`);

const sharedFence = 'function:authz_acquire_shared_fence(integer):EXECUTE';
const resolveSession = 'function:resolve_session(bytea):EXECUTE';
const audit = 'table:audit_outbox:INSERT';
const provisionAccount = 'function:provision_oidc_account(uuid, text, text, uuid):EXECUTE';
const reactivateAccount = 'function:reactivate_iam_account(uuid):EXECUTE';
const accountDirectory = 'table:account_directory:SELECT';
/** Exact grants of each runtime login after the product migrations (credential matrix). */
export const expectedPrivileges: Readonly<Record<RuntimePurpose, readonly string[]>> = {
  data: [
    ...tables(['SELECT'], authorityTables),
    ...columns('SELECT', 'app_user', ['id', 'state', 'auth_epoch']),
    // Emails only through the IAM projection; accounts only through the definer.
    accountDirectory,
    provisionAccount,
    audit,
    sharedFence,
    resolveSession,
  ],
  identity: [
    ...tables(
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      ['application_session', 'oidc_login_attempt', 'rate_limit'],
    ),
    // binding_ref is never written by a login, no row deleted;
    // No binding is updated once created.
    'table:external_identity:SELECT',
    ...columns('INSERT', 'external_identity', ['issuer', 'subject', 'user_id']),
    // Only the bootstrap credential issues tokens.
    ...tables(['SELECT'], ['one_time_token']),
    'column:one_time_token.consumed_at:UPDATE',
    ...tables(['SELECT', 'INSERT', 'DELETE'], ['oidc_email_enrollment']),
    // Second factors; recovery codes are only ever marked used.
    ...tables(['SELECT', 'INSERT', 'UPDATE', 'DELETE'], ['mfa_totp']),
    ...tables(['SELECT', 'INSERT', 'DELETE'], ['mfa_recovery_code']),
    'column:mfa_recovery_code.used_at:UPDATE',
    ...tables(['SELECT'], ['oidc_provider', 'app_user', 'authz_state']),
    ...columns('INSERT', 'app_user', [
      'id',
      'email_canonical',
      'email_verified',
      'state',
      'auth_epoch',
    ]),
    ...columns('UPDATE', 'app_user', ['email_verified', 'state', 'auth_epoch']),
    'column:authz_state.revision:UPDATE',
    audit,
    sharedFence,
    resolveSession,
  ],
  authority: [
    ...tables(['SELECT'], [...authorityTables, 'authz_state']),
    ...columns('SELECT', 'app_user', ['id', 'state', 'auth_epoch', 'kind']),
    ...columns('UPDATE', 'app_user', ['state', 'auth_epoch']),
    'table:iam_account:SELECT',
    accountDirectory,
    // The one way out of `suspended`, for IAM accounts only.
    reactivateAccount,
    'column:authz_state.revision:UPDATE',
    ...tables(
      ['INSERT', 'UPDATE', 'DELETE'],
      [
        'role_definition',
        'user_role',
        'policy_rule',
        'record_exception',
        'relation_edge',
        'user_relation',
        'user_boundary',
        'object_ref',
      ],
    ),
    audit,
    resolveSession,
  ],
  sync: [
    ...tables(['SELECT'], [...authorityTables, 'oidc_provider']),
    ...tables(['SELECT', 'UPDATE'], ['authz_state']),
    ...tables(
      ['INSERT', 'UPDATE', 'DELETE'],
      [
        'resource_type',
        'permission_policy',
        'permission_catalog',
        'scope_template',
        'role_definition',
        'policy_rule',
        'resource_relation_definition',
        'permission_boundary',
        'permission_boundary_entry',
        'relation_edge',
        'user_boundary',
        'oidc_provider',
      ],
    ),
    'table:object_ref:INSERT',
    audit,
  ],
  bootstrap: [
    ...tables(['SELECT'], [...authorityTables, 'authz_state']),
    ...columns('SELECT', 'app_user', ['id', 'state', 'auth_epoch', 'email_canonical', 'kind']),
    // set-root-email, bounded by guard_root_lifecycle.
    ...columns('UPDATE', 'app_user', [
      'kind',
      'state',
      'auth_epoch',
      'email_canonical',
      'email_verified',
    ]),
    ...columns('SELECT', 'external_identity', [
      'issuer',
      'subject',
      'user_id',
      'enabled',
      'binding_version',
    ]),
    // `root:bootstrap` inserts the pending account, checks the issuer
    // and pins (issuer, email); `root:reissue` replaces the pin.
    ...columns('INSERT', 'app_user', ['id', 'email_canonical', 'state']),
    ...columns('SELECT', 'oidc_provider', ['issuer', 'enabled']),
    'column:oidc_email_enrollment.user_id:SELECT',
    ...tables(['INSERT', 'DELETE'], ['oidc_email_enrollment']),
    'column:authz_state.revision:UPDATE',
    ...tables(['SELECT', 'UPDATE'], ['security_bootstrap_state']),
    'table:one_time_token:INSERT',
    ...columns('SELECT', 'one_time_token', ['user_id', 'purpose', 'consumed_at']),
    'column:one_time_token.consumed_at:UPDATE',
    // `root:reset-mfa` deletes the Root's factor, guarded to Root.
    ...['mfa_totp', 'mfa_recovery_code'].flatMap((table) => [
      `column:${table}.user_id:SELECT`,
      `table:${table}:DELETE`,
    ]),
    audit,
  ],
  // Audit delivery worker: reads events, writes delivery state only; no fence, no other table.
  outbox: [
    'table:audit_outbox:SELECT',
    ...columns('UPDATE', 'audit_outbox', [
      'delivered_at',
      'delivery_attempts',
      'lease_token',
      'lease_until',
      'dead_at',
    ]),
  ],
};

/** Protection functions in public: VOLATILE, owner, SECURITY DEFINER and exact migration body. */
export const protectionFunctions: Readonly<Record<string, readonly [string, boolean, string]>> = {
  authz_acquire_shared_fence: ['product_fence_owner', true, sharedFenceBody],
  // Bodies replaced by migration 018 (OIDC sessions and activation only).
  resolve_session: ['product_session_owner', true, resolveSessionOidcBody],
  protect_product_state: ['product_migration', false, productStateBody],
  protect_product_rows: ['product_migration', false, productRowsIamBody],
  protect_account_lifecycle: ['product_migration', false, accountLifecycleBody],
  protect_token_consumption: ['product_migration', false, tokenConsumptionBody],
  guard_root_kind: ['product_session_owner', true, guardRootKindOidcBody],
  require_root_marker_kind: ['product_session_owner', true, requireRootMarkerKindBody],
  guard_root_not_iam_subject: ['product_session_owner', true, guardRootNotIamSubjectBody],
  guard_root_activation: ['product_session_owner', true, guardRootActivationOidcBody],
  // Body replaced by migrations 015 and 016.
  guard_root_lifecycle: ['product_session_owner', true, guardRootLifecycleMfaBody],
  provision_oidc_account: ['product_account_owner', true, provisionOidcAccountBody],
  reactivate_iam_account: ['product_account_owner', true, reactivateIamAccountBody],
  protect_binding_ref: ['product_migration', false, protectBindingRefBody],
  require_email_epoch: ['product_migration', false, requireEmailEpochBody],
  protect_mfa_totp: ['product_migration', false, protectMfaTotpBody],
  protect_mfa_recovery_code: ['product_migration', false, protectMfaRecoveryCodeBody],
  mfa_epoch: ['product_migration', false, mfaEpochBody],
};

/** PostgreSQL 18 pg_get_viewdef output of the IAM-only projection installed by migration 012. */
export const iamAccountDefinition = ` SELECT id,
    state
   FROM app_user
  WHERE (kind = 'iam'::text);`;

/**
 * Every non-internal trigger on the protected tables, as
 * table.trigger:function:tgtype:UPDATE OF columns:enabled:deferrable:initially deferred.
 * tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE.
 */
export const protectionTriggers = new Set([
  ...[
    'role_definition',
    'policy_rule',
    'record_exception',
    'user_role',
    'relation_edge',
    'user_boundary',
  ].map((table) => `${table}.protect_product_rows:protect_product_rows:31::O:false:false`),
  ...['user_role', 'user_boundary', 'policy_rule', 'record_exception'].map(
    (table) => `${table}.guard_root_not_iam_subject:guard_root_not_iam_subject:23::O:false:false`,
  ),
  'security_bootstrap_state.protect_product_state:protect_product_state:19::O:false:false',
  'authz_state.protect_product_state:protect_product_state:19::O:false:false',
  'app_user.protect_account_lifecycle:protect_account_lifecycle:19::O:false:false',
  'app_user.guard_root_kind:guard_root_kind:23:kind:O:false:false',
  'app_user.require_root_marker_kind:require_root_marker_kind:17:kind:O:true:true',
  'app_user.guard_root_lifecycle:guard_root_lifecycle:19:auth_epoch,state:O:false:false',
  'one_time_token.guard_root_activation:guard_root_activation:7::O:false:false',
  'one_time_token.protect_token_consumption:protect_token_consumption:19::O:false:false',
  'external_identity.protect_binding_ref:protect_binding_ref:19::O:false:false',
  'app_user.require_email_epoch:require_email_epoch:19:email_canonical,email_verified:O:false:false',
  'mfa_totp.protect_mfa_totp:protect_mfa_totp:31::O:false:false',
  'mfa_totp.mfa_epoch:mfa_epoch:25::O:false:false',
  'mfa_recovery_code.protect_mfa_recovery_code:protect_mfa_recovery_code:31::O:false:false',
]);

export const protectedTables = [...new Set([...protectionTriggers].map((t) => t.split('.')[0]!))];

/**
 * Exact ACL of the NOLOGIN owner of resolve_session and the Root guards: the 002/008 grants with
 * the 012 delta (spec 3.2). Anything more widens what every SECURITY DEFINER guard can do.
 */
export const sessionOwnerAcl: readonly string[] = [
  'schema:public:USAGE',
  ...columns('SELECT', 'app_user', ['id', 'state', 'auth_epoch', 'email_verified', 'kind']),
  'column:app_user.kind:UPDATE',
  ...columns('SELECT', 'application_session', [
    'token_hash',
    'user_id',
    'auth_epoch',
    'method',
    'assurance',
    'authenticated_at',
    'reauthenticated_at',
    'expires_at',
    'revoked_at',
    'last_seen_at',
    'external_issuer',
    'external_subject',
    'binding_version',
    'provider_version',
  ]),
  ...columns('SELECT', 'external_identity', [
    'issuer',
    'subject',
    'user_id',
    'enabled',
    'binding_version',
  ]),
  ...columns('SELECT', 'oidc_provider', ['issuer', 'version', 'enabled']),
  ...['user_role', 'user_boundary', 'policy_rule', 'record_exception'].map(
    (table) => `column:${table}.user_id:SELECT`,
  ),
  ...columns('SELECT', 'one_time_token', ['user_id', 'purpose', 'consumed_at', 'expires_at']),
  // guard_root_lifecycle checks that a reset Root holds no second factor.
  'column:mfa_totp.user_id:SELECT',
  'table:security_bootstrap_state:SELECT',
  ...[
    'resolve_session(bytea)',
    'guard_root_kind()',
    'require_root_marker_kind()',
    'guard_root_not_iam_subject()',
    'guard_root_activation()',
    'guard_root_lifecycle()',
  ].map((fn) => `function:${fn}:EXECUTE`),
];

/**
 * Exact ACL of the NOLOGIN owner of provision_oidc_account, reactivate_iam_account and
 * account_directory: what the definers and the owner-rights projection can
 * read, insert or update. Anything more widens both.
 */
export const accountOwnerAcl: readonly string[] = [
  'schema:public:USAGE',
  ...columns('SELECT', 'app_user', ['id', 'email_canonical', 'state', 'kind', 'auth_epoch']),
  ...columns('INSERT', 'app_user', ['id', 'email_canonical', 'state']),
  // Migration 021: reactivate_iam_account moves a suspended IAM account and advances its epoch.
  ...columns('UPDATE', 'app_user', ['state', 'auth_epoch']),
  ...columns('SELECT', 'external_identity', ['issuer', 'user_id', 'enabled']),
  ...columns('SELECT', 'oidc_provider', ['issuer', 'enabled']),
  'table:oidc_email_enrollment:INSERT',
  ...columns('SELECT', 'oidc_email_enrollment', ['user_id', 'expires_at']),
  // Owner privileges on its own view; logins only hold SELECT on it.
  ...tables(
    ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'],
    ['account_directory'],
  ),
  provisionAccount,
  reactivateAccount,
];

/** PostgreSQL 18 pg_get_viewdef output of the account projection installed by migration 013. */
export const accountDirectoryDefinition = ` SELECT u.id,
    u.email_canonical AS email,
    u.state,
        CASE
            WHEN (e.user_id IS NULL) THEN NULL::text
            WHEN (e.expires_at > statement_timestamp()) THEN 'pending'::text
            ELSE 'expired'::text
        END AS enrollment
   FROM (app_user u
     LEFT JOIN oidc_email_enrollment e ON ((e.user_id = u.id)))
  WHERE (u.kind = 'iam'::text);`;
