// account.changeEmail / resetMfa / resetGoogleBinding (ADR-15 D11) through the service on real
// PostgreSQL: the actor matrix, the order of the checks (what each refusal may reveal), the
// invariants (a) self, (b) Root, (d) grants within, the 409 cases and the audit. One file.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ProductAccessDenied,
  ProductAuthorization,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import { ProductIdentityOperationService } from '../dist/authorization/services/product-identity-operation.service.js';
import { sessionDigest } from '../dist/authentication/services/product-identity.service.js';
import {
  ProductAuditRepository,
  type ProductAuditEvent,
} from '../dist/audit/product-audit.repository.js';
import type { ProductTransaction } from '../dist/database/product-transaction.runner.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { FIXTURE_ISSUER, bindAccount, oidcSession } from './oidc-fixture.helper.ts';
import {
  appended,
  bindAccountBoundary,
  bindings,
  boundaryBindings,
  freshRoot,
  grantViaRole,
  iamUser,
  identityOperations,
  migration,
  pools,
  revision,
  root,
  runner,
  setupStack,
  teardownStack,
  utf8,
  validators,
} from './product-root-stack.helper.ts';

before(setupStack);
after(teardownStack);

interface Command {
  readonly name: 'changeEmail' | 'resetMfa' | 'resetGoogleBinding';
  readonly permission: string;
  readonly kind: string;

  readonly run: (secret: string, id: string) => Promise<boolean>;

  readonly target: (options?: Seed) => Promise<{ id: string; email: string }>;
}

interface Seed {
  readonly state?: 'pending' | 'active' | 'suspended';
  readonly email?: string | null;
  readonly factor?: boolean;
}

async function seed(options: Seed = {}) {
  const id = randomUUID();
  const state = options.state ?? 'active';
  const email = options.email === undefined ? `${id}@example.test` : options.email;
  await migration.query(
    'INSERT INTO app_user(id,email_canonical,state,email_verified) VALUES($1,$2,$3,$4)',
    [id, email, state, state === 'active'],
  );
  if (state !== 'pending') await bindAccount(pools.identity, id);
  if (options.factor ?? true) await factor(id);
  return { id, email: email as string };
}

async function factor(id: string, recoveryCodes = 2) {
  await migration.query(
    `INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id) VALUES($1,decode(repeat('ab',36),'hex'),decode(repeat('cd',12),'hex'),'k1')`,
    [id],
  );
  await migration.query('UPDATE mfa_totp SET confirmed_at=statement_timestamp() WHERE user_id=$1', [
    id,
  ]);
  for (let i = 0; i < recoveryCodes; i += 1)
    await migration.query('INSERT INTO mfa_recovery_code(user_id,code_hash) VALUES($1,$2)', [
      id,
      Buffer.alloc(32, i + 1),
    ]);
}

const commands: readonly Command[] = [
  {
    name: 'changeEmail',
    permission: 'account.changeEmail',
    kind: 'identity.email-change',
    run: (secret, id) =>
      identityOperations().changeEmail(
        secret,
        id,
        `New-${randomUUID()}@Example.test`,
        FIXTURE_ISSUER,
      ),
    target: seed,
  },
  {
    name: 'resetMfa',
    permission: 'account.resetMfa',
    kind: 'identity.mfa-reset-by-permission',
    run: (secret, id) => identityOperations().resetMfa(secret, id),
    target: seed,
  },
  {
    name: 'resetGoogleBinding',
    permission: 'account.resetGoogleBinding',
    kind: 'identity.binding-reset',
    run: (secret, id) => identityOperations().resetGoogleBinding(secret, id, FIXTURE_ISSUER),
    target: seed,
  },
];

/** Everything the three commands can touch, for "nothing changed". */
async function snapshot(id: string) {
  return {
    user: await migration.query<
      { email_canonical: string | null; email_verified: boolean; state: string; epoch: string }[]
    >(
      'SELECT email_canonical,email_verified,state,auth_epoch::text epoch FROM app_user WHERE id=$1',
      [id],
    ),
    bindings: await migration.query<{ subject: string; enabled: boolean; version: string }[]>(
      'SELECT subject,enabled,binding_version::text version FROM external_identity WHERE user_id=$1 ORDER BY subject',
      [id],
    ),
    factors: await migration.query<{ totp: string; codes: string }[]>(
      `SELECT (SELECT count(*) FROM mfa_totp WHERE user_id=$1)::text totp,(SELECT count(*) FROM mfa_recovery_code WHERE user_id=$1)::text codes`,
      [id],
    ),
    enrollment: await migration.query<{ issuer: string; email_canonical: string }[]>(
      'SELECT issuer,email_canonical FROM oidc_email_enrollment WHERE user_id=$1',
      [id],
    ),
  };
}

const epoch = async (id: string) =>
  Number(
    (
      await migration.query<{ e: string }[]>(
        'SELECT auth_epoch::text e FROM app_user WHERE id=$1',
        [id],
      )
    )[0]?.e,
  );

/** An IAM actor holding the permission through a role; the boundary and a fresh session on request. */
async function actor(
  permission: string,
  options: { fresh?: boolean; boundary?: boolean; grant?: boolean; more?: string[] } = {},
) {
  const user = await iamUser(options.fresh ?? true);
  if (options.grant ?? true) await grantViaRole(user.id, [permission, ...(options.more ?? [])]);
  if (options.boundary ?? true)
    await bindAccountBoundary(user.id, [permission], 'identityAdministration');
  return user;
}

for (const c of commands) {
  /** Refused with `false`/an error, and not a trace: same state, no event, same revision. */
  const untouched = async (id: string, work: () => Promise<unknown>) => {
    const before = await snapshot(id);
    const result = await appended(work);
    assert.deepEqual(await snapshot(id), before);
    return result;
  };

  test(`${c.name}: Root acts on an IAM account; the audit event is marked root and carries ids only`, async () => {
    const target = await c.target();
    const before = await epoch(target.id);
    const fresh = await freshRoot();
    const done = await appended(async () => assert.equal(await c.run(fresh, target.id), true));
    assert.deepEqual(done.added, [
      [
        c.kind,
        root.id,
        c.permission,
        null,
        {
          principalKind: 'root',
          outcome: 'ok',
          targetUserId: target.id,
          resultingRevision: done.after,
        },
      ],
    ]);
    assert.ok((await epoch(target.id)) > before);
    assert.equal(done.after, String(BigInt(done.before) + 1n));
    // A Root session without a step-up is refused before any effect (fresh@1).
    const other = await c.target();
    const stale = await untouched(other.id, () =>
      assert.rejects(c.run(root.stale, other.id), ProductAccessDenied),
    );
    assert.deepEqual(stale.added, []);
    assert.equal(stale.after, stale.before);
  });

  test(`${c.name}: an IAM actor with the grant, the boundary and a fresh session acts; the audit holds ids only`, async () => {
    const admin = await actor(c.permission);
    const target = await c.target();
    const before = await epoch(target.id);
    const emailBefore = target.email;
    const done = await appended(async () =>
      assert.equal(await c.run(admin.secret, target.id), true),
    );
    assert.deepEqual(done.added, [
      [`access.${c.name}`, admin.id, c.permission, null, {}],
      [
        c.kind,
        admin.id,
        c.permission,
        null,
        { targetUserId: target.id, resultingRevision: done.after },
      ],
    ]);
    assert.ok((await epoch(target.id)) > before);
    // No address, subject or binding reference in anything the audit stored.
    const stored = JSON.stringify(
      await migration.query('SELECT event_kind,safe_metadata,reason FROM audit_outbox'),
    );
    assert.equal(stored.includes(emailBefore), false);
    assert.equal(stored.includes(`sub-${target.id}`), false);
    assert.equal(stored.includes('example.test'), false);
    assert.equal(stored.includes(FIXTURE_ISSUER), false);
  });

  test(`${c.name}: IAM actor matrix: no boundary binding, a binding of another identity permission, a stale session are 403; a binding without a grant reaches nothing (404); none leaves a trace`, async () => {
    const noBoundary = await actor(c.permission, { boundary: false });
    const noGrant = await actor(c.permission, { grant: false });
    const stale = await actor(c.permission, { fresh: false });
    const otherPermission = commands.find((x) => x !== c)!.permission;
    const wrongBinding = await actor(c.permission, { boundary: false });
    await bindAccountBoundary(wrongBinding.id, [otherPermission], 'identityAdministration');
    const nothing = await iamUser(true);
    const target = await c.target();
    for (const who of [noBoundary, stale, wrongBinding, nothing]) {
      const refused = await untouched(target.id, () =>
        assert.rejects(c.run(who.secret, target.id), ProductAccessDenied),
      );
      assert.deepEqual(refused.added, []);
      assert.equal(refused.after, refused.before);
    }
    // A binding without a grant reaches nothing: the same answer as an absent account, no trace.
    const unreached = await untouched(target.id, async () =>
      assert.equal(await c.run(noGrant.secret, target.id), false),
    );
    assert.deepEqual(unreached.added, []);
    assert.equal(unreached.after, unreached.before);
  });

  test(`${c.name}: a non-canonical id is 403 before any query, even with an invalid email`, async () => {
    const admin = await actor(c.permission);
    const target = await c.target();
    for (const secret of [admin.secret, await freshRoot()]) {
      const refused = await appended(async () => {
        await assert.rejects(c.run(secret, target.id.toUpperCase()), ProductAccessDenied);
        await assert.rejects(c.run(secret, 'not-a-uuid'), ProductAccessDenied);
      });
      assert.deepEqual(refused.added, []);
      assert.equal(refused.after, refused.before);
    }
    await assert.rejects(
      identityOperations().changeEmail(admin.secret, 'not-a-uuid', 'bad', FIXTURE_ISSUER),
      ProductAccessDenied,
    );
  });

  test(`${c.name}: Root and absent targets are the same "not found"; an IAM caller leaves no trace and a Root caller is audited as absent`, async () => {
    const admin = await actor(c.permission);
    const fresh = await freshRoot();
    for (const target of [root.id, randomUUID()]) {
      const iam = await appended(async () =>
        assert.equal(await c.run(admin.secret, target), false),
      );
      assert.deepEqual(iam.added, []);
      assert.equal(
        iam.after,
        iam.before,
        'the shared-fence pre-check never takes the exclusive fence',
      );
      const asRoot = await appended(async () => assert.equal(await c.run(fresh, target), false));
      assert.equal(asRoot.added.length, 1);
      assert.deepEqual(asRoot.added[0]?.slice(0, 3), [c.kind, root.id, c.permission]);
      assert.equal(asRoot.added[0]?.[4].outcome, 'absent');
      assert.equal(asRoot.added[0]?.[4].principalKind, 'root');
    }
    const rootRow = await snapshot(root.id);
    assert.equal(await c.run(fresh, root.id), false);
    assert.deepEqual(await snapshot(root.id), rootRow);
  });

  test(`${c.name}: (a) oneself is 403 for an IAM actor; Root has no account to act on`, async () => {
    const admin = await actor(c.permission);
    const own = await snapshot(admin.id);
    const refused = await appended(() =>
      assert.rejects(c.run(admin.secret, admin.id), ProductAccessDenied),
    );
    assert.deepEqual(refused.added, []);
    assert.equal(refused.after, refused.before);
    assert.deepEqual(await snapshot(admin.id), own);
  });

  test(`${c.name}: (d) a target with a grant outside the actor set is "not found"; revoking it is seen at once`, async () => {
    const admin = await actor(c.permission);
    const larger = await c.target();
    await grantViaRole(larger.id, [c.permission, 'account.provision']);
    const refused = await untouched(larger.id, async () =>
      assert.equal(await c.run(admin.secret, larger.id), false),
    );
    assert.deepEqual(
      refused.added.filter((e) => e[0] === c.kind),
      [],
    );
    await migration.query(
      `DELETE FROM user_role WHERE user_id=$1 AND role_key IN (SELECT role_key FROM policy_rule WHERE permission_key=$2)`,
      [larger.id, utf8('account.provision')],
    );
    assert.equal(await c.run(admin.secret, larger.id), true);
  });

  test(`${c.name}: (d) a deny, a rule on the user, another template and a cut-off read are "not found"; Root bypasses them`, async () => {
    const admin = await actor(c.permission);
    const denied = await c.target();
    await grantViaRole(denied.id, [{ permission: c.permission, effect: 'deny' }]);
    const userRule = await c.target();
    await migration.query(
      "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow','allAccounts',1,'{}','runtime')",
      [randomUUID(), utf8(c.permission), userRule.id],
    );
    const template = await c.target();
    await grantViaRole(template.id, [{ permission: c.permission, template: 'setting' }]);
    const cut = await c.target();
    const role = await grantViaRole(cut.id, [c.permission]);
    await migration.query(
      `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
       SELECT gen_random_uuid(), $1, $2, 'allow', $3, 1, jsonb_build_object('i', g), 'runtime' FROM generate_series(1, 20001) g`,
      [utf8('account.read'), utf8(role), utf8('allAccounts')],
    );
    for (const target of [denied, userRule, template, cut])
      await untouched(target.id, async () =>
        assert.equal(await c.run(admin.secret, target.id), false),
      );
    // The actor's own set must be provable as well: a deny of its own refuses every target.
    const tainted = await actor(c.permission, {});
    await grantViaRole(tainted.id, [{ permission: 'account.read', effect: 'deny' }]);
    const plain = await c.target();
    await untouched(plain.id, async () =>
      assert.equal(await c.run(tainted.secret, plain.id), false),
    );
    const fresh = await freshRoot();
    for (const target of [denied, userRule, template, cut])
      assert.equal(await c.run(fresh, target.id), true);
  });
}

test('changeEmail: the new email is lowercased and unverified; a pending account moves its invitation, an active one has none', async () => {
  const fresh = await freshRoot();
  const active = await seed();
  assert.equal(
    await identityOperations().changeEmail(
      fresh,
      active.id,
      'MiXed.Case@Example.TEST',
      FIXTURE_ISSUER,
    ),
    true,
  );
  assert.deepEqual((await snapshot(active.id)).user[0]?.email_canonical, 'mixed.case@example.test');
  assert.equal((await snapshot(active.id)).user[0]?.email_verified, false);
  assert.deepEqual((await snapshot(active.id)).enrollment, []);
  const pending = await seed({ state: 'pending', factor: false });
  await migration.query(
    `INSERT INTO oidc_email_enrollment(user_id,issuer,email_canonical,expires_at,created_by)
     VALUES($1,$2,$3,statement_timestamp()+interval '1 day',$4)`,
    [pending.id, FIXTURE_ISSUER, pending.email, root.id],
  );
  assert.equal(
    await identityOperations().changeEmail(fresh, pending.id, 'moved@example.test', FIXTURE_ISSUER),
    true,
  );
  assert.deepEqual((await snapshot(pending.id)).enrollment, [
    { issuer: FIXTURE_ISSUER, email_canonical: 'moved@example.test' },
  ]);
});

test('changeEmail: an invalid email is 400 before any transaction; unchanged or taken emails are 409 and leave no trace', async () => {
  const admin = await actor('account.changeEmail');
  const target = await seed();
  const other = await seed();
  const ops = identityOperations();
  for (const email of [
    '',
    'no-at-sign',
    'a b@example.test',
    `${'x'.repeat(250)}@e.co`,
    'a@b',
    5 as unknown as string,
    null as unknown as string,
  ]) {
    const refused = await appended(() =>
      assert.rejects(
        ops.changeEmail(admin.secret, target.id, email, FIXTURE_ISSUER),
        ProductInvalidRequest,
      ),
    );
    assert.deepEqual(refused.added, []);
    assert.equal(refused.after, refused.before);
  }
  const rootEmail = (
    await migration.query<{ e: string }[]>('SELECT email_canonical e FROM app_user WHERE id=$1', [
      root.id,
    ])
  )[0]?.e as string;
  for (const email of [
    target.email,
    target.email.toUpperCase(),
    other.email,
    other.email.toUpperCase(),
    rootEmail,
    rootEmail.toUpperCase(),
  ]) {
    const before = await snapshot(target.id);
    const refused = await appended(() =>
      assert.rejects(
        ops.changeEmail(admin.secret, target.id, email, FIXTURE_ISSUER),
        ProductCommandRejected,
      ),
    );
    assert.deepEqual(refused.added, []);
    assert.equal(refused.after, refused.before);
    assert.deepEqual(await snapshot(target.id), before);
  }
});

test('changeEmail: a larger target answers "not found", not the 409 an equal target would get', async () => {
  const admin = await actor('account.changeEmail');
  const larger = await seed();
  await grantViaRole(larger.id, ['account.changeEmail', 'account.provision']);
  assert.equal(
    await identityOperations().changeEmail(admin.secret, larger.id, larger.email, FIXTURE_ISSUER),
    false,
  );
  const equal = await seed();
  await assert.rejects(
    identityOperations().changeEmail(admin.secret, equal.id, equal.email, FIXTURE_ISSUER),
    ProductCommandRejected,
  );
});

test('resetMfa: no factor is 409 and changes nothing; the factor, the recovery codes and the sessions go; recovery codes alone count', async () => {
  const admin = await actor('account.resetMfa');
  const none = await seed({ factor: false });
  const refused = await appended(() =>
    assert.rejects(identityOperations().resetMfa(admin.secret, none.id), ProductCommandRejected),
  );
  assert.deepEqual(refused.added, []);
  assert.equal(refused.after, refused.before);
  const larger = await seed({ factor: false });
  await grantViaRole(larger.id, ['account.resetMfa', 'account.provision']);
  assert.equal(await identityOperations().resetMfa(admin.secret, larger.id), false);

  const codesOnly = await seed({ factor: false });
  await migration.query('INSERT INTO mfa_recovery_code(user_id,code_hash) VALUES($1,$2)', [
    codesOnly.id,
    Buffer.alloc(32, 7),
  ]);
  const session = await oidcSession(pools.identity, codesOnly.id);
  const before = await epoch(codesOnly.id);
  assert.equal(await identityOperations().resetMfa(admin.secret, codesOnly.id), true);
  assert.deepEqual((await snapshot(codesOnly.id)).factors, [{ totp: '0', codes: '0' }]);
  assert.ok((await epoch(codesOnly.id)) > before);
  assert.deepEqual(
    await pools.authority.query('SELECT user_id FROM public.resolve_session($1)', [
      sessionDigest(session),
    ]),
    [],
  );
});

test('resetGoogleBinding: no email on the account is 409; an active account becomes pending, a suspended one stays suspended', async () => {
  const admin = await actor('account.resetGoogleBinding');
  const ops = identityOperations();
  const noEmail = await seed({ email: null });
  await assert.rejects(
    ops.resetGoogleBinding(admin.secret, noEmail.id, FIXTURE_ISSUER),
    ProductCommandRejected,
  );
  const active = await seed();
  assert.equal(await ops.resetGoogleBinding(admin.secret, active.id, FIXTURE_ISSUER), true);
  const after = await snapshot(active.id);
  assert.equal(after.user[0]?.state, 'pending');
  assert.deepEqual(
    after.bindings.map((b) => b.enabled),
    [false],
  );
  assert.equal(after.enrollment.length, 1);
  const suspended = await seed({ state: 'suspended' });
  assert.equal(await ops.resetGoogleBinding(admin.secret, suspended.id, FIXTURE_ISSUER), true);
  assert.equal((await snapshot(suspended.id)).user[0]?.state, 'suspended');
});

test('a failing audit rolls the function back: nothing changes and the revision stays', async () => {
  class FailingAudit extends ProductAuditRepository {
    override async appendProductAudit(tx: ProductTransaction, event: ProductAuditEvent) {
      if (event.kind.startsWith('identity.')) throw new Error('audit unavailable');
      await super.appendProductAudit(tx, event);
    }
  }
  const failing = new FailingAudit();
  const ops = new ProductIdentityOperationService(
    new ProductAuthorization(runner, failing, bindings, {
      validators,
      obligations: createProductObligations(failing),
    }),
    failing,
    bindings,
  );
  const admin = await iamUser(true);
  const permissions = commands.map((c) => c.permission);
  await grantViaRole(admin.id, permissions);
  await bindAccountBoundary(admin.id, permissions, 'identityAdministration');
  const fresh = await freshRoot();
  const runs = [
    (id: string, secret: string) =>
      ops.changeEmail(secret, id, 'rolled@example.test', FIXTURE_ISSUER),
    (id: string, secret: string) => ops.resetMfa(secret, id),
    (id: string, secret: string) => ops.resetGoogleBinding(secret, id, FIXTURE_ISSUER),
  ];
  for (const run of runs)
    for (const secret of [admin.secret, fresh]) {
      const target = await seed();
      const before = await snapshot(target.id);
      const result = await appended(() =>
        assert.rejects(run(target.id, secret), /audit unavailable/),
      );
      assert.deepEqual(result.added, []);
      assert.equal(result.after, result.before);
      assert.deepEqual(await snapshot(target.id), before);
    }
});

test('the boundary package is bound and unbound by the existing commands, with no new code', async () => {
  const service = boundaryBindings();
  const ref = { key: 'identityAdministration', version: 1 };
  const user = await iamUser();
  const fresh = await freshRoot();

  const rows = () =>
    migration.query(
      "SELECT convert_from(permission_key,'UTF8') p FROM user_boundary WHERE user_id=$1 AND convert_from(boundary_key,'UTF8')='identityAdministration' ORDER BY 1",
      [user.id],
    );

  assert.equal(await service.bindBoundary(fresh, user.id, ref), true);
  assert.deepEqual(await rows(), [
    { p: 'account.changeEmail' },
    { p: 'account.resetGoogleBinding' },
    { p: 'account.resetMfa' },
  ]);
  await assert.rejects(service.bindBoundary(fresh, user.id, ref), ProductCommandRejected);
  assert.equal(await service.unbindBoundary(fresh, user.id, ref), true);
  assert.deepEqual(await rows(), []);
  await assert.rejects(service.unbindBoundary(fresh, user.id, ref), ProductCommandRejected);
});

test('a revision is spent once per success and never by a refusal', async () => {
  const fresh = await freshRoot();
  const target = await seed();
  const before = BigInt(await revision());
  assert.equal(await identityOperations().resetMfa(fresh, target.id), true);
  assert.equal(BigInt(await revision()), before + 1n);
  await assert.rejects(identityOperations().resetMfa(fresh, target.id), ProductCommandRejected);
  assert.equal(BigInt(await revision()), before + 1n);
});
