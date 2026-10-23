// T7 leave rules without a database: monthly accrual (D03, spec §9), the invariant over every
// month (§8), the balance view (D09) and the query parsers (acceptance E-01..E-16, B-05, B-07).
// Synthetic employees only; "today" is always an explicit input, never a clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  type AccrualFacts,
  accruedByMonth,
  firstMonthOver,
  leaveBalanceView,
  monthlyMinutes,
} from '../dist/modules/leave/helpers/leave-balance.helper.js';
import {
  parseLeaveAdjustment,
  parseLeaveBalanceQuery,
  parseLeaveReconciliationQuery,
} from '../dist/modules/leave/leave.validator.js';

const employee = '7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f';

/** Official from `from` (null: from the hire date), hired `hiredOn`, one rate unless given. */
function facts(over: Partial<AccrualFacts> = {}): AccrualFacts {
  return {
    year: 2026,
    hiredOn: '2025-01-06',
    terminatedOn: null,
    periods: [{ status: 'official', startsOn: '2025-01-06', endsOn: null }],
    rates: [{ effectiveFrom: '2025-01-06', annualMinutes: 5760 }],
    ...over,
  };
}

const at = (accrued: readonly number[], month: number) => accrued[month - 1];

test('the standard rate is 12 days = 5760 minutes: 480 a month, exactly 5760 at the end of the year (E-01)', () => {
  const accrued = accruedByMonth(facts());
  assert.equal(accrued.length, 12);
  assert.equal(at(accrued, 1), 480);
  assert.equal(at(accrued, 3), 1440);
  assert.equal(at(accrued, 12), 5760);
});

test('an agreed rate above 12 days accrues floor(R*k/12) without drift (E-02, E-14)', () => {
  const accrued = accruedByMonth(
    facts({ rates: [{ effectiveFrom: '2025-01-06', annualMinutes: 6720 }] }),
  );
  assert.equal(at(accrued, 3), 1680);
  assert.equal(at(accrued, 12), 6720);
  // 5761 does not divide by 12: the cumulative floor still ends on the exact rate.
  const odd = accruedByMonth(
    facts({ rates: [{ effectiveFrom: '2025-01-06', annualMinutes: 5761 }] }),
  );
  assert.equal(at(odd, 1), 480);
  assert.equal(at(odd, 12), 5761);
  for (let month = 2; month <= 12; month++)
    assert.ok((at(odd, month) ?? 0) >= (at(odd, month - 1) ?? 0), `monotonic at ${month}`);
});

test('hired official mid-year: months count when official on the 15th (E-11)', () => {
  const from = (date: string) =>
    accruedByMonth(
      facts({
        hiredOn: date,
        periods: [{ status: 'official', startsOn: date, endsOn: null }],
        rates: [{ effectiveFrom: date, annualMinutes: 5760 }],
      }),
    );

  assert.equal(at(from('2026-07-01'), 12), 2880);
  assert.equal(at(from('2026-07-15'), 12), 2880);
  assert.equal(at(from('2026-07-16'), 12), 2400);
  // Months before the hire date are not accrued, so a January balance of a July hire is 0.
  assert.equal(at(from('2026-07-01'), 6), 0);
  assert.equal(at(from('2026-07-01'), 7), 480);
});

test('probation accrues nothing and is not paid back after the official date (B-05, B-07, E-11)', () => {
  const accrued = accruedByMonth(
    facts({
      hiredOn: '2026-07-01',
      periods: [
        { status: 'probation', startsOn: '2026-07-01', endsOn: '2026-09-01' },
        { status: 'official', startsOn: '2026-09-01', endsOn: null },
      ],
      rates: [{ effectiveFrom: '2026-07-01', annualMinutes: 5760 }],
    }),
  );
  assert.equal(at(accrued, 8), 0);
  assert.equal(at(accrued, 9), 480);
  assert.equal(at(accrued, 12), 1920);
  // Official from 2026-11-16 (P1 of the acceptance fixture): November is on probation on the 15th.
  const p1 = accruedByMonth(
    facts({
      hiredOn: '2026-01-05',
      periods: [
        { status: 'probation', startsOn: '2026-01-05', endsOn: '2026-11-16' },
        { status: 'official', startsOn: '2026-11-16', endsOn: null },
      ],
      rates: [{ effectiveFrom: '2026-01-05', annualMinutes: 5760 }],
    }),
  );
  assert.equal(at(p1, 11), 0);
  assert.equal(at(p1, 12), 480);
});

test('leaving: the last working day on or after the 15th still counts the month (D03)', () => {
  assert.equal(at(accruedByMonth(facts({ terminatedOn: '2026-06-15' })), 12), 2880);
  assert.equal(at(accruedByMonth(facts({ terminatedOn: '2026-06-14' })), 12), 2400);
  assert.equal(at(accruedByMonth(facts({ terminatedOn: '2025-12-31' })), 12), 0);
});

test('a change of rate during the year applies per month on the rate of that 15th (spec §9, [P])', () => {
  const accrued = accruedByMonth(
    facts({
      rates: [
        { effectiveFrom: '2025-01-06', annualMinutes: 5760 },
        { effectiveFrom: '2026-07-15', annualMinutes: 6720 },
      ],
    }),
  );
  // Jan..Jun: 480 each; July onwards each month adds floor(6720*k/12) - floor(6720*(k-1)/12).
  assert.equal(at(accrued, 6), 2880);
  assert.equal(at(accrued, 7), 2880 + (Math.floor((6720 * 7) / 12) - Math.floor((6720 * 6) / 12)));
  assert.equal(at(accrued, 12), 2880 + (6720 - Math.floor((6720 * 6) / 12)));
  // The rate of 2026-07-16 is too late for the 15th: July still accrues on the old rate.
  const late = accruedByMonth(
    facts({
      rates: [
        { effectiveFrom: '2025-01-06', annualMinutes: 5760 },
        { effectiveFrom: '2026-07-16', annualMinutes: 6720 },
      ],
    }),
  );
  assert.equal(at(late, 7), 3360);
});

test('no carry-over and no seniority: a new year starts from its own accrual (E-15, E-16)', () => {
  const six = facts({ hiredOn: '2020-01-06' });
  assert.equal(at(accruedByMonth({ ...six, year: 2026 }), 1), 480);
  assert.equal(at(accruedByMonth({ ...six, year: 2027 }), 1), 480);
  assert.equal(at(accruedByMonth({ ...six, year: 2027 }), 12), 5760);
});

test('a rate missing on a counted 15th accrues nothing instead of guessing a standard one', () => {
  const accrued = accruedByMonth(facts({ rates: [] }));
  assert.equal(at(accrued, 12), 0);
});

test('firstMonthOver checks the cumulative committed minutes against every month (spec §8, E-08, E-13)', () => {
  const accrued = accruedByMonth(facts());
  const none = monthlyMinutes([], 2026);
  assert.equal(firstMonthOver(accrued, none), undefined);
  // 5 days in March against 1440 accrued to the end of March (E-13).
  assert.equal(
    firstMonthOver(accrued, monthlyMinutes([{ date: '2026-03-02', minutes: 2400 }], 2026)),
    3,
  );
  // Exactly the accrued minutes is allowed; one more minute is not.
  assert.equal(
    firstMonthOver(accrued, monthlyMinutes([{ date: '2026-03-31', minutes: 1440 }], 2026)),
    undefined,
  );
  assert.equal(
    firstMonthOver(accrued, monthlyMinutes([{ date: '2026-03-31', minutes: 1441 }], 2026)),
    3,
  );
  // An early month can be full while the cumulative rule on later months still holds.
  assert.equal(
    firstMonthOver(
      accrued,
      monthlyMinutes(
        [
          { date: '2026-01-05', minutes: 480 },
          { date: '2026-02-03', minutes: 480 },
        ],
        2026,
      ),
    ),
    undefined,
  );
  // Days taken in January leave less for March: the cumulative sum, not each month alone.
  assert.equal(
    firstMonthOver(
      accrued,
      monthlyMinutes(
        [
          { date: '2026-01-05', minutes: 480 },
          { date: '2026-01-06', minutes: 480 },
        ],
        2026,
      ),
    ),
    1,
  );
});

test('a negative entitlement blocks taking leave but not months with nothing committed', () => {
  const accrued = [-960, -480, 0, 480, 960, 1440, 1920, 2400, 2880, 3360, 3840, 4320];
  assert.equal(firstMonthOver(accrued, monthlyMinutes([], 2026)), undefined);
  assert.equal(
    firstMonthOver(accrued, monthlyMinutes([{ date: '2026-04-10', minutes: 480 }], 2026)),
    undefined,
  );
  assert.equal(
    firstMonthOver(accrued, monthlyMinutes([{ date: '2026-04-10', minutes: 481 }], 2026)),
    4,
  );
  assert.equal(
    firstMonthOver(accrued, monthlyMinutes([{ date: '2026-02-10', minutes: 1 }], 2026)),
    2,
  );
});

test('the balance view separates entitled, used to the report date, approved future, pending (D09, E-05, E-09)', () => {
  const view = leaveBalanceView({
    employeeId: employee,
    asOn: '2026-11-30',
    facts: facts(),
    adjustments: [],
    approved: [
      { date: '2026-11-04', minutes: 240 },
      { date: '2026-11-30', minutes: 480 },
      { date: '2026-12-15', minutes: 480 },
    ],
    pending: [{ date: '2026-12-16', minutes: 240 }],
  });
  assert.deepEqual(view, {
    employeeId: employee,
    year: 2026,
    asOn: '2026-11-30',
    annualMinutes: 5760,
    entitledMinutes: 5280,
    usedMinutes: 720,
    futureApprovedMinutes: 480,
    pendingMinutes: 240,
    availableMinutes: 5280 - 720 - 480 - 240,
  });
});

test('the balance view shows no annual rate while the report date is not official (ADR 0039)', () => {
  const view = (asOn: string, over: Partial<AccrualFacts>) =>
    leaveBalanceView({
      employeeId: employee,
      asOn,
      facts: facts({
        hiredOn: '2026-01-05',
        periods: [
          { status: 'probation', startsOn: '2026-01-05', endsOn: '2026-09-01' },
          { status: 'official', startsOn: '2026-09-01', endsOn: null },
        ],
        rates: [{ effectiveFrom: '2026-09-01', annualMinutes: 5760 }],
        ...over,
      }),
      adjustments: [],
      approved: [],
      pending: [],
    });

  // Probation on the date: no rate, no accrual.
  assert.equal(view('2026-08-31', {}).annualMinutes, null);
  assert.equal(view('2026-08-31', {}).entitledMinutes, 0);
  // Official on the date: the rate in force.
  assert.equal(view('2026-09-01', {}).annualMinutes, 5760);
  // An old rate row written at hire (before ADR 0039) is hidden while still on probation.
  const legacy = { rates: [{ effectiveFrom: '2026-01-05', annualMinutes: 5760 }] };
  assert.equal(view('2026-03-31', legacy).annualMinutes, null);
  assert.equal(view('2026-09-30', legacy).annualMinutes, 5760);
  // Official with no rate at all: still null (never guessed).
  assert.equal(view('2026-09-30', { rates: [] }).annualMinutes, null);
});

test('available never goes below zero and an entry after the report month stays out of "entitled"', () => {
  const view = leaveBalanceView({
    employeeId: employee,
    asOn: '2026-02-10',
    facts: facts(),
    adjustments: [
      { date: '2026-01-02', minutes: -2000 },
      { date: '2026-05-02', minutes: 4000 },
    ],
    approved: [],
    pending: [{ date: '2026-02-12', minutes: 480 }],
  });
  assert.equal(view.entitledMinutes, 960 - 2000);
  assert.equal(view.availableMinutes, 0);
});

test('the report year is the year of the report date; a reversal nets a debit out', () => {
  const view = leaveBalanceView({
    employeeId: employee,
    asOn: '2027-01-20',
    facts: { ...facts(), year: 2027 },
    adjustments: [],
    approved: [
      { date: '2027-01-12', minutes: 480 },
      { date: '2027-01-12', minutes: -480 },
    ],
    pending: [],
  });
  assert.equal(view.year, 2027);
  assert.equal(view.usedMinutes, 0);
  assert.equal(view.entitledMinutes, 480);
  assert.equal(view.availableMinutes, 480);
});

test('the query parsers accept only the documented shapes', () => {
  const id = employee;
  assert.deepEqual(parseLeaveBalanceQuery(id, {}), { employeeId: id, asOn: null });
  assert.deepEqual(parseLeaveBalanceQuery(id, { date: '2026-11-30' }), {
    employeeId: id,
    asOn: '2026-11-30',
  });
  for (const bad of [
    { date: '2026-02-30' },
    { date: '30/11/2026' },
    { date: ['2026-11-30'] },
    { year: '2026' },
    { date: '1899-12-31' },
  ])
    assert.throws(() => parseLeaveBalanceQuery(id, bad), ProductInvalidRequest);
  assert.throws(() => parseLeaveBalanceQuery('not-a-uuid', {}), ProductInvalidRequest);
  assert.deepEqual(parseLeaveReconciliationQuery({}), { year: null, limit: 20, offset: 0 });
  assert.deepEqual(parseLeaveReconciliationQuery({ year: '2026', limit: '5', offset: '10' }), {
    year: 2026,
    limit: 5,
    offset: 10,
  });
  for (const bad of [
    { year: '26' },
    { year: '2101' },
    { year: '1899' },
    { limit: '101' },
    { x: '1' },
  ])
    assert.throws(() => parseLeaveReconciliationQuery(bad), ProductInvalidRequest);
});

test('leave adjustment body: signed minutes, a date and a mandatory reference; nothing else (D14, E-17)', () => {
  const key = '0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21';
  const ok = { minutes: -480, effectiveOn: '2026-03-10', reference: ' QĐ-12/2026 ' };
  assert.deepEqual(parseLeaveAdjustment(ok, employee, key), {
    employeeId: employee,
    idempotencyKey: key,
    minutes: -480,
    effectiveOn: '2026-03-10',
    reference: 'QĐ-12/2026',
  });
  assert.equal(parseLeaveAdjustment({ ...ok, minutes: 175680 }, employee, key).minutes, 175680);
  for (const bad of [
    { ...ok, minutes: 0 },
    { ...ok, minutes: 175681 },
    { ...ok, minutes: -175681 },
    { ...ok, minutes: 1.5 },
    { ...ok, minutes: '480' },
    { ...ok, effectiveOn: '2026-02-30' },
    { ...ok, effectiveOn: '10/03/2026' },
    { ...ok, reference: '' },
    { ...ok, reference: '   ' },
    { ...ok, reference: 'x'.repeat(201) },
    { minutes: 480, effectiveOn: '2026-03-10' },
    { ...ok, kind: 'opening' },
    { ...ok, employeeId: employee },
    null,
    [],
  ])
    assert.throws(() => parseLeaveAdjustment(bad, employee, key), ProductInvalidRequest);
  assert.throws(() => parseLeaveAdjustment(ok, 'nope', key), ProductInvalidRequest);
  assert.throws(() => parseLeaveAdjustment(ok, employee, undefined), ProductInvalidRequest);
});
