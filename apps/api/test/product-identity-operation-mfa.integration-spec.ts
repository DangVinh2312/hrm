// ADR-15 D11: account.resetMfa through the service, then the account's own second factor again:
// the sessions are gone, the factor and recovery codes are gone, and the account sets up and
// confirms a new factor by itself. Real PostgreSQL and the real MFA service, one file.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ProductAuthorization } from '../dist/authorization/services/product-authority.service.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import { ProductIdentityOperationService } from '../dist/authorization/services/product-identity-operation.service.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import { productBindings } from '../dist/authorization/product.manifest.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import { base32Decode, hotp } from '../dist/authentication/helpers/totp.helper.js';
import { bootstrapActiveRoot } from './oidc-fixture.helper.ts';
import {
  alive,
  core,
  enrolled,
  epoch,
  events,
  factor,
  ip,
  issuer,
  mfa,
  migration,
  pools,
  release,
  runner,
  session,
  setupStack,
  stableStep,
  teardownStack,
} from './product-mfa-stack.helper.ts';

before(setupStack);
after(teardownStack);

const audit = new ProductAuditRepository();

const operations = () =>
  new ProductIdentityOperationService(
    new ProductAuthorization(
      runner,
      audit,
      new ProductBindingRegistry(core, release.declarations, productBindings),
      {
        validators: {
          'fresh@1': (_p: unknown, input: { context: { freshAuthentication?: unknown } }) =>
            input.context.freshAuthentication === true,
        },
        obligations: createProductObligations(audit),
      },
    ),
    audit,
    new ProductBindingRegistry(core, release.declarations, productBindings),
  );

const codeCount = async (userId: string) =>
  (
    await migration.query<{ n: number }[]>(
      'SELECT count(*)::int n FROM mfa_recovery_code WHERE user_id=$1',
      [userId],
    )
  )[0]?.n;

test('resetMfa ends every session, removes the factor and its codes, and the account enrols again by itself', async () => {
  const { userId: rootId } = await bootstrapActiveRoot(
    runner,
    release,
    pools.identity,
    `root-${randomUUID()}@example.test`,
    { issuer },
  );
  const target = await enrolled();
  assert.equal((await factor(target.userId))?.confirmed, true);
  assert.ok(((await codeCount(target.userId)) ?? 0) > 0);
  assert.ok(await alive(target.secret));
  const before = BigInt((await epoch(target.userId)) ?? '0');

  assert.equal(await operations().resetMfa(await session(rootId, true), target.userId), true);

  assert.equal(await factor(target.userId), undefined);
  assert.equal(await codeCount(target.userId), 0);
  assert.ok(BigInt((await epoch(target.userId)) ?? '0') > before);
  assert.equal(await alive(target.secret), undefined, 'the session of the old factor is gone');

  // The account signs in again (its binding is untouched) and sets up a new factor by itself.
  const next = await session(target.userId);
  assert.ok(await alive(next));
  const setup = await mfa.setup(next, ip());
  const raw = base32Decode(setup.secret);
  const step = await stableStep();
  const confirmed = await mfa.confirm(next, hotp(raw, step - 1n), ip());
  assert.equal((await factor(target.userId))?.confirmed, true);
  assert.equal(confirmed.recoveryCodes.length > 0, true);
  assert.ok(await alive(confirmed.session.secret));

  // Audited as a permission-based reset, ids only; the offline reset kind is not used.
  const recorded = await events('identity.mfa-reset-by-permission', rootId);
  assert.equal(recorded.length, 1);
  assert.deepEqual(Object.keys(recorded[0]!.metadata).sort(), [
    'outcome',
    'principalKind',
    'resultingRevision',
    'targetUserId',
  ]);
  assert.equal(recorded[0]!.metadata.targetUserId, target.userId);
  assert.deepEqual(await events('identity.mfa-reset', rootId), []);
});
