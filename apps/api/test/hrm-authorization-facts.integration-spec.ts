// HR authorization: fact changes take effect in the next transaction (split from the upgrade spec, ADR 0048).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorization,
  p,
  t,
  names,
  employeeKeys,
  visible,
  submitAs,
  revision,
  runner,
  setupStack,
  teardownStack,
} from './hrm-authorization-stack.helper.ts';
import { decideLead } from './hrm-authorization-fixture-commands.helper.ts';

before(setupStack);
after(teardownStack);

test('facts change in the next transaction: team removal moves step 1 (C-24), lead revoke closes it', async () => {
  const moved = await submitAs('E1', 'T2');
  const queued = await submitAs('E2', 'T1');

  const detail = (person: string, id: string) =>
    authorization.detail(p(person).secret, 'workRequest', 'read', id);

  assert.ok(await detail('L2', moved));
  assert.equal(await detail('L1', moved), null);
  const before = await revision();
  await runner.run('admin', (tx) =>
    tx.manager.query(
      'UPDATE team_membership SET ends_at=statement_timestamp() WHERE employee_id=$1 AND team_id=$2 AND ends_at IS NULL',
      [p('E1').employee, t('T2')],
    ),
  );
  assert.equal(BigInt((await revision()) ?? '0'), BigInt(before ?? '0') + 1n);
  assert.equal(await detail('L2', moved), null);
  assert.equal(
    await authorization.execute(p('L2').secret, decideLead, {
      requestId: moved,
      expectedVersion: '1',
    }),
    undefined,
  );
  // Step 1 is now the lead of the employee's primary team.
  assert.ok(await detail('L1', moved));
  await runner.run('admin', (tx) =>
    tx.manager.query(
      'UPDATE team_lead_assignment SET ends_at=statement_timestamp() WHERE team_id=$1 AND ends_at IS NULL',
      [t('T1')],
    ),
  );
  for (const id of [moved, queued]) {
    assert.equal(await detail('L1', id), null);
    assert.equal(
      await authorization.execute(p('L1').secret, decideLead, {
        requestId: id,
        expectedVersion: '1',
      }),
      undefined,
    );
  }
  assert.deepEqual(names(await visible('L1', 'employee'), employeeKeys()), ['E4', 'L1']);
});
