// Menu `roles` (Q17): the probe for role.read joins the ONE permitsMany of
// EmployeeService.menus. A linked account now asks 17 pairs, exactly MAX_PERMIT_PROBES (raised from
// 16 after a measurement), so there is still a single lookup. Granted by permission only: the
// administrative role by release grant, Root, a runtime grant; never the COO, an employee or an
// account without a role.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { MAX_PERMIT_PROBES } from '../dist/authorization/helpers/permit-probe.helper.js';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';
import { attendanceFixture } from './hrm-attendance.helper.ts';

let stack: ModuleStack;

before(async () => {
  stack = await startModuleStack();
});
after(async () => {
  await stack?.stop();
});

const utf8 = (value: string) => Buffer.from(value, 'utf8');

// A rule attached to a user is seeded by the owner login: the authority login only writes role rules.
const setGrant = async (userId: string, granted: boolean) => {
  if (granted)
    await stack.migration.query(
      "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
      [randomUUID(), utf8('role.read'), userId, utf8('role')],
    );
  else
    await stack.migration.query('DELETE FROM policy_rule WHERE user_id=$1 AND permission_key=$2', [
      userId,
      utf8('role.read'),
    ]);
};

test('roles is granted by role.read: Root, the administrative role and a runtime holder; nobody else', async () => {
  const roleless = await stack.person([]);
  const employee = await stack.person(['hr.employee']);
  const admin = await stack.person(['hr.employee', 'hr.admin']);
  const coo = await stack.person(['hr.employee', 'hr.coo']);
  assert.ok((await stack.employees.menus(await stack.root())).includes('roles'));
  assert.ok((await stack.employees.menus(admin.secret)).includes('roles'));
  assert.ok(!(await stack.employees.menus(coo.secret)).includes('roles'));
  assert.ok(!(await stack.employees.menus(employee.secret)).includes('roles'));
  assert.deepEqual(await stack.employees.menus(roleless.secret), []);
  await setGrant(roleless.id, true);
  assert.deepEqual(await stack.employees.menus(roleless.secret), ['roles']);
  // Revocation is seen by the same session on the next call (no cached menus).
  await setGrant(roleless.id, false);
  assert.deepEqual(await stack.employees.menus(roleless.secret), []);
});

test('a linked account with every menu asks exactly the limit in ONE lookup and sees roles', async () => {
  const f = attendanceFixture(stack);
  await f.setup();
  const person = f.p('H');
  let transactions = 0;
  const run = stack.runner.run.bind(stack.runner);
  stack.runner.run = ((...args: Parameters<typeof run>) => {
    transactions++;
    return run(...args);
  }) as typeof stack.runner.run;
  let menus: readonly string[];
  try {
    menus = await stack.employees.menus(person.secret);
  } finally {
    stack.runner.run = run;
  }
  for (const key of [
    'requests',
    'employees',
    'teams',
    'calendar',
    'leave',
    'attendance',
    'reports',
    'settings',
    'roles',
  ])
    assert.ok(menus.includes(key), key);
  assert.equal(MAX_PERMIT_PROBES, 17);
  // One own-profile read plus the single permitsMany transaction; no second lookup for `roles`.
  assert.equal(transactions, 2);
});
