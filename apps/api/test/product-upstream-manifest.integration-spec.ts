import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyUpstreamManifest } from '../dist/infrastructure/product-upstream-manifest.service.js';
import { startModuleStack } from './hrm-stack.helper.ts';

const expected = { sequence: '6', manifestHash: 'ab'.repeat(32) };
const stateSql =
  'SELECT singleton,revision,manifest_hash,release_sequence,materialized_hash,min_runtime_capability FROM authz_state';

test('upstream verifies a Go-owned release without reconciling or changing revision and audit', async () => {
  const stack = await startModuleStack();
  try {
    await stack.pools.sync.query(
      "UPDATE authz_state SET manifest_hash=decode($1,'hex') WHERE singleton",
      [expected.manifestHash],
    );
    const before = await stack.pools.sync.query<unknown[]>(stateSql);
    const audit = await stack.migration.query<{ n: string }[]>(
      'SELECT count(*)::text n FROM audit_outbox',
    );
    await verifyUpstreamManifest(stack.runner, expected);
    assert.deepEqual(await stack.pools.sync.query<unknown[]>(stateSql), before);
    assert.deepEqual(
      await stack.migration.query('SELECT count(*)::text n FROM audit_outbox'),
      audit,
    );
    for (const value of [
      null,
      {},
      { ...expected, sequence: '0' },
      { ...expected, sequence: '06' },
      { ...expected, sequence: '9223372036854775808' },
      { ...expected, manifestHash: 'AB'.repeat(32) },
      { ...expected, extra: true },
      { ...expected, sequence: '7' },
      { ...expected, manifestHash: 'cd'.repeat(32) },
    ])
      await assert.rejects(verifyUpstreamManifest(stack.runner, value), /not_ready/);
    await stack.pools.sync.query('UPDATE authz_state SET materialized_hash=NULL WHERE singleton');
    await assert.rejects(verifyUpstreamManifest(stack.runner, expected), /not_ready/);
  } finally {
    await stack.stop();
  }
});

test('upstream refuses drift instead of repairing code-owned facts', async () => {
  const stack = await startModuleStack();
  try {
    await stack.pools.sync.query(
      "UPDATE authz_state SET manifest_hash=decode($1,'hex') WHERE singleton",
      [expected.manifestHash],
    );
    await stack.pools.sync.query(
      "UPDATE role_definition SET label='Changed fixture' WHERE role_key=convert_to('hr.employee','UTF8')",
    );
    await assert.rejects(verifyUpstreamManifest(stack.runner, expected), /not_ready/);
    const rows = await stack.pools.sync.query<{ label: string }[]>(
      "SELECT label FROM role_definition WHERE role_key=convert_to('hr.employee','UTF8')",
    );
    assert.equal(rows[0]?.label, 'Changed fixture');
  } finally {
    await stack.stop();
  }
});
