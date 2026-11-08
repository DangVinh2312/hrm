// ADR-19 working hours on PostgreSQL: who reads and changes the company week and an employee's
// own frames, the "after today" rule, unchanged/overlap rejections, audit, and the hours a day gets.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  ProductAccessDenied,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.types.js';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { isoWeekday } from '../dist/modules/work-calendar/working-time.helper.js';
import { attendanceFixture, refused } from './hrm-attendance.helper.ts';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';

// Synthetic people only. L1 leads T1 with member E; O is an employee outside T1; H is HR/Admin;
// N is signed in without any HR role.
let stack: ModuleStack;
let fixture: ReturnType<typeof attendanceFixture>;

type Frame = [number, number][];

const companyWeek: Frame = [
  [540, 780],
  [840, 1080],
];
const earlyWeek: Frame = [
  [480, 720],
  [780, 1020],
];

const week = (workday: Frame): Frame[] => [...Array<Frame>(5).fill(workday), [], []];

const rejected = (reason: string) => (error: unknown) =>
  error instanceof ProductCommandRejected && error.reason === reason;

const audits = (kind: string) =>
  fixture.count(
    `SELECT count(*)::text AS n FROM audit_outbox WHERE convert_from(event_kind,'UTF8')=$1`,
    [kind],
  );

const p = (name: string) => fixture.p(name);

/** The offset of the first Monday–Friday from `offset` days after today on. */
async function weekdayFrom(offset: number): Promise<number> {
  for (let day = offset; ; day++) if (isoWeekday(await stack.day(day)) < 6) return day;
}

before(async () => {
  stack = await startModuleStack();
  fixture = attendanceFixture(stack);
  await fixture.setup();
  await fixture.hire('E', ['hr.employee']);
  await fixture.hire('O', ['hr.employee'], { inTeam: false });
  fixture.people.N = await stack.person([]);
});

after(() => stack?.stop());

test('every HR role reads the company week in force; an account without HR role sees nothing', async () => {
  for (const name of ['H', 'C', 'L1', 'E']) {
    const view = await stack.workSchedule.companySchedule(p(name).secret);
    assert.equal(view?.today, await stack.day(0));
    assert.equal(view?.maxMinutes, 480);
    assert.deepEqual(view?.versions, [{ effectiveFrom: '1900-01-01', days: week(companyWeek) }]);
  }
  assert.equal(await stack.workSchedule.companySchedule(p('N').secret), undefined);
});

test('only fresh HR/Admin changes the company week, from tomorrow on, and only to a valid week', async () => {
  const tomorrow = await stack.day(1);
  const later = await stack.day(30);

  const put = (secret: string, effectiveFrom = later, days = week(earlyWeek)) =>
    stack.workSchedule.putCompanySchedule(secret, { effectiveFrom, days });

  const before = await audits('hr.work-schedule.update');

  for (const secret of [p('H').secret, p('L1').fresh, p('E').fresh, p('N').fresh])
    await assert.rejects(put(secret), ProductAccessDenied);
  // Today and earlier are worked under the version in force: never rewritten.
  for (const date of [await stack.day(0), await stack.day(-1)])
    await assert.rejects(put(p('H').fresh, date), ProductInvalidRequest);
  // 9 hours a day is above hr.workdayMaxMinutes (480); an all-empty week has no workday.
  await assert.rejects(put(p('H').fresh, later, week([[480, 1020]])), ProductInvalidRequest);
  await assert.rejects(put(p('H').fresh, later, week([])), ProductInvalidRequest);
  // Overlapping shifts, or shifts out of order, or off the 5-minute step.
  for (const frame of [
    [
      [540, 800],
      [780, 1000],
    ],
    [
      [840, 1080],
      [540, 780],
    ],
    [[541, 780]],
  ] as Frame[])
    await assert.rejects(put(p('H').fresh, later, week(frame)), ProductInvalidRequest);
  assert.equal(await audits('hr.work-schedule.update'), before);

  assert.deepEqual(await put(p('H').fresh), { effectiveFrom: later });
  await assert.rejects(put(p('H').fresh), rejected('unchanged'));
  // Fresh Root bypasses grants; replacing a version not in force yet keeps one row for the date.
  assert.deepEqual(await put(await stack.freshRoot(), later, week(companyWeek)), {
    effectiveFrom: later,
  });
  assert.deepEqual(await put(p('H').fresh, tomorrow), { effectiveFrom: tomorrow });
  assert.equal(await audits('hr.work-schedule.update'), before + 3);
  assert.deepEqual((await stack.workSchedule.companySchedule(p('E').secret))?.versions, [
    { effectiveFrom: '1900-01-01', days: week(companyWeek) },
    { effectiveFrom: tomorrow, days: week(earlyWeek) },
    { effectiveFrom: later, days: week(companyWeek) },
  ]);

  // Removing: only a version not in force yet; an unknown date is not found.
  await assert.rejects(
    stack.workSchedule.deleteCompanySchedule(p('E').fresh, later),
    ProductAccessDenied,
  );
  await assert.rejects(
    stack.workSchedule.deleteCompanySchedule(p('H').fresh, '1900-01-01'),
    ProductInvalidRequest,
  );
  for (const date of [later, tomorrow])
    assert.deepEqual(await stack.workSchedule.deleteCompanySchedule(p('H').fresh, date), {
      effectiveFrom: date,
    });
  await assert.rejects(
    stack.workSchedule.deleteCompanySchedule(p('H').fresh, later),
    rejected('no_version'),
  );
  assert.equal(await audits('hr.work-schedule.update'), before + 5);
  assert.equal(await fixture.count('SELECT count(*)::text AS n FROM work_schedule_shift'), 10);
});

test('employee frames: self and lead read, only fresh HR/Admin writes, frames never overlap', async () => {
  const employeeId = fixture.employeeOf('E');
  const from = await stack.day(10);
  const to = await stack.day(40);

  const add = (secret: string, validFrom = from, validTo: string | null = to) =>
    stack.workSchedule.addEmployeeFrame(secret, {
      employeeId,
      validFrom,
      validTo,
      days: week(earlyWeek),
    });

  const before = await audits('hr.employee-schedule.update');

  for (const name of ['E', 'L1', 'H'])
    assert.deepEqual(
      (await stack.workSchedule.employeeFrames(p(name).secret, employeeId))?.frames,
      [],
    );
  for (const name of ['O', 'N'])
    assert.equal(await stack.workSchedule.employeeFrames(p(name).secret, employeeId), undefined);

  // Without employee.manageSchedule on E the target is absent (404), as for any other write;
  // HR without a recent step-up fails fresh@1.
  for (const name of ['E', 'L1', 'O', 'N']) assert.equal(await add(p(name).fresh), undefined);
  await assert.rejects(add(p('H').secret), ProductAccessDenied);
  await assert.rejects(add(p('H').fresh, await stack.day(0)), ProductInvalidRequest);
  // Saturday is off in the company week in force at validFrom: no own hours for it.
  await assert.rejects(
    stack.workSchedule.addEmployeeFrame(p('H').fresh, {
      employeeId,
      validFrom: from,
      validTo: to,
      days: [...week(earlyWeek).slice(0, 5), [[540, 780]], []],
    }),
    ProductInvalidRequest,
  );
  assert.equal(await audits('hr.employee-schedule.update'), before);

  const created = await add(p('H').fresh);
  assert.ok(created);
  for (const [validFrom, validTo] of [
    [await stack.day(40), null],
    [await stack.day(2), await stack.day(10)],
    [await stack.day(12), await stack.day(20)],
  ] as const)
    await assert.rejects(add(p('H').fresh, validFrom, validTo), rejected('overlap'));
  const next = await add(p('H').fresh, await stack.day(41), null);
  assert.ok(next);

  const view = await stack.workSchedule.employeeFrames(p('E').secret, employeeId);
  assert.deepEqual(view?.frames, [
    { id: created.id, validFrom: from, validTo: to, days: week(earlyWeek) },
    { id: next.id, validFrom: await stack.day(41), validTo: null, days: week(earlyWeek) },
  ]);
  assert.equal(await audits('hr.employee-schedule.update'), before + 2);

  // A frame not started yet is removed; a frame of another employee, or one gone, is refused.
  assert.deepEqual(
    await stack.workSchedule.endEmployeeFrame(p('H').fresh, { employeeId, frameId: next.id }),
    { id: next.id },
  );
  await assert.rejects(
    stack.workSchedule.endEmployeeFrame(p('H').fresh, {
      employeeId: fixture.employeeOf('O'),
      frameId: created.id,
    }),
    rejected('no_frame'),
  );
  await assert.rejects(
    stack.workSchedule.endEmployeeFrame(p('H').fresh, { employeeId, frameId: next.id }),
    rejected('no_frame'),
  );
  assert.equal(
    await stack.workSchedule.endEmployeeFrame(p('E').fresh, { employeeId, frameId: created.id }),
    undefined,
  );
  assert.equal(
    (await stack.workSchedule.employeeFrames(p('E').secret, employeeId))?.frames.length,
    1,
  );
  assert.equal(await audits('hr.employee-schedule.update'), before + 3);
});

test('a frame in force ends today: earlier days keep its hours, a second end is unchanged', async () => {
  const employeeId = fixture.employeeOf('O');
  const id = '00000000-0000-4000-8000-0000000000f1';
  // Only a fixture can start a frame in the past; the API accepts dates after today only.
  await stack.migration.query(
    `INSERT INTO employee_schedule(id, employee_id, valid_from, valid_to)
     VALUES ($1, $2, CAST($3 AS date), NULL)`,
    [id, employeeId, await stack.day(-20)],
  );
  await stack.migration.query(
    `INSERT INTO employee_schedule_shift(schedule_id, weekday, position, start_minute, end_minute)
     SELECT $1, w, 1, 480, 720 FROM generate_series(1, 5) w`,
    [id],
  );

  const end = () => stack.workSchedule.endEmployeeFrame(p('H').fresh, { employeeId, frameId: id });

  assert.deepEqual(await end(), { id });
  await assert.rejects(end(), rejected('unchanged'));
  assert.deepEqual(
    await stack.migration.query(
      `SELECT to_char(valid_to,'YYYY-MM-DD') AS "validTo" FROM employee_schedule WHERE id = $1`,
      [id],
    ),
    [{ validTo: await stack.day(0) }],
  );
  // A frame ending today is still listed (it ends today or later).
  assert.deepEqual(
    (await stack.workSchedule.employeeFrames(p('O').secret, employeeId))?.frames.map((f) => f.id),
    [id],
  );
});

test('the hours of each day: own frame over the company week, weekends off', async () => {
  const employeeId = fixture.employeeOf('E');
  const start = await weekdayFrom(60);
  const from = await stack.day(start);
  const own = await stack.workSchedule.addEmployeeFrame(p('H').fresh, {
    employeeId,
    validFrom: from,
    validTo: from,
    days: Array.from({ length: 7 }, (_, i): Frame =>
      i === isoWeekday(from) - 1 ? [[600, 840]] : [],
    ),
  });
  assert.ok(own);
  const to = await stack.day(start + 6);
  const view = await stack.workSchedule.employeeDays(p('L1').secret, { employeeId, from, to });
  assert.equal(view?.employeeId, employeeId);
  assert.equal(view?.days.length, 7);
  for (const day of view?.days ?? []) {
    const weekend = isoWeekday(day.date) > 5;
    const expected =
      day.date === from
        ? { date: from, kind: 'workday', shifts: [[600, 840]] }
        : { date: day.date, kind: weekend ? 'off' : 'workday', shifts: weekend ? [] : companyWeek };
    assert.deepEqual(day, expected);
  }
  for (const name of ['O', 'N'])
    assert.equal(
      await stack.workSchedule.employeeDays(p(name).secret, { employeeId, from, to }),
      undefined,
    );
});

test('a company change that would break a later makeup day is refused (409), nothing written', async () => {
  let offset = 40;
  while (isoWeekday(await stack.day(offset)) !== 6) offset++;
  const saturday = await stack.day(offset);

  const version = async () =>
    String(await fixture.count(`SELECT version::text AS n FROM work_calendar`));

  const setMakeup = async (makeup: { asWeekday: number; frameSource: 'company' } | null) =>
    stack.workCalendar.setDay(p('H').fresh, {
      expectedVersion: await version(),
      date: saturday,
      makeup,
    });

  await setMakeup({ asWeekday: 1, frameSource: 'company' });
  const effectiveFrom = await stack.day(offset - 7);

  const put = (days: Frame[]) =>
    stack.workSchedule.putCompanySchedule(p('H').fresh, { effectiveFrom, days });

  const versions = () => fixture.count(`SELECT count(*)::text AS n FROM work_schedule`);

  const before = await versions();
  // The makeup Saturday becomes a company workday, or its Monday hours become a day off.
  await assert.rejects(
    put([...week(companyWeek).slice(0, 5), [[480, 720]], []]),
    rejected('makeup_day'),
  );
  await assert.rejects(put([[], ...week(companyWeek).slice(1)]), rejected('makeup_day'));
  assert.deepEqual(await versions(), before);
  await setMakeup(null);
  assert.ok(await put([...week(companyWeek).slice(0, 5), [[480, 720]], []]));
  await stack.workSchedule.deleteCompanySchedule(p('H').fresh, effectiveFrom);
});

test('schedule changes are refused while the month of their first changed day is closed', async () => {
  const tomorrow = await stack.day(1);
  const month = (await stack.day(0)).slice(0, 7);
  // Only the current month can be closed; on its last day, tomorrow is in a month still open.
  if (!tomorrow.startsWith(month)) return;
  await stack.attendance.closePeriod(p('H').fresh, { month });
  const employeeId = fixture.employeeOf('O');
  const closed = refused('error.periodClosed', 409);
  await assert.rejects(
    stack.workSchedule.putCompanySchedule(p('H').fresh, {
      effectiveFrom: tomorrow,
      days: week(earlyWeek),
    }),
    closed,
  );
  await assert.rejects(
    stack.workSchedule.addEmployeeFrame(p('H').fresh, {
      employeeId,
      validFrom: tomorrow,
      validTo: tomorrow,
      days: week(earlyWeek),
    }),
    closed,
  );
  await stack.attendance.reopenPeriod(p('H').fresh, { month, reason: 'Kiểm thử' });
});
