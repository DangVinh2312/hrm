// T4 work calendar on PostgreSQL: who reads and changes it, versioned append-only history
// (paid holidays on weekdays, makeup workdays on Saturday/Sunday),
// optimistic concurrency, DB invariants and audit atomicity. Holidays are fixtures, not the
// legal calendar (docs/hrm-acceptance.md).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  ProductAccessDenied,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import { WORK_CALENDAR_ID } from '../dist/modules/permission/permission-database.helper.js';
import { withClient } from './setup-postgres.ts';
import { refused } from './hrm-attendance.helper.ts';
import { type ModulePerson, type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';

// Synthetic people only. H = HR/Admin, C = COO, E = employee, N = signed in without HR role.
let stack: ModuleStack;
const people: Record<string, ModulePerson> = {};

const p = (name: string) => {
  const person = people[name];
  if (!person) throw new Error(`Unknown fixture person ${name}`);
  return person;
};

const one = async (sql: string, params: unknown[] = []) =>
  (await stack.migration.query<{ v: string | null }[]>(sql, params))[0]?.v ?? null;

const calendarVersion = async () =>
  (await one('SELECT version::text AS v FROM work_calendar WHERE id=$1', [WORK_CALENDAR_ID])) ?? '';

const changes = () => one('SELECT count(*)::text AS v FROM work_calendar_change');

const audits = (kind: string) =>
  one(`SELECT count(*)::text AS v FROM audit_outbox WHERE convert_from(event_kind,'UTF8')=$1`, [
    kind,
  ]);

const rejected = (reason: string) => (error: unknown) =>
  error instanceof ProductCommandRejected && error.reason === reason;

const setDay = async (secret: string, date: string, holiday: string | null) =>
  stack.workCalendar.setDay(secret, { expectedVersion: await calendarVersion(), date, holiday });

before(async () => {
  stack = await startModuleStack();
  for (const [name, roles] of [
    ['H', ['hr.employee', 'hr.admin']],
    ['C', ['hr.employee', 'hr.coo']],
    ['E', ['hr.employee']],
    ['N', []],
  ] as const)
    people[name] = await stack.person(roles);
});

after(() => stack?.stop());

test('every HR role reads the calendar; an account without HR role sees nothing', async () => {
  for (const name of ['H', 'C', 'E'])
    assert.deepEqual(await stack.workCalendar.year(p(name).secret, 2026), {
      version: '1',
      year: 2026,
      holidays: [],
      makeupDays: [],
    });
  assert.equal(await stack.workCalendar.year(p('N').secret, 2026), undefined);
});

test('only HR/Admin with a fresh session (and fresh Root) change the calendar', async () => {
  const before = { version: await calendarVersion(), changes: await changes() };

  const attempt = (secret: string) =>
    stack.workCalendar.setDay(secret, {
      expectedVersion: before.version,
      date: '2026-09-01',
      holiday: 'Ngày lễ giả',
    });

  // hrFresh (TD5): HR without a recent step-up, other roles and no role are all denied.
  for (const secret of [p('H').secret, p('C').fresh, p('E').fresh, p('N').fresh])
    await assert.rejects(attempt(secret), ProductAccessDenied);
  // Root bypasses grants but not the policy's fresh@1 (ADR 0022).
  const root = await stack.root();
  await assert.rejects(attempt(root), ProductAccessDenied);
  assert.deepEqual({ version: await calendarVersion(), changes: await changes() }, before);

  assert.deepEqual(await attempt(p('H').fresh), {
    version: String(BigInt(before.version) + 1n),
  });
  assert.ok(await setDay(await stack.freshRoot(), '2026-09-01', null));
});

test('holidays are versioned: each change is one new version and history stays', async () => {
  const start = BigInt(await calendarVersion());
  const h = p('H').fresh;
  await setDay(h, '2026-11-02', 'Ngày lễ giả A');
  await setDay(h, '2026-12-31', 'Ngày lễ giả B');
  await setDay(h, '2027-01-01', 'Tết dương lịch giả');
  assert.deepEqual(await stack.workCalendar.year(p('E').secret, 2026), {
    version: String(start + 3n),
    year: 2026,
    holidays: [
      { date: '2026-11-02', name: 'Ngày lễ giả A' },
      { date: '2026-12-31', name: 'Ngày lễ giả B' },
    ],
    makeupDays: [],
  });
  assert.deepEqual((await stack.workCalendar.year(p('E').secret, 2027))?.holidays, [
    { date: '2027-01-01', name: 'Tết dương lịch giả' },
  ]);

  // Rename, then back to a standard workday: two more versions, nothing rewritten.
  await setDay(h, '2026-11-02', 'Ngày lễ giả A (đổi tên)');
  await setDay(h, '2026-11-02', null);
  const view = await stack.workCalendar.year(p('E').secret, 2026);
  assert.equal(view?.version, String(start + 5n));
  assert.deepEqual(view?.holidays, [{ date: '2026-12-31', name: 'Ngày lễ giả B' }]);
  const history = await stack.migration.query<{ version: string; kind: string }[]>(
    `SELECT version::text AS version, kind FROM work_calendar_change
      WHERE day = DATE '2026-11-02' ORDER BY version`,
  );
  assert.deepEqual(
    history.map((row) => row.kind),
    ['paid_holiday', 'paid_holiday', 'standard'],
  );
  // The calendar of an earlier version is still exact (what T8 snapshots will rely on).
  assert.equal(
    await one(
      `SELECT name AS v FROM work_calendar_change WHERE day = DATE '2026-11-02'
        AND version <= CAST($1 AS int8) ORDER BY version DESC LIMIT 1`,
      [String(start + 1n)],
    ),
    'Ngày lễ giả A',
  );
});

const setMakeup = async (secret: string, date: string, makeup: boolean) =>
  stack.workCalendar.setDay(secret, { expectedVersion: await calendarVersion(), date, makeup });

test('makeup Saturdays/Sundays are versioned like holidays and listed apart from them', async () => {
  const start = BigInt(await calendarVersion());
  const h = p('H').fresh;
  // 2026-06-06 Saturday, 2026-06-07 Sunday, 2027-01-02 Saturday.
  await setMakeup(h, '2026-06-07', true);
  await setMakeup(h, '2026-06-06', true);
  await setMakeup(h, '2027-01-02', true);
  const view = await stack.workCalendar.year(p('E').secret, 2026);
  assert.equal(view?.version, String(start + 3n));
  assert.deepEqual(view?.makeupDays, ['2026-06-06', '2026-06-07']);
  assert.ok(view?.holidays.every((holiday) => !holiday.date.startsWith('2026-06-0')));
  assert.deepEqual((await stack.workCalendar.year(p('E').secret, 2027))?.makeupDays, [
    '2027-01-02',
  ]);

  // Making it a weekend again is one more version; the earlier version still has the makeup day.
  const before = { version: await calendarVersion(), changes: await changes() };
  await assert.rejects(setMakeup(h, '2026-06-06', true), rejected('unchanged'));
  await assert.rejects(setMakeup(h, '2026-06-13', false), rejected('unchanged'));
  assert.deepEqual({ version: await calendarVersion(), changes: await changes() }, before);
  await setMakeup(h, '2026-06-06', false);
  assert.deepEqual((await stack.workCalendar.year(p('E').secret, 2026))?.makeupDays, [
    '2026-06-07',
  ]);
  const history = await stack.migration.query<{ kind: string; name: string | null }[]>(
    `SELECT kind, name FROM work_calendar_change WHERE day = DATE '2026-06-06' ORDER BY version`,
  );
  assert.deepEqual(history, [
    { kind: 'makeup_workday', name: null },
    { kind: 'standard', name: null },
  ]);
  assert.equal(
    await one(
      `SELECT kind AS v FROM work_calendar_change WHERE day = DATE '2026-06-06'
        AND version <= CAST($1 AS int8) ORDER BY version DESC LIMIT 1`,
      [before.version],
    ),
    'makeup_workday',
  );

  // Same permission as holidays: fresh HR/Admin only.
  for (const secret of [p('H').secret, p('C').fresh, p('E').fresh])
    await assert.rejects(setMakeup(secret, '2026-06-13', true), ProductAccessDenied);
  const audits0 = Number(await audits('hr.work-calendar.update'));
  await setMakeup(h, '2026-06-13', true);
  assert.equal(Number(await audits('hr.work-calendar.update')), audits0 + 1);
});

test('duplicate dates, no-op changes and stale versions are refused without a new version', async () => {
  const h = p('H').fresh;
  await setDay(h, '2026-10-01', 'Ngày lễ giả C');
  const before = { version: await calendarVersion(), changes: await changes() };
  await assert.rejects(setDay(h, '2026-10-01', 'Ngày lễ giả C'), rejected('unchanged'));
  await assert.rejects(setDay(h, '2026-10-02', null), rejected('unchanged'));
  await assert.rejects(
    stack.workCalendar.setDay(h, {
      expectedVersion: '1',
      date: '2026-10-05',
      holiday: 'Ngày lễ giả D',
    }),
    rejected('stale_version'),
  );
  assert.deepEqual({ version: await calendarVersion(), changes: await changes() }, before);
});

test('two concurrent changes on the same version: exactly one commits', async () => {
  const h = p('H').fresh;
  const expectedVersion = await calendarVersion();
  const results = await Promise.allSettled(
    ['2026-08-03', '2026-08-04'].map((date) =>
      stack.workCalendar.setDay(h, { expectedVersion, date, holiday: 'Ngày lễ giả đồng thời' }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = results.find((r) => r.status === 'rejected');
  assert.ok(failed && rejected('stale_version')(failed.reason));
  assert.equal(await calendarVersion(), String(BigInt(expectedVersion) + 1n));
  assert.equal(
    (await stack.workCalendar.year(p('E').secret, 2026))?.holidays.filter(
      (holiday) => holiday.name === 'Ngày lễ giả đồng thời',
    ).length,
    1,
  );
});

test('each change is audited by id only and rolls back with a failing audit writer', async () => {
  const h = p('H').fresh;
  const auditsBefore = await audits('hr.work-calendar.update');
  await setDay(h, '2026-07-01', 'Ngày lễ giả E');
  assert.equal(Number(await audits('hr.work-calendar.update')), Number(auditsBefore) + 1);
  const [event] = await stack.migration.query<{ metadata: unknown; object: string | null }[]>(
    `SELECT safe_metadata AS metadata, object_id::text AS object FROM audit_outbox
      WHERE convert_from(event_kind,'UTF8')='hr.work-calendar.update' ORDER BY occurred_at DESC LIMIT 1`,
  );
  const metadata = JSON.stringify(event?.metadata);
  for (const value of ['2026-07-01', 'Ngày lễ giả E']) assert.ok(!metadata.includes(value), value);

  const before = { version: await calendarVersion(), changes: await changes() };
  await withClient(stack.postgres.superuser, (client) =>
    client.query('REVOKE INSERT ON audit_outbox FROM product_data'),
  );
  try {
    await assert.rejects(
      setDay(h, '2026-07-02', 'Ngày lễ giả F'),
      (error) => !(error instanceof ProductAccessDenied),
    );
  } finally {
    await withClient(stack.postgres.superuser, (client) =>
      client.query('GRANT INSERT ON audit_outbox TO product_data'),
    );
  }
  assert.deepEqual({ version: await calendarVersion(), changes: await changes() }, before);
});

test('history is append-only for the runtime and the schema keeps holidays on weekdays, makeup on weekends', async () => {
  const deniedPrivilege = (error: unknown) =>
    (error as { driverError?: { code?: string } }).driverError?.code === '42501';

  await assert.rejects(
    stack.pools.data.query(`UPDATE work_calendar_change SET name = 'x'`),
    deniedPrivilege,
  );
  await assert.rejects(stack.pools.data.query('DELETE FROM work_calendar_change'), deniedPrivilege);
  await assert.rejects(stack.pools.data.query('UPDATE work_calendar SET id = id'), deniedPrivilege);

  const checkViolation = (error: unknown) =>
    (error as { driverError?: { code?: string } }).driverError?.code === '23514';

  // 2026-11-07 is a Saturday: a holiday there would be a silent no-op for working time.
  await assert.rejects(
    stack.migration.query(
      `INSERT INTO work_calendar_change(version,day,kind,name) VALUES (999999, DATE '2026-11-07','paid_holiday','x')`,
    ),
    checkViolation,
  );
  await assert.rejects(
    stack.migration.query(
      `INSERT INTO work_calendar_change(version,day,kind,name) VALUES (999998, DATE '2026-11-09','standard','x')`,
    ),
    checkViolation,
  );
  // Migration 103 had no makeup kind: the Monday makeup row is refused by the new constraint by
  // name, not by the old work_calendar_change_kind_check. (No paid_holiday/standard row separates
  // old from new: every row the old CHECKs accepted the new one accepts too.)
  await assert.rejects(
    stack.migration.query(
      `INSERT INTO work_calendar_change(version,day,kind,name) VALUES (999993, DATE '2026-11-09','makeup_workday',NULL)`,
    ),
    (error: unknown) =>
      (error as { driverError?: { constraint?: string } }).driverError?.constraint ===
      'ck_work_calendar_change_kind',
  );
  // Makeup only on Saturday/Sunday and without a name; one kind per row, so never both.
  for (const values of [
    `(999997, DATE '2026-11-09','makeup_workday',NULL)`, // Monday
    `(999996, DATE '2026-11-07','makeup_workday','x')`,
    `(999995, DATE '2026-11-07','workday',NULL)`,
    `(999994, DATE '2101-01-01','standard',NULL)`,
  ])
    await assert.rejects(
      stack.migration.query(
        `INSERT INTO work_calendar_change(version,day,kind,name) VALUES ${values}`,
      ),
      checkViolation,
      values,
    );
});

const setHolidays = async (secret: string, from: string, to: string, name: string) =>
  stack.workCalendar.setHolidays(secret, {
    expectedVersion: await calendarVersion(),
    from,
    to,
    name,
  });

const holidaysOf = async (year: number) =>
  (await stack.workCalendar.year(p('E').secret, year))?.holidays ?? [];

test('a holiday range is one transaction and one audit, one version per weekday, weekends skipped', async () => {
  const h = p('H').fresh;
  const start = BigInt(await calendarVersion());
  const auditsBefore = Number(await audits('hr.work-calendar.update'));
  // 2028-12-28 Thursday .. 2029-01-02 Tuesday: crosses the year; 30/31 Dec are Sat/Sun.
  const result = await setHolidays(h, '2028-12-28', '2029-01-02', 'Nghỉ lễ giả khoảng');
  assert.deepEqual(result, { version: String(start + 4n) });
  assert.equal(await calendarVersion(), String(start + 4n));
  assert.equal(Number(await audits('hr.work-calendar.update')), auditsBefore + 1);
  assert.deepEqual(await holidaysOf(2028), [
    { date: '2028-12-28', name: 'Nghỉ lễ giả khoảng' },
    { date: '2028-12-29', name: 'Nghỉ lễ giả khoảng' },
  ]);
  assert.deepEqual(await holidaysOf(2029), [
    { date: '2029-01-01', name: 'Nghỉ lễ giả khoảng' },
    { date: '2029-01-02', name: 'Nghỉ lễ giả khoảng' },
  ]);
  // Each day has its own version, consecutive, so any earlier version stays exact.
  const versions = await stack.migration.query<{ day: string; version: string }[]>(
    `SELECT to_char(day,'YYYY-MM-DD') AS day, version::text AS version FROM work_calendar_change
      WHERE version > CAST($1 AS int8) ORDER BY version`,
    [String(start)],
  );
  assert.deepEqual(
    versions.map((row) => row.version),
    [1n, 2n, 3n, 4n].map((n) => String(start + n)),
  );
  assert.deepEqual(
    versions.map((row) => row.day),
    ['2028-12-28', '2028-12-29', '2029-01-01', '2029-01-02'],
  );
});

test('a holiday range only writes the days that change; all unchanged, stale or weekend-only is refused', async () => {
  const h = p('H').fresh;
  await setHolidays(h, '2029-03-05', '2029-03-06', 'Nghỉ khoảng G');
  const start = BigInt(await calendarVersion());
  // 03-06 already has this name: only 03-07 changes.
  assert.deepEqual(await setHolidays(h, '2029-03-06', '2029-03-07', 'Nghỉ khoảng G'), {
    version: String(start + 1n),
  });
  const before = { version: await calendarVersion(), changes: await changes() };
  await assert.rejects(
    setHolidays(h, '2029-03-05', '2029-03-07', 'Nghỉ khoảng G'),
    rejected('unchanged'),
  );
  // A range of weekend days only never reaches the service through the validator, but the
  // service refuses it too (nothing to change).
  await assert.rejects(
    setHolidays(h, '2029-03-10', '2029-03-11', 'Nghỉ khoảng G'),
    rejected('unchanged'),
  );
  await assert.rejects(
    stack.workCalendar.setHolidays(h, {
      expectedVersion: '1',
      from: '2029-03-12',
      to: '2029-03-13',
      name: 'Nghỉ khoảng H',
    }),
    rejected('stale_version'),
  );
  assert.deepEqual({ version: await calendarVersion(), changes: await changes() }, before);
});

test('a holiday range is fresh HR/Admin only and refused whole when one day is in a closed month', async () => {
  const attempt = (secret: string) =>
    setHolidays(secret, '2029-04-02', '2029-04-03', 'Nghỉ khoảng I');

  for (const secret of [p('H').secret, p('C').fresh, p('E').fresh, p('N').fresh])
    await assert.rejects(attempt(secret), ProductAccessDenied);
  assert.deepEqual(
    await holidaysOf(2029).then((rows) => rows.filter((r) => r.date.startsWith('2029-04'))),
    [],
  );

  // February 2026 is closed: a range that reaches into it is refused whole, March included.
  await stack.attendance.closePeriod(p('H').fresh, { month: '2026-02' });
  const before = { version: await calendarVersion(), changes: await changes() };
  await assert.rejects(
    setHolidays(p('H').fresh, '2026-02-26', '2026-03-03', 'Nghỉ khoảng J'),
    refused('error.periodClosed', 409),
  );
  assert.deepEqual({ version: await calendarVersion(), changes: await changes() }, before);
});

test('renaming a holiday range rewrites every day: two days renamed make two versions', async () => {
  const h = p('H').fresh;
  await setHolidays(h, '2029-06-04', '2029-06-05', 'Tên X');
  const start = BigInt(await calendarVersion());
  assert.deepEqual(await setHolidays(h, '2029-06-04', '2029-06-05', 'Tên Y'), {
    version: String(start + 2n),
  });
  assert.deepEqual(
    (await holidaysOf(2029)).filter((holiday) => holiday.date.startsWith('2029-06')),
    [
      { date: '2029-06-04', name: 'Tên Y' },
      { date: '2029-06-05', name: 'Tên Y' },
    ],
  );
});

test('a range over two months is refused whole when only the second month is closed', async () => {
  // April 2026 stays open; May 2026 is closed.
  await stack.attendance.closePeriod(p('H').fresh, { month: '2026-05' });
  const before = { version: await calendarVersion(), changes: await changes() };
  await assert.rejects(
    setHolidays(p('H').fresh, '2026-04-29', '2026-05-04', 'Nghỉ khoảng K'),
    refused('error.periodClosed', 409),
  );
  assert.deepEqual({ version: await calendarVersion(), changes: await changes() }, before);
});
