import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { verifyProductPrivileges } from '../dist/database/helpers/product-database.helper.js';
import { sqlState, withClient } from './setup-postgres.ts';
import { startRootGuardsStack, type RootGuardsStack } from './root-guards-stack.helper.ts';

let stack: RootGuardsStack;
before(async () => {
  stack = await startRootGuardsStack();
});
after(async () => {
  await stack?.stop();
});

const insertToken = (purpose: string, userId: string) =>
  [
    `INSERT INTO one_time_token(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,statement_timestamp()+interval '1 minute')`,
    [randomBytes(32), userId, purpose],
  ] as [string, unknown[]];

test('login identity cannot issue any one-time token; the privilege probe matches (migration 020)', async () => {
  const { connections, pools, migration, root, member } = stack;
  // No runtime code inserts tokens since ADR 0027 step 4; only the bootstrap CLI does.
  for (const [target, purpose] of [
    [root, 'oidc-activation'],
    [member, 'oidc-activation'],
    [member, 'activation'],
  ] as const)
    await withClient(connections.identity, async (c) =>
      assert.equal(await sqlState(c.query(...insertToken(purpose, target))), '42501', purpose),
    );
  // It keeps reading tokens (the flows of ProductIdentityService).
  await pools.identity.query('SELECT purpose FROM one_time_token WHERE user_id=$1', [root]);
  // Probe: the expected set matches now, and a re-granted INSERT is reported as drift.
  await verifyProductPrivileges(pools);
  await migration.query('GRANT INSERT ON one_time_token TO product_identity');
  try {
    await assert.rejects(
      verifyProductPrivileges(pools),
      /Product privilege drift for identity: unexpected \[table:one_time_token:INSERT\]/,
    );
  } finally {
    await migration.query('REVOKE INSERT ON one_time_token FROM product_identity');
  }
  await verifyProductPrivileges(pools);
});

test('only bootstrap issues Root activation; local token purposes no longer exist', async () => {
  const { migration, pools, root, member } = stack;
  // The owner passes the table privilege, so the guard trigger itself is what refuses.
  await assert.rejects(
    migration.query(...insertToken('oidc-activation', root)),
    /bootstrap credential only/,
  );
  await pools.bootstrap.query(...insertToken('oidc-activation', member));
  // ADR 0027 §2 (migration 018): activation and reset tokens are refused for any account.
  for (const target of [root, member])
    for (const purpose of ['activation', 'reset'])
      assert.equal(
        await sqlState(migration.query(...insertToken(purpose, target))),
        '23514',
        purpose,
      );
});
