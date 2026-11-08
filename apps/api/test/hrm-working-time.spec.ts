import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  WorkingTimeRejected,
  datesBetween,
  isoWeekday,
} from '../dist/modules/work-calendar/working-time.helper.js';

// Acceptance cases A-07 and A-09 (docs/hrm-acceptance.md); the hours themselves are in
// hrm-work-schedule.spec.ts.
const rejected = (run: () => unknown, reason: string) =>
  assert.throws(run, (error) => error instanceof WorkingTimeRejected && error.reason === reason);

test('ISO weekdays: Monday 1 .. Sunday 7', () => {
  assert.deepEqual(
    ['2026-11-02', '2026-11-06', '2026-11-07', '2026-11-08'].map(isoWeekday),
    [1, 5, 6, 7],
  );
  assert.equal(isoWeekday('2028-02-29'), 2); // leap day
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
    '2027-02-29',
  ])
    rejected(() => isoWeekday(date), 'invalid_date');
});

test('a date range lists every day, at most 31, never reversed', () => {
  assert.deepEqual(datesBetween('2026-11-06', '2026-11-09'), [
    '2026-11-06',
    '2026-11-07',
    '2026-11-08',
    '2026-11-09',
  ]);
  assert.deepEqual(datesBetween('2026-12-31', '2027-01-01'), ['2026-12-31', '2027-01-01']);
  assert.equal(datesBetween('2026-01-01', '2026-01-31').length, 31);
  assert.deepEqual(datesBetween('2026-01-01', '2026-02-01'), []);
  assert.deepEqual(datesBetween('2026-11-09', '2026-11-08'), []);
});

test('results do not depend on the host timezone (A-09)', () => {
  const helper = (path: string) =>
    JSON.stringify(new URL(`../dist/modules/${path}.helper.js`, import.meta.url).href);

  const script = `
    const t = await import(${helper('work-calendar/working-time')});
    const s = await import(${helper('work-schedule/helpers/work-schedule')});
    const standard = [[540, 780], [840, 1080]];
    const facts = {
      versions: [{ effectiveFrom: '1900-01-01', days: [standard, standard, standard, standard, standard, [], []] }],
      overrides: [],
      paidHolidays: new Set(['2026-11-02']),
      makeupDays: new Map([['2026-11-08', { asWeekday: 1, frameSource: 'company' }]]),
    };
    const out = ['2026-11-01','2026-11-02','2026-11-07','2026-11-08','2026-12-31','2027-01-01'].map((date) => {
      const day = s.frameOn(date, facts);
      return [t.isoWeekday(date), day.kind, s.frameMinutes(day.frame)];
    });
    process.stdout.write(JSON.stringify([out, t.datesBetween('2026-03-28', '2026-03-30')]));`;
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
      [
        [7, 'off', 0],
        [1, 'paid_holiday', 480],
        [6, 'off', 0],
        [7, 'makeup_workday', 480],
        [4, 'workday', 480],
        [5, 'workday', 480],
      ],
      ['2026-03-28', '2026-03-29', '2026-03-30'],
    ]),
  );
});
