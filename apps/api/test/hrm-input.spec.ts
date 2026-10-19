import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  parseAccountLink,
  parseEmployeeCreate,
  parseEmployeeList,
  parseIdentity,
  parseLeaveRate,
} from '../dist/employee/employee.validator.js';
import { parseTeamLead, parseTeamMember } from '../dist/team/team.validator.js';
import { hrDate, hrLikePattern, hrText } from '../dist/hr/hr-input.helper.js';
import {
  parseCalendarDay,
  parseCalendarYear,
} from '../dist/work-calendar/work-calendar.validator.js';

const id = '7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f';
const identity = { dateOfBirth: null, documentKind: null, documentNumber: null, taxCode: null };
const valid = {
  code: 'NV001',
  fullName: '  Nguyễn Văn A ',
  hiredOn: '2026-01-05',
  status: 'probation',
  annualLeaveMinutes: 5760,
  identity,
};

const invalid = (run: () => unknown, label: string) =>
  assert.throws(run, ProductInvalidRequest, label);

test('business dates are real calendar days in YYYY-MM-DD, without any timezone', () => {
  assert.equal(hrDate('2028-02-29'), '2028-02-29');
  assert.equal(hrDate('2000-02-29'), '2000-02-29');
  assert.equal(hrDate('1900-01-01'), '1900-01-01');
  assert.equal(hrDate('2100-12-31'), '2100-12-31');
  for (const value of [
    '2026-02-29',
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-1-5',
    '2026-01-5',
    ' 2026-01-05',
    '2026-01-05 ',
    '2026/01/05',
    '05-01-2026',
    '+02026-01-05',
    '2026-04-31',
    '2100-02-29',
    '2026-01-05T00:00:00Z',
    '1899-12-31',
    '2101-01-01',
    20260105,
    null,
  ])
    invalid(() => hrDate(value), String(value));
});

test('employee create body: allowlist, trimmed name, bounded leave minutes, paired document', () => {
  const parsed = parseEmployeeCreate(valid);
  assert.equal(parsed.fullName, 'Nguyễn Văn A');
  assert.equal(parsed.annualLeaveMinutes, 5760);
  for (const [label, body] of [
    ['unknown field', { ...valid, accountId: id }],
    ['role smuggled', { ...valid, role: 'hr.admin' }],
    ['missing identity', { ...valid, identity: undefined }],
    ['below 12 days', { ...valid, annualLeaveMinutes: 5759 }],
    ['fractional minutes', { ...valid, annualLeaveMinutes: 5760.5 }],
    ['minutes as text', { ...valid, annualLeaveMinutes: '5760' }],
    ['unknown status', { ...valid, status: 'terminated' }],
    ['code with space', { ...valid, code: 'NV 001' }],
    ['empty name', { ...valid, fullName: '   ' }],
    ['impossible hire date', { ...valid, hiredOn: '2026-02-30' }],
  ] as const)
    invalid(() => parseEmployeeCreate(body), label);
});

test('F2 identity: kind and number together, formats as the table CHECKs', () => {
  assert.deepEqual(
    parseIdentity({
      dateOfBirth: '1990-02-28',
      documentKind: 'cccd',
      documentNumber: '001090000001',
      taxCode: '0100000001-001',
    }),
    {
      dateOfBirth: '1990-02-28',
      documentKind: 'cccd',
      documentNumber: '001090000001',
      taxCode: '0100000001-001',
    },
  );
  for (const [label, body] of [
    ['kind without number', { ...identity, documentKind: 'cccd' }],
    ['number without kind', { ...identity, documentNumber: '001090000001' }],
    ['lowercase number', { ...identity, documentKind: 'passport', documentNumber: 'b1234567' }],
    ['unknown kind', { ...identity, documentKind: 'driver', documentNumber: 'B1234567' }],
    ['tax code letters', { ...identity, taxCode: 'MST0100000001' }],
    ['field missing', { dateOfBirth: null, documentKind: null, documentNumber: null }],
  ] as const)
    invalid(() => parseIdentity(body), label);
});

test('ids, versions and flags are exact; text refuses control characters', () => {
  invalid(
    () => parseLeaveRate('not-a-uuid', { effectiveFrom: '2026-01-01', annualMinutes: 5760 }),
    'id',
  );
  invalid(
    () => parseLeaveRate(id.toUpperCase(), { effectiveFrom: '2026-01-01', annualMinutes: 5760 }),
    'uppercase id',
  );
  invalid(() => parseAccountLink(id, { expectedVersion: 1, accountId: null }), 'number version');
  invalid(() => parseAccountLink(id, { expectedVersion: '01', accountId: null }), 'padded version');
  assert.equal(parseAccountLink(id, { expectedVersion: '3', accountId: null }).accountId, null);
  invalid(() => parseTeamMember(id, { employeeId: id, primary: 'true' }), 'string flag');
  assert.equal(parseTeamLead(id, { employeeId: null }).employeeId, null);
  invalid(() => hrText('a\u0000b', 10), 'NUL');
  invalid(() => hrText('a\nb', 10), 'newline');
  invalid(() => hrText('x'.repeat(11), 10), 'too long');
});

test('list query: bounded page, literal search', () => {
  assert.deepEqual(parseEmployeeList({}), { limit: 20, offset: 0 });
  assert.deepEqual(parseEmployeeList({ limit: '100', offset: '10000', search: 'An' }), {
    limit: 100,
    offset: 10000,
    search: 'An',
  });
  for (const query of [
    { limit: '0' },
    { limit: '101' },
    { offset: '10001' },
    { limit: '-1' },
    { sort: 'code' },
  ])
    invalid(() => parseEmployeeList(query), JSON.stringify(query));
  assert.equal(hrLikePattern('50%_a\\'), '%50\\%\\_a\\\\%');
});

test('calendar input: weekdays only, exact body, bounded year and holiday name', () => {
  assert.deepEqual(
    parseCalendarDay('2026-11-02', { expectedVersion: '3', holiday: '  Ngày lễ giả ' }),
    { expectedVersion: '3', date: '2026-11-02', holiday: 'Ngày lễ giả' },
  );
  assert.deepEqual(parseCalendarDay('2026-11-02', { expectedVersion: '3', holiday: null }), {
    expectedVersion: '3',
    date: '2026-11-02',
    holiday: null,
  });
  const body = { expectedVersion: '3', holiday: 'x' };
  invalid(() => parseCalendarDay('2026-11-07', body), 'Saturday');
  invalid(() => parseCalendarDay('2026-11-08', body), 'Sunday');
  invalid(() => parseCalendarDay('2026-02-30', body), 'no such day');
  invalid(() => parseCalendarDay('2026-11-02', { expectedVersion: '3' }), 'holiday missing');
  invalid(() => parseCalendarDay('2026-11-02', { ...body, kind: 'paid_holiday' }), 'extra key');
  invalid(() => parseCalendarDay('2026-11-02', { ...body, expectedVersion: 3 }), 'number version');
  invalid(() => parseCalendarDay('2026-11-02', { ...body, holiday: '' }), 'empty name');
  invalid(() => parseCalendarDay('2026-11-02', { ...body, holiday: 'x'.repeat(201) }), 'long');
  assert.equal(parseCalendarYear({ year: '2026' }), 2026);
  for (const query of [
    {},
    { year: '26' },
    { year: '1899' },
    { year: '2101' },
    { year: '2026', limit: '1' },
  ])
    invalid(() => parseCalendarYear(query), JSON.stringify(query));
});
