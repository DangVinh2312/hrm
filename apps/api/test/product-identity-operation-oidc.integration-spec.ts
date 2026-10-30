// ADR-15 D9 x D10 x D11: the commands through the service, then the real Google sign-in against
// the fake IdP: a reset binding refuses the old (issuer, sub) pair for good, a new Google with the
// matching verified email activates the account exactly once, an email change moves the
// invitation of a pending account, and a sign-in racing a reset ends in a state either order allows.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  ProductAuthenticationError,
  newSessionSecret,
  sessionDigest,
} from '../dist/authentication/services/product-identity.service.js';
import { ProductAuthorization } from '../dist/authorization/services/product-authority.service.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import { ProductIdentityOperationService } from '../dist/authorization/services/product-identity-operation.service.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import { productBindings } from '../dist/authorization/product.manifest.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import { bootstrapActiveRoot, oidcSession } from './oidc-fixture.helper.ts';
import {
  core,
  federation,
  fixtureAdmin,
  issuer,
  pools,
  productRelease,
  responseFor,
  runner,
  setTokenGate,
  setupStack,
  teardownStack,
} from './product-identity-stack.helper.ts';

const audit = new ProductAuditRepository();
let operations: ProductIdentityOperationService;
let rootId: string;

before(async () => {
  await setupStack();
  await new ProductManifestReconciler(runner, audit, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: productRelease.declarations.capabilities,
  }).reconcile(productRelease);
  const bindings = new ProductBindingRegistry(core, productRelease.declarations, productBindings);
  operations = new ProductIdentityOperationService(
    new ProductAuthorization(runner, audit, bindings, {
      validators: {
        'fresh@1': (_p: unknown, input: { context: { freshAuthentication?: unknown } }) =>
          input.context.freshAuthentication === true,
      },
      obligations: createProductObligations(audit),
    }),
    audit,
    bindings,
  );
  rootId = (
    await bootstrapActiveRoot(runner, productRelease, pools.identity, 'root-oidc@example.test', {
      issuer,
    })
  ).userId;
});
after(teardownStack);

const freshRoot = () => oidcSession(pools.identity, rootId, { fresh: true });

let attempt = 0;

const login = async (claims: Record<string, unknown>) => {
  const browser = newSessionSecret();
  const start = await federation.begin(issuer, browser, {}, `operation-${++attempt}`);
  return federation.callback(issuer, responseFor(start, claims), browser);
};

const verified = (sub: string, email: string) => ({ sub, email, email_verified: true });

async function activeAccount(sub: string) {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await fixtureAdmin.query(
    `INSERT INTO app_user(id,email_canonical,email_verified,state) VALUES($1,$2,true,'active')`,
    [id, email],
  );
  await pools.identity.query(
    'INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)',
    [issuer, sub, id],
  );
  return { id, email };
}

interface AccountRow {
  state: string;
  email: string;
  verified: boolean;
  enabled: number;
  subjects: string | null;
  invitations: number;
}

const row = async (id: string): Promise<AccountRow> => {
  const [found] = await fixtureAdmin.query<AccountRow[]>(
    `SELECT u.state,u.email_canonical email,u.email_verified verified,
      (SELECT count(*) FROM external_identity e WHERE e.user_id=u.id AND e.enabled)::int enabled,
      (SELECT string_agg(subject,',' ORDER BY subject) FROM external_identity e WHERE e.user_id=u.id) subjects,
      (SELECT count(*) FROM oidc_email_enrollment n WHERE n.user_id=u.id)::int invitations
     FROM app_user u WHERE u.id=$1`,
    [id],
  );
  if (!found) throw new Error('account row missing');
  return found;
};

const sessionRows = (secret: string) =>
  pools.authority.query('SELECT user_id FROM public.resolve_session($1)', [sessionDigest(secret)]);

test('resetGoogleBinding: the old pair is refused for good, a new Google with the matching verified email activates once, replay and a second Google are refused', async () => {
  const { id, email } = await activeAccount('reset-old-a');
  const oldSession = await oidcSession(pools.identity, id);
  assert.deepEqual(await sessionRows(oldSession), [{ user_id: id }]);
  assert.equal(await operations.resetGoogleBinding(await freshRoot(), id, issuer), true);
  assert.deepEqual(await sessionRows(oldSession), [], 'the earlier session ended');
  assert.deepEqual(await row(id), {
    state: 'pending',
    email,
    verified: true,
    enabled: 0,
    subjects: 'reset-old-a',
    invitations: 1,
  });
  await assert.rejects(login(verified('reset-old-a', email)), ProductAuthenticationError);

  const browser = newSessionSecret();
  const start = await federation.begin(issuer, browser, {}, 'operation-replay');
  const callback = responseFor(start, verified('reset-new-a', email));
  assert.ok(await federation.callback(issuer, callback, browser));
  assert.deepEqual(await row(id), {
    state: 'active',
    email,
    verified: true,
    enabled: 1,
    subjects: 'reset-new-a,reset-old-a',
    invitations: 0,
  });
  await assert.rejects(federation.callback(issuer, callback, browser), ProductAuthenticationError);
  await assert.rejects(login(verified('reset-newer-a', email)), ProductAuthenticationError);
  await assert.rejects(login(verified('reset-old-a', email)), ProductAuthenticationError);
  assert.equal((await row(id)).enabled, 1);
});

test('resetGoogleBinding: a missing or false email_verified claim and another email are refused; a suspended account stays suspended until reactivated', async () => {
  const { id, email } = await activeAccount('reset-old-b');
  assert.equal(await operations.resetGoogleBinding(await freshRoot(), id, issuer), true);
  for (const claims of [
    { sub: 'reset-new-b', email, email_verified: false },
    { sub: 'reset-new-b', email },
    { sub: 'reset-new-b', email: 'other@example.test', email_verified: true },
  ])
    await assert.rejects(login(claims), ProductAuthenticationError, JSON.stringify(claims));
  assert.equal((await row(id)).state, 'pending');

  const held = await activeAccount('reset-old-c');
  await fixtureAdmin.query(
    `UPDATE app_user SET state='suspended',auth_epoch=auth_epoch+1 WHERE id=$1`,
    [held.id],
  );
  assert.equal(await operations.resetGoogleBinding(await freshRoot(), held.id, issuer), true);
  assert.equal((await row(held.id)).state, 'suspended');
  await assert.rejects(login(verified('reset-new-c', held.email)), ProductAuthenticationError);
  await assert.rejects(login(verified('reset-old-c', held.email)), ProductAuthenticationError);
  assert.equal((await row(held.id)).state, 'suspended');
});

test('changeEmail on a pending account moves the invitation: the new address signs in, the old one is refused', async () => {
  const id = randomUUID();
  const first = `first-${id}@example.test`;
  const second = `second-${id}@example.test`;
  await pools.data.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', [
    id,
    first,
    issuer,
    rootId,
  ]);
  assert.equal(
    await operations.changeEmail(await freshRoot(), id, second.toUpperCase(), issuer),
    true,
  );
  assert.equal((await row(id)).email, second);
  await assert.rejects(login(verified('moved-sub', first)), ProductAuthenticationError);
  assert.ok(await login(verified('moved-sub', second)));
  assert.deepEqual(await row(id), {
    state: 'active',
    email: second,
    verified: true,
    enabled: 1,
    subjects: 'moved-sub',
    invitations: 0,
  });
});

test('changeEmail on an active account: unverified, earlier sessions end, the existing binding still signs in and verifies the new email only when the claim matches', async () => {
  const { id, email } = await activeAccount('change-old-d');
  const oldSession = await oidcSession(pools.identity, id);
  const changed = `changed-${id}@example.test`;
  assert.equal(await operations.changeEmail(await freshRoot(), id, changed, issuer), true);
  assert.deepEqual(await sessionRows(oldSession), []);
  assert.deepEqual(await row(id), {
    state: 'active',
    email: changed,
    verified: false,
    enabled: 1,
    subjects: 'change-old-d',
    invitations: 0,
  });
  // The binding is by (issuer, sub), not by email: it is not a way in for the new address, and a
  // claim with the old address verifies nothing.
  assert.ok(await login(verified('change-old-d', email)));
  assert.equal((await row(id)).verified, false);
  // Only the matching verified claim of the bound Google verifies the new address.
  assert.ok(await login(verified('change-old-d', changed)));
  assert.equal((await row(id)).verified, true);
  // Nobody can reach the account with another Google through the new email: no invitation exists.
  await assert.rejects(login(verified('change-other-d', changed)), ProductAuthenticationError);
  assert.equal((await row(id)).subjects, 'change-old-d');
});

test('a Google sign-in racing a second reset ends in a state either order allows, never two bindings', async () => {
  for (let round = 0; round < 3; round += 1) {
    const { id, email } = await activeAccount(`race-old-${round}`);
    assert.equal(await operations.resetGoogleBinding(await freshRoot(), id, issuer), true);
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    setTokenGate(async () => {
      if (++arrived === 1) open();
      await gate;
    });
    let results: PromiseSettledResult<unknown>[];
    try {
      const fresh = await freshRoot();
      results = await Promise.allSettled([
        login(verified(`race-new-${round}`, email)),
        gate.then(() => operations.resetGoogleBinding(fresh, id, issuer)),
      ]);
    } finally {
      setTokenGate(undefined);
    }
    assert.equal(results[1]?.status, 'fulfilled', 'the reset itself always succeeds');
    const final = await row(id);
    assert.ok(final.enabled <= 1);
    if (final.state === 'active') {
      assert.equal(results[0]?.status, 'fulfilled');
      assert.deepEqual([final.enabled, final.invitations], [1, 0]);
    } else {
      assert.equal(final.state, 'pending');
      assert.deepEqual([final.enabled, final.invitations], [0, 1]);
    }
    await assert.rejects(login(verified(`race-old-${round}`, email)), ProductAuthenticationError);
  }
});
