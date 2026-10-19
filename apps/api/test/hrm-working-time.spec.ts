import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  WorkingTimeRejected,
  dayKind,
  leaveSlotMinutes,
  workingMinutes,
} from '../dist/work-calendar/working-time.helper.js';

// Acceptance cases A-01..A-20 (docs/hrm-acceptance.md). Holidays are fixtures, not the legal calendar.
const none = { paidHolidays: new Set<string>(), makeupDays: new Set<string>() };
const holiday = { paidHolidays: new Set(['2026-11-02']), makeupDays: new Set<string>() };
// 2026-11-07 is a Saturday, 2026-11-08 a Sunday; 2026-11-03 (Tuesday) in makeupDays is ignored.
const makeup = {
  paidHolidays: new Set<string>(),
  makeupDays: new Set(['2026-11-07', '2026-11-08', '2026-11-03']),
};

const day = (date: string, calendar = none) =>
  workingMinutes({ date, from: 0, to: 1440, calendar });

const rejected = (run: () => unknown, reason: string) =>
  assert.throws(run, (error) => error instanceof WorkingTimeRejected && error.reason === reason);

test('a standard weekday is 480 minutes, weekends are 0 (A-01, A-02)', () => {
  assert.equal(day('2026-11-02'), 480);
  assert.equal(day('2026-11-06'), 480);
  assert.equal(day('2026-11-07'), 0);
  assert.equal(day('2026-11-08'), 0);
  assert.equal(dayKind('2026-11-07', none), 'weekend');
  assert.equal(dayKind('2026-11-02', none), 'workday');
});

test('lunch break is not working time; ranges clip to the two shifts (A-03, A-04)', () => {
  const at = (from: number, to: number) =>
    workingMinutes({ date: '2026-11-02', from, to, calendar: none });

  assert.equal(at(780, 840), 0);
  assert.equal(at(540, 1080), 480);
  assert.equal(at(540, 780), 240);
  assert.equal(at(840, 1080), 240);
  assert.equal(at(720, 900), 120); // 12:00–15:00 → 60 + 60
  assert.equal(at(0, 540), 0); // ends exactly at shift start
  assert.equal(at(1080, 1440), 0); // starts exactly at shift end
  assert.equal(at(539, 541), 1);
  assert.equal(at(779, 841), 2);
});

test('a month of working minutes is the sum of its weekdays (A-05)', () => {
  let total = 0;
  for (let d = 1; d <= 30; d += 1) total += day(`2026-11-${String(d).padStart(2, '0')}`);
  assert.equal(total, 21 * 480);
});

test('a paid holiday has no working minutes and is its own kind (A-06)', () => {
  assert.equal(day('2026-11-02', holiday), 0);
  assert.equal(dayKind('2026-11-02', holiday), 'paid_holiday');
  assert.equal(day('2026-11-03', holiday), 480);
});

test('a makeup Saturday/Sunday is a full workday with the standard shifts (T4 makeup)', () => {
  assert.equal(dayKind('2026-11-07', makeup), 'makeup_workday');
  assert.equal(dayKind('2026-11-08', makeup), 'makeup_workday');
  assert.equal(day('2026-11-07', makeup), 480);
  assert.equal(day('2026-11-08', makeup), 480);
  assert.equal(day('2026-11-14', makeup), 0); // another Saturday stays a weekend

  const at = (from: number, to: number) =>
    workingMinutes({ date: '2026-11-07', from, to, calendar: makeup });

  assert.equal(at(780, 840), 0);
  assert.equal(at(540, 780), 240);
  assert.equal(at(720, 900), 120);
  // A weekday listed as makeup is just a workday: makeup never changes Monday–Friday.
  assert.equal(dayKind('2026-11-03', makeup), 'workday');
  assert.equal(day('2026-11-03', makeup), 480);
  // With both Saturday and Sunday listed as makeup, Monday 2026-11-02 to Sunday 08 has seven full days.
  let total = 0;
  for (let d = 2; d <= 8; d += 1) total += day(`2026-11-0${d}`, makeup);
  assert.equal(total, 7 * 480);
});

test('invalid dates are rejected, never corrected (A-07)', () => {
  for (const date of [
    '2026-02-30',
    '2026-13-01',
    '2026-1-2',
    '2026-00-10',
    '2026-11-31',
    '2026-11-02T00:00',
    ' 2026-11-02',
    '١٢٣٤-11-02',
    '1899-12-31',
    '2101-01-01',
  ])
    rejected(() => day(date), 'invalid_date');
  assert.equal(day('2028-02-29'), 480); // leap day, Tuesday
  rejected(() => day('2027-02-29'), 'invalid_date');
});

test('reversed, empty, fractional or out-of-day intervals are rejected (A-08)', () => {
  const at = (from: number, to: number) => () =>
    workingMinutes({ date: '2026-11-02', from, to, calendar: none });

  rejected(at(840, 660), 'invalid_interval');
  rejected(at(540, 540), 'invalid_interval');
  rejected(at(540.5, 600), 'invalid_interval');
  rejected(at(-1, 600), 'invalid_interval');
  rejected(at(540, 1441), 'invalid_interval');
  rejected(at(Number.NaN, 600), 'invalid_interval');
});

test('only the seven listed slots are valid leave slots (A-10..A-18)', () => {
  const slot = (start: number, end: number, date = '2026-11-02') =>
    leaveSlotMinutes({ date, start, end, calendar: none });

  assert.equal(slot(540, 660), 120);
  assert.equal(slot(660, 780), 120);
  assert.equal(slot(840, 960), 120);
  assert.equal(slot(960, 1080), 120);
  assert.equal(slot(540, 780), 240);
  assert.equal(slot(840, 1080), 240);
  assert.equal(slot(540, 1080), 480);
  rejected(() => slot(600, 720), 'invalid_slot'); // 10–12 is 120 minutes but not a slot
  rejected(() => slot(720, 840), 'invalid_slot'); // over lunch
  rejected(() => slot(660, 840), 'invalid_slot');
  rejected(() => slot(780, 840), 'invalid_slot'); // lunch itself
  rejected(() => slot(660, 540), 'invalid_slot');
  rejected(() => slot(540, 660, '2026-02-30'), 'invalid_date');
});

test('a slot on a weekend or paid holiday is not a working day (A-19, A-20)', () => {
  rejected(
    () => leaveSlotMinutes({ date: '2026-11-07', start: 540, end: 660, calendar: none }),
    'non_working_day',
  );
  rejected(
    () => leaveSlotMinutes({ date: '2026-11-02', start: 540, end: 660, calendar: holiday }),
    'non_working_day',
  );
});

test('a leave slot on a makeup day is refused with its own reason until T7 decides', () => {
  rejected(
    () => leaveSlotMinutes({ date: '2026-11-07', start: 540, end: 660, calendar: makeup }),
    'makeup_day',
  );
  rejected(
    () => leaveSlotMinutes({ date: '2026-11-07', start: 600, end: 720, calendar: makeup }),
    'invalid_slot',
  );
  assert.equal(
    leaveSlotMinutes({ date: '2026-11-03', start: 540, end: 1080, calendar: makeup }),
    480,
  );
});

test('results do not depend on the host timezone (A-09)', () => {
  const script = `
    const m = await import(${JSON.stringify(new URL('../dist/work-calendar/working-time.helper.js', import.meta.url).href)});
    const c = { paidHolidays: new Set(['2026-11-02']), makeupDays: new Set(['2026-11-08']) };
    const out = ['2026-11-01','2026-11-02','2026-11-07','2026-11-08','2026-12-31','2027-01-01'].map((date) => [m.dayKind(date, c), m.workingMinutes({ date, from: 0, to: 1440, calendar: c })]);
    process.stdout.write(JSON.stringify(out));`;
  const outputs = ['UTC', 'Asia/Ho_Chi_Minh', 'Pacific/Kiritimati', 'America/Los_Angeles'].map(
    (tz) => {
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
      return run.stdout;
    },
  );
  assert.equal(new Set(outputs).size, 1);
  assert.equal(
    outputs[0],
    JSON.stringify([
      ['weekend', 0],
      ['paid_holiday', 0],
      ['weekend', 0],
      ['makeup_workday', 480],
      ['workday', 480],
      ['workday', 480],
    ]),
  );
});
