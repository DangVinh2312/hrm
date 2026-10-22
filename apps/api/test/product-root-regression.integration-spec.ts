import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { productDataSourceOptions } from '../dist/database/helpers/product-database.helper.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { prepareProductRelease } from '../dist/authorization/services/product-manifest.service.js';
import {
  bootstrapProductRoot,
  reissueRootActivation,
} from '../dist/authorization/services/product-root.service.js';
import { activateRootAccount } from './oidc-fixture.helper.ts';
import { core } from './core/fixtures.ts';
import {
  base,
  startRegressionPostgres,
  stopRegressionPostgres,
  withProduct,
} from './system-regression.helper.ts';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

before(startRegressionPostgres);
after(stopRegressionPostgres);

test('Root bootstrap by email pins (issuer, email) and issues one one-time proof; reissue replaces both', async () => {
  await withProduct(async (_reconciler, migration, settings) => {
    const bootstrap = await new DataSource(
      productDataSourceOptions(settings.bootstrap),
    ).initialize();
    try {
      const runner = new ProductTransactionRunner({ bootstrap });
      const issuer = 'https://idp.example.test';
      await migration.query(
        `INSERT INTO oidc_provider(issuer,version,enabled) VALUES('https://idp.example.test',1,true)`,
      );
      const result = await bootstrapProductRoot(runner, audit, prepareProductRelease(base, core), {
        operationId: randomUUID(),
        issuer,
        email: 'Root@Example.test',
      });
      assert.match(result.activationSecret ?? '', /^[A-Za-z0-9_-]{43}$/);
      const target = result.userId;
      assert.deepEqual(
        await migration.query('SELECT purpose FROM one_time_token WHERE user_id=$1', [target]),
        [{ purpose: 'oidc-activation' }],
      );
      assert.deepEqual(
        await migration.query(
          'SELECT kind,state,email_canonical,email_verified FROM app_user WHERE id=$1',
          [target],
        ),
        [
          {
            kind: 'root',
            state: 'pending',
            email_canonical: 'root@example.test',
            email_verified: false,
          },
        ],
      );

      const pin = () =>
        migration.query(
          'SELECT issuer,email_canonical,expires_at>statement_timestamp() live FROM oidc_email_enrollment WHERE user_id=$1',
          [target],
        );

      const pinned = [{ issuer, email_canonical: 'root@example.test', live: true }];
      assert.deepEqual(await pin(), pinned);
      // No binding is written: the Google account is bound by the verified activation only.
      assert.deepEqual(
        await migration.query('SELECT 1 FROM external_identity WHERE user_id=$1', [target]),
        [],
      );
      // Reissue needs an enabled provider.
      await assert.rejects(
        reissueRootActivation(runner, audit, { issuer: 'https://unknown.example.test' }),
        /enabled provider/,
      );
      const reissued = await reissueRootActivation(runner, audit, { issuer });
      assert.notEqual(reissued.activationSecret, result.activationSecret);
      assert.deepEqual(await pin(), pinned);
      assert.deepEqual(
        await migration.query(
          'SELECT count(*)::int n FROM one_time_token WHERE user_id=$1 AND consumed_at IS NULL',
          [target],
        ),
        [{ n: 1 }],
      );
      // Once the Root holds a binding there is nothing left to reissue.
      await migration.query(
        `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,'root-subject',$2)`,
        [issuer, target],
      );
      await assert.rejects(reissueRootActivation(runner, audit, { issuer }), /does not fit/);
    } finally {
      await bootstrap.destroy();
    }
  });
});

test('a Root promotion commits only with the marker naming it', async () => {
  await withProduct(async (_reconciler, migration, settings) => {
    const bootstrap = await new DataSource(
      productDataSourceOptions(settings.bootstrap),
    ).initialize();
    try {
      const runner = new ProductTransactionRunner({ bootstrap });

      const denied = (e: { code?: string; driverError?: { code?: string } }) =>
        (e.driverError?.code ?? e.code) === '42501';

      const target = randomUUID();
      const other = randomUUID();
      await migration.query(`INSERT INTO app_user(id,state) VALUES($1,'pending'),($2,'pending')`, [
        target,
        other,
      ]);
      const promote = `UPDATE app_user SET kind='root' WHERE id=$1`;
      // No marker at all: the deferred check refuses the commit.
      await assert.rejects(
        runner.run('bootstrap', (tx) => tx.manager.query(promote, [target])),
        denied,
      );
      // A marker naming somebody else, and forcing the check early, are refused too.
      await assert.rejects(
        runner.run('bootstrap', async (tx) => {
          await tx.manager.query(promote, [target]);
          await tx.manager.query(
            'UPDATE security_bootstrap_state SET operation_id=$1,target_user_id=$2,initialized_at=statement_timestamp() WHERE singleton',
            [randomUUID(), other],
          );
        }),
        denied,
      );
      await assert.rejects(
        runner.run('bootstrap', async (tx) => {
          await tx.manager.query('SET CONSTRAINTS ALL IMMEDIATE');
          await tx.manager.query(promote, [target]);
        }),
        denied,
      );
      assert.deepEqual(await migration.query(`SELECT id FROM app_user WHERE kind='root'`), []);
      assert.deepEqual(
        await migration.query('SELECT initialized_at FROM security_bootstrap_state'),
        [{ initialized_at: null }],
      );
    } finally {
      await bootstrap.destroy();
    }
  });
});

test('only the bootstrap credential issues activation for Root', async () => {
  await withProduct(async (_reconciler, migration, settings) => {
    const bootstrap = await new DataSource(
      productDataSourceOptions(settings.bootstrap),
    ).initialize();
    const identityPool = await new DataSource(
      productDataSourceOptions(settings.identity),
    ).initialize();
    try {
      const runner = new ProductTransactionRunner({ bootstrap, identity: identityPool });
      const release = prepareProductRelease(base, core);
      const issuer = 'https://idp.example.test';
      await migration.query(
        `INSERT INTO oidc_provider(issuer,version,enabled) VALUES('https://idp.example.test',1,true)`,
      );

      const denied = (e: { code?: string; driverError?: { code?: string } }) =>
        (e.driverError?.code ?? e.code) === '42501';

      // An ordinary pending account with a live proof exists before the bootstrap.
      const invited = randomUUID();
      await migration.query(
        `INSERT INTO app_user(id,email_canonical,state) VALUES($1,'invited@example.test','pending')`,
        [invited],
      );
      await bootstrap.query(
        `INSERT INTO one_time_token(token_hash,user_id,purpose,expires_at) VALUES(sha256('first'::bytea),$1,'oidc-activation',statement_timestamp()+interval '1 minute')`,
        [invited],
      );
      const { userId: root, initialized } = await bootstrapProductRoot(runner, audit, release, {
        operationId: randomUUID(),
        issuer,
        email: 'root@example.test',
      });
      assert.ok(initialized);
      // After bootstrap, identity cannot mint another proof for the pending Root ...
      await assert.rejects(
        identityPool.query(
          `INSERT INTO one_time_token(token_hash,user_id,purpose,expires_at) VALUES(sha256('raw'::bytea),$1,'oidc-activation',statement_timestamp()+interval '1 minute')`,
          [root],
        ),
        denied,
      );
      // ... nor retarget the earlier ordinary proof: identity may only mark tokens consumed.
      await assert.rejects(
        identityPool.query('UPDATE one_time_token SET user_id=$1 WHERE user_id=$2', [
          root,
          invited,
        ]),
        denied,
      );
      // The bootstrap credential reissues a lost or expired proof for the pending Root only.
      const { activationSecret } = await reissueRootActivation(runner, audit, { issuer });
      assert.match(activationSecret, /^[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(
        await migration.query(
          'SELECT count(*)::int n FROM one_time_token WHERE user_id=$1 AND consumed_at IS NULL',
          [root],
        ),
        [{ n: 1 }],
      );
      // The voided proof stays void: no login revives, deletes or rewrites a token.
      for (const pool of [identityPool, bootstrap])
        await assert.rejects(
          pool.query('UPDATE one_time_token SET consumed_at=NULL WHERE user_id=$1', [root]),
          denied,
        );
      await assert.rejects(
        identityPool.query('DELETE FROM one_time_token WHERE user_id=$1', [root]),
        denied,
      );
      // Activated (as the Google activation leaves it): no further proof.
      await activateRootAccount(identityPool, root, 'root-subject', issuer);
      await assert.rejects(
        reissueRootActivation(runner, audit, { issuer }),
        /pending bootstrap Root/,
      );
    } finally {
      await identityPool.destroy();
      await bootstrap.destroy();
    }
  });
});
