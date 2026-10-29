// Email accounts for Google first login. Real PostgreSQL logins, SECURITY DEFINER
// function, owner-rights projection, exact probes, ProductAuthorization provisioning/list and the
// OIDC first-login binding / link email rule against a signed RS256 fixture provider.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import * as oidc from 'openid-client';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  ProductAccessDenied,
  ProductAuthorization,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import { ProductAccountService } from '../dist/authorization/services/product-account.service.js';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import {
  ProductManifestReconciler,
  prepareProductRelease,
} from '../dist/authorization/services/product-manifest.service.js';
import {
  createProductAuthorizationCore,
  productBindings,
  productDeclarations,
  productReleaseSource,
} from '../dist/authorization/product.manifest.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
} from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
import { verifyProductPrivileges } from '../dist/database/services/product-privilege-verify.service.js';
import {
  ProductAuthenticationError,
  ProductIdentityService,
  newSessionSecret,
} from '../dist/authentication/services/product-identity.service.js';
import type { ProductOidcProvider } from '../dist/authentication/services/product-oidc-provider.service.js';
import { ProductOidcService } from '../dist/authentication/services/product-oidc.service.js';
import { bindAccount, bootstrapActiveRoot, oidcSession } from './oidc-fixture.helper.ts';
import { sqlState, startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();
const productObligations = createProductObligations(audit);

const core = createProductAuthorizationCore();
// Release 4 plus one account boundary, so the IAM path (grant + required boundary) exists.
const release = prepareProductRelease(
  {
    ...productReleaseSource,
    declarations: {
      ...productDeclarations,
      boundaries: [
        ...productDeclarations.boundaries,
        {
          key: 'accountAdmin',
          version: 1,
          entries: ['account.provision', 'account.read'].map((permission) => ({
            permission,
            contextRequirements: [],
            requiredScope: { op: 'constant', value: true },
          })),
        },
      ],
    },
  },
  core,
);
const validators = {
  'fresh@1': (_p: unknown, input: { context: { freshAuthentication?: unknown } }) =>
    input.context.freshAuthentication === true,
};

const utf8 = (value: string) => Buffer.from(value, 'utf8');

const issuer = 'https://issuer.fixture';
const otherIssuer = 'https://other-issuer.fixture';
const redirectUri = 'https://app.fixture/api/auth/oidc/callback';
const rootEmail = 'root@example.test';

let postgres: TestPostgres;
let pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;
let migration: DataSource;
let runner: ProductTransactionRunner;
let identity: ProductIdentityService;
let federation: ProductOidcService;
let authorization: ProductAuthorization;
let accounts: ProductAccountService;
let server: Server;
let rootId: IdentityId;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'fixture-key',
  alg: 'RS256',
  use: 'sig',
};
const codes = new Map<
  string,
  { nonce: string; challenge: string; claims: Record<string, unknown> }
>();
let tokenGate: (() => Promise<void>) | undefined;

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  const input = `${part({ alg: 'RS256', kid: 'fixture-key' })}.${part(claims)}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}

/** The provider's redirect back to the app for an authorization URL `begin` returned. */
function responseFor(url: URL, claims: Record<string, unknown>): URL {
  const code = randomBytes(16).toString('hex');
  codes.set(code, {
    nonce: url.searchParams.get('nonce') ?? '',
    challenge: url.searchParams.get('code_challenge') ?? '',
    claims,
  });
  const response = new URL(redirectUri);
  response.searchParams.set('state', url.searchParams.get('state') ?? '');
  response.searchParams.set('code', code);
  return response;
}

let attemptCounter = 0;

/** begin(login) + callback with these ID token claims; the session or the rejection. */
async function googleLogin(claims: Record<string, unknown>) {
  const browser = newSessionSecret();
  const start = await federation.begin(issuer, browser, {}, `login-${++attemptCounter}`);
  return federation.callback(issuer, responseFor(start, claims), browser);
}

const events = () =>
  withClient(
    postgres.superuser,
    async (c) =>
      (
        await c.query<{
          id: string;
          kind: string;
          actor: string;
          permission: string | null;
          metadata: Record<string, unknown>;
        }>(
          `SELECT event_id id,convert_from(event_kind,'UTF8') kind,actor_id::text actor,convert_from(permission_key,'UTF8') permission,safe_metadata metadata FROM audit_outbox`,
        )
      ).rows,
  );

/** Events appended by `work`, as [kind, actor, permission, metadata], sorted by kind. */
async function appended(work: () => Promise<unknown>) {
  const seen = new Set((await events()).map((e) => e.id));
  await work();
  return (await events())
    .filter((e) => !seen.has(e.id))
    .map((e) => [e.kind, e.actor, e.permission, e.metadata] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

const revision = async () =>
  (await migration.query<{ r: string }[]>('SELECT revision::text r FROM authz_state'))[0]?.r;

const accountByEmail = (email: string) =>
  migration.query<{ id: string; state: string; kind: string }[]>(
    'SELECT id::text,state,kind FROM app_user WHERE email_canonical=$1',
    [email],
  );

const enrollmentOf = (email: string) =>
  migration.query<{ user_id: string; issuer: string; window: string; created_by: string }[]>(
    `SELECT user_id::text,issuer,(expires_at-created_at)::text "window",created_by::text FROM oidc_email_enrollment WHERE email_canonical=$1`,
    [email],
  );

/** Root session with a step-up 5 s ago, as a 2FA verify leaves it. */
async function freshRoot(): Promise<string> {
  return oidcSession(pools.identity, rootId, { fresh: true });
}

/** Active IAM account with one Google binding and a session, fresh when asked. */
async function iamUser(options: { fresh?: boolean; email?: string | null } = {}) {
  const id = randomUUID() as IdentityId;
  await migration.query(
    `INSERT INTO app_user(id,email_canonical,state,email_verified) VALUES($1,$2,'active',true)`,
    [id, options.email ?? null],
  );
  await bindAccount(pools.identity, id, `sub-${id}`, issuer);
  const secret = await oidcSession(pools.identity, id, { fresh: options.fresh === true });
  return { id, secret };
}

const grant = async (user: string, permission: string, boundary: boolean) => {
  await migration.query(
    "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
    [randomUUID(), utf8(permission), user, utf8('allAccounts')],
  );
  if (boundary)
    await runner.run('admin', (tx) =>
      tx.manager.query(
        'INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,$2,$3,1)',
        [user, utf8(permission), utf8('accountAdmin')],
      ),
    );
};

/** Provision directly through the definer, as the data login (fixture setup). */
const definer = (email: string, at = issuer, user: string = randomUUID()) =>
  pools.data.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', [user, email, at, rootId]);

before(async () => {
  postgres = await startPostgres();
  const passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'bootstrap', 'migration', 'outbox'].map((p) => [
      p,
      randomBytes(20).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  const connections = await provisionProductDatabase(postgres.superuser, passwords);
  pools = {} as typeof pools;
  for (const purpose of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const)
    pools[purpose] = await new DataSource(
      productDataSourceOptions(connections[purpose]),
    ).initialize();
  migration = await new DataSource(productDataSourceOptions(connections.migration)).initialize();
  runner = new ProductTransactionRunner(pools);
  identity = new ProductIdentityService(runner, audit);
  await new ProductManifestReconciler(runner, audit, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: release.declarations.capabilities,
  }).reconcile(release);
  const bindings = new ProductBindingRegistry(core, release.declarations, productBindings);
  authorization = new ProductAuthorization(runner, audit, bindings, {
    validators,
    obligations: productObligations,
  });
  accounts = new ProductAccountService(authorization, audit, bindings);
  for (const at of [issuer, otherIssuer])
    await migration.query('INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)', [
      at,
    ]);
  await migration.query(
    "INSERT INTO oidc_provider(issuer,version,enabled) VALUES('https://disabled.fixture',1,false)",
  );
  ({ userId: rootId } = await bootstrapActiveRoot(runner, release, pools.identity, rootEmail, {
    issuer,
  }));

  server = createServer((req, res) => {
    (async () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/jwks') return void res.end(JSON.stringify({ keys: [jwk] }));
      if (req.url !== '/token') return void res.writeHead(404).end();
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const input = new URLSearchParams(body);
      const code = input.get('code') ?? '';
      const attempt = codes.get(code);
      if (
        !attempt ||
        createHash('sha256')
          .update(input.get('code_verifier') ?? '')
          .digest('base64url') !== attempt.challenge
      )
        return void res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
      codes.delete(code);
      await tokenGate?.();
      const now = Math.floor(Date.now() / 1000);
      res.end(
        JSON.stringify({
          access_token: 'fixture-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: jwt({
            iss: issuer,
            aud: 'fixture-client',
            iat: now,
            exp: now + 300,
            auth_time: now,
            nonce: attempt.nonce,
            ...attempt.claims,
          }),
        }),
      );
    })().catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const configuration = new oidc.Configuration(
    {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      id_token_signing_alg_values_supported: ['RS256'],
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
    },
    'fixture-client',
    { id_token_signed_response_alg: 'RS256' },
    oidc.None(),
  );
  configuration[oidc.customFetch] = (input, init) => {
    const target = new URL(input);
    return fetch(`http://127.0.0.1:${port}${target.pathname}`, {
      ...init,
      body: init.body instanceof URLSearchParams ? init.body.toString() : init.body,
    } as RequestInit);
  };
  const provider: ProductOidcProvider = {
    settings: {
      issuer,
      clientId: 'fixture-client',
      redirectUri,
      version: '1',
      assuranceMappings: [],
    },
    configuration,
  };
  federation = new ProductOidcService(identity, new Map([[issuer, provider]]));
});

after(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await migration?.destroy();
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await postgres?.stop();
});

test('migration 013 grants exactly what the probes expect; logins reach emails only through the projection', async () => {
  await verifyProductPrivileges({
    data: pools.data,
    identity: pools.identity,
    authority: pools.authority,
    sync: pools.sync,
  });
  for (const statement of [
    'SELECT email_canonical FROM app_user',
    'SELECT * FROM oidc_email_enrollment',
    `INSERT INTO app_user(id,state) VALUES(gen_random_uuid(),'pending')`,
  ])
    assert.equal(await sqlState(pools.data.query(statement)), '42501', statement);
  // Only the data login may call the definer.
  for (const pool of [pools.identity, pools.authority, pools.sync, pools.bootstrap])
    assert.equal(
      await sqlState(
        pool.query(
          'SELECT public.provision_oidc_account(gen_random_uuid(),$1,$2,gen_random_uuid())',
          ['x@example.test', issuer],
        ),
      ),
      '42501',
    );
  // The authority login reads the projection for suspend, never the raw email column.
  assert.equal(
    await sqlState(pools.authority.query('SELECT email_canonical FROM app_user')),
    '42501',
  );
  assert.deepEqual(await pools.authority.query('SELECT id FROM account_directory WHERE false'), []);
  // The identity login cannot rewrite enrollments (no UPDATE): consume = DELETE only.
  assert.equal(
    await sqlState(pools.identity.query('UPDATE oidc_email_enrollment SET expires_at=now()')),
    '42501',
  );
});

test('protection probe fails closed on definer, projection and owner-ACL drift', async () => {
  await withClient(postgres.superuser, async (client) => {
    for (const [alter, restore] of [
      [
        'ALTER FUNCTION public.provision_oidc_account(uuid,text,text,uuid) OWNER TO product_object_owner',
        'ALTER FUNCTION public.provision_oidc_account(uuid,text,text,uuid) OWNER TO product_account_owner',
      ],
      [
        'ALTER FUNCTION public.provision_oidc_account(uuid,text,text,uuid) SET search_path=public',
        'ALTER FUNCTION public.provision_oidc_account(uuid,text,text,uuid) SET search_path=pg_catalog,pg_temp',
      ],
      [
        'ALTER VIEW public.account_directory RESET (security_barrier)',
        'ALTER VIEW public.account_directory SET (security_barrier=true)',
      ],
      [
        'ALTER VIEW public.account_directory SET (security_invoker=true)',
        'ALTER VIEW public.account_directory RESET (security_invoker)',
      ],
      [
        'ALTER VIEW public.account_directory OWNER TO product_migration',
        'ALTER VIEW public.account_directory OWNER TO product_account_owner',
      ],
      [
        `CREATE OR REPLACE VIEW public.account_directory WITH (security_barrier=true) AS SELECT u.id, u.email_canonical AS email, u.state, NULL::text AS enrollment FROM public.app_user u`,
        `CREATE OR REPLACE VIEW public.account_directory WITH (security_barrier=true) AS SELECT u.id, u.email_canonical AS email, u.state, CASE WHEN e.user_id IS NULL THEN NULL WHEN e.expires_at > statement_timestamp() THEN 'pending' ELSE 'expired' END AS enrollment FROM public.app_user u LEFT JOIN public.oidc_email_enrollment e ON e.user_id = u.id WHERE u.kind = 'iam'`,
      ],
      // Migration 021 widened the owner to SELECT(auth_epoch) and UPDATE(state, auth_epoch) for
      // reactivate_iam_account; anything beyond that, or less, is drift.
      [
        'GRANT SELECT(email_verified) ON app_user TO product_account_owner',
        'REVOKE SELECT(email_verified) ON app_user FROM product_account_owner',
      ],
      [
        'GRANT UPDATE(email_canonical) ON app_user TO product_account_owner',
        'REVOKE UPDATE(email_canonical) ON app_user FROM product_account_owner',
      ],
      [
        'REVOKE UPDATE(auth_epoch) ON app_user FROM product_account_owner',
        'GRANT UPDATE(auth_epoch) ON app_user TO product_account_owner',
      ],
      [
        'GRANT UPDATE(enabled) ON external_identity TO product_account_owner',
        'REVOKE UPDATE(enabled) ON external_identity FROM product_account_owner',
      ],
      [
        'ALTER FUNCTION public.reactivate_iam_account(uuid) OWNER TO product_object_owner',
        'ALTER FUNCTION public.reactivate_iam_account(uuid) OWNER TO product_account_owner',
      ],
      [
        'ALTER FUNCTION public.reactivate_iam_account(uuid) SET search_path=public',
        'ALTER FUNCTION public.reactivate_iam_account(uuid) SET search_path=pg_catalog,pg_temp',
      ],
      [
        'ALTER FUNCTION public.reactivate_iam_account(uuid) SECURITY INVOKER',
        'ALTER FUNCTION public.reactivate_iam_account(uuid) SECURITY DEFINER',
      ],
      ['ALTER ROLE product_account_owner LOGIN', 'ALTER ROLE product_account_owner NOLOGIN'],
    ] as const) {
      await client.query(alter);
      await assert.rejects(
        verifyProductPrivileges({ data: pools.data }),
        /Product protection drift/,
        alter,
      );
      await client.query(restore);
    }
  });
  // EXECUTE of the un-suspend definer belongs to the authority login alone.
  await withClient(postgres.superuser, async (client) => {
    await client.query(
      'GRANT EXECUTE ON FUNCTION public.reactivate_iam_account(uuid) TO product_data',
    );
    await assert.rejects(verifyProductPrivileges({ data: pools.data }), /Product privilege drift/);
    await client.query(
      'REVOKE EXECUTE ON FUNCTION public.reactivate_iam_account(uuid) FROM product_data',
    );
    await client.query(
      'REVOKE EXECUTE ON FUNCTION public.reactivate_iam_account(uuid) FROM product_authority',
    );
    await assert.rejects(
      verifyProductPrivileges({ authority: pools.authority }),
      /Product privilege drift/,
    );
    await client.query(
      'GRANT EXECUTE ON FUNCTION public.reactivate_iam_account(uuid) TO product_authority',
    );
  });
  await verifyProductPrivileges({ data: pools.data, authority: pools.authority });
});

test('the definer validates input, needs an enabled issuer, never touches existing accounts', async () => {
  const before = await revision();
  for (const [email, at] of [
    [null, issuer],
    ['Upper@example.test', issuer],
    ['no-at-sign.example.test', issuer],
    ['space in@example.test', issuer],
    [`${'a'.repeat(250)}@x.test`, issuer],
    ['ok@example.test', null],
    ['ok@example.test', 'https://unknown.fixture'],
    ['ok@example.test', 'https://disabled.fixture'],
  ] as const)
    assert.equal(
      await sqlState(
        pools.data.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', [
          randomUUID(),
          email,
          at,
          rootId,
        ]),
      ),
      '22023',
      `${String(email)} ${String(at)}`,
    );
  for (const args of [
    [null, 'ok@example.test', issuer, rootId],
    [randomUUID(), 'ok@example.test', issuer, null],
  ])
    assert.equal(
      await sqlState(pools.data.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', args)),
      '22023',
    );
  await definer('window@example.test');
  const [row] = await enrollmentOf('window@example.test');
  // Exactly 7 days on the DB clock, the actor recorded, the account pending IAM.
  assert.equal(row?.window, '7 days');
  assert.equal(row?.created_by, rootId);
  assert.deepEqual(
    (await accountByEmail('window@example.test')).map(({ state, kind }) => ({ state, kind })),
    [{ state: 'pending', kind: 'iam' }],
  );
  // A taken email (enrolled, or any existing account such as Root) and a taken id are 23505;
  // nothing is changed.
  assert.equal(await sqlState(definer('window@example.test')), '23505');
  assert.equal(await sqlState(definer('window@example.test', otherIssuer)), '23505');
  assert.equal(await sqlState(definer(rootEmail)), '23505');
  assert.equal(await sqlState(definer('fresh-id@example.test', issuer, rootId)), '23505');
  assert.equal((await accountByEmail('fresh-id@example.test')).length, 0);
  assert.equal(await revision(), before);
});

test('Root provisions with fresh reauthentication only; audit carries the id, never the email', async () => {
  const email = 'Root-Added@Example.test';
  const stale = await oidcSession(pools.identity, rootId);
  assert.deepEqual(
    await appended(() =>
      assert.rejects(accounts.provisionAccount(stale, email, issuer), ProductAccessDenied),
    ),
    [],
  );
  const fresh = await freshRoot();
  const before = await revision();
  let created: Awaited<ReturnType<ProductAccountService['provisionAccount']>> | undefined;
  const added = await appended(async () => {
    created = await accounts.provisionAccount(fresh, email, issuer);
  });
  assert.ok(created);
  assert.deepEqual(
    { email: created.email, state: created.state, enrollment: created.enrollment },
    { email: 'root-added@example.test', state: 'pending', enrollment: 'pending' },
  );
  assert.deepEqual(added, [
    [
      'account.provision',
      rootId,
      'account.provision',
      {
        principalKind: 'root',
        outcome: 'ok',
        targetUserId: created.key,
        resultingRevision: before,
      },
    ],
  ]);
  assert.equal(JSON.stringify(added).includes('example.test'), false);
  // `write` mode: no fence revision change for a pending, grantless account.
  assert.equal(await revision(), before);
  // Duplicate (any case) is a command rejection (409) and leaves nothing behind.
  assert.deepEqual(
    await appended(() =>
      assert.rejects(
        accounts.provisionAccount(fresh, 'ROOT-ADDED@example.test', issuer),
        ProductCommandRejected,
      ),
    ),
    [],
  );
  for (const bad of ['', 'not-an-email', 'a b@example.test', `${'x'.repeat(250)}@x.test`])
    await assert.rejects(accounts.provisionAccount(fresh, bad, issuer), ProductInvalidRequest);
  // Root lists accounts with emails (one audited access); Root itself is not listed.
  const listed = await appended(async () => {
    const page = await authorization.list(fresh, 'account', 'read', { orderBy: 'email' });
    assert.ok(page.items.some((item) => item.email === 'root-added@example.test'));
    assert.ok(page.items.every((item) => item.key !== rootId));
  });
  assert.deepEqual(listed, [
    ['access.account.read', rootId, 'account.read', { principalKind: 'root', outcome: 'ok' }],
  ]);
  assert.equal(await authorization.permits(stale, 'account', 'read'), true);
  // Cancel = suspend; the projection then shows it suspended.
  assert.equal(await accounts.suspendUser(fresh, created.key), true);
  const [account] = (
    await authorization.list(fresh, 'account', 'read', { limit: 100 })
  ).items.filter((item) => item.key === created?.key);
  assert.deepEqual(account?.state, 'suspended');
});

test('IAM provisioning needs a grant, a boundary and fresh reauthentication', async () => {
  const none = await iamUser({ fresh: true });
  const unbounded = await iamUser({ fresh: true });
  const admin = await iamUser({ fresh: true });
  const staleAdmin = await iamUser();
  await grant(unbounded.id, 'account.provision', false);
  for (const user of [admin.id, staleAdmin.id]) {
    await grant(user, 'account.provision', true);
    await grant(user, 'account.read', true);
  }
  for (const [label, secret] of [
    ['no grant', none.secret],
    ['no boundary', unbounded.secret],
    ['not fresh', staleAdmin.secret],
  ] as const) {
    assert.deepEqual(
      await appended(() =>
        assert.rejects(
          accounts.provisionAccount(secret, `${label.replace(' ', '-')}@example.test`, issuer),
          ProductAccessDenied,
          label,
        ),
      ),
      [],
    );
    assert.equal((await accountByEmail(`${label.replace(' ', '-')}@example.test`)).length, 0);
  }
  assert.equal(await authorization.permits(none.secret, 'account', 'read'), false);
  // No grant: the plan matches nothing (design §5.3), an empty page rather than an error.
  assert.deepEqual(await authorization.list(none.secret, 'account', 'read'), {
    items: [],
    total: '0',
  });
  assert.equal(await authorization.permits(staleAdmin.secret, 'account', 'read'), true);
  let created: Awaited<ReturnType<ProductAccountService['provisionAccount']>> | undefined;
  const added = await appended(async () => {
    created = await accounts.provisionAccount(admin.secret, 'iam-added@example.test', issuer);
  });
  assert.ok(created);
  assert.deepEqual(added, [
    ['access.provision', admin.id, 'account.provision', {}],
    [
      'account.provision',
      admin.id,
      'account.provision',
      { targetUserId: created.key, resultingRevision: await revision() },
    ],
  ]);
});

test('a failing audit write rolls the new account back', async () => {
  const fresh = await freshRoot();
  await withClient(postgres.superuser, (c) =>
    c.query('REVOKE INSERT ON audit_outbox FROM product_data'),
  );
  try {
    await assert.rejects(accounts.provisionAccount(fresh, 'rollback@example.test', issuer));
  } finally {
    await withClient(postgres.superuser, (c) =>
      c.query('GRANT INSERT ON audit_outbox TO product_data'),
    );
  }
  assert.equal((await accountByEmail('rollback@example.test')).length, 0);
  assert.equal((await enrollmentOf('rollback@example.test')).length, 0);
});

const verified = (sub: string, email: string) => ({ sub, email, email_verified: true });

test('first verified Google login binds the enrolled email once; later logins use (issuer, sub) only', async () => {
  const email = 'employee@example.test';
  await definer(email);
  const [{ id } = { id: '' }] = await accountByEmail(email);
  let session: Awaited<ReturnType<typeof googleLogin>> | undefined;
  const added = await appended(async () => {
    session = await googleLogin(verified('employee-sub', 'Employee@Example.test'));
  });
  assert.ok(session);
  assert.deepEqual(
    added.map(([kind, actor]) => [kind, actor]),
    [
      ['identity.oidc-activation', id],
      ['identity.oidc-login', id],
    ],
  );
  assert.equal(JSON.stringify(added).includes('example.test'), false);
  assert.deepEqual(
    (await accountByEmail(email)).map(({ state }) => state),
    ['active'],
  );
  assert.deepEqual(await enrollmentOf(email), []);
  assert.deepEqual(
    await migration.query('SELECT subject FROM external_identity WHERE user_id=$1', [id]),
    [{ subject: 'employee-sub' }],
  );
  // The verified claim that matched the enrolled email verifies it in the binding commit.
  const [bound] = await migration.query<{ verified: boolean; epoch: string }[]>(
    'SELECT email_verified verified,auth_epoch::text epoch FROM app_user WHERE id=$1',
    [id],
  );
  assert.equal(bound?.verified, true);
  // The bound subject signs in without any email claim; a changed Google email is irrelevant.
  assert.ok(await googleLogin({ sub: 'employee-sub' }));
  assert.ok(await googleLogin(verified('employee-sub', email)));
  assert.equal(
    (
      await migration.query<{ epoch: string }[]>(
        'SELECT auth_epoch::text epoch FROM app_user WHERE id=$1',
        [id],
      )
    )[0]?.epoch,
    bound?.epoch,
  );
  assert.ok(await googleLogin(verified('employee-sub', 'renamed@example.test')));
  // Another Google account with the same verified email is never re-bound to the active account.
  await assert.rejects(googleLogin(verified('other-sub', email)), ProductAuthenticationError);
  assert.equal(
    (
      await migration.query<unknown[]>('SELECT 1 FROM external_identity WHERE subject=$1', [
        'other-sub',
      ])
    ).length,
    0,
  );
});

test('unenrolled, unverified, missing, foreign-issuer, expired or suspended enrollments are refused', async () => {
  await assert.rejects(
    googleLogin(verified('stranger-sub', 'stranger@example.test')),
    ProductAuthenticationError,
  );
  const email = 'careful@example.test';
  await definer(email);
  for (const claims of [
    { sub: 'careful-sub', email, email_verified: false },
    { sub: 'careful-sub', email, email_verified: 'true' },
    { sub: 'careful-sub', email },
    { sub: 'careful-sub', email_verified: true },
    { sub: 'careful-sub', email: 'not an email', email_verified: true },
  ])
    await assert.rejects(googleLogin(claims), ProductAuthenticationError, JSON.stringify(claims));
  assert.equal((await enrollmentOf(email)).length, 1);
  // Enrolled at another issuer only.
  await definer('elsewhere@example.test', otherIssuer);
  await assert.rejects(
    googleLogin(verified('elsewhere-sub', 'elsewhere@example.test')),
    ProductAuthenticationError,
  );
  // Expiry is exclusive on the DB clock: a deadline already reached refuses, a live one binds.
  await definer('late@example.test');
  await withClient(postgres.superuser, (c) =>
    c.query(
      `UPDATE oidc_email_enrollment SET created_at=statement_timestamp()-interval '7 days',expires_at=statement_timestamp() WHERE email_canonical='late@example.test'`,
    ),
  );
  await assert.rejects(
    googleLogin(verified('late-sub', 'late@example.test')),
    ProductAuthenticationError,
  );
  await withClient(postgres.superuser, (c) =>
    c.query(
      `UPDATE oidc_email_enrollment SET created_at=statement_timestamp()-interval '7 days',expires_at=statement_timestamp()+interval '1 minute' WHERE email_canonical='late@example.test'`,
    ),
  );
  assert.ok(await googleLogin(verified('late-sub', 'late@example.test')));
  // A suspended (cancelled) pending account cannot be claimed.
  await definer('cancelled@example.test');
  const fresh = await freshRoot();
  const [cancelled] = await accountByEmail('cancelled@example.test');
  assert.equal(await accounts.suspendUser(fresh, cancelled?.id ?? ''), true);
  await assert.rejects(
    googleLogin(verified('cancelled-sub', 'cancelled@example.test')),
    ProductAuthenticationError,
  );
});

test('two concurrent first logins of one email bind exactly one subject', async () => {
  const email = 'race@example.test';
  await definer(email);
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  tokenGate = async () => {
    if (++arrived === 2) open();
    await gate;
  };
  try {
    const results = await Promise.allSettled([
      googleLogin(verified('race-a', email)),
      googleLogin(verified('race-b', email)),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.ok(rejected.reason instanceof ProductAuthenticationError, String(rejected.reason));
  } finally {
    tokenGate = undefined;
  }
  const [account] = await accountByEmail(email);
  assert.equal(
    (
      await migration.query<unknown[]>('SELECT 1 FROM external_identity WHERE user_id=$1', [
        account?.id,
      ])
    ).length,
    1,
  );
});

test('a replayed callback is refused and changes nothing', async () => {
  const email = 'replay@example.test';
  await definer(email);
  const browser = newSessionSecret();
  const start = await federation.begin(issuer, browser, {}, 'replay');
  const callback = responseFor(start, verified('replay-sub', email));
  assert.ok(await federation.callback(issuer, callback, browser));
  await assert.rejects(federation.callback(issuer, callback, browser), ProductAuthenticationError);
});
