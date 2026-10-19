// Sign-in methods: provider error, Root activation and email, set-root-email, email verification.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  ProductAuthenticationError,
  newSessionSecret,
  sessionDigest,
} from '../dist/auth/services/product-identity.service.js';
import { ReleaseRejectedError } from '../dist/authorization/helpers/release-content.helper.js';
import { bootstrapProductRoot } from '../dist/authorization/services/product-root.service.js';
import { setRootEmail } from '../dist/authorization/services/product-root-lifecycle.service.js';
import { sqlState } from './setup-postgres.ts';
import {
  core,
  release,
  issuer,
  pools,
  migration,
  runner,
  identity,
  federation,
  responseFor,
  setupStack,
  teardownStack,
} from './product-sign-in-stack.helper.ts';
import {
  client,
  superuser,
  account,
  bind,
  session,
  live,
  verified,
  epoch,
  emailState,
  login,
  cancelledFor,
  failure,
} from './product-sign-in-fixtures.helper.ts';

before(setupStack);
after(teardownStack);

test('a provider error (no code) consumes the login attempt once and stays a login failure', async () => {
  const browser = newSessionSecret();
  const start = await federation.begin(issuer, browser, {}, client());
  // Another browser does not spend the attempt; the right one does, once.
  assert.ok(
    (await failure(federation.callback(issuer, cancelledFor(start), newSessionSecret()))) instanceof
      ProductAuthenticationError,
  );
  assert.ok(
    (await failure(federation.callback(issuer, cancelledFor(start), browser))) instanceof
      ProductAuthenticationError,
  );
  assert.ok(
    (await failure(
      federation.callback(issuer, responseFor(start, { sub: 'cancel-subject' }), browser),
    )) instanceof ProductAuthenticationError,
  );
  // An error redirect carrying a code, or two states, is malformed and spends nothing.
  const user = await account();
  await bind(user.id, issuer, 'cancel-subject');
  const other = newSessionSecret();
  const next = await federation.begin(issuer, other, {}, client());
  const both = responseFor(next, { sub: 'cancel-subject' });
  both.searchParams.set('error', 'access_denied');
  assert.ok(
    (await failure(federation.callback(issuer, both, other))) instanceof ProductAuthenticationError,
  );
  const twice = cancelledFor(next);
  twice.searchParams.append('state', 'other');
  assert.ok(
    (await failure(federation.callback(issuer, twice, other))) instanceof
      ProductAuthenticationError,
  );
  assert.ok(await federation.callback(issuer, responseFor(next, { sub: 'cancel-subject' }), other));
});

test('Root created from an email: activation, login sessions never fresh; one binding by reference', async () => {
  const { userId: rootId, activationSecret } = await bootstrapProductRoot(runner, release, {
    operationId: randomUUID(),
    issuer,
    email: 'root@example.test',
  });
  assert.ok(activationSecret);
  const browser = newSessionSecret();
  const start = await federation.begin(
    issuer,
    browser,
    { purpose: 'activation', activationToken: activationSecret },
    client(),
  );
  const activated = await federation.callback(
    issuer,
    responseFor(start, {
      sub: 'root-subject',
      email: 'Root@Example.test',
      email_verified: true,
    }),
    browser,
  );
  assert.ok(activated);
  const [bound] = await migration.query<{ ref: string }[]>(
    'SELECT binding_ref::text ref FROM external_identity WHERE user_id=$1',
    [rootId],
  );
  const rootRef = bound!.ref;
  // ADR 0027 §7: no OIDC callback sets reauthenticated_at; `fresh` only comes from 2FA.
  const signedIn = await login(federation, { sub: 'root-subject' });
  assert.ok(signedIn);
  for (const secret of [activated.secret, signedIn.secret]) {
    const [row] = await migration.query<{ reauthenticated: boolean }[]>(
      'SELECT reauthenticated_at IS NOT NULL reauthenticated FROM application_session WHERE token_hash=$1',
      [sessionDigest(secret)],
    );
    assert.equal(row?.reauthenticated, false);
  }
  assert.equal(
    (await runner.run('read', (tx) => identity.authenticate(tx, signedIn.secret))).fresh,
    false,
  );
  assert.deepEqual((await federation.ownAccount(signedIn.secret)).identities, [
    { issuer, reference: rootRef },
  ]);
});

test('set-root-email: the Root gets a new unverified email and loses every session; bootstrap may do nothing else', async () => {
  const [marker] = await migration.query<{ id: string }[]>(
    'SELECT target_user_id::text id FROM security_bootstrap_state',
  );
  const rootId = marker!.id as IdentityId;
  const rootSession = await session(rootId, { oidc: { issuer, subject: 'root-subject' } });
  const iam = await account();

  const set = (userId: string, email: string) =>
    setRootEmail(runner, { operationId: randomUUID(), userId: userId as IdentityId, email }, core);

  const reason = async (operation: Promise<unknown>) => {
    const error = await failure(operation);
    assert.ok(error instanceof ReleaseRejectedError, String(error));
    return error.reason;
  };

  const events = async () =>
    (
      await superuser(
        `SELECT safe_metadata metadata FROM audit_outbox WHERE event_kind=convert_to('root.set-email','UTF8')`,
      )
    ).rows as { metadata: Record<string, string> }[];

  const before = await epoch(rootId);

  assert.equal(await reason(set(iam.id, 'iam-target@example.test')), 'collision');
  assert.equal(await reason(set(randomUUID(), 'nobody@example.test')), 'collision');
  for (const email of ['not-an-email', ' root@example.test', `${'a'.repeat(250)}@x.test`, ''])
    assert.equal(await reason(set(rootId, email)), 'invalid_release', email);
  assert.equal(
    await reason(
      setRootEmail(
        runner,
        { operationId: 'not-a-uuid', userId: rootId, email: 'root@example.test' },
        core,
      ),
    ),
    'invalid_release',
  );
  // Another account's email: the UNIQUE constraint refuses it.
  assert.equal(await reason(set(rootId, iam.email.toUpperCase())), 'collision');
  // A failing audit write rolls everything back.
  await superuser('REVOKE INSERT ON audit_outbox FROM product_bootstrap');
  try {
    await assert.rejects(
      set(rootId, 'root.owner@example.test'),
      (error: unknown) => !(error instanceof ReleaseRejectedError),
    );
  } finally {
    await superuser('GRANT INSERT ON audit_outbox TO product_bootstrap');
  }
  assert.deepEqual(await emailState(rootId), { email: 'root@example.test', verified: true });
  assert.deepEqual(await emailState(iam.id), { email: iam.email, verified: true });
  assert.equal(await epoch(rootId), before);
  assert.equal(await live(rootSession), true);
  assert.deepEqual(await events(), []);

  const operationId = randomUUID();
  assert.deepEqual(
    await setRootEmail(
      runner,
      { operationId, userId: rootId, email: 'Root.Owner@Example.Test' },
      core,
    ),
    { changed: true },
  );
  assert.deepEqual(await emailState(rootId), {
    email: 'root.owner@example.test',
    verified: false,
  });
  assert.equal(await epoch(rootId), String(BigInt(before!) + 1n));
  assert.equal(await live(rootSession), false);
  const [event] = await events();
  assert.deepEqual(event?.metadata, {
    targetUserId: rootId,
    operationId,
    resultingRevision: event?.metadata.resultingRevision,
  });
  // A rerun with the same email changes nothing and audits nothing.
  assert.deepEqual(await set(rootId, 'root.owner@example.test'), { changed: false });
  assert.equal(await epoch(rootId), String(BigInt(before!) + 1n));
  assert.equal((await events()).length, 1);
  // The narrowed guard: only an email change to an unverified address, same state, new epoch.
  // (Since migration 016 an epoch-only change is allowed for a Root without a second factor,
  // ADR 0026 §4; refused while it holds one: product-mfa.integration-spec.ts.)
  for (const sql of [
    `UPDATE app_user SET email_canonical='root.other@example.test',email_verified=true,auth_epoch=auth_epoch+1 WHERE id=$1`,
    `UPDATE app_user SET email_canonical=NULL,email_verified=false,auth_epoch=auth_epoch+1 WHERE id=$1`,
    `UPDATE app_user SET email_canonical='root.other@example.test',email_verified=false,auth_epoch=auth_epoch WHERE id=$1`,
    `UPDATE app_user SET email_canonical='root.other@example.test',email_verified=false WHERE id=$1`,
    `UPDATE app_user SET state='pending',email_canonical='root.other@example.test',email_verified=false,auth_epoch=auth_epoch+1 WHERE id=$1`,
  ])
    assert.equal(await sqlState(pools.bootstrap.query(sql, [rootId])), '42501', sql);
  assert.deepEqual(await emailState(rootId), {
    email: 'root.owner@example.test',
    verified: false,
  });
});

test('a verified Google email equal to the account email verifies it once and ends other sessions', async () => {
  // Root (email set by the test above, unverified): a mismatching or unverified claim changes nothing.
  const [marker] = await migration.query<{ id: string }[]>(
    'SELECT target_user_id::text id FROM security_bootstrap_state',
  );
  const rootId = marker!.id;
  const rootEmail = (await emailState(rootId))!.email!;
  const start = await epoch(rootId);
  for (const claims of [
    { sub: 'root-subject', email: rootEmail, email_verified: false },
    { sub: 'root-subject', email: rootEmail, email_verified: 'true' },
    verified('root-subject', 'someone.else@example.test'),
    { sub: 'root-subject' },
  ])
    assert.ok(await login(federation, claims), JSON.stringify(claims));
  assert.equal(await epoch(rootId), start);
  assert.equal((await emailState(rootId))?.verified, false);
  const earlier = await session(rootId, { oidc: { issuer, subject: 'root-subject' } });
  const signedIn = await login(federation, verified('root-subject', rootEmail.toUpperCase()));
  assert.ok(signedIn);
  assert.deepEqual(await emailState(rootId), { email: rootEmail, verified: true });
  assert.equal(await epoch(rootId), String(BigInt(start!) + 1n));
  assert.equal(await live(earlier), false);
  assert.equal(await live(signedIn.secret), true);
  // Verified: later logins change nothing.
  assert.ok(await login(federation, verified('root-subject', rootEmail)));
  assert.equal(await epoch(rootId), String(BigInt(start!) + 1n));
  assert.equal(await live(signedIn.secret), true);
});
