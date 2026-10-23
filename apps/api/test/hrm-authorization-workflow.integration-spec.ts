// HR authorization: workflow commands, then SQL/evaluator parity over the rows they leave (order-dependent).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  IdentityId,
  UserCompleteFacts,
} from '../dist/authorization/core/authorization.types.js';
import {
  ProductCommandRejected,
  readProductAuthority,
  type ProductCommand,
} from '../dist/authorization/services/product-authority.service.js';
import { ProductDataGateway } from '../dist/authorization/product-data.gateway.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import {
  core,
  release,
  validators,
  migration,
  runner,
  bindings,
  authorization,
  p,
  t,
  names,
  visible,
  submitAs,
  stateOf,
  setupStack,
  teardownStack,
} from './hrm-authorization-stack.helper.ts';
import {
  type DecideInput,
  type Decided,
  submit,
  decideLead,
  rejectFinal,
  cancel,
} from './hrm-authorization-fixture-commands.helper.ts';

before(setupStack);
after(teardownStack);

test('commands: own record only, current lead, COO final stage, owner cancel; no default approval for CEO or HR', async () => {
  const requests: Record<string, string> = {};
  // Owner spoof: another employee's record is not found, like an absent one.
  assert.equal(
    await authorization.execute(p('E2').secret, submit, {
      employeeId: p('E1').employee,
      teamId: t('T1'),
    }),
    undefined,
  );
  requests.qA = await submitAs('E1', 'T1');
  requests.qB = await submitAs('E1', 'T2');
  requests.qC = await submitAs('E5', 'T4');
  requests.qD = await submitAs('X', 'T2');

  const seen = async (person: string) => names(await visible(person, 'workRequest'), requests);

  assert.deepEqual(await seen('E1'), ['qA', 'qB']);
  assert.deepEqual(await seen('L1'), ['qA']);
  assert.deepEqual(await seen('L2'), ['qB', 'qD']);
  assert.deepEqual(await seen('C'), []);
  assert.deepEqual(await seen('H'), ['qA', 'qB', 'qC', 'qD']);
  assert.deepEqual(await seen('X'), ['qD']);
  assert.deepEqual(await seen('E2'), []);

  const decide = (person: string, command: ProductCommand<DecideInput, Decided>, id: string) =>
    authorization.execute(p(person).secret, command, { requestId: id, expectedVersion: '1' });

  // C-21: the lead of the request's team decides; the employee's other lead does not see it.
  assert.equal(await decide('L1', decideLead, requests.qB), undefined);
  // A team without a lead: nobody decides step 1 (no fallback, D01).
  for (const person of ['L1', 'L2', 'H', 'C', 'X'])
    assert.equal(await decide(person, decideLead, requests.qC), undefined, person);
  // CEO holds no approval grant: step 1 needs an assignment, step 2 needs hr.coo. Without a grant
  // the plan is `false`, so the record is as absent as a foreign one (404, default deny).
  assert.equal(await decide('X', decideLead, requests.qD), undefined);
  for (const person of ['X', 'H', 'L2', 'E1'])
    assert.equal(await decide(person, rejectFinal, requests.qB), undefined, person);
  await assert.rejects(
    authorization.execute(p('L2').secret, decideLead, {
      requestId: requests.qB,
      expectedVersion: '7',
    }),
    (error) => error instanceof ProductCommandRejected && error.reason === 'invalid_transition',
  );
  assert.deepEqual(await stateOf(requests.qB), { state: 'pending_lead', version: '1' });
  assert.deepEqual(await decide('L2', decideLead, requests.qB), {
    state: 'pending_final',
    version: '2',
  });
  // The stage policy closes the record for a second lead decision.
  assert.equal(await decide('L2', decideLead, requests.qB), undefined);
  assert.deepEqual(await seen('C'), ['qB']);
  assert.equal(await decide('C', rejectFinal, requests.qA), undefined);
  assert.deepEqual(
    await authorization.execute(p('C').secret, rejectFinal, {
      requestId: requests.qB,
      expectedVersion: '2',
    }),
    { state: 'rejected', version: '3' },
  );
  // Deciders keep reading what they decided (D02); the final queue no longer holds it.
  assert.deepEqual(await seen('C'), ['qB']);
  assert.deepEqual(await seen('L2'), ['qB', 'qD']);
  assert.equal(await decide('E2', cancel, requests.qA), undefined);
  assert.equal(await decide('E1', cancel, requests.qB), undefined);
  assert.deepEqual(await decide('E1', cancel, requests.qA), { state: 'cancelled', version: '2' });

  // A lead's own request reaches the lead's scope; the code-owned guard still refuses it.
  const own = await submitAs('L1', 'T3');
  await assert.rejects(
    decide('L1', decideLead, own),
    (error) => error instanceof ProductCommandRejected && error.reason === 'self_decision',
  );
  assert.deepEqual(await stateOf(own), { state: 'pending_lead', version: '1' });

  const [event] = await migration.query<
    { kind: string; actor: string; permission: string; object: string; metadata: object }[]
  >(
    `SELECT convert_from(event_kind,'UTF8') AS kind,actor_id::text AS actor,convert_from(permission_key,'UTF8') AS permission,object_id::text AS object,safe_metadata AS metadata
      FROM audit_outbox WHERE convert_from(event_kind,'UTF8')='hr.request.submit' AND safe_metadata->>'key'=$1`,
    [requests.qA],
  );
  const [{ object } = { object: '' }] = await migration.query<{ object: string }[]>(
    'SELECT object_id::text AS object FROM work_request WHERE id=$1',
    [requests.qA],
  );
  assert.deepEqual(event && { ...event, metadata: { ...event.metadata, resultingRevision: '' } }, {
    kind: 'hr.request.submit',
    actor: p('E1').id,
    permission: 'employee.submitRequest',
    object,
    metadata: { resource: 'workRequest', keyKind: 'uuid', key: requests.qA, resultingRevision: '' },
  });
});

test('SQL scopes match the evaluator on every HR row (parity)', async () => {
  const gateway = new ProductDataGateway(bindings);
  let partial = 0;
  const relations: Record<string, readonly [string, string, string]> = {
    'employee.lead': ['hr_employee_lead', 'employee_id', 'lead_account_id'],
    'workRequest.owner': ['hr_request_owner', 'request_id', 'account_id'],
    'workRequest.lead': ['hr_request_lead', 'request_id', 'lead_account_id'],
    'workRequest.decider': ['hr_request_decider', 'request_id', 'actor_account_id'],
    'workRequest.leadRejectedLeadOwned': [
      'hr_request_lead_rejected',
      'request_id',
      'owner_account_id',
    ],
  };
  for (const person of ['E1', 'L1', 'L2', 'C', 'H', 'X']) {
    for (const resource of ['employee', 'workRequest'] as const) {
      await runner.run('read', async (tx) => {
        const snapshot = await readProductAuthority(
          tx,
          p(person).id,
          `${resource}.read`,
          release.declarations,
          {
            validators,
            obligationHandlers: Object.keys(createProductObligations(new ProductAuditRepository())),
          },
        );
        const [clock] = await tx.manager.query<{ now: string; until: string }[]>(
          `SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now,
            to_char((statement_timestamp()+interval '1 second') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS until`,
        );
        assert.ok(clock);
        const decision = core.planUser(
          {
            principal: { id: p(person).id, assurance: 1 },
            resource,
            action: 'read',
            context: { freshAuthentication: false },
            now: clock.now,
            validUntil: clock.until,
          },
          snapshot,
        );
        assert.equal(decision.effect, 'allow', `${person} ${resource}`);
        if (decision.effect !== 'allow') return;
        const rows = await tx.manager.query<
          { key: string; object_id: string; fields: Record<string, string | null> }[]
        >(
          resource === 'employee'
            ? `SELECT id::text AS key,object_id::text,json_build_object('code',code,'fullName',full_name,'accountId',account_id) AS fields FROM employee ORDER BY id`
            : `SELECT id::text AS key,object_id::text,json_build_object('kind',kind,'state',state,'version',version::text) AS fields FROM work_request ORDER BY id`,
        );
        const edges: UserCompleteFacts['edges'][number][] = [];
        for (const [relation, [view, source, target]] of Object.entries(relations)) {
          if (!relation.startsWith(`${resource}.`)) continue;
          for (const edge of await tx.manager.query<{ source: string; target: string }[]>(
            `SELECT ${source}::text AS source,${target}::text AS target FROM ${view}`,
          ))
            edges.push({
              relation: { key: relation, version: 1 },
              source: rows.find((row) => row.key === edge.source)?.object_id ?? '',
              target: { kind: 'identity' as const, identity: edge.target as IdentityId },
              startsAt: '2000-01-01T00:00:00Z',
              expiresAt: null,
            });
        }
        const expected = rows
          .filter((row) => {
            const record = {
              type: resource,
              key: core.parseKey('uuid', row.key),
              objectId: row.object_id,
              fields: row.fields,
            };
            const facts: UserCompleteFacts = {
              now: clock.now,
              record,
              objects: [record],
              edges,
              exceptions: [],
            };
            return core.evaluateUser(decision.plan, facts).effect === 'allow';
          })
          .map((row) => row.key);
        const page = await gateway.list(decision.plan, { limit: 100 }, tx);
        assert.deepEqual(
          page.items.map((item) => item.key),
          expected,
          `${person} ${resource}`,
        );
        if (expected.length > 0 && expected.length < rows.length) partial += 1;
      });
    }
  }
  // Scoped, non-trivial cases: some rows visible and some hidden, for most principals.
  assert.ok(partial >= 6, `partial scopes: ${partial}`);
});
