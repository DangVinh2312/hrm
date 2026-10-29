// Menu `settings`: the probe for setting.read joins the ONE permitsMany
// of EmployeeService.menus (a linked account asks 17 pairs since the role matrix, exactly
// MAX_PERMIT_PROBES, so there is still no second lookup). Granted by permission only: admin and COO by release grant, Root, a
// runtime grant; never an employee or an account without a role.
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

const setGrant = (userId: string, granted: boolean) =>
  stack.runner.run('admin', async (tx) => {
    if (granted)
      await tx.manager.query(
        "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
        [randomUUID(), utf8('setting.read'), userId, utf8('setting')],
      );
    else
      await tx.manager.query('DELETE FROM policy_rule WHERE user_id=$1 AND permission_key=$2', [
        userId,
        utf8('setting.read'),
      ]);
  });

test('settings is granted by setting.read: Root, admin, COO and a runtime holder; nobody else', async () => {
  const roleless = await stack.person([]);
  const employee = await stack.person(['hr.employee']);
  const admin = await stack.person(['hr.employee', 'hr.admin']);
  const coo = await stack.person(['hr.employee', 'hr.coo']);
  assert.ok((await stack.employees.menus(await stack.root())).includes('settings'));
  assert.ok((await stack.employees.menus(admin.secret)).includes('settings'));
  assert.ok((await stack.employees.menus(coo.secret)).includes('settings'));
  assert.ok(!(await stack.employees.menus(employee.secret)).includes('settings'));
  assert.deepEqual(await stack.employees.menus(roleless.secret), []);
  await setGrant(roleless.id, true);
  assert.deepEqual(await stack.employees.menus(roleless.secret), ['settings']);
  // Revocation is seen by the same session on the next call (no cached menus).
  await setGrant(roleless.id, false);
  assert.deepEqual(await stack.employees.menus(roleless.secret), []);
});

test('a linked account with every menu stays within the probe limit of the one lookup', async () => {
  const f = attendanceFixture(stack);
  await f.setup();
  const menus = await stack.employees.menus(f.p('H').secret);
  // A linked admin holds the three self-service menus and every HR one besides `accounts`.
  for (const key of [
    'requests',
    'employees',
    'teams',
    'calendar',
    'leave',
    'attendance',
    'reports',
    'settings',
  ])
    assert.ok(menus.includes(key as never), key);
  // 17 pairs for a linked account fit exactly (raised from 16 for `roles` after a measurement).
  assert.equal(MAX_PERMIT_PROBES, 17);
});
