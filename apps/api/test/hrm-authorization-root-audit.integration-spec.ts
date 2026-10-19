// HR authorization: Root bypass, audit atomicity and deny rules.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ProductAccessDenied,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import { withClient } from './setup-postgres.ts';
import { oidcSession } from './oidc-fixture.helper.ts';
import {
  utf8,
  postgres,
  pools,
  migration,
  runner,
  authorization,
  rootId,
  p,
  t,
  freshRoot,
  visible,
  submitAs,
  stateOf,
  setupStack,
  teardownStack,
} from './hrm-authorization-stack.helper.ts';
import {
  submit,
  decideLead,
  rejectFinal,
  forgetsAudit,
} from './hrm-authorization-fixture-commands.helper.ts';

before(setupStack);
after(teardownStack);

test('Root bypasses authorization only: guards still apply, absent targets and effects are audited', async () => {
  const stale = await oidcSession(pools.identity, rootId);
  const pending = await submitAs('X', 'T2');
  // decideLead's policy has no fresh@1 (TD5), so a stale Root session is authorized like a fresh
  // one (ADR 0022); the command's own guard still refuses it and nothing changes.
  await assert.rejects(
    authorization.execute(stale, decideLead, { requestId: pending, expectedVersion: '1' }),
    (error) => error instanceof ProductCommandRejected && error.reason === 'not_current_approver',
  );
  assert.deepEqual(await stateOf(pending), { state: 'pending_lead', version: '1' });
  const root = await freshRoot();
  // Root reaches the record but is not the current first-step approver (no fallback to Root).
  await assert.rejects(
    authorization.execute(root, decideLead, { requestId: pending, expectedVersion: '1' }),
    (error) => error instanceof ProductCommandRejected && error.reason === 'not_current_approver',
  );
  assert.deepEqual(await stateOf(pending), { state: 'pending_lead', version: '1' });
  const missing = randomUUID();
  assert.equal(
    await authorization.execute(root, decideLead, { requestId: missing, expectedVersion: '1' }),
    undefined,
  );
  const final = await submitAs('E2', 'T1');
  assert.ok(
    await authorization.execute(p('L1').secret, decideLead, {
      requestId: final,
      expectedVersion: '1',
    }),
  );
  assert.deepEqual(
    await authorization.execute(root, rejectFinal, { requestId: final, expectedVersion: '2' }),
    { state: 'rejected', version: '3' },
  );
  const events = await migration.query<{ kind: string; metadata: Record<string, string> }[]>(
    `SELECT convert_from(event_kind,'UTF8') AS kind,safe_metadata AS metadata FROM audit_outbox WHERE actor_id=$1 AND convert_from(event_kind,'UTF8') LIKE ANY(ARRAY['hr.%','access.workRequest.%']) ORDER BY occurred_at,event_id`,
    [rootId],
  );
  assert.deepEqual(
    events.map((e) => [e.kind, e.metadata.principalKind, e.metadata.outcome, e.metadata.key]),
    [
      ['access.workRequest.decideLead', 'root', 'absent', missing],
      ['hr.request.decide-final', 'root', 'ok', final],
    ],
  );
});

test('a command without its audit event, or a failing audit writer, leaves no effect', async () => {
  const count = async () =>
    (
      await migration.query<{ n: string }[]>(
        'SELECT count(*)::text AS n FROM work_request WHERE employee_id=$1',
        [p('E4').employee],
      )
    )[0]?.n;

  const before = await count();
  const objectsBefore = (
    await migration.query<{ n: string }[]>(
      "SELECT count(*)::text AS n FROM object_ref WHERE type_key=convert_to('workRequest','UTF8')",
    )
  )[0]?.n;
  await assert.rejects(
    authorization.execute(p('E4').secret, forgetsAudit, {
      employeeId: p('E4').employee,
      teamId: t('T3'),
    }),
    /committed no audit event/,
  );
  await withClient(postgres.superuser, (client) =>
    client.query('REVOKE INSERT ON audit_outbox FROM product_data'),
  );
  try {
    await assert.rejects(
      authorization.execute(p('E4').secret, submit, {
        employeeId: p('E4').employee,
        teamId: t('T3'),
      }),
    );
  } finally {
    await withClient(postgres.superuser, (client) =>
      client.query('GRANT INSERT ON audit_outbox TO product_data'),
    );
  }
  assert.equal(await count(), before);
  assert.equal(
    (
      await migration.query<{ n: string }[]>(
        "SELECT count(*)::text AS n FROM object_ref WHERE type_key=convert_to('workRequest','UTF8')",
      )
    )[0]?.n,
    objectsBefore,
  );
  // Only commands registered at composition run; an equal-looking object is refused.
  await assert.rejects(
    authorization.execute(
      p('E4').secret,
      { ...submit },
      {
        employeeId: p('E4').employee,
        teamId: t('T3'),
      },
    ),
    ProductAccessDenied,
  );
});

test('a deny rule wins over every HR allow', async () => {
  const rule = randomUUID();
  await runner.run('admin', (tx) =>
    tx.manager.query(
      "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'deny',$4,1,'{}','runtime')",
      [rule, utf8('employee.read'), p('L2').id, utf8('allEmployees')],
    ),
  );
  assert.deepEqual(await visible('L2', 'employee'), []);
  assert.equal(
    await authorization.detail(p('L2').secret, 'employee', 'read', p('L2').employee),
    null,
  );
  await runner.run('admin', (tx) =>
    tx.manager.query('DELETE FROM policy_rule WHERE rule_id=$1', [rule]),
  );
  assert.equal((await visible('L2', 'employee')).length, 4);
});
