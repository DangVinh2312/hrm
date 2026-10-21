// T9 part A without a database: seniority from the employment dates (acceptance R-03), the report
// query parsers (budgets, explicit cutoff) and the canonical attendance snapshot hash (ADR 0018
// bổ sung T9). Synthetic data only; no clock.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  buildSnapshot,
  parseSnapshot,
  snapshotHash,
  verifiedSnapshot,
} from '../dist/modules/attendance/helpers/attendance-snapshot.helper.js';
import { parseReportQuery } from '../dist/modules/report/report.validator.js';
import { seniorityOf } from '../dist/modules/report/seniority.helper.js';

test('seniority counts the hire day and the cutoff day: 2025-01-01 to 2026-12-31 is 2 years exactly (R-03)', () => {
  assert.deepEqual(seniorityOf('2025-01-01', '2026-12-31'), {
    years: 2,
    months: 0,
    days: 0,
    totalDays: 730,
  });
  assert.deepEqual(seniorityOf('2025-01-01', '2025-01-01'), {
    years: 0,
    months: 0,
    days: 1,
    totalDays: 1,
  });
  assert.deepEqual(seniorityOf('2025-01-15', '2026-03-14'), {
    years: 1,
    months: 2,
    days: 0,
    totalDays: 424,
  });
  assert.deepEqual(seniorityOf('2025-01-15', '2026-03-20'), {
    years: 1,
    months: 2,
    days: 6,
    totalDays: 430,
  });
  assert.equal(seniorityOf('2026-01-02', '2026-01-01'), null);
});

test('seniority month arithmetic clamps the day to the end of the month, leap years included', () => {
  // 2024-01-31 + 1 month = 2024-02-29 (clamped), the cutoff 2024-03-01 adds two days.
  assert.deepEqual(seniorityOf('2024-01-31', '2024-03-01'), {
    years: 0,
    months: 1,
    days: 2,
    totalDays: 31,
  });
  // 366 days of a leap year are one year and one day of 2024-03-01 → 2025-03-01 exclusive.
  assert.deepEqual(seniorityOf('2024-02-29', '2025-02-28'), {
    years: 1,
    months: 0,
    days: 1,
    totalDays: 366,
  });
  assert.deepEqual(seniorityOf('2024-02-29', '2028-02-29'), {
    years: 4,
    months: 0,
    days: 1,
    totalDays: 1462,
  });
});

const refused = (query: unknown, kind: Parameters<typeof parseReportQuery>[0] = 'attendance') =>
  assert.throws(() => parseReportQuery(kind, query), ProductInvalidRequest);

test('monthly reports need an explicit from..to of at most 12 months, pages bounded', () => {
  assert.deepEqual(parseReportQuery('wfh', { from: '2026-01', to: '2026-12' }), {
    kind: 'wfh',
    from: '2026-01',
    to: '2026-12',
    limit: 20,
    offset: 0,
  });
  assert.deepEqual(
    parseReportQuery('late-early', {
      from: '2026-11',
      to: '2026-11',
      limit: '100',
      offset: '10000',
    }),
    { kind: 'late-early', from: '2026-11', to: '2026-11', limit: 100, offset: 10000 },
  );
  // 12 months across a year boundary pass, 13 do not.
  assert.equal(
    parseReportQuery('attendance', { from: '2025-12', to: '2026-11' }).kind,
    'attendance',
  );
  refused({ from: '2025-11', to: '2026-11' });
  refused({ from: '2026-12', to: '2026-11' });
  refused({ from: '2026-11' });
  refused({ to: '2026-11' });
  refused({});
  refused({ from: '2026-13', to: '2026-13' });
  refused({ from: '2026-1', to: '2026-11' });
  refused({ from: '2026-11-01', to: '2026-11' });
  refused({ from: '2026-11', to: '2026-11', asOn: '2026-11-30' });
  refused({ from: '2026-11', to: '2026-11', employeeId: 'x' });
  refused({ from: '2026-11', to: '2026-11', limit: '101' });
  refused({ from: '2026-11', to: '2026-11', limit: '0' });
  refused({ from: '2026-11', to: '2026-11', offset: '10001' });
  refused({ from: ['2026-11', '2026-12'], to: '2026-12' });
  refused(undefined);
  refused(null);
});

test('leave and seniority need an explicit valid cutoff date', () => {
  for (const kind of ['leave', 'seniority'] as const) {
    assert.deepEqual(parseReportQuery(kind, { asOn: '2026-11-30', limit: '5' }), {
      kind,
      asOn: '2026-11-30',
      limit: 5,
      offset: 0,
    });
    refused({}, kind);
    refused({ asOn: '2026-02-30' }, kind);
    refused({ asOn: '2026-11' }, kind);
    refused({ asOn: '2026-11-30', from: '2026-11' }, kind);
    refused({ asOn: ['2026-11-30'] }, kind);
  }
  assert.throws(
    () => parseReportQuery('birthday' as never, { asOn: '2026-11-30' }),
    ProductInvalidRequest,
  );
});

const totals = (seed: number) => ({
  scheduledMinutes: 10080 + seed,
  paidHolidayMinutes: 0,
  unpaidMinutes: 120,
  annualLeaveMinutes: 480,
  paidMinutes: 9960,
  wfhDays: 2,
  lateCount: 1,
  lateMinutes: 60,
  earlyCount: 0,
  earlyMinutes: 0,
});

const employees = [
  { employeeId: '11111111-1111-4111-8111-111111111111', ...totals(0) },
  { employeeId: '22222222-2222-4222-8222-222222222222', ...totals(480) },
];

test('the canonical hash equals what every close hashed before (stored hashes stay valid)', () => {
  // The literal is the shape the T8 close wrote: month, calendarVersion, employees in this key order.
  const legacy = {
    month: '2026-11',
    calendarVersion: '3',
    employees: employees.map((e) => ({
      employeeId: e.employeeId,
      scheduledMinutes: e.scheduledMinutes,
      paidHolidayMinutes: e.paidHolidayMinutes,
      unpaidMinutes: e.unpaidMinutes,
      annualLeaveMinutes: e.annualLeaveMinutes,
      paidMinutes: e.paidMinutes,
      wfhDays: e.wfhDays,
      lateCount: e.lateCount,
      lateMinutes: e.lateMinutes,
      earlyCount: e.earlyCount,
      earlyMinutes: e.earlyMinutes,
    })),
  };
  const expected = createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
  assert.equal(snapshotHash(buildSnapshot('2026-11', '3', employees)), expected);
});

/** What jsonb hands back: object keys ordered by length, then bytes (not insertion order). */
const jsonbOrder = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => [key, jsonbOrder(inner)]),
  );
};

test('a snapshot read back from jsonb (other key order) verifies against its stored hash', () => {
  const snapshot = buildSnapshot('2026-11', '3', employees);
  const hash = snapshotHash(snapshot);
  const readBack = jsonbOrder(JSON.parse(JSON.stringify(snapshot)));
  // Hashing the text of the read-back value is exactly the shortcut that could not be re-checked.
  assert.notEqual(createHash('sha256').update(JSON.stringify(readBack)).digest('hex'), hash);
  assert.deepEqual(verifiedSnapshot('2026-11', readBack, hash), snapshot);
  assert.equal(snapshotHash(parseSnapshot(readBack)), hash);
});

test('a snapshot that was altered, moved to another month or malformed is refused', () => {
  const snapshot = buildSnapshot('2026-11', '3', employees);
  const hash = snapshotHash(snapshot);
  const stored = JSON.parse(JSON.stringify(snapshot)) as {
    month: string;
    calendarVersion: string;
    employees: Record<string, unknown>[];
  };
  const altered = structuredClone(stored);
  altered.employees[0]!.paidMinutes = 9961;
  assert.throws(() => verifiedSnapshot('2026-11', altered, hash), /does not match its hash/);
  assert.throws(() => verifiedSnapshot('2026-12', stored, hash), /does not match its hash/);
  assert.throws(() => verifiedSnapshot('2026-11', stored, 'f'.repeat(64)), /does not match/);
  const dropped = { ...stored, employees: stored.employees.slice(0, 1) };
  assert.throws(() => verifiedSnapshot('2026-11', dropped, hash), /does not match/);
  const text = structuredClone(stored);
  text.employees[0]!.paidMinutes = '9960';
  assert.throws(() => verifiedSnapshot('2026-11', text, hash), /Invalid attendance snapshot entry/);
  const fractional = structuredClone(stored);
  fractional.employees[0]!.wfhDays = 1.5;
  assert.throws(() => parseSnapshot(fractional), /Invalid attendance snapshot entry/);
  assert.throws(() => parseSnapshot({ month: '2026-11' }), /Invalid attendance snapshot/);
  assert.throws(() => parseSnapshot(null), /Invalid attendance snapshot/);
});
