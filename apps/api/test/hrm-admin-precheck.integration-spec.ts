// `admin` commands of `execute` (role.*, employee.linkAccount, team.assign): a caller whose plan
// does not reach the target is answered from a shared-fence read, so it neither takes the
// exclusive fence nor bumps the revision; the exclusive step still decides again. Service level,
// synthetic people only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
  productBindings,
} from '../dist/authorization/product.manifest.js';
import {
  ProductAccessDenied,
  ProductAuthorization,
} from '../dist/authorization/services/product-authority.service.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import {
  ProductTransactionRunner,
  type ProductTransaction,
  type ProductTransactionMode,
} from '../dist/database/product-transaction.runner.js';
import {
  AuthorityUnavailableError,
  TransactionConflictError,
} from '../dist/database/helpers/transaction-errors.helper.js';
import { type ModulePerson, type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';

let stack: ModuleStack;

const utf8 = (value: string) => Buffer.from(value, 'utf8');

after(() => stack?.stop());

let counter = 0;

async function seedRole(key: string, permissions: readonly string[]) {
  await stack.migration.query(
    "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'runtime','Seed')",
    [utf8(key)],
  );
  for (const permission of permissions)
    await stack.migration.query(
      "INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow','role',1,'{}','runtime')",
      [randomUUID(), utf8(permission), utf8(key)],
    );
}

async function actor(...permissions: string[]): Promise<ModulePerson> {
  const key = `custom.pre${++counter}`;
  await seedRole(key, permissions);
  return stack.person([key]);
}

const createInput = (key: string) => ({ key, label: 'Nhãn', grants: [] });

let team: string;
let employee: string;

before(async () => {
  stack = await startModuleStack();
  const root = await stack.freshRoot();
  team = (await stack.teams.create(root, { name: 'Nhóm kiểm tra' })).id;
  employee = (
    await stack.employees.create(root, {
      code: 'PRE001',
      fullName: 'Nhân viên giả',
      hiredOn: '2026-01-05',
      status: 'probation',
      annualLeaveMinutes: null,
      identity: {
        dateOfBirth: null,
        documentKind: null,
        documentNumber: null,
        taxCode: null,
        gender: null,
        phone: null,
        workEmail: null,
      },
      position: null,
      classification: null,
    })
  ).id;
});

type Command = readonly [name: string, run: (secret: string) => Promise<unknown>];

function commands(): Command[] {
  const key = 'custom.absent';
  return [
    ['role.create', (s) => stack.roles.create(s, createInput(key))],
    [
      'role.update',
      (s) => stack.roles.update(s, { ...createInput(key), expectedDigest: '0'.repeat(64) }),
    ],
    ['role.delete', (s) => stack.roles.remove(s, key)],
    [
      'employee.linkAccount',
      (s) =>
        stack.employees.linkAccount(s, {
          employeeId: employee,
          expectedVersion: '1',
          accountId: null,
        }),
    ],
    [
      'team.addMember',
      (s) => stack.teams.addMember(s, { teamId: team, employeeId: employee, primary: true }),
    ],
    ['team.setPrimary', (s) => stack.teams.setPrimary(s, { teamId: team, employeeId: employee })],
    [
      'team.endMembership',
      (s) => stack.teams.endMembership(s, { teamId: team, employeeId: employee }),
    ],
    ['team.assignLead', (s) => stack.teams.assignLead(s, { teamId: team, employeeId: employee })],
  ];
}

const denied = (error: unknown) => error instanceof ProductAccessDenied;

test('a caller without the grant is denied by every admin command and the revision does not move', async () => {
  const nobody = await stack.person([]);
  const readers = await actor('role.read', 'team.read', 'employee.read');
  for (const person of [nobody, readers])
    for (const [name, run] of commands()) {
      const revision = await stack.revision();
      await assert.rejects(run(person.fresh), denied, name);
      assert.equal(await stack.revision(), revision, name);
    }
});

test('a denied caller does not wait for the exclusive fence: a shared holder does not block it', async () => {
  const nobody = await stack.person([]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const holder = stack.runner.run('read', async () => {
    entered();
    await held;
  });
  const impatient = new ProductTransactionRunner(stack.pools, {
    lockTimeoutMs: 100,
    maxRetries: 0,
  });
  try {
    await inside;
    // Control: an exclusive taker cannot get the fence while the shared holder is open.
    await assert.rejects(
      impatient.run('admin', () => Promise.resolve()),
      (error) =>
        error instanceof TransactionConflictError || error instanceof AuthorityUnavailableError,
    );
    for (const [name, run] of commands()) await assert.rejects(run(nobody.fresh), denied, name);
  } finally {
    release();
    await holder;
  }
});

test('the exclusive step decides again: a grant revoked after the shared check is denied and nothing moves', async () => {
  class HookedRunner extends ProductTransactionRunner {
    before: (() => Promise<void>) | undefined;

    override async run<T>(
      mode: ProductTransactionMode,
      work: (tx: ProductTransaction) => Promise<T>,
      options: { readonly serialize?: number } = {},
    ): Promise<T> {
      if (mode === 'admin') await this.before?.();
      return super.run(mode, work, options);
    }
  }
  const runner = new HookedRunner(stack.pools);
  const audit = new ProductAuditRepository();
  const core = createProductAuthorizationCore();
  const release = createProductRelease(core);
  const authorization = new ProductAuthorization(
    runner,
    audit,
    new ProductBindingRegistry(core, release.declarations, productBindings),
    {
      validators: { 'fresh@1': (_params, i) => i.context.freshAuthentication === true },
      obligations: createProductObligations(audit),
    },
    [],
    stack.modules.commands,
    stack.modules.queries,
  );
  const { roles } = stack.modules.bindServices(authorization);

  const holder = await actor('role.create');
  let reached = 0;
  runner.before = () => {
    reached++;
    return Promise.resolve();
  };
  const revision = BigInt(await stack.revision());
  await roles.create(holder.fresh, createInput('custom.raceok'));
  assert.equal(reached, 1);
  assert.equal(BigInt(await stack.revision()), revision + 1n);

  runner.before = async () => {
    reached++;
    await stack.migration.query('DELETE FROM user_role WHERE user_id=$1', [holder.id]);
  };
  await assert.rejects(roles.create(holder.fresh, createInput('custom.racedenied')), denied);
  assert.equal(reached, 2);
  const rows = await stack.migration.query<{ n: string }[]>(
    'SELECT count(*)::text AS n FROM role_definition WHERE role_key=$1',
    [utf8('custom.racedenied')],
  );
  assert.equal(rows[0]?.n, '0');
});

test('a caller with the grant still commits and advances the revision once', async () => {
  const holder = await actor('role.create');
  const revision = BigInt(await stack.revision());
  await stack.roles.create(holder.fresh, createInput('custom.permitted'));
  assert.equal(BigInt(await stack.revision()), revision + 1n);
});
