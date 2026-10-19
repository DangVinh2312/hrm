import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { prepareProductRelease } from '../dist/authorization/services/product-manifest.service.js';
import { core } from './core/fixtures.ts';
import {
  base,
  offlineAlter,
  startRegressionPostgres,
  stopRegressionPostgres,
  withProduct,
} from './system-regression.helper.ts';

before(startRegressionPostgres);
after(stopRegressionPostgres);

test('a new release cannot adopt drift in a persisted code-owned grant omitted from it', async () => {
  await withProduct(async (reconciler, migration) => {
    await offlineAlter(migration, "UPDATE policy_rule SET effect='deny' WHERE managed_by='code'");
    await assert.rejects(
      reconciler.reconcile(prepareProductRelease(base, core)),
      /drift|not_ready|immutable_definition/,
    );
    const next = prepareProductRelease(
      { ...base, sequence: '2', predecessor: '1', defaultGrants: [] },
      core,
    );
    await assert.rejects(reconciler.reconcile(next), /drift|not_ready|immutable_definition/);
    assert.equal(
      (
        await migration.query<{ sequence: string }[]>(
          'SELECT release_sequence::text sequence FROM authz_state',
        )
      )[0]!.sequence,
      '1',
    );
  });
});
test('a code-owned grant with a rewritten rule ID is drift, not a fresh grant', async () => {
  await withProduct(async (reconciler, migration) => {
    await offlineAlter(migration, "UPDATE policy_rule SET rule_id=$1 WHERE managed_by='code'", [
      randomUUID(),
    ]);
    const next = prepareProductRelease({ ...base, sequence: '2', predecessor: '1' }, core);
    await assert.rejects(
      reconciler.reconcile(next),
      /drift|not_ready|collision|immutable_definition/,
    );
    assert.equal(
      (
        await migration.query<{ sequence: string }[]>(
          'SELECT release_sequence::text sequence FROM authz_state',
        )
      )[0]!.sequence,
      '1',
    );
  });
});
