// HR authorization: migration grants, protection probes and shared scope.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyProductPrivileges } from '../dist/database/helpers/product-database.helper.js';
import {
  hrPrivileges,
  verifyHrProtection,
  verifyWorkCalendarSchema,
} from '../dist/hr/hr-database.helper.js';
import { sqlState, withClient } from './setup-postgres.ts';
import {
  utf8,
  postgres,
  pools,
  authorization,
  people,
  teams,
  p,
  names,
  employeeKeys,
  visible,
  setupStack,
  teardownStack,
} from './hrm-authorization-stack.helper.ts';

before(setupStack);
after(teardownStack);

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

test('work calendar schema probe fails closed when the makeup CHECK is missing', async () => {
  await verifyWorkCalendarSchema(pools.data);
  await withClient(postgres.superuser, async (client) => {
    const { rows } = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid='work_calendar_change'::regclass AND conname='ck_work_calendar_change_kind'`,
    );
    const def = rows[0]?.def ?? assert.fail('constraint absent before the test');
    await client.query(
      'ALTER TABLE work_calendar_change DROP CONSTRAINT ck_work_calendar_change_kind',
    );
    try {
      await assert.rejects(verifyWorkCalendarSchema(pools.data), /Work calendar schema drift/);
    } finally {
      await client.query(
        `ALTER TABLE work_calendar_change ADD CONSTRAINT ck_work_calendar_change_kind ${def}`,
      );
    }
  });
  await verifyWorkCalendarSchema(pools.data);
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
