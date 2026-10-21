// T8 attendance rules without a database: the monthly sheet is a pure function of the hire and
// leaving dates, the calendar and the approved effects (design §9, acceptance F-01..F-08, D05),
// plus the parsers of the attendance routes. Synthetic data; dates are fixed inputs, never a clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  type AttendanceFacts,
  attendanceTotals,
  monthDates,
} from '../dist/modules/attendance/helpers/attendance-calculation.helper.js';
import {
  parseAttendanceMonth,
  parseAttendanceQuery,
  parsePeriodReopen,
} from '../dist/modules/attendance/attendance.validator.js';

const employee = '7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f';

/** November 2026: Sunday the 1st, 21 weekdays, no holiday unless the test adds one. */
function facts(over: Partial<AttendanceFacts> = {}): AttendanceFacts {
  return {
    month: '2026-11',
    hiredOn: '2026-01-05',
    terminatedOn: null,
    calendar: { paidHolidays: new Set(), makeupDays: new Set() },
    effects: [],
    ...over,
  };
}

const effect = (
  kind: AttendanceFacts['effects'][number]['kind'],
  date: string,
  startMinute: number,
  endMinute: number,
) => ({ kind, date, startMinute, endMinute });

test('a month without requests is fully paid by the calendar: 21 weekdays x 480 (F-01)', () => {
  assert.deepEqual(attendanceTotals(facts()), {
    scheduledMinutes: 10080,
    paidHolidayMinutes: 0,
    unpaidMinutes: 0,
    annualLeaveMinutes: 0,
    paidMinutes: 10080,
    wfhDays: 0,
    lateCount: 0,
    lateMinutes: 0,
    earlyCount: 0,
    earlyMinutes: 0,
  });
});

test('nothing is counted before the hire date or after the last working day (F-02)', () => {
  assert.equal(attendanceTotals(facts({ hiredOn: '2026-11-16' })).scheduledMinutes, 5280);
  // Last working day 2026-11-13 (Friday), inclusive: 10 days.
  assert.equal(attendanceTotals(facts({ terminatedOn: '2026-11-13' })).scheduledMinutes, 4800);
  // Hired after the month, left before it: an empty sheet.
  assert.equal(attendanceTotals(facts({ hiredOn: '2026-12-01' })).scheduledMinutes, 0);
  assert.equal(attendanceTotals(facts({ terminatedOn: '2026-10-30' })).paidMinutes, 0);
});

test('weekends are not scheduled and a declared makeup weekend day is (design §3)', () => {
  const calendar = { paidHolidays: new Set<string>(), makeupDays: new Set(['2026-11-14']) };
  assert.equal(attendanceTotals(facts({ calendar })).scheduledMinutes, 22 * 480);
});

test('a paid holiday is paid time off, not working minutes, and subtracts nothing (F-06)', () => {
  const calendar = { paidHolidays: new Set(['2026-11-10']), makeupDays: new Set<string>() };
  const totals = attendanceTotals(facts({ calendar }));
  assert.equal(totals.scheduledMinutes, 20 * 480);
  assert.equal(totals.paidHolidayMinutes, 480);
  assert.equal(totals.paidMinutes, 10080);
  // A holiday outside the employment period is not paid either.
  assert.equal(attendanceTotals(facts({ calendar, hiredOn: '2026-11-16' })).paidHolidayMinutes, 0);
});

test('approved unpaid leave is deducted, 120/240/480 (F-03)', () => {
  const slots = [
    [effect('unpaid-leave', '2026-11-03', 540, 660)],
    [effect('unpaid-leave', '2026-11-03', 540, 780)],
    [effect('unpaid-leave', '2026-11-03', 540, 1080)],
  ];
  const minutes = slots.map((effects) => {
    const t = attendanceTotals(facts({ effects }));
    return [t.unpaidMinutes, t.paidMinutes];
  });
  assert.deepEqual(minutes, [
    [120, 9960],
    [240, 9840],
    [480, 9600],
  ]);
});

test('annual leave is recorded but does not reduce paid time (F-05)', () => {
  const t = attendanceTotals(facts({ effects: [effect('annual-leave', '2026-11-03', 540, 1080)] }));
  assert.equal(t.annualLeaveMinutes, 480);
  assert.equal(t.unpaidMinutes, 0);
  assert.equal(t.paidMinutes, 10080);
});

test('WFH is a worked day: counted once per day, no deduction', () => {
  const t = attendanceTotals(
    facts({
      effects: [
        effect('wfh', '2026-11-03', 540, 1080),
        effect('wfh', '2026-11-04', 540, 1080),
        effect('wfh', '2026-11-04', 540, 1080),
      ],
    }),
  );
  assert.equal(t.wfhDays, 2);
  assert.equal(t.paidMinutes, 10080);
});

test('late arrival and early departure are only recorded: count and minutes, nothing deducted (F-07, D05)', () => {
  const t = attendanceTotals(
    facts({
      effects: [
        effect('late-arrival', '2026-11-03', 540, 600),
        effect('late-arrival', '2026-11-04', 840, 870),
        effect('early-departure', '2026-11-05', 1020, 1080),
      ],
    }),
  );
  assert.deepEqual(
    [t.lateCount, t.lateMinutes, t.earlyCount, t.earlyMinutes, t.paidMinutes],
    [2, 90, 1, 60, 10080],
  );
});

test('overlapping leave is never counted twice: each working minute belongs to one kind', () => {
  // Annual 09-11 and unpaid 09-13 on one day cannot both be approved (submit refuses the
  // overlap), but a bug or a manual fix must not double count: the shared 120 minutes count once.
  const t = attendanceTotals(
    facts({
      effects: [
        effect('unpaid-leave', '2026-11-03', 540, 780),
        effect('annual-leave', '2026-11-03', 540, 660),
      ],
    }),
  );
  assert.equal(t.annualLeaveMinutes + t.unpaidMinutes, 240);
  // Fixed attribution: annual leave first, so the result does not depend on the input order.
  assert.deepEqual([t.annualLeaveMinutes, t.unpaidMinutes], [120, 120]);
  // Unpaid leave never exceeds the working minutes of the day.
  const full = attendanceTotals(
    facts({
      effects: [
        effect('unpaid-leave', '2026-11-03', 540, 1080),
        effect('unpaid-leave', '2026-11-03', 540, 660),
      ],
    }),
  );
  assert.equal(full.unpaidMinutes, 480);
});

test('effects outside the month, off schedule or outside employment change nothing', () => {
  const t = attendanceTotals(
    facts({
      hiredOn: '2026-11-16',
      effects: [
        effect('unpaid-leave', '2026-10-30', 540, 1080), // other month
        effect('unpaid-leave', '2026-11-07', 540, 1080), // a Saturday
        effect('unpaid-leave', '2026-11-09', 540, 1080), // before the hire date
        effect('wfh', '2026-11-09', 540, 1080),
        effect('late-arrival', '2026-11-09', 540, 600),
      ],
    }),
  );
  assert.deepEqual([t.unpaidMinutes, t.wfhDays, t.lateCount, t.paidMinutes], [0, 0, 0, 5280]);
});

test('recompute: same input, same result, whatever the effect order (F-08)', () => {
  const effects = [
    effect('unpaid-leave', '2026-11-03', 540, 660),
    effect('annual-leave', '2026-11-05', 540, 1080),
    effect('late-arrival', '2026-11-04', 840, 870),
    effect('wfh', '2026-11-06', 540, 1080),
  ];
  const first = JSON.stringify(attendanceTotals(facts({ effects })));
  assert.equal(JSON.stringify(attendanceTotals(facts({ effects }))), first);
  assert.equal(JSON.stringify(attendanceTotals(facts({ effects: [...effects].reverse() }))), first);
});

test('monthDates lists every day of the month, February of a leap year included', () => {
  assert.equal(monthDates('2026-11').length, 30);
  assert.equal(monthDates('2028-02').length, 29);
  assert.equal(monthDates('2026-12')[30], '2026-12-31');
  assert.throws(() => monthDates('2026-13'));
  assert.throws(() => monthDates('2026-1'));
});

test('parsers: month is YYYY-MM, query has only month, reopen needs a reason', () => {
  assert.equal(parseAttendanceMonth('2026-11'), '2026-11');
  for (const bad of [
    '2026-13',
    '2026-00',
    '2026-1',
    '26-11',
    '2026-11-01',
    '1899-12',
    '2101-01',
    5,
  ])
    assert.throws(() => parseAttendanceMonth(bad), ProductInvalidRequest);
  assert.deepEqual(parseAttendanceQuery(employee, { month: '2026-11' }), {
    employeeId: employee,
    month: '2026-11',
  });
  assert.deepEqual(parseAttendanceQuery(employee, {}), { employeeId: employee, month: null });
  assert.throws(() => parseAttendanceQuery(employee, { other: 'x' }), ProductInvalidRequest);
  assert.throws(() => parseAttendanceQuery('not-a-uuid', {}), ProductInvalidRequest);
  assert.deepEqual(parsePeriodReopen('2026-11', { reason: ' Sửa lịch ' }), {
    month: '2026-11',
    reason: 'Sửa lịch',
  });
  assert.throws(() => parsePeriodReopen('2026-11', {}), ProductInvalidRequest);
  assert.throws(() => parsePeriodReopen('2026-11', { reason: '' }), ProductInvalidRequest);
  assert.throws(
    () => parsePeriodReopen('2026-11', { reason: 'x', extra: 1 }),
    ProductInvalidRequest,
  );
});
