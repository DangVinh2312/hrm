// ADR-15 D11 follow-up: faults are not answers (a revoked EXECUTE is a fault, not "absent"), who
// the invitation is attributed to, a provider the function refuses, emails the two lower()
// implementations disagree on, and the three copies of the grants-within check agreeing.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import { withClient } from './setup-postgres.ts';
import { FIXTURE_ISSUER, bindAccount, fixtureProvider } from './oidc-fixture.helper.ts';
import {
  accounts,
  appended,
  bindAccountBoundary,
  boundaryBindings,
  freshRoot,
  grantViaRole,
  iamUser,
  identityOperations,
  migration,
  pools,
  postgres,
  revision,
  setupStack,
  teardownStack,
} from './product-root-stack.helper.ts';

before(setupStack);
after(teardownStack);

async function seed(state: 'pending' | 'active' = 'active') {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await migration.query(
    'INSERT INTO app_user(id,email_canonical,state,email_verified) VALUES($1,$2,$3,$4)',
    [id, email, state, state === 'active'],
  );
  if (state === 'active') await bindAccount(pools.identity, id);
  await migration.query(
    `INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id) VALUES($1,decode(repeat('ab',36),'hex'),decode(repeat('cd',12),'hex'),'k1')`,
    [id],
  );
  return { id, email };
}

const state = async (id: string) =>
  JSON.stringify(
    await migration.query(
      `SELECT email_canonical,email_verified,state,auth_epoch::text,
        (SELECT count(*) FROM mfa_totp WHERE user_id=$1) totp,
        (SELECT count(*) FROM external_identity WHERE user_id=$1 AND enabled) bindings
       FROM app_user WHERE id=$1`,
      [id],
    ),
  );

const functions = {
  changeEmail: 'public.change_iam_account_email(uuid,text,text,uuid)',
  resetMfa: 'public.reset_iam_mfa(uuid)',
  resetGoogleBinding: 'public.reset_iam_google_binding(uuid,text,uuid)',
} as const;

const runs = {
  changeEmail: (secret: string, id: string) =>
    identityOperations().changeEmail(secret, id, 'x@example.test', FIXTURE_ISSUER),
  resetMfa: (secret: string, id: string) => identityOperations().resetMfa(secret, id),
  resetGoogleBinding: (secret: string, id: string) =>
    identityOperations().resetGoogleBinding(secret, id, FIXTURE_ISSUER),
};

test('a revoked EXECUTE is a fault (rejects, nothing written, no Root "absent" event), not "not found"', async () => {
  const fresh = await freshRoot();
  for (const [name, signature] of Object.entries(functions) as [keyof typeof runs, string][]) {
    const target = await seed();
    const before = await state(target.id);
    await withClient(postgres.superuser, (c) =>
      c.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM product_authority`),
    );
    try {
      const result = await appended(async () => {
        const failure: unknown = await runs[name](fresh, target.id).then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.ok(failure instanceof QueryFailedError, `${name} must reject with the driver fault`);
        const driver = failure.driverError as { code?: string; message?: string };
        assert.equal(driver.code, '42501');
        assert.doesNotMatch(String(driver.message), /^only IAM accounts/);
      });
      assert.deepEqual(result.added, []);
      assert.equal(result.after, result.before);
      assert.equal(await state(target.id), before);
    } finally {
      await withClient(postgres.superuser, (c) =>
        c.query(`GRANT EXECUTE ON FUNCTION ${signature} TO product_authority`),
      );
    }
    assert.equal(await runs[name](fresh, target.id).then(() => 'ok'), 'ok');
  }
});

test('the invitation is attributed to the acting account, not to the target', async () => {
  const admin = await iamUser(true);
  const permissions = ['account.changeEmail', 'account.resetGoogleBinding'];
  await grantViaRole(admin.id, permissions);
  await bindAccountBoundary(admin.id, permissions, 'identityAdministration');
  const rootSecret = await freshRoot();
  const rootId = (
    await migration.query<{ id: string }[]>("SELECT id FROM app_user WHERE kind='root'")
  )[0]?.id;

  const createdBy = async (id: string) =>
    (
      await migration.query<{ by: string }[]>(
        'SELECT created_by::text by FROM oidc_email_enrollment WHERE user_id=$1',
        [id],
      )
    ).map((row) => row.by);

  for (const [secret, actor] of [
    [admin.secret, admin.id],
    [rootSecret, rootId],
  ] as const) {
    const pending = await seed('pending');
    assert.equal(
      await identityOperations().changeEmail(
        secret,
        pending.id,
        `m-${pending.id}@example.test`,
        FIXTURE_ISSUER,
      ),
      true,
    );
    assert.deepEqual(await createdBy(pending.id), [actor]);
    const active = await seed();
    assert.equal(
      await identityOperations().resetGoogleBinding(secret, active.id, FIXTURE_ISSUER),
      true,
    );
    assert.deepEqual(await createdBy(active.id), [actor]);
  }
});

test('a provider the function refuses is a fault for email and binding, with no audit and no revision; resetMfa does not use it', async () => {
  const other = 'https://idp.disabled.fixture';
  await fixtureProvider(migration, other);
  await migration.query('UPDATE oidc_provider SET enabled=false WHERE issuer=$1', [other]);
  const fresh = await freshRoot();
  const target = await seed();
  const before = await state(target.id);
  for (const run of [
    () => identityOperations().changeEmail(fresh, target.id, 'y@example.test', other),
    () => identityOperations().resetGoogleBinding(fresh, target.id, other),
  ]) {
    const result = await appended(async () => {
      const failure: unknown = await run().then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(failure instanceof QueryFailedError);
      assert.equal((failure.driverError as { code?: string }).code, '22023');
    });
    assert.deepEqual(result.added, []);
    assert.equal(result.after, result.before);
    assert.equal(await state(target.id), before);
  }
  assert.equal(await identityOperations().resetMfa(fresh, target.id), true);
});

test('emails the two lower() implementations may disagree on are accepted on this PostgreSQL (collation of the test cluster), not 400 or a fault', async () => {
  const fresh = await freshRoot();
  const target = await seed();
  for (const email of ['İ@example.test', 'a\u0085b@example.test'])
    assert.equal(
      await identityOperations().changeEmail(fresh, target.id, email, FIXTURE_ISSUER),
      true,
      JSON.stringify(email),
    );
  assert.equal(
    (
      await migration.query<{ e: string }[]>('SELECT email_canonical e FROM app_user WHERE id=$1', [
        target.id,
      ])
    )[0]?.e,
    'a\u0085b@example.test',
  );
});

test('the three copies of the grants-within check agree on one matrix of targets', async () => {
  const actor = await iamUser(true);
  await grantViaRole(actor.id, [
    'account.suspend',
    'account.changeEmail',
    'account.unbindBoundary',
  ]);
  await bindAccountBoundary(actor.id, ['account.suspend', 'account.unbindBoundary']);
  await bindAccountBoundary(actor.id, ['account.changeEmail'], 'identityAdministration');
  const cases: [string, boolean, (id: string) => Promise<void>][] = [
    ['no grants', true, async () => {}],
    ['a subset', true, async (id) => void (await grantViaRole(id, ['account.suspend']))],
    ['a larger set', false, async (id) => void (await grantViaRole(id, ['account.provision']))],
    [
      'a deny',
      false,
      async (id) =>
        void (await grantViaRole(id, [{ permission: 'account.suspend', effect: 'deny' }])),
    ],
    [
      'a rule on the user',
      false,
      async (id) => {
        await migration.query(
          "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow','allAccounts',1,'{}','runtime')",
          [randomUUID(), Buffer.from('account.suspend'), id],
        );
      },
    ],
    [
      'another template',
      false,
      async (id) =>
        void (await grantViaRole(id, [{ permission: 'account.suspend', template: 'setting' }])),
    ],
  ];
  for (const [label, expected, prepare] of cases) {
    const verdicts: Record<string, boolean> = {};
    const targets = await Promise.all([seed(), seed(), seed()]);
    for (const t of targets) {
      await prepare(t.id);
      await bindAccountBoundary(t.id, ['account.changeEmail'], 'identityAdministration');
    }
    verdicts.accountService = await accounts().suspendUser(actor.secret, targets[0].id);
    verdicts.identityService = await identityOperations().changeEmail(
      actor.secret,
      targets[1].id,
      `n-${targets[1].id}@example.test`,
      FIXTURE_ISSUER,
    );
    verdicts.boundaryService = await boundaryBindings().unbindBoundary(
      actor.secret,
      targets[2].id,
      { key: 'identityAdministration', version: 1 },
    );
    assert.deepEqual(
      verdicts,
      { accountService: expected, identityService: expected, boundaryService: expected },
      label,
    );
  }
  assert.ok((await revision()).length > 0);
});
