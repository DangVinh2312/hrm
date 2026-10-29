import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { UserId } from '../dist/authorization/core/authorization.types.js';
import {
  ProductAccessDenied,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import { addMember, assignLead } from '../dist/modules/team/team.service.js';
import { type ModulePerson, type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';

// Synthetic people only. H = HR/Admin (grant, no boundary binding), A/B/M employees, L/L2 leads.
let stack: ModuleStack;
const people: Record<string, ModulePerson & { employee: string }> = {};
let sequence = 0;

const p = (name: string) => {
  const person = people[name];
  if (!person) throw new Error(`Unknown fixture person ${name}`);
  return person;
};

const versionOf = async (employeeId: string) =>
  (
    await stack.migration.query<{ version: string }[]>(
      'SELECT version::text AS version FROM employee WHERE id=$1',
      [employeeId],
    )
  )[0]!.version;

async function hire(name: string, roles: readonly string[]): Promise<void> {
  const person = await stack.person(roles);
  const { id } = await stack.employees.create(await stack.freshRoot(), {
    code: `T${String(++sequence).padStart(3, '0')}`,
    fullName: `Thành viên giả ${sequence}`,
    hiredOn: '2026-01-05',
    status: 'official',
    annualLeaveMinutes: 5760,
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
  });
  assert.ok(
    await stack.employees.linkAccount(await stack.freshRoot(), {
      employeeId: id,
      expectedVersion: await versionOf(id),
      accountId: person.id,
    }),
  );
  people[name] = { ...person, employee: id };
}

const newTeam = async (name: string) =>
  (await stack.teams.create(await stack.freshRoot(), { name })).id;

/** Current membership rows of an employee as [team, primary], ordered. */
const current = async (name: string) =>
  (
    await stack.migration.query<{ team: string; primary: boolean }[]>(
      `SELECT team_id::text AS team, is_primary AS "primary" FROM team_membership
        WHERE employee_id=$1 AND ends_at IS NULL ORDER BY is_primary DESC, team_id`,
      [p(name).employee],
    )
  ).map((row) => [row.team, row.primary]);

const visibleEmployees = async (name: string) =>
  (await stack.employees.list(p(name).secret, { limit: 100, offset: 0 })).items
    .map((item) => item.id)
    .sort();

before(async () => {
  stack = await startModuleStack();
  for (const [name, roles] of [
    ['H', ['hr.employee', 'hr.admin']],
    ['A', ['hr.employee']],
    ['B', ['hr.employee']],
    ['M', ['hr.employee']],
    ['L', ['hr.employee']],
    ['L2', ['hr.employee']],
  ] as const)
    await hire(name, roles);
});

after(async () => {
  await stack?.stop();
});

test('teams: HR creates and renames; names unique ignoring case; employees cannot', async () => {
  const id = (await stack.teams.create(p('H').secret, { name: 'Kế toán' })).id;
  await assert.rejects(
    stack.teams.create(p('H').secret, { name: 'KẾ TOÁN' }),
    ProductCommandRejected,
  );
  await assert.rejects(stack.teams.create(p('A').fresh, { name: 'Khác' }), ProductAccessDenied);
  const view = await stack.teams.detail(p('H').secret, id);
  assert.equal(view?.name, 'Kế toán');
  assert.deepEqual(view?.members, []);
  assert.equal(view?.lead, null);
  const renamed = await stack.teams.rename(p('H').secret, {
    teamId: id,
    expectedVersion: view.version,
    name: 'Kế toán tổng hợp',
  });
  assert.equal(renamed?.version, String(BigInt(view.version) + 1n));
  await assert.rejects(
    stack.teams.rename(p('H').secret, { teamId: id, expectedVersion: view.version, name: 'X' }),
    ProductCommandRejected,
  );
  // Outside the update grant the team is simply not found.
  assert.equal(
    await stack.teams.rename(p('A').fresh, {
      teamId: id,
      expectedVersion: renamed.version,
      name: 'Y',
    }),
    undefined,
  );
});

test('team.assign needs Root here: HR has the grant but no boundary binding (required)', async () => {
  const team = await newTeam('Boundary');
  const revision = await stack.revision();
  for (const secret of [p('H').fresh, p('H').secret])
    await assert.rejects(
      stack.teams.addMember(secret, { teamId: team, employeeId: p('A').employee, primary: true }),
      ProductAccessDenied,
    );
  await assert.rejects(
    stack.teams.assignLead(p('H').fresh, { teamId: team, employeeId: p('L').employee }),
    ProductAccessDenied,
  );
  assert.equal(await stack.revision(), revision);
  assert.deepEqual((await stack.teams.detail(p('H').secret, team))?.members, []);
});

test('membership keeps exactly one primary team and its history', async () => {
  const [t1, t2, t3] = [await newTeam('M1'), await newTeam('M2'), await newTeam('M3')];
  const root = await stack.freshRoot();
  // The first team is primary even when asked otherwise.
  assert.ok(
    await stack.teams.addMember(root, { teamId: t1, employeeId: p('M').employee, primary: false }),
  );
  assert.ok(
    await stack.teams.addMember(root, { teamId: t2, employeeId: p('M').employee, primary: false }),
  );
  assert.deepEqual(
    await current('M'),
    [
      [t1, true],
      [t2, false],
    ].sort((a, b) => Number(b[1]) - Number(a[1])),
  );
  await assert.rejects(
    stack.teams.addMember(root, { teamId: t2, employeeId: p('M').employee, primary: true }),
    ProductCommandRejected,
  );
  // A new primary team moves the flag; the old primary stays as a secondary membership.
  assert.ok(
    await stack.teams.addMember(root, { teamId: t3, employeeId: p('M').employee, primary: true }),
  );
  assert.deepEqual(
    (await current('M')).filter(([, primary]) => primary),
    [[t3, true]],
  );
  assert.ok(await stack.teams.setPrimary(root, { teamId: t2, employeeId: p('M').employee }));
  assert.deepEqual(
    (await current('M')).filter(([, primary]) => primary),
    [[t2, true]],
  );
  await assert.rejects(
    stack.teams.setPrimary(root, { teamId: t2, employeeId: p('M').employee }),
    ProductCommandRejected,
  );
  // The primary team ends only when it is the last one.
  await assert.rejects(
    stack.teams.endMembership(root, { teamId: t2, employeeId: p('M').employee }),
    ProductCommandRejected,
  );
  assert.ok(await stack.teams.endMembership(root, { teamId: t1, employeeId: p('M').employee }));
  assert.ok(await stack.teams.endMembership(root, { teamId: t3, employeeId: p('M').employee }));
  assert.ok(await stack.teams.endMembership(root, { teamId: t2, employeeId: p('M').employee }));
  assert.deepEqual(await current('M'), []);
  await assert.rejects(
    stack.teams.endMembership(root, { teamId: t2, employeeId: p('M').employee }),
    ProductCommandRejected,
  );
  // History: every row ended, never deleted; one primary at any instant.
  const [rows] = await stack.migration.query<{ total: string; open: string }[]>(
    `SELECT count(*)::text AS total, count(*) FILTER (WHERE ends_at IS NULL)::text AS open
       FROM team_membership WHERE employee_id=$1`,
    [p('M').employee],
  );
  assert.deepEqual(rows, { total: '6', open: '0' });
  // Absent team: 404; absent or terminated employee: refused.
  assert.equal(
    await stack.teams.addMember(root, {
      teamId: randomUUID(),
      employeeId: p('M').employee,
      primary: true,
    }),
    undefined,
  );
  await assert.rejects(
    stack.teams.addMember(root, { teamId: t1, employeeId: randomUUID(), primary: true }),
    ProductCommandRejected,
  );
});

test('lead and membership changes move scope in the next transaction (revoke, D02)', async () => {
  const team = await newTeam('Scope');
  const root = await stack.freshRoot();
  for (const name of ['A', 'B'])
    assert.ok(
      await stack.teams.addMember(root, {
        teamId: team,
        employeeId: p(name).employee,
        primary: true,
      }),
    );
  // The lead must be an open member; L is a member and sees the same set as before.
  assert.ok(
    await stack.teams.addMember(root, { teamId: team, employeeId: p('L').employee, primary: true }),
  );
  const revision = await stack.revision();
  assert.ok(await stack.teams.assignLead(root, { teamId: team, employeeId: p('L').employee }));
  assert.equal(await stack.revision(), String(BigInt(revision) + 1n));
  assert.deepEqual(
    await visibleEmployees('L'),
    [p('A').employee, p('B').employee, p('L').employee].sort(),
  );
  assert.deepEqual(
    (await stack.teams.detail(p('L').secret, team))?.lead?.employeeId,
    p('L').employee,
  );
  // B leaves the team: the lead loses B at once.
  assert.ok(await stack.teams.endMembership(root, { teamId: team, employeeId: p('B').employee }));
  assert.deepEqual(await visibleEmployees('L'), [p('A').employee, p('L').employee].sort());
  // The lead changes: L sees only self, L2 takes over; history keeps both. L2 joins first and the
  // former lead leaves the team once replaced (a lead cannot leave while leading), so the
  // visible sets below stay what a team of A and the lead would show.
  assert.ok(
    await stack.teams.addMember(root, {
      teamId: team,
      employeeId: p('L2').employee,
      primary: true,
    }),
  );
  assert.ok(await stack.teams.assignLead(root, { teamId: team, employeeId: p('L2').employee }));
  assert.ok(await stack.teams.endMembership(root, { teamId: team, employeeId: p('L').employee }));
  assert.deepEqual(await visibleEmployees('L'), [p('L').employee]);
  assert.equal(await stack.teams.detail(p('L').secret, team), undefined);
  assert.deepEqual(await visibleEmployees('L2'), [p('A').employee, p('L2').employee].sort());
  const history = (await stack.teams.detail(p('H').secret, team))?.leadHistory ?? [];
  assert.deepEqual(
    history.map((row) => [row.employeeId, row.endsAt === null]),
    [
      [p('L2').employee, true],
      [p('L').employee, false],
    ],
  );
  await assert.rejects(
    stack.teams.assignLead(root, { teamId: team, employeeId: p('L2').employee }),
    ProductCommandRejected,
  );
  assert.ok(await stack.teams.assignLead(root, { teamId: team, employeeId: null }));
  assert.deepEqual(await visibleEmployees('L2'), [p('L2').employee]);
});

test('two concurrent assignments serialize: one membership, one current lead', async () => {
  const team = await newTeam('Concurrent');
  const [first, second] = [await stack.freshRoot(), await stack.freshRoot()];
  const added = await Promise.allSettled([
    stack.teams.addMember(first, { teamId: team, employeeId: p('B').employee, primary: false }),
    stack.teams.addMember(second, { teamId: team, employeeId: p('B').employee, primary: false }),
  ]);
  assert.deepEqual(added.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  const rejected = added.find((r) => r.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof ProductCommandRejected);
  // Both candidates must be members before they can lead, so three members remain.
  for (const name of ['L', 'L2'])
    assert.ok(
      await stack.teams.addMember(first, {
        teamId: team,
        employeeId: p(name).employee,
        primary: false,
      }),
    );
  const leads = await Promise.allSettled([
    stack.teams.assignLead(first, { teamId: team, employeeId: p('L').employee }),
    stack.teams.assignLead(second, { teamId: team, employeeId: p('L2').employee }),
  ]);
  assert.deepEqual(
    leads.map((r) => r.status),
    ['fulfilled', 'fulfilled'],
  );
  const [counts] = await stack.migration.query<{ members: string; leads: string; ended: string }[]>(
    `SELECT (SELECT count(*) FROM team_membership WHERE team_id=$1 AND ends_at IS NULL)::text AS members,
            (SELECT count(*) FROM team_lead_assignment WHERE team_id=$1 AND ends_at IS NULL)::text AS leads,
            (SELECT count(*) FROM team_lead_assignment WHERE team_id=$1 AND ends_at IS NOT NULL)::text AS ended`,
    [team],
  );
  assert.deepEqual(counts, { members: '3', leads: '1', ended: '1' });
});

test('nobody assigns themself as member or lead (guard runs before any write, Root too)', async () => {
  const team = await newTeam('Self');

  const attempt = <I>(command: typeof addMember | typeof assignLead, actor: UserId, input: I) =>
    stack.runner.run('admin', async (tx) => {
      const [row] = await tx.manager.query<{ object_id: string }[]>(
        'SELECT object_id::text FROM team WHERE id=$1',
        [team],
      );
      return (command.run as (ctx: unknown, input: I) => Promise<unknown>)(
        {
          tx,
          actor: { id: actor, kind: 'iam' },
          permission: 'team.assign',
          target: { key: team, objectId: row!.object_id },
          audit: () => Promise.resolve(),
        },
        input,
      );
    });

  await assert.rejects(
    attempt(addMember, p('H').id, { teamId: team, employeeId: p('H').employee, primary: true }),
    /self_assignment/,
  );
  await assert.rejects(
    attempt(assignLead, p('H').id, { teamId: team, employeeId: p('H').employee }),
    /self_assignment/,
  );
  assert.deepEqual((await stack.teams.detail(p('H').secret, team))?.members, []);
});

const leadRows = (team: string) =>
  stack.migration.query<{ employee: string }[]>(
    'SELECT lead_employee_id::text AS employee FROM team_lead_assignment WHERE team_id=$1 AND ends_at IS NULL',
    [team],
  );

test('a lead must be an open member of that team; a refusal writes nothing', async () => {
  await hire('F', ['hr.employee']);
  const team = await newTeam('Lead needs membership');
  const other = await newTeam('Other team');
  const root = await stack.freshRoot();

  const refuse = async (employee: string) => {
    const revision = await stack.revision();
    await assert.rejects(
      stack.teams.assignLead(root, { teamId: team, employeeId: employee }),
      (error) => error instanceof ProductCommandRejected && error.reason === 'lead_not_member',
    );
    assert.equal(await stack.revision(), revision);
    assert.deepEqual(await leadRows(team), []);
  };

  // Not a member at all, and a member of another team only.
  await refuse(p('A').employee);
  assert.ok(
    await stack.teams.addMember(root, {
      teamId: other,
      employeeId: p('A').employee,
      primary: true,
    }),
  );
  await refuse(p('A').employee);
  // A former member (ended membership) is no member either.
  assert.ok(
    await stack.teams.addMember(root, { teamId: team, employeeId: p('F').employee, primary: true }),
  );
  assert.ok(await stack.teams.endMembership(root, { teamId: team, employeeId: p('F').employee }));
  await refuse(p('F').employee);
  // A member leads and stays a member (spec 6.4(2): a lead's own request skips the lead step).
  assert.ok(
    await stack.teams.addMember(root, {
      teamId: team,
      employeeId: p('M').employee,
      primary: false,
    }),
  );
  assert.ok(await stack.teams.assignLead(root, { teamId: team, employeeId: p('M').employee }));
  assert.deepEqual(await leadRows(team), [{ employee: p('M').employee }]);
  // Replacing with a non-member leaves the current lead untouched.
  await assert.rejects(
    stack.teams.assignLead(root, { teamId: team, employeeId: p('A').employee }),
    ProductCommandRejected,
  );
  assert.deepEqual(await leadRows(team), [{ employee: p('M').employee }]);
  const detail = await stack.teams.detail(p('H').secret, team);
  assert.equal(detail?.lead?.employeeId, p('M').employee);
  assert.ok(detail?.members.some((m) => m.employeeId === p('M').employee));
});

test('the current lead cannot leave the team; hand over or clear the lead first', async () => {
  const team = await newTeam('Lead cannot leave');
  const root = await stack.freshRoot();

  const join = async (name: string) =>
    assert.ok(
      await stack.teams.addMember(root, {
        teamId: team,
        employeeId: p(name).employee,
        primary: false,
      }),
    );

  await join('A');
  await join('B');
  assert.ok(await stack.teams.assignLead(root, { teamId: team, employeeId: p('A').employee }));
  const revision = await stack.revision();
  await assert.rejects(
    stack.teams.endMembership(root, { teamId: team, employeeId: p('A').employee }),
    (error) => error instanceof ProductCommandRejected && error.reason === 'member_is_lead',
  );
  assert.equal(await stack.revision(), revision);
  assert.deepEqual(await leadRows(team), [{ employee: p('A').employee }]);
  assert.equal((await stack.teams.detail(p('H').secret, team))?.members.length, 2);
  // A non-lead member leaves freely while A leads; B rejoins and takes over.
  assert.ok(await stack.teams.endMembership(root, { teamId: team, employeeId: p('B').employee }));
  await join('B');
  assert.ok(await stack.teams.assignLead(root, { teamId: team, employeeId: p('B').employee }));
  assert.ok(await stack.teams.endMembership(root, { teamId: team, employeeId: p('A').employee }));
  // B now leads and cannot leave; clearing the lead (employeeId null) releases B.
  await assert.rejects(
    stack.teams.endMembership(root, { teamId: team, employeeId: p('B').employee }),
    ProductCommandRejected,
  );
  assert.ok(await stack.teams.assignLead(root, { teamId: team, employeeId: null }));
  assert.ok(await stack.teams.endMembership(root, { teamId: team, employeeId: p('B').employee }));
  assert.deepEqual(await leadRows(team), []);
  assert.deepEqual((await stack.teams.detail(p('H').secret, team))?.members, []);
});

test('terminating a lead ends neither its membership nor its lead row (lead stays a member)', async () => {
  await hire('Z', ['hr.employee']);
  const team = await newTeam('Terminated lead');
  const root = await stack.freshRoot();
  assert.ok(
    await stack.teams.addMember(root, {
      teamId: team,
      employeeId: p('Z').employee,
      primary: false,
    }),
  );
  assert.ok(await stack.teams.assignLead(root, { teamId: team, employeeId: p('Z').employee }));
  assert.ok(
    await stack.employees.terminate(await stack.freshRoot(), {
      employeeId: p('Z').employee,
      terminatedOn: await stack.day(-1),
    }),
  );
  assert.deepEqual(await leadRows(team), [{ employee: p('Z').employee }]);
  assert.deepEqual(await current('Z'), [[team, true]]);
  // The lead is still protected from leaving; the operator clears the lead first.
  await assert.rejects(
    stack.teams.endMembership(root, { teamId: team, employeeId: p('Z').employee }),
    ProductCommandRejected,
  );
  assert.ok(await stack.teams.assignLead(root, { teamId: team, employeeId: null }));
  assert.ok(await stack.teams.endMembership(root, { teamId: team, employeeId: p('Z').employee }));
});

test('a legacy lead who is not a member is found by the operator query and fixed by adding the member', async () => {
  const team = await newTeam('Legacy lead');
  // Data from before the rule: written outside the command (the app refuses it now).
  await stack.migration.query(
    `INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES($1,$2,$3,statement_timestamp())`,
    [randomUUID(), team, p('A').employee],
  );

  // Same text as the operator query documented in docs/decisions/ADR-08-hr-data-time-pii.md.
  const orphans = () =>
    stack.migration.query<{ team: string; name: string; employee: string; code: string }[]>(
      `SELECT l.team_id::text AS team, t.name, l.lead_employee_id::text AS employee, e.code
       FROM team_lead_assignment l
       JOIN team t ON t.id = l.team_id
       JOIN employee e ON e.id = l.lead_employee_id
      WHERE l.ends_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM team_membership m
                         WHERE m.team_id = l.team_id AND m.employee_id = l.lead_employee_id
                           AND m.ends_at IS NULL)
      ORDER BY t.name, l.team_id`,
    );

  assert.deepEqual(
    (await orphans()).filter((row) => row.team === team).map((row) => row.employee),
    [p('A').employee],
  );
  const root = await stack.freshRoot();
  assert.ok(
    await stack.teams.addMember(root, {
      teamId: team,
      employeeId: p('A').employee,
      primary: false,
    }),
  );
  assert.deepEqual(
    (await orphans()).filter((row) => row.team === team),
    [],
  );
  assert.deepEqual(await leadRows(team), [{ employee: p('A').employee }]);
});

test('team.read per role: members see their teams, the lead its team, HR every team', async () => {
  const team = await newTeam('Read');
  const root = await stack.freshRoot();
  assert.ok(
    await stack.teams.addMember(root, {
      teamId: team,
      employeeId: p('A').employee,
      primary: false,
    }),
  );

  const names = async (name: string) =>
    (await stack.teams.list(p(name).secret, { limit: 100, offset: 0 })).items.map((t) => t.id);

  assert.ok((await names('A')).includes(team));
  assert.ok(!(await names('B')).includes(team));
  assert.equal(await stack.teams.detail(p('B').secret, team), undefined);
  const all = await stack.teams.list(p('H').secret, { limit: 100, offset: 0 });
  assert.equal(all.total, String(all.items.length));
  assert.ok(all.items.some((t) => t.id === team && t.memberCount === 1));
});
