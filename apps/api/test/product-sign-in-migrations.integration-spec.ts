// Sign-in methods: migrations 014, 015 and 017 against the real logins.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { verifyProductPrivileges } from '../dist/database/helpers/product-database.helper.js';
import { protectBindingRefBody } from '../dist/database/migrations/014-sign-in-methods.migration.js';
import { ProductSingleGoogleBinding1792108800017 } from '../dist/database/migrations/017-single-google-binding.migration.js';
import { sqlState } from './setup-postgres.ts';
import {
  issuer,
  second,
  redirectUri,
  pools,
  migration,
  setupStack,
  teardownStack,
} from './product-sign-in-stack.helper.ts';
import {
  superuser,
  account,
  bind,
  bindings,
  epoch,
  emailState,
} from './product-sign-in-fixtures.helper.ts';

before(setupStack);
after(teardownStack);

test('migration 014: unique immutable binding_ref, column grants, exact probes', async () => {
  await verifyProductPrivileges(pools);
  const owner = await account();
  const ref = await bind(owner.id, issuer, 'grant-subject');
  assert.match(ref, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Identity writes no column of a binding once it exists (migration 017: nothing re-enables or
  // disables one any more).
  assert.equal(
    await sqlState(
      pools.identity.query(
        `UPDATE external_identity SET enabled=false,binding_version=binding_version+1 WHERE binding_ref=$1`,
        [ref],
      ),
    ),
    '42501',
  );
  assert.equal(
    await sqlState(
      pools.identity.query(
        `UPDATE external_identity SET binding_ref=gen_random_uuid() WHERE binding_ref=$1`,
        [ref],
      ),
    ),
    '42501',
  );
  assert.equal(
    await sqlState(
      pools.identity.query(`UPDATE external_identity SET user_id=$2 WHERE binding_ref=$1`, [
        ref,
        owner.id,
      ]),
    ),
    '42501',
  );
  assert.equal(
    await sqlState(
      pools.identity.query(
        `INSERT INTO external_identity(issuer,subject,user_id,binding_ref) VALUES($1,'chosen-ref',$2,gen_random_uuid())`,
        [issuer, owner.id],
      ),
    ),
    '42501',
  );
  // The trigger refuses a changed reference to the table owner and to a superuser alike.
  assert.equal(
    await sqlState(
      migration.query(
        `UPDATE external_identity SET binding_ref=gen_random_uuid() WHERE binding_ref=$1`,
        [ref],
      ),
    ),
    '42501',
  );
  assert.equal(
    await sqlState(
      superuser(`UPDATE external_identity SET binding_ref=gen_random_uuid() WHERE binding_ref=$1`, [
        ref,
      ]),
    ),
    '42501',
  );
  assert.equal((await bindings(owner.id))[0]?.ref, ref);
  const privilegeDrift = [
    [
      'GRANT UPDATE(binding_ref) ON external_identity TO product_identity',
      'REVOKE UPDATE(binding_ref) ON external_identity FROM product_identity',
    ],
    [
      'GRANT INSERT(binding_ref) ON external_identity TO product_identity',
      'REVOKE INSERT(binding_ref) ON external_identity FROM product_identity',
    ],
    [
      'GRANT UPDATE ON external_identity TO product_identity',
      'REVOKE UPDATE ON external_identity FROM product_identity',
    ],
    [
      'GRANT UPDATE(enabled,binding_version) ON external_identity TO product_identity',
      'REVOKE UPDATE(enabled,binding_version) ON external_identity FROM product_identity',
    ],
    [
      'REVOKE INSERT(user_id) ON external_identity FROM product_identity',
      'GRANT INSERT(user_id) ON external_identity TO product_identity',
    ],
    [
      'GRANT EXECUTE ON FUNCTION public.protect_binding_ref() TO PUBLIC',
      'REVOKE EXECUTE ON FUNCTION public.protect_binding_ref() FROM PUBLIC',
    ],
  ] as const;
  for (const [alter, restore] of privilegeDrift) {
    await superuser(alter);
    try {
      await assert.rejects(verifyProductPrivileges(pools), /privilege drift/, alter);
    } finally {
      await superuser(restore);
    }
    await verifyProductPrivileges(pools);
  }
  const trigger =
    'CREATE TRIGGER protect_binding_ref BEFORE UPDATE ON external_identity FOR EACH ROW EXECUTE FUNCTION public.protect_binding_ref()';

  const body = (text: string) =>
    `CREATE OR REPLACE FUNCTION public.protect_binding_ref() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$${text}$fn$`;

  const protectionDrift = [
    ['DROP TRIGGER protect_binding_ref ON external_identity', trigger],
    [
      'ALTER TABLE external_identity DISABLE TRIGGER protect_binding_ref',
      'ALTER TABLE external_identity ENABLE TRIGGER protect_binding_ref',
    ],
    [
      'DROP TRIGGER protect_binding_ref ON external_identity; CREATE TRIGGER protect_binding_ref BEFORE UPDATE OF user_id ON external_identity FOR EACH ROW EXECUTE FUNCTION public.protect_binding_ref()',
      `DROP TRIGGER protect_binding_ref ON external_identity; ${trigger}`,
    ],
    [body('BEGIN RETURN NEW; END'), body(protectBindingRefBody)],
    [
      'ALTER FUNCTION public.protect_binding_ref() SET search_path=public',
      'ALTER FUNCTION public.protect_binding_ref() SET search_path=pg_catalog,pg_temp',
    ],
    [
      'CREATE TRIGGER protect_binding_ref_copy BEFORE UPDATE ON external_identity FOR EACH ROW EXECUTE FUNCTION public.protect_binding_ref()',
      'DROP TRIGGER protect_binding_ref_copy ON external_identity',
    ],
  ] as const;
  for (const [alter, restore] of protectionDrift) {
    await superuser(alter);
    try {
      await assert.rejects(verifyProductPrivileges(pools), /protection drift/, alter);
    } finally {
      await superuser(restore);
    }
    await verifyProductPrivileges(pools);
  }
});

test('migration 015: identity never deletes bindings; an email change must advance auth_epoch for every login', async () => {
  await verifyProductPrivileges(pools);
  const owner = await account({ verified: false });
  const ref = await bind(owner.id, issuer, 'delete-subject');
  // A deleted and re-inserted tuple would come back under a new binding_ref (ADR 0023 §2).
  assert.equal(
    await sqlState(
      pools.identity.query(`DELETE FROM external_identity WHERE binding_ref=$1`, [ref]),
    ),
    '42501',
  );
  assert.equal((await bindings(owner.id))[0]?.ref, ref);
  const before = await epoch(owner.id);
  for (const sql of [
    `UPDATE app_user SET email_verified=true WHERE id=$1`,
    `UPDATE app_user SET email_verified=true,auth_epoch=auth_epoch WHERE id=$1`,
    `UPDATE app_user SET email_canonical='moved-'||email_canonical,auth_epoch=auth_epoch WHERE id=$1`,
    `UPDATE app_user SET email_canonical=NULL WHERE id=$1`,
  ]) {
    assert.equal(await sqlState(pools.identity.query(sql, [owner.id])), '42501', sql);
    assert.equal(await sqlState(migration.query(sql, [owner.id])), '42501', sql);
    assert.equal(await sqlState(superuser(sql, [owner.id])), '42501', sql);
  }
  assert.deepEqual(await emailState(owner.id), { email: owner.email, verified: false });
  // Writing the same values is no change; a change with a new epoch passes.
  await migration.query(`UPDATE app_user SET email_verified=false WHERE id=$1`, [owner.id]);
  assert.equal(await epoch(owner.id), before);
  await pools.identity.query(
    `UPDATE app_user SET email_verified=true,auth_epoch=auth_epoch+1 WHERE id=$1`,
    [owner.id],
  );
  assert.equal(await epoch(owner.id), String(BigInt(before!) + 1n));
  // Bootstrap reaches no IAM email, with or without a new epoch.
  for (const sql of [
    `UPDATE app_user SET email_canonical='boot-'||email_canonical,email_verified=false,auth_epoch=auth_epoch+1 WHERE id=$1`,
    `UPDATE app_user SET email_verified=false WHERE id=$1`,
  ])
    assert.equal(await sqlState(pools.bootstrap.query(sql, [owner.id])), '42501', sql);
  assert.deepEqual(await emailState(owner.id), { email: owner.email, verified: true });
});

test('migration 017: one enabled Google binding per account, no link or reauth attempts, no link proofs', async () => {
  await verifyProductPrivileges(pools);
  const owner = await account();
  await bind(owner.id, issuer, 'single-first');
  // A second enabled binding is refused to every login, the owner and a superuser alike.
  assert.equal(
    await sqlState(
      pools.identity.query(
        `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,'single-second',$2)`,
        [second, owner.id],
      ),
    ),
    '23505',
  );
  assert.equal(
    await sqlState(
      superuser(
        `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,'single-second',$2)`,
        [second, owner.id],
      ),
    ),
    '23505',
  );
  // A disabled row (history of an earlier unlink) does not count.
  await migration.query(
    `INSERT INTO external_identity(issuer,subject,user_id,enabled) VALUES($1,'single-old',$2,false)`,
    [second, owner.id],
  );
  assert.deepEqual(
    (await bindings(owner.id)).map((b) => [b.subject, b.enabled]),
    [
      ['single-first', true],
      ['single-old', false],
    ],
  );
  // Only login and activation attempts remain; the session column of link/reauth is gone.
  for (const purpose of ['link', 'reauth'])
    assert.equal(
      await sqlState(
        pools.identity.query(
          `INSERT INTO oidc_login_attempt(state_hash,nonce,verifier,provider_issuer,provider_version,redirect_uri,expires_at,browser_hash,purpose)
           VALUES($1,'n','v',$2,1,$3,statement_timestamp()+interval '5 minutes',$4,$5)`,
          [randomBytes(32), issuer, redirectUri, randomBytes(32), purpose],
        ),
      ),
      '23514',
      purpose,
    );
  assert.equal(
    await sqlState(pools.identity.query('SELECT linking_session_hash FROM oidc_login_attempt')),
    '42703',
  );
  assert.equal(await sqlState(pools.identity.query('SELECT 1 FROM oidc_link_proof')), '42P01');

  // Preflight: the migration refuses a database where an account holds two enabled bindings,
  // before any change (dev data is fixed by hand first, ADR 0027 §6).
  await superuser('DROP INDEX public.uq_external_identity_one_enabled');
  try {
    await superuser(
      `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,'single-second',$2)`,
      [second, owner.id],
    );
    const queryRunner = migration.createQueryRunner();
    await queryRunner.startTransaction();
    try {
      await assert.rejects(
        new ProductSingleGoogleBinding1792108800017().up(queryRunner),
        /more than one enabled Google binding/,
      );
    } finally {
      await queryRunner.rollbackTransaction();
      await queryRunner.release();
    }
  } finally {
    await superuser(`DELETE FROM external_identity WHERE issuer=$1 AND subject='single-second'`, [
      second,
    ]);
    await superuser(
      'CREATE UNIQUE INDEX uq_external_identity_one_enabled ON public.external_identity(user_id) WHERE enabled',
    );
  }
  await verifyProductPrivileges(pools);
});
