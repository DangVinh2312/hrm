import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type EmployeeFrames,
  type Frame,
  type ScheduleFacts,
  type ScheduleVersion,
  earlySegment,
  frameMinutes,
  frameOn,
  isValidFrame,
  lateSegment,
  leaveMinutes,
  overlapMinutes,
  wfhSegment,
} from '../dist/modules/work-schedule/helpers/work-schedule.helper.js';
import { WorkingTimeRejected } from '../dist/modules/work-calendar/working-time.helper.js';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  MAX_SCHEDULE_RANGE_DAYS,
  parseCompanySchedule,
  parseEmployeeFrame,
  parseEmployeeScheduleQuery,
  parseWeekFrames,
} from '../dist/modules/work-schedule/work-schedule.validator.js';

// 2026-11-02 is a Monday, 2026-11-07 a Saturday, 2026-11-08 a Sunday.
const standard: Frame = [
  [540, 780],
  [840, 1080],
];

const week = (workday: Frame, weekend: Frame = []): Frame[] => [
  ...Array<Frame>(5).fill(workday),
  weekend,
  weekend,
];

const seed: ScheduleVersion = { effectiveFrom: '1900-01-01', days: week(standard) };

const facts = (over: Partial<ScheduleFacts> = {}): ScheduleFacts => ({
  versions: [seed],
  overrides: [],
  paidHolidays: new Set(),
  makeupDays: new Map(),
  ...over,
});

const workday = { kind: 'workday', frame: standard } as const;

const rejected = (run: () => unknown, reason: string) =>
  assert.throws(run, (error) => error instanceof WorkingTimeRejected && error.reason === reason);

test('the seeded schedule keeps the old week: Monday–Friday two shifts, weekend off', () => {
  for (let d = 2; d <= 6; d += 1) assert.deepEqual(frameOn(`2026-11-0${d}`, facts()), workday);
  assert.deepEqual(frameOn('2026-11-07', facts()), { kind: 'off', frame: [] });
  assert.deepEqual(frameOn('2026-11-08', facts()), { kind: 'off', frame: [] });
  assert.equal(frameMinutes(standard), 480);
});

test('parity: every old leave slot is valid with the same minutes', () => {
  for (const [start, end, minutes] of [
    [540, 660, 120],
    [660, 780, 120],
    [840, 960, 120],
    [960, 1080, 120],
    [540, 780, 240],
    [840, 1080, 240],
    [540, 1080, 480],
  ] as const)
    assert.equal(leaveMinutes(workday, start, end), minutes);
});

test('leave edges are shift edges or whole hours inside a shift; lunch alone is refused', () => {
  assert.equal(leaveMinutes(workday, 600, 720), 120);
  assert.equal(leaveMinutes(workday, 720, 900), 120);
  assert.equal(leaveMinutes(workday, 540, 840), 240);
  rejected(() => leaveMinutes(workday, 780, 840), 'invalid_slot');
  rejected(() => leaveMinutes(workday, 570, 660), 'invalid_slot');
  rejected(() => leaveMinutes(workday, 480, 600), 'invalid_slot');
  rejected(() => leaveMinutes(workday, 1080, 1140), 'invalid_slot');
  rejected(() => leaveMinutes(workday, 660, 540), 'invalid_slot');
  rejected(() => leaveMinutes(workday, 660, 660), 'invalid_slot');
  const custom = {
    kind: 'workday',
    frame: [
      [510, 780],
      [840, 1050],
    ],
  } as const;
  assert.equal(leaveMinutes(custom, 510, 600), 90);
  assert.equal(leaveMinutes(custom, 960, 1050), 90);
  assert.equal(leaveMinutes(custom, 510, 1050), 480);
  rejected(() => leaveMinutes(custom, 540, 1080), 'invalid_slot');
});

test('leave on a day off, a holiday or a makeup day is refused with its reason', () => {
  rejected(() => leaveMinutes({ kind: 'off', frame: [] }, 540, 660), 'non_working_day');
  rejected(
    () => leaveMinutes({ kind: 'paid_holiday', frame: standard }, 540, 660),
    'non_working_day',
  );
  rejected(() => leaveMinutes({ kind: 'makeup_workday', frame: standard }, 540, 660), 'makeup_day');
});

test('parity: late arrival 541..780 and 841..1079, early departure 541..779 and 841..1079', () => {
  for (let m = 0; m <= 1440; m += 1) {
    const late = m >= 541 && m <= 780 ? [540, m] : m >= 841 && m <= 1079 ? [840, m] : undefined;
    const early = m >= 541 && m <= 779 ? [m, 780] : m >= 841 && m <= 1079 ? [m, 1080] : undefined;
    assert.deepEqual(lateSegment(standard, m), late, `late ${m}`);
    assert.deepEqual(earlySegment(standard, m), early, `early ${m}`);
  }
  assert.equal(lateSegment([], 600), undefined);
  assert.equal(earlySegment([], 600), undefined);
});

test('parity: a WFH day is 540–1080 for 480 minutes; a custom frame spans its own shifts', () => {
  assert.deepEqual(wfhSegment(standard), { start: 540, end: 1080, minutes: 480 });
  assert.deepEqual(
    wfhSegment([
      [480, 720],
      [780, 960],
      [1020, 1080],
    ]),
    {
      start: 480,
      end: 1080,
      minutes: 480,
    },
  );
  assert.equal(wfhSegment([]), undefined);
});

test('overlap counts minutes inside the shifts only', () => {
  assert.equal(overlapMinutes(standard, 0, 1440), 480);
  assert.equal(overlapMinutes(standard, 720, 900), 120);
  assert.equal(overlapMinutes(standard, 780, 840), 0);
  assert.equal(overlapMinutes(standard, 539, 541), 1);
});

test('a frame has at most 3 shifts on the 5-minute grid, a gap between shifts, a bounded total', () => {
  assert.equal(isValidFrame([], 480), true);
  assert.equal(isValidFrame(standard, 480), true);
  assert.equal(isValidFrame(standard, 479), false);
  assert.equal(
    isValidFrame(
      [
        [0, 5],
        [10, 15],
        [1435, 1440],
      ],
      480,
    ),
    true,
  );
  assert.equal(
    isValidFrame(
      [
        [0, 60],
        [120, 180],
        [240, 300],
        [360, 420],
      ],
      720,
    ),
    false,
  );
  assert.equal(isValidFrame([[540, 783]], 480), false);
  assert.equal(isValidFrame([[541, 780]], 480), false);
  assert.equal(isValidFrame([[540.5, 780]], 480), false);
  assert.equal(isValidFrame([[780, 540]], 480), false);
  assert.equal(isValidFrame([[540, 540]], 480), false);
  assert.equal(isValidFrame([[-5, 60]], 480), false);
  assert.equal(isValidFrame([[1400, 1445]], 480), false);
  assert.equal(
    isValidFrame(
      [
        [840, 1080],
        [540, 780],
      ],
      480,
    ),
    false,
  );
  assert.equal(
    isValidFrame(
      [
        [540, 780],
        [780, 1020],
      ],
      480,
    ),
    false,
  );
  assert.equal(
    isValidFrame(
      [
        [540, 800],
        [780, 1000],
      ],
      720,
    ),
    false,
  );
});

const own = (
  validFrom: string,
  validTo: string | null,
  days: [number, Frame][],
): EmployeeFrames => ({
  validFrom,
  validTo,
  days: new Map(days),
});

const early: Frame = [
  [510, 780],
  [840, 1050],
];

test('an employee frame changes the hours of its weekdays inside its range only', () => {
  const f = facts({
    overrides: [
      own('2026-11-03', '2026-11-04', [
        [2, early],
        [6, early],
      ]),
    ],
  });
  assert.deepEqual(frameOn('2026-11-02', f), workday);
  assert.deepEqual(frameOn('2026-11-03', f), { kind: 'workday', frame: early });
  assert.deepEqual(frameOn('2026-11-04', f), workday); // Wednesday not listed
  assert.deepEqual(frameOn('2026-11-10', f), workday); // after valid_to
  // A frame for a weekday the company has off never adds a workday.
  assert.deepEqual(
    frameOn('2026-11-07', facts({ overrides: [own('2026-11-01', null, [[6, early]])] })),
    {
      kind: 'off',
      frame: [],
    },
  );
  assert.deepEqual(
    frameOn('2030-01-01', facts({ overrides: [own('2026-11-01', null, [[2, early]])] })),
    {
      kind: 'workday',
      frame: early,
    },
  );
});

test('the company version in force is the latest one starting on or before the date', () => {
  const later: ScheduleVersion = {
    effectiveFrom: '2026-11-04',
    days: week([[480, 960]], [[480, 720]]),
  };
  const f = facts({ versions: [seed, later] });
  assert.deepEqual(frameOn('2026-11-03', f), workday);
  assert.deepEqual(frameOn('2026-11-04', f), { kind: 'workday', frame: [[480, 960]] });
  assert.deepEqual(frameOn('2026-11-07', f), { kind: 'workday', frame: [[480, 720]] });
  assert.throws(() => frameOn('2026-11-03', facts({ versions: [later] })), RangeError);
  // A later version turning a weekday off drops the employee's frame for it.
  const sundayOnly: ScheduleVersion = {
    effectiveFrom: '2026-11-04',
    days: [...Array<Frame>(6).fill([]), standard],
  };
  const g = facts({
    versions: [seed, sundayOnly],
    overrides: [own('2026-11-01', null, [[2, early]])],
  });
  assert.deepEqual(frameOn('2026-11-10', g), { kind: 'off', frame: [] });
  assert.deepEqual(frameOn('2026-11-08', g), workday);
});

test('a paid holiday may fall on any weekday and only affects days the company works', () => {
  const holidays = new Set(['2026-11-03', '2026-11-07']);
  const f = facts({ paidHolidays: holidays, overrides: [own('2026-11-01', null, [[2, early]])] });
  assert.deepEqual(frameOn('2026-11-03', f), { kind: 'paid_holiday', frame: early });
  assert.deepEqual(frameOn('2026-11-07', f), { kind: 'off', frame: [] });
  const saturdays: ScheduleVersion = {
    effectiveFrom: '1900-01-01',
    days: week(standard, [[540, 780]]),
  };
  assert.deepEqual(
    frameOn('2026-11-07', facts({ versions: [saturdays], paidHolidays: holidays })),
    {
      kind: 'paid_holiday',
      frame: [[540, 780]],
    },
  );
});

test('a makeup day takes the hours of its weekday from the company or from each employee', () => {
  const overrides = [own('2026-11-01', null, [[1, early]])];
  const company = facts({
    overrides,
    makeupDays: new Map([['2026-11-07', { asWeekday: 1, frameSource: 'company' }]]),
  });
  assert.deepEqual(frameOn('2026-11-07', company), { kind: 'makeup_workday', frame: standard });
  const employee = facts({
    overrides,
    makeupDays: new Map([['2026-11-07', { asWeekday: 1, frameSource: 'employee' }]]),
  });
  assert.deepEqual(frameOn('2026-11-07', employee), { kind: 'makeup_workday', frame: early });
  // Without an own frame for that weekday the employee falls back to the company's.
  const tuesday = facts({
    overrides,
    makeupDays: new Map([['2026-11-07', { asWeekday: 2, frameSource: 'employee' }]]),
  });
  assert.deepEqual(frameOn('2026-11-07', tuesday), { kind: 'makeup_workday', frame: standard });
  // As a weekday the company has off, the makeup day has no hours.
  const sunday = facts({
    makeupDays: new Map([['2026-11-07', { asWeekday: 7, frameSource: 'employee' }]]),
  });
  assert.deepEqual(frameOn('2026-11-07', sunday), { kind: 'off', frame: [] });
});

test('invalid dates are refused before any schedule lookup', () => {
  rejected(() => frameOn('2026-02-30', facts()), 'invalid_date');
  rejected(() => frameOn('2026-11-2', facts()), 'invalid_date');
});

const invalid = (run: () => unknown) => assert.throws(run, ProductInvalidRequest);

const employeeId = '00000000-0000-4000-8000-000000000001';

test('a week is exactly seven lists of at most three [start, end] integer minutes in 0..1440', () => {
  const days = week(standard);
  assert.deepEqual(parseWeekFrames(days), days);
  for (const bad of [
    undefined,
    {},
    days.slice(0, 6),
    [...days, []],
    [
      [
        [540, 780],
        [800, 900],
        [910, 1000],
        [1010, 1080],
      ],
      ...days.slice(1),
    ],
    [[[540]], ...days.slice(1)],
    [[[540, 780, 900]], ...days.slice(1)],
    [[[-5, 780]], ...days.slice(1)],
    [[[540, 1445]], ...days.slice(1)],
    [[[540.5, 780]], ...days.slice(1)],
    [[['540', 780]], ...days.slice(1)],
    [[{ start: 540, end: 780 }], ...days.slice(1)],
  ])
    invalid(() => parseWeekFrames(bad));
});

test('schedule bodies are allowlisted; a frame ends on or after it starts', () => {
  const days = week(standard);
  assert.deepEqual(parseCompanySchedule('2026-12-01', { days }), {
    effectiveFrom: '2026-12-01',
    days,
  });
  invalid(() => parseCompanySchedule('2026-02-30', { days }));
  invalid(() => parseCompanySchedule('2026-12-01', { days, effectiveFrom: '2026-12-02' }));
  assert.deepEqual(
    parseEmployeeFrame(employeeId, { validFrom: '2026-12-01', validTo: '2026-12-01', days }),
    { employeeId, validFrom: '2026-12-01', validTo: '2026-12-01', days },
  );
  assert.equal(
    parseEmployeeFrame(employeeId, { validFrom: '2026-12-01', validTo: null, days }).validTo,
    null,
  );
  invalid(() =>
    parseEmployeeFrame(employeeId, { validFrom: '2026-12-02', validTo: '2026-12-01', days }),
  );
  invalid(() => parseEmployeeFrame('not-a-uuid', { validFrom: '2026-12-01', validTo: null, days }));
  invalid(() =>
    parseEmployeeFrame(employeeId, { validFrom: '2026-12-01', validTo: null, days, id: 'x' }),
  );
});

test('a schedule range is from..to inclusive and at most 92 days', () => {
  assert.equal(MAX_SCHEDULE_RANGE_DAYS, 92);
  assert.deepEqual(
    parseEmployeeScheduleQuery(employeeId, { from: '2026-11-01', to: '2026-11-01' }),
    {
      employeeId,
      from: '2026-11-01',
      to: '2026-11-01',
    },
  );
  // 2026-11-01 + 91 days = 2027-01-31: 92 days.
  assert.ok(parseEmployeeScheduleQuery(employeeId, { from: '2026-11-01', to: '2027-01-31' }));
  invalid(() => parseEmployeeScheduleQuery(employeeId, { from: '2026-11-01', to: '2027-02-01' }));
  invalid(() => parseEmployeeScheduleQuery(employeeId, { from: '2026-11-02', to: '2026-11-01' }));
  invalid(() => parseEmployeeScheduleQuery(employeeId, { from: '2026-11-01' }));
});
