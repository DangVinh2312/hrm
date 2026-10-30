import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
} from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
import {
  ProductManifestReconciler,
  prepareProductRelease,
} from '../dist/authorization/services/product-manifest.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';

import {
  createProductAuthorizationCore,
  createProductRelease,
  productReleaseSource,
} from '../dist/authorization/product.manifest.js';
import { startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

const core = createProductAuthorizationCore();
const passwords = Object.fromEntries(
  ['data', 'identity', 'authority', 'sync', 'migration', 'bootstrap', 'outbox'].map((p) => [
    p,
    randomBytes(24).toString('hex'),
  ]),
) as Record<ProductDatabasePurpose, string>;
let fixture: TestPostgres;
before(async () => {
  fixture = await startPostgres();
});
after(async () => {
  await fixture?.stop();
});

/** A freshly provisioned product database (release_sequence 0) and its sync reconciler. */
async function freshDatabase(name: string) {
  await withClient(fixture.superuser, (c) => c.query(`CREATE DATABASE ${name}`));
  const settings = await provisionProductDatabase(
    { ...fixture.superuser, database: name },
    passwords,
  );
  const sync = await new DataSource(productDataSourceOptions(settings.sync)).initialize();
  const reconciler = new ProductManifestReconciler(new ProductTransactionRunner({ sync }), audit, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: { validators: ['fresh@1'], obligationHandlers: ['audit@1'] },
  });

  const sequence = async () =>
    (await sync.query<{ s: string }[]>('SELECT release_sequence::text s FROM authz_state'))[0]!.s;

  const migration = await new DataSource(productDataSourceOptions(settings.migration)).initialize();

  return { sync, migration, reconciler, sequence };
}

const release = (sequence: string, predecessor: string) =>
  prepareProductRelease({ ...productReleaseSource, sequence, predecessor }, core);

test('a fresh database accepts any release as its first; later releases keep a strict predecessor', async () => {
  const { sync, reconciler, sequence } = await freshDatabase('genesis_fresh');
  try {
    assert.equal((await reconciler.reconcile(release('2', '1'))).changed, true);
    assert.equal(await sequence(), '2');
    await assert.rejects(reconciler.reconcile(release('4', '3')), /predecessor_mismatch/);
    assert.equal((await reconciler.reconcile(release('3', '2'))).changed, true);
  } finally {
    await sync.destroy();
  }
});

test('genesis needs an empty code-owned catalog; otherwise the predecessor stays strict', async () => {
  const { sync, reconciler, sequence } = await freshDatabase('genesis_dirty');
  try {
    // A code-owned fact although nothing was published yet (release_sequence is still 0).
    await sync.query(
      "INSERT INTO resource_type(type_key,key_kind,binding_key) VALUES($1,'uuid',$1)",
      [Buffer.from('stray')],
    );
    await assert.rejects(reconciler.reconcile(release('2', '1')), /predecessor_mismatch/);
    assert.equal(await sequence(), '0');
    // The ordinary first release (predecessor 0) is unchanged.
    assert.equal((await reconciler.reconcile(release('1', '0'))).changed, true);
  } finally {
    await sync.destroy();
  }
});

test('a fresh database takes the product release (sequence 4 over 3) as its first; repeated sync changes nothing', async () => {
  const { sync, reconciler, sequence } = await freshDatabase('genesis_product');
  try {
    const product = createProductRelease(core);
    assert.deepEqual([productReleaseSource.sequence, productReleaseSource.predecessor], ['4', '3']);
    const first = await reconciler.reconcile(product);
    assert.equal(first.changed, true);
    assert.equal(first.manifestHash, product.hash);
    assert.equal(await sequence(), '4');
    assert.deepEqual(await reconciler.reconcile(product), { ...first, changed: false });
  } finally {
    await sync.destroy();
  }
});

type Declarations = typeof productReleaseSource.declarations;

/** `base` without the named actions of one resource: the content of an older release. */
const without = (
  base: Declarations,
  resource: string,
  actions: readonly string[],
): Declarations => ({
  ...base,
  resources: base.resources.map((declared) =>
    declared.key === resource
      ? {
          ...declared,
          actions: Object.fromEntries(
            Object.entries(declared.actions).filter(([action]) => !actions.includes(action)),
          ),
        }
      : declared,
  ),
});

const ROLE_WRITES = ['create', 'update', 'delete'];

const ACCOUNT_ROLE_COMMANDS = ['assignRole', 'revokeRole'];

const BOUNDARY_COMMANDS = ['bindBoundary', 'unbindBoundary'];

/** `base` without the boundary `key`. */
const withoutBoundary = (base: Declarations, key: string): Declarations => ({
  ...base,
  boundaries: base.boundaries.filter((boundary) => boundary.key !== key),
});

/** Release 3 as it was published: the product release without the boundary package and its two commands. */
const declarationsThree = () =>
  withoutBoundary(
    without(productReleaseSource.declarations, 'account', BOUNDARY_COMMANDS),
    'accountAdministration',
  );

/** Release 2 as it was published: release 3 without the two account role commands. */
const declarationsTwo = () => without(declarationsThree(), 'account', ACCOUNT_ROLE_COMMANDS);

const releaseThree = () =>
  prepareProductRelease(
    {
      ...productReleaseSource,
      sequence: '3',
      predecessor: '2',
      declarations: declarationsThree(),
    },
    core,
  );

const releaseTwo = () =>
  prepareProductRelease(
    { ...productReleaseSource, sequence: '2', predecessor: '1', declarations: declarationsTwo() },
    core,
  );

/** Release 1 as it was published: release 2 without the three role write actions. */
const releaseOne = () =>
  prepareProductRelease(
    {
      ...productReleaseSource,
      sequence: '1',
      predecessor: '0',
      declarations: without(declarationsTwo(), 'role', ROLE_WRITES),
    },
    core,
  );

test('upgrade 1 to 2 adds exactly role.create|update|delete; runtime roles are left alone and the hash ignores the sequence', async () => {
  const { sync, migration, reconciler, sequence } = await freshDatabase('genesis_upgrade');
  try {
    const one = releaseOne();
    assert.equal(
      one.hash,
      'd5b3cd60fac120749dbe66b7130325b6504e28a9cab4846efa98af998dda6030',
      'release 1 is the published genesis content',
    );
    assert.equal((await reconciler.reconcile(one)).changed, true);
    assert.equal(await sequence(), '1');

    const permissions = async () =>
      (
        await migration.query<{ key: string }[]>(
          "SELECT convert_from(permission_key,'UTF8') AS key FROM permission_catalog WHERE convert_from(permission_key,'UTF8') LIKE 'role.%' ORDER BY 1",
        )
      ).map((row) => row.key);

    assert.deepEqual(await permissions(), ['role.read']);

    const key = Buffer.from('custom.kept_by_sync');
    await migration.query(
      "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'runtime','Kept')",
      [key],
    );
    await migration.query(
      "INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
      [randomUUID(), Buffer.from('role.read'), key, Buffer.from('role')],
    );

    const two = releaseTwo();
    assert.equal(
      two.hash,
      'b97020cae49b063b8420fe9112daba0348b250df89e97e9be536b798e471c789',
      'release 2 is the published content',
    );
    const upgraded = await reconciler.reconcile(two);
    assert.equal(upgraded.changed, true);
    assert.equal(await sequence(), '2');
    assert.deepEqual(await permissions(), [
      'role.create',
      'role.delete',
      'role.read',
      'role.update',
    ]);
    const defaults = await migration.query<{ n: number }[]>(
      "SELECT count(*)::int AS n FROM policy_rule WHERE managed_by='code' AND convert_from(permission_key,'UTF8') IN ('role.create','role.update','role.delete')",
    );
    assert.equal(defaults[0]?.n, 0, 'no default grant for a role write');
    const kept = await migration.query<{ label: string; rules: number }[]>(
      "SELECT d.label, (SELECT count(*)::int FROM policy_rule r WHERE r.role_key=d.role_key) AS rules FROM role_definition d WHERE d.role_key=$1 AND d.managed_by='runtime'",
      [key],
    );
    assert.deepEqual(kept, [{ label: 'Kept', rules: 1 }]);
    assert.equal((await reconciler.reconcile(two)).changed, false);
    // The release hash covers content only: another sequence over the same content is the same hash.
    assert.equal(
      prepareProductRelease(
        {
          ...productReleaseSource,
          sequence: '9',
          predecessor: '8',
          declarations: declarationsTwo(),
        },
        core,
      ).hash,
      two.hash,
    );
  } finally {
    await migration.destroy();
    await sync.destroy();
  }
});

test('upgrade 2 to 3 adds exactly account.assignRole|revokeRole; held roles and rules are left alone, no default grant', async () => {
  const { sync, migration, reconciler, sequence } = await freshDatabase('genesis_upgrade_3');
  try {
    const two = releaseTwo();
    assert.equal((await reconciler.reconcile(releaseOne())).changed, true);
    assert.equal((await reconciler.reconcile(two)).changed, true);
    assert.equal(await sequence(), '2');

    const permissions = async () =>
      (
        await migration.query<{ key: string }[]>(
          "SELECT convert_from(permission_key,'UTF8') AS key FROM permission_catalog WHERE convert_from(permission_key,'UTF8') LIKE 'account.%' ORDER BY 1",
        )
      ).map((row) => row.key);

    assert.deepEqual(await permissions(), [
      'account.provision',
      'account.reactivate',
      'account.read',
      'account.readPermissions',
      'account.suspend',
    ]);

    const user = randomUUID();
    await migration.query(
      "INSERT INTO app_user(id,state,email_verified) VALUES($1,'active',true)",
      [user],
    );
    await migration.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
      user,
      Buffer.from('hr.admin'),
    ]);

    const codeRules = () =>
      migration.query<{ n: number }[]>(
        "SELECT count(*)::int AS n FROM policy_rule WHERE managed_by='code'",
      );

    const before = (await codeRules())[0]?.n;

    const three = releaseThree();
    assert.equal(
      three.hash,
      'ed170f558c46b68d6844d9b381ead9f3a9002533ac5511262d8f3ce9041d3893',
      'release 3 is the published content',
    );
    assert.equal((await reconciler.reconcile(three)).changed, true);
    assert.equal(await sequence(), '3');
    assert.deepEqual(await permissions(), [
      'account.assignRole',
      'account.provision',
      'account.reactivate',
      'account.read',
      'account.readPermissions',
      'account.revokeRole',
      'account.suspend',
    ]);
    assert.equal((await codeRules())[0]?.n, before, 'no default grant for either command');
    const held = await migration.query<{ role: string }[]>(
      "SELECT convert_from(role_key,'UTF8') AS role FROM user_role WHERE user_id=$1",
      [user],
    );
    assert.deepEqual(held, [{ role: 'hr.admin' }]);
    assert.equal((await reconciler.reconcile(three)).changed, false);
  } finally {
    await migration.destroy();
    await sync.destroy();
  }
});

test('upgrade 3 to 4 adds account.bindBoundary|unbindBoundary and accountAdministration@1; from now on an IAM account with a grant and a binding reaches provision, suspend and reactivate, and nothing runtime is touched', async () => {
  const { sync, migration, reconciler, sequence } = await freshDatabase('genesis_upgrade_4');
  try {
    assert.equal((await reconciler.reconcile(releaseOne())).changed, true);
    assert.equal((await reconciler.reconcile(releaseTwo())).changed, true);
    assert.equal((await reconciler.reconcile(releaseThree())).changed, true);
    assert.equal(await sequence(), '3');

    const boundaries = () =>
      migration.query<{ key: string; permissions: string[] }[]>(
        `SELECT convert_from(d.boundary_key,'UTF8') AS key,
                ARRAY(SELECT convert_from(e.permission_key,'UTF8') FROM permission_boundary_entry e
                       WHERE e.boundary_key=d.boundary_key AND e.boundary_version=d.boundary_version ORDER BY 1) AS permissions
           FROM permission_boundary d ORDER BY 1`,
      );

    const commands = async () =>
      (
        await migration.query<{ key: string }[]>(
          "SELECT convert_from(permission_key,'UTF8') AS key FROM permission_catalog WHERE convert_from(permission_key,'UTF8') LIKE 'account.%Boundary' ORDER BY 1",
        )
      ).map((row) => row.key);

    // Before: no boundary covers account.* or role.*, so no binding can exist and only Root
    // reaches provision, suspend and reactivate over HTTP.
    assert.deepEqual(
      (await boundaries()).map((row) => row.key),
      ['hrAdministration'],
    );
    assert.deepEqual(await commands(), []);

    const user = randomUUID();
    await migration.query(
      "INSERT INTO app_user(id,state,email_verified) VALUES($1,'active',true)",
      [user],
    );
    await migration.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
      user,
      Buffer.from('hr.admin'),
    ]);
    const bindSql =
      'INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,$2,$3,1)';
    const refused = await migration
      .query(bindSql, [user, Buffer.from('account.suspend'), Buffer.from('accountAdministration')])
      .then(
        () => 'inserted',
        (error: { code?: string }) => error.code,
      );
    assert.equal(refused, '23503', 'no boundary entry to bind to');

    const codeRules = () =>
      migration.query<{ n: number }[]>(
        "SELECT count(*)::int AS n FROM policy_rule WHERE managed_by='code'",
      );

    const before = (await codeRules())[0]?.n;

    const four = createProductRelease(core);
    assert.equal((await reconciler.reconcile(four)).changed, true);
    assert.equal(await sequence(), '4');
    assert.deepEqual(await commands(), ['account.bindBoundary', 'account.unbindBoundary']);
    assert.deepEqual(await boundaries(), [
      {
        key: 'accountAdministration',
        permissions: [
          'account.assignRole',
          'account.bindBoundary',
          'account.provision',
          'account.reactivate',
          'account.revokeRole',
          'account.suspend',
          'account.unbindBoundary',
          'role.delete',
          'role.update',
        ],
      },
      { key: 'hrAdministration', permissions: ['employee.linkAccount', 'team.assign'] },
    ]);
    assert.equal((await codeRules())[0]?.n, before, 'no default grant for either command');
    const seeded = await migration.query<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM user_boundary',
    );
    assert.equal(seeded[0]?.n, 0, 'the release binds nobody');

    // After: the binding is possible, and sync leaves a runtime binding alone from then on.
    await migration.query(bindSql, [
      user,
      Buffer.from('account.suspend'),
      Buffer.from('accountAdministration'),
    ]);
    assert.equal((await reconciler.reconcile(four)).changed, false);
    const kept = await migration.query<{ seeded: boolean }[]>(
      'SELECT seed_owner IS NOT NULL AS seeded FROM user_boundary WHERE user_id=$1',
      [user],
    );
    assert.deepEqual(kept, [{ seeded: false }]);
    const held = await migration.query<{ role: string }[]>(
      "SELECT convert_from(role_key,'UTF8') AS role FROM user_role WHERE user_id=$1",
      [user],
    );
    assert.deepEqual(held, [{ role: 'hr.admin' }]);
  } finally {
    await migration.destroy();
    await sync.destroy();
  }
});

test('reconcile refuses the same sequence with other content and any older sequence', async () => {
  const { sync, reconciler, sequence } = await freshDatabase('genesis_reject');
  try {
    assert.equal((await reconciler.reconcile(release('1', '0'))).changed, true);
    const relabelled = prepareProductRelease(
      {
        ...productReleaseSource,
        sequence: '1',
        predecessor: '0',
        roles: productReleaseSource.roles.map((r, i) => (i === 0 ? { ...r, label: 'Other' } : r)),
      },
      core,
    );
    await assert.rejects(reconciler.reconcile(relabelled), /conflicting_release/);
    assert.equal((await reconciler.reconcile(release('2', '1'))).changed, true);
    await assert.rejects(reconciler.reconcile(release('1', '0')), /downgrade/);
    assert.equal(await sequence(), '2');
  } finally {
    await sync.destroy();
  }
});
