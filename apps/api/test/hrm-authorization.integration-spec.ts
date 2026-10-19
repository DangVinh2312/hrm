import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { DataSource } from 'typeorm';
import type {
  IdentityId,
  UserCompleteFacts,
  UserId,
} from '../dist/authorization/core/authorization.types.js';
import {
  ProductAccessDenied,
  ProductAuthorization,
  ProductCommandRejected,
  readProductAuthority,
  type ProductCommand,
} from '../dist/authorization/services/product-authority.service.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import { ProductDataGateway } from '../dist/authorization/product-data.gateway.js';
import {
  ProductManifestReconciler,
  bootstrapProductRoot,
  prepareProductRelease,
} from '../dist/authorization/services/product-manifest.service.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
  productBindings,
  productReleaseSource,
} from '../dist/authorization/product.manifest.js';
import { documentDefaultGrants } from '../dist/document/document.declarations.js';
import { hrDeclarations } from '../dist/hr/hr.declarations.js';
import { productObligations } from '../dist/authorization/helpers/product-obligations.helper.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  productMigrations,
  provisionProductDatabase,
  verifyProductPrivileges,
} from '../dist/database/helpers/product-database.helper.js';
import { HrmAuthorization1792108800100 } from '../dist/hr/migrations/hrm-authorization.migration.js';
import { HrmEmployee1792108800101 } from '../dist/employee/migrations/hrm-employee.migration.js';
import { HrmTeam1792108800102 } from '../dist/team/migrations/hrm-team.migration.js';
import {
  hrPrivileges,
  registerHrObject,
  verifyHrProtection,
} from '../dist/hr/hr-database.helper.js';
import { sqlState, startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';
import {
  activateAccount,
  bindAccount,
  fixtureProvider,
  FIXTURE_ISSUER,
  oidcSession,
} from './oidc-fixture.helper.ts';
import { releaseThreeHash, releaseThreeSource } from './fixtures/release-three.ts';
import { releaseFourHash, releaseFourSource } from './fixtures/release-four.ts';

// Fixture after docs/hrm-acceptance.md (synthetic people only): T1 lead L1 {E1, E2, L1},
// T2 lead L2 {L2, C, X, E1 secondary}, T3 lead L1 {E4, L1 secondary}, T4 without lead {E5}.
const core = createProductAuthorizationCore();
const release = createProductRelease(core);
const validators = {
  'fresh@1': (_params: unknown, input: { context: { freshAuthentication?: unknown } }) =>
    input.context.freshAuthentication === true,
};

const utf8 = (value: string) => Buffer.from(value, 'utf8');

let postgres: TestPostgres;
let pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;
let migration: DataSource;
let runner: ProductTransactionRunner;
let bindings: ProductBindingRegistry;
let authorization: ProductAuthorization;

interface Person {
  readonly id: UserId;
  readonly secret: string;
  employee: string;
}
const people: Record<string, Person> = {};
const teams: Record<string, string> = {};
const objects = new Map<string, string>();
const rootEmail = 'root@example.test';
let rootId: UserId;

type SubmitInput = { readonly employeeId: string; readonly teamId: string };
type DecideInput = { readonly requestId: string; readonly expectedVersion: string };
type Decided = { readonly state: string; readonly version: string };

/**
 * Fixture commands standing in for T5/T6 handlers: they exercise the capability (target lock,
 * object registration, typed audit, code-owned guards) without the business rules of later tasks.
 */
const submit: ProductCommand<SubmitInput, { readonly id: string }> = {
  resource: 'employee',
  action: 'submitRequest',
  mode: 'write',
  target: (input) => input.employeeId,
  run: async (ctx, input) => {
    const id = randomUUID();
    const objectId = await registerHrObject(ctx.tx, 'workRequest', id);
    await ctx.tx.manager.query(
      `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state) VALUES($1,$2,$3,$4,$5,'wfh','pending_lead')`,
      [id, objectId, ctx.target.key, ctx.actor.id, input.teamId],
    );
    await ctx.audit('hr.request.submit', { resource: 'workRequest', key: id, objectId });
    return { id };
  },
};

function transition(
  action: 'decideLead' | 'decideFinal' | 'cancel',
  from: string,
  to: string,
  stage: 'lead' | 'final' | 'cancel',
  decision: 'approve' | 'reject' | 'cancel',
  kind: 'hr.request.decide-lead' | 'hr.request.decide-final' | 'hr.request.cancel',
): ProductCommand<DecideInput, Decided> {
  return {
    resource: 'workRequest',
    action,
    mode: 'write',
    target: (input) => input.requestId,
    run: async (ctx, input) => {
      const [request] = await ctx.tx.manager.query<
        { owner: string; account: string | null; approver: boolean }[]
      >(
        `SELECT r.owner_account_id::text AS owner,e.account_id::text AS account,
           EXISTS(SELECT 1 FROM hr_request_lead l WHERE l.request_id=r.id AND l.lead_account_id=$2) AS approver
          FROM work_request r JOIN employee e ON e.id=r.employee_id WHERE r.id=$1`,
        [ctx.target.key, ctx.actor.id],
      );
      if (!request) throw new Error('Locked target vanished');
      const own = request.owner === ctx.actor.id || request.account === ctx.actor.id;
      // Guards of design §6.2 run for every principal, Root included.
      if (stage === 'cancel' ? !own : own) throw new ProductCommandRejected('self_decision');
      if (stage === 'lead' && !request.approver)
        throw new ProductCommandRejected('not_current_approver');
      const [updated] = await ctx.tx.manager.query<{ version: string }[]>(
        // TypeORM returns [rows, count] for a bare UPDATE; a CTE yields plain rows.
        `WITH updated AS(UPDATE work_request SET state=$2,version=version+1 WHERE id=$1 AND state=$3 AND version=CAST($4 AS int8) RETURNING version::text AS version) SELECT * FROM updated`,
        [ctx.target.key, to, from, input.expectedVersion],
      );
      if (!updated) throw new ProductCommandRejected('invalid_transition');
      await ctx.tx.manager.query(
        `INSERT INTO request_decision(id,request_id,stage,decision,actor_kind,actor_account_id) VALUES($1,$2,$3,$4,'user',$5)`,
        [randomUUID(), ctx.target.key, stage, decision, ctx.actor.id],
      );
      await ctx.audit(kind, {
        resource: 'workRequest',
        key: ctx.target.key,
        objectId: ctx.target.objectId,
      });
      return { state: to, version: updated.version };
    },
  };
}

const decideLead = transition(
  'decideLead',
  'pending_lead',
  'pending_final',
  'lead',
  'approve',
  'hr.request.decide-lead',
);
const rejectFinal = transition(
  'decideFinal',
  'pending_final',
  'rejected',
  'final',
  'reject',
  'hr.request.decide-final',
);
const cancel = transition(
  'cancel',
  'pending_lead',
  'cancelled',
  'cancel',
  'cancel',
  'hr.request.cancel',
);
const forgetsAudit: ProductCommand<SubmitInput, string> = {
  ...submit,
  run: async (ctx, input) => {
    const id = randomUUID();
    const objectId = await registerHrObject(ctx.tx, 'workRequest', id);
    await ctx.tx.manager.query(
      `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state) VALUES($1,$2,$3,$4,$5,'wfh','pending_lead')`,
      [id, objectId, ctx.target.key, ctx.actor.id, input.teamId],
    );
    return id;
  },
};
const commands = [submit, decideLead, rejectFinal, cancel, forgetsAudit];

async function addPerson(name: string, roles: readonly string[]): Promise<void> {
  const id = randomUUID() as UserId;
  await migration.query(`INSERT INTO app_user(id,state,email_verified) VALUES($1,'active',true)`, [
    id,
  ]);
  await bindAccount(pools.identity, id);
  const secret = await oidcSession(pools.identity, id);
  await runner.run('admin', async (tx) => {
    for (const role of roles)
      await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
        id,
        utf8(role),
      ]);
  });
  const employee = randomUUID();
  objects.set(
    employee,
    await runner.run('write', (tx) => registerHrObject(tx, 'employee', employee)),
  );
  await migration.query(
    "INSERT INTO employee(id,object_id,code,full_name,account_id,hired_on) VALUES($1,$2,$3,$4,$5,DATE '2026-01-05')",
    [employee, objects.get(employee), `NV-${name}`, `Fixture ${name}`, id],
  );
  people[name] = { id, secret, employee };
}

const p = (name: string): Person => {
  const person = people[name];
  if (!person) throw new Error(`Unknown fixture person ${name}`);
  return person;
};

const t = (name: string): string => {
  const team = teams[name];
  if (!team) throw new Error(`Unknown fixture team ${name}`);
  return team;
};

/** A Root session with a step-up 5 s ago, as a 2FA verify leaves it. */
async function freshRoot(): Promise<string> {
  return oidcSession(pools.identity, rootId, { fresh: true });
}

const names = (keys: readonly string[], universe: Record<string, string>) =>
  Object.entries(universe)
    .filter(([, key]) => keys.includes(key))
    .map(([name]) => name)
    .sort();

const employeeKeys = () =>
  Object.fromEntries(Object.entries(people).map(([name, person]) => [name, person.employee]));

async function visible(person: string, resource: string): Promise<string[]> {
  const page = await authorization.list(p(person).secret, resource, 'read', { limit: 100 });
  assert.equal(await authorization.count(p(person).secret, resource, 'read'), page.total);
  return page.items.map((item) => item.key);
}

async function submitAs(person: string, team: string, as = person): Promise<string> {
  const result = await authorization.execute(p(as).secret, submit, {
    employeeId: p(person).employee,
    teamId: t(team),
  });
  assert.ok(result, `${as} submits for ${person}`);
  return result.id;
}

const stateOf = async (id: string) =>
  (
    await migration.query<{ state: string; version: string }[]>(
      'SELECT state,version::text AS version FROM work_request WHERE id=$1',
      [id],
    )
  )[0];

const revision = async () =>
  (
    await migration.query<{ revision: string }[]>(
      'SELECT revision::text AS revision FROM authz_state WHERE singleton',
    )
  )[0]?.revision;

let passwords: Record<ProductDatabasePurpose, string>;

before(async () => {
  postgres = await startPostgres();
  passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'bootstrap', 'migration', 'outbox'].map((name) => [
      name,
      randomBytes(20).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  // The HR migration needs the NOLOGIN object owner, so it runs through provisioning (tools).
  const connections = await provisionProductDatabase(postgres.superuser, passwords, [
    ...productMigrations,
    HrmAuthorization1792108800100,
    HrmEmployee1792108800101,
    HrmTeam1792108800102,
  ]);
  pools = {} as typeof pools;
  for (const purpose of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const)
    pools[purpose] = await new DataSource(
      productDataSourceOptions(connections[purpose]),
    ).initialize();
  migration = await new DataSource(productDataSourceOptions(connections.migration)).initialize();
  await fixtureProvider(migration);
  runner = new ProductTransactionRunner(pools);
  await new ProductManifestReconciler(runner, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: release.declarations.capabilities,
  }).reconcile(release);
  bindings = new ProductBindingRegistry(core, release.declarations, productBindings);
  authorization = new ProductAuthorization(
    runner,
    bindings,
    { validators, obligations: productObligations },
    [],
    commands,
  );
  for (const [name, roles] of [
    ['E1', ['hr.employee']],
    ['E2', ['hr.employee']],
    ['L1', ['hr.employee']],
    ['L2', ['hr.employee']],
    ['C', ['hr.employee', 'hr.coo']],
    ['X', ['hr.employee']],
    ['E4', ['hr.employee']],
    ['E5', ['hr.employee']],
    ['H', ['hr.employee', 'hr.admin']],
  ] as const)
    await addPerson(name, roles);
  for (const name of ['T1', 'T2', 'T3', 'T4']) {
    const id = randomUUID();
    objects.set(id, await runner.run('write', (tx) => registerHrObject(tx, 'team', id)));
    await migration.query('INSERT INTO team(id,object_id,name) VALUES($1,$2,$3)', [
      id,
      objects.get(id),
      `Team ${name}`,
    ]);
    teams[name] = id;
  }
  // Facts go through the authority login under the exclusive fence (ADR 0016 §5).
  await runner.run('admin', async (tx) => {
    for (const [person, team, primary] of [
      ['E1', 'T1', true],
      ['E1', 'T2', false],
      ['E2', 'T1', true],
      ['L1', 'T1', true],
      ['L1', 'T3', false],
      ['L2', 'T2', true],
      ['C', 'T2', true],
      ['X', 'T2', true],
      ['E4', 'T3', true],
      ['E5', 'T4', true],
    ] as const)
      await tx.manager.query(
        `INSERT INTO team_membership(id,employee_id,team_id,is_primary,starts_at) VALUES($1,$2,$3,$4,statement_timestamp()-interval '1 minute')`,
        [randomUUID(), p(person).employee, t(team), primary],
      );
    for (const [team, lead] of [
      ['T1', 'L1'],
      ['T2', 'L2'],
      ['T3', 'L1'],
    ] as const)
      await tx.manager.query(
        `INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES($1,$2,$3,statement_timestamp()-interval '1 minute')`,
        [randomUUID(), t(team), p(lead).employee],
      );
  });
  rootId = randomUUID() as UserId;
  await migration.query(`INSERT INTO app_user(id,email_canonical,state) VALUES($1,$2,'pending')`, [
    rootId,
    rootEmail,
  ]);
  await bindAccount(pools.identity, rootId, 'root-subject');
  const { activationSecret } = await bootstrapProductRoot(runner, release, {
    operationId: randomUUID(),
    userId: rootId,
    method: 'oidc',
    issuer: FIXTURE_ISSUER,
    subject: 'root-subject',
  });
  assert.ok(activationSecret);
  await activateAccount(pools.identity, rootId);
});

after(async () => {
  await migration?.destroy();
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await postgres?.stop();
});

test('HR migration grants exactly what the probes expect and refuses direct registry writes', async () => {
  await verifyProductPrivileges(
    { data: pools.data, identity: pools.identity, authority: pools.authority, sync: pools.sync },
    {
      data: [...hrPrivileges.data],
      authority: [...hrPrivileges.authority],
      sync: [...hrPrivileges.sync],
    },
  );
  await verifyHrProtection(pools.data);
  const key = randomUUID();
  assert.equal(
    await sqlState(
      pools.data.query(
        "INSERT INTO object_ref(object_id,type_key,key_kind,key_bytes) VALUES($1,$2,'uuid',$3)",
        [randomUUID(), utf8('workRequest'), utf8(key)],
      ),
    ),
    '42501',
  );
  for (const type of ['document', 'account', null])
    assert.equal(
      await sqlState(pools.data.query('SELECT public.hr_register_object($1,$2)', [type, key])),
      '22023',
      String(type),
    );
  assert.equal(
    await sqlState(pools.data.query('SELECT public.hr_register_object($1,NULL)', ['team'])),
    '22023',
  );
  assert.equal(
    await sqlState(pools.identity.query('SELECT public.hr_register_object($1,$2)', ['team', key])),
    '42501',
  );
  for (const statement of [
    "UPDATE request_decision SET decision='approve'",
    'DELETE FROM request_decision',
    'DELETE FROM work_request',
    'UPDATE work_request SET employee_id=employee_id',
    'UPDATE employee SET account_id=NULL',
    'INSERT INTO team_membership(id,employee_id,team_id,is_primary,starts_at) VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),false,now())',
  ])
    assert.equal(await sqlState(pools.data.query(statement)), '42501', statement);
  for (const statement of ['DELETE FROM team_membership', 'UPDATE team SET name=name'])
    assert.equal(await sqlState(pools.authority.query(statement)), '42501', statement);
});

test('HR protection probe fails closed on owner, view and owner-ACL drift', async () => {
  await withClient(postgres.superuser, async (client) => {
    for (const [alter, restore] of [
      [
        'ALTER FUNCTION public.hr_register_object(text,uuid) OWNER TO product_fence_owner',
        'ALTER FUNCTION public.hr_register_object(text,uuid) OWNER TO product_object_owner',
      ],
      [
        'ALTER VIEW hr_request_lead SET (security_invoker=false)',
        'ALTER VIEW hr_request_lead SET (security_invoker=true)',
      ],
      [
        'CREATE OR REPLACE VIEW hr_request_decider WITH (security_invoker=true) AS SELECT d.request_id, d.actor_account_id FROM request_decision d',
        "CREATE OR REPLACE VIEW hr_request_decider WITH (security_invoker=true) AS SELECT d.request_id, d.actor_account_id FROM public.request_decision d WHERE d.actor_kind = 'user'",
      ],
      [
        'GRANT SELECT ON employee TO product_object_owner',
        'REVOKE SELECT ON employee FROM product_object_owner',
      ],
    ] as const) {
      await client.query(alter);
      await assert.rejects(verifyHrProtection(pools.data), /HR protection drift/, alter);
      await client.query(restore);
    }
  });
  await verifyHrProtection(pools.data);
});

test('list, detail and count share one scope per role (design §5.2)', async () => {
  const employees = employeeKeys();
  const expected: Record<string, string[]> = {
    E1: ['E1'],
    L1: ['E1', 'E2', 'E4', 'L1'],
    L2: ['C', 'E1', 'L2', 'X'],
    C: Object.keys(people).sort(),
    H: Object.keys(people).sort(),
    X: ['X'],
    E5: ['E5'],
  };
  for (const [person, expectedNames] of Object.entries(expected)) {
    assert.deepEqual(names(await visible(person, 'employee'), employees), expectedNames, person);
    for (const [name, key] of Object.entries(employees)) {
      const row = await authorization.detail(p(person).secret, 'employee', 'read', key);
      assert.equal(row !== null, expectedNames.includes(name), `${person} → ${name}`);
      if (row) assert.deepEqual(Object.keys(row).sort(), ['code', 'fullName', 'key']);
    }
  }
  const teamExpected: Record<string, string[]> = {
    E1: ['T1', 'T2'],
    L1: ['T1', 'T3'],
    X: ['T2'],
    E5: ['T4'],
    C: ['T1', 'T2', 'T3', 'T4'],
    H: ['T1', 'T2', 'T3', 'T4'],
  };
  for (const [person, expectedNames] of Object.entries(teamExpected))
    assert.deepEqual(names(await visible(person, 'team'), teams), expectedNames, person);
});

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

test('SQL scopes match the evaluator on every HR row (parity)', async () => {
  const gateway = new ProductDataGateway(bindings);
  let partial = 0;
  const relations: Record<string, readonly [string, string, string]> = {
    'employee.lead': ['hr_employee_lead', 'employee_id', 'lead_account_id'],
    'workRequest.owner': ['hr_request_owner', 'request_id', 'account_id'],
    'workRequest.lead': ['hr_request_lead', 'request_id', 'lead_account_id'],
    'workRequest.decider': ['hr_request_decider', 'request_id', 'actor_account_id'],
  };
  for (const person of ['E1', 'L1', 'L2', 'C', 'H', 'X']) {
    for (const resource of ['employee', 'workRequest'] as const) {
      await runner.run('read', async (tx) => {
        const snapshot = await readProductAuthority(
          tx,
          p(person).id,
          `${resource}.read`,
          release.declarations,
          { validators, obligationHandlers: Object.keys(productObligations) },
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

test('a release-2 database upgrades to release 3 and then 4 by sync; a repeated sync changes nothing', async () => {
  await withClient(postgres.superuser, (client) => client.query('CREATE DATABASE hr_upgrade'));
  const connections = await provisionProductDatabase(
    { ...postgres.superuser, database: 'hr_upgrade' },
    passwords,
    [
      ...productMigrations,
      HrmAuthorization1792108800100,
      HrmEmployee1792108800101,
      HrmTeam1792108800102,
    ],
  );
  const sync = await new DataSource(productDataSourceOptions(connections.sync)).initialize();
  try {
    const reconciler = new ProductManifestReconciler(new ProductTransactionRunner({ sync }), {
      core,
      actor: randomUUID() as IdentityId,
      capabilities: release.declarations.capabilities,
    });

    // Release 2 rebuilt from today's source without the HR fragment; its pinned hash proves it.
    const hr = (key: string) => hrDeclarations.resources.some((r) => r.key === key);

    const hrPolicies = new Set(hrDeclarations.policies.map((policy) => policy.key));
    // Release 3 without the ADR 0020 account delta (fixtures/release-three.ts), then minus HR.
    const three = releaseThreeSource.declarations;
    const releaseTwo = prepareProductRelease(
      {
        ...productReleaseSource,
        sequence: '2',
        predecessor: '1',
        declarations: {
          ...three,
          resources: three.resources.filter((r) => !hr(r.key)),
          policies: three.policies.filter((policy) => !hrPolicies.has(policy.key)),
          templates: three.templates.filter((template) => !hr(template.resource)),
          relations: [],
        },
        roles: [{ key: 'reviewer', label: 'Reviewer' }],
        defaultGrants: documentDefaultGrants,
      },
      core,
    );
    assert.equal(
      releaseTwo.hash,
      'e11f43e8199bf70fd4a2c8e552477b682222402510fd3d0cc35b98256f15afaa',
    );
    await reconciler.reconcile(releaseTwo);
    const releaseThree = prepareProductRelease(releaseThreeSource, core);
    assert.equal(releaseThree.hash, releaseThreeHash);
    assert.equal((await reconciler.reconcile(releaseThree)).changed, true);
    // Release 3 → 4 (ADR 0020) → 5 (T3) by sync as well.
    const releaseFour = prepareProductRelease(releaseFourSource, core);
    assert.equal(releaseFour.hash, releaseFourHash);
    assert.equal((await reconciler.reconcile(releaseFour)).changed, true);
    const upgraded = await reconciler.reconcile(release);
    assert.equal(upgraded.changed, true);
    assert.equal(upgraded.manifestHash, release.hash);
    const again = await reconciler.reconcile(release);
    assert.deepEqual(again, { ...upgraded, changed: false });
    // An older build cannot downgrade the product it no longer describes.
    await assert.rejects(reconciler.reconcile(releaseTwo), /Release rejected \(downgrade/);
  } finally {
    await sync.destroy();
  }
});
