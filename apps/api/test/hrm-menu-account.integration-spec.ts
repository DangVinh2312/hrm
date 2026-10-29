// Menu `accounts` (Q17): the probe for account.read joins the ONE permitsMany of
// EmployeeService.menus, so Root and holders of the permission see it and nobody else does.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';

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
        [randomUUID(), utf8('account.read'), userId, utf8('allAccounts')],
      );
    else
      await tx.manager.query('DELETE FROM policy_rule WHERE user_id=$1 AND permission_key=$2', [
        userId,
        utf8('account.read'),
      ]);
  });

test('accounts is granted to Root and to a holder of account.read, to nobody else, with no default role', async () => {
  const none = await stack.person(['hr.employee', 'hr.coo', 'hr.admin']);
  const roleless = await stack.person([]);
  const holder = await stack.person(['hr.employee']);
  assert.ok((await stack.employees.menus(await stack.root())).includes('accounts'));
  // No HR role (the three release roles included) carries account.read.
  assert.ok(!(await stack.employees.menus(none.secret)).includes('accounts'));
  assert.deepEqual(await stack.employees.menus(roleless.secret), []);
  assert.ok(!(await stack.employees.menus(holder.secret)).includes('accounts'));
  await setGrant(holder.id, true);
  assert.ok((await stack.employees.menus(holder.secret)).includes('accounts'));
  // Revocation is seen by the same session on the next call (no cached menus).
  await setGrant(holder.id, false);
  assert.ok(!(await stack.employees.menus(holder.secret)).includes('accounts'));
});
