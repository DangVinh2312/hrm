import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  parseAccountLink,
  parseEmployeeCreate,
  parseEmployeeList,
  parseEmployeeUpdate,
  parseIdentity,
  parseLeaveRate,
  parsePhone,
  parseWorkEmail,
} from '../dist/modules/employee/employee.validator.js';
import { parseTeamLead, parseTeamMember } from '../dist/modules/team/team.validator.js';
import {
  inputDate,
  inputLikePattern,
  inputText,
} from '../dist/infrastructure/helpers/input-validation.helper.js';
import {
  parseCalendarDay,
  parseCalendarHolidays,
  parseCalendarYear,
} from '../dist/modules/work-calendar/work-calendar.validator.js';

const id = '7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f';
const identity = {
  dateOfBirth: null,
  documentKind: null,
  documentNumber: null,
  taxCode: null,
  gender: null,
  phone: null,
  workEmail: null,
};
const valid = {
  code: 'NV001',
  fullName: '  Nguyễn Văn A ',
  hiredOn: '2026-01-05',
  status: 'probation',
  identity,
  position: null,
  classification: null,
};
const official = { ...valid, status: 'official' };

const invalid = (run: () => unknown, label: string) =>
  assert.throws(run, ProductInvalidRequest, label);

test('business dates are real calendar days in YYYY-MM-DD, without any timezone', () => {
  assert.equal(inputDate('2028-02-29'), '2028-02-29');
  assert.equal(inputDate('2000-02-29'), '2000-02-29');
  assert.equal(inputDate('1900-01-01'), '1900-01-01');
  assert.equal(inputDate('2100-12-31'), '2100-12-31');
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
    invalid(() => inputDate(value), String(value));
});

test('employee create body: allowlist, trimmed name, bounded leave minutes, paired document', () => {
  const parsed = parseEmployeeCreate(valid);
  assert.equal(parsed.fullName, 'Nguyễn Văn A');
  // Probation has no leave rate (ADR 0039): the field is absent in the parsed input.
  assert.equal(parsed.annualLeaveMinutes, null);
  // Official without the field takes the `hr.annualLeaveDefaultMinutes` setting in force when it is
  // written (ADR 0045): the parser only marks it; a given value is kept.
  assert.equal(parseEmployeeCreate(official).annualLeaveMinutes, 'default');
  assert.equal(
    parseEmployeeCreate({ ...official, annualLeaveMinutes: 7200 }).annualLeaveMinutes,
    7200,
  );
  // The DB CHECK bounds: 175680 is the last valid value, one more is refused.
  assert.equal(
    parseEmployeeCreate({ ...official, annualLeaveMinutes: 175_680 }).annualLeaveMinutes,
    175_680,
  );
  invalid(() => parseEmployeeCreate({ ...official, annualLeaveMinutes: 175_681 }), 'above max');
  for (const [label, body] of [
    ['probation with a rate', { ...valid, annualLeaveMinutes: 5760 }],
    ['probation with a null rate', { ...valid, annualLeaveMinutes: null }],
    ['official with a null rate', { ...official, annualLeaveMinutes: null }],
    ['unknown field', { ...valid, accountId: id }],
    ['role smuggled', { ...valid, role: 'hr.admin' }],
    ['missing identity', { ...valid, identity: undefined }],
    ['missing position', { ...valid, position: undefined }],
    ['missing classification', { ...valid, classification: undefined }],
    ['unknown classification', { ...valid, classification: 'intern' }],
    ['empty position', { ...valid, position: '  ' }],
    ['position with tab', { ...valid, position: 'Kỹ\tsư' }],
    ['position too long', { ...valid, position: 'x'.repeat(101) }],
    ['below 12 days', { ...official, annualLeaveMinutes: 5759 }],
    ['fractional minutes', { ...official, annualLeaveMinutes: 5760.5 }],
    ['minutes as text', { ...official, annualLeaveMinutes: '5760' }],
    ['unknown status', { ...valid, status: 'terminated' }],
    ['code with space', { ...valid, code: 'NV 001' }],
    ['empty name', { ...valid, fullName: '   ' }],
    ['impossible hire date', { ...valid, hiredOn: '2026-02-30' }],
  ] as const)
    invalid(() => parseEmployeeCreate(body), label);
});

test('F1 extras: trimmed position up to 100 code points, closed classification, null clears', () => {
  const parsed = parseEmployeeCreate({
    ...valid,
    position: '  Kỹ sư phần mềm ',
    classification: 'contractor',
  });
  assert.equal(parsed.position, 'Kỹ sư phần mềm');
  assert.equal(parsed.classification, 'contractor');
  assert.equal(parseEmployeeCreate({ ...valid, position: 'x'.repeat(100) }).position?.length, 100);
  assert.equal(parseEmployeeCreate({ ...valid, position: '😀'.repeat(100) }).position?.length, 200);
  const update = {
    expectedVersion: '2',
    code: 'NV001',
    fullName: 'A',
    position: null,
    classification: 'fullTime',
  };
  assert.deepEqual(parseEmployeeUpdate(id, update), { employeeId: id, ...update });
  invalid(() => parseEmployeeUpdate(id, { ...update, position: undefined }), 'position missing');
  invalid(() => parseEmployeeUpdate(id, { ...update, classification: 'x' }), 'classification');
  invalid(() => parseEmployeeUpdate(id, { ...update, role: 'hr.admin' }), 'extra key');
});

test('phone: separators and +84 normalize to national digits; everything else is refused', () => {
  for (const [input, expected] of [
    ['0901234567', '0901234567'],
    ['090 123 4567', '0901234567'],
    ['(090) 123-4567', '0901234567'],
    ['090.123.4567', '0901234567'],
    ['+84 90 123 4567', '0901234567'],
    ['+84901234567', '0901234567'],
    ['02812345678', '02812345678'],
  ] as const)
    assert.equal(parsePhone(input), expected, input);
  for (const value of [
    '',
    '901234567',
    '84901234567',
    '+85 901234567',
    '+840901234567',
    '0001234567',
    '090123456',
    '090123456789',
    '090123456a',
    '090 123 4567\n',
    '٠٩٠١٢٣٤٥٦٧',
    '0'.repeat(33),
    null,
    901234567,
  ])
    invalid(() => parsePhone(value), String(value));
});

test('work email: trimmed and lowercased; ASCII dot-atom subset, 254 characters at most', () => {
  assert.equal(parseWorkEmail('  Nguyen.Van.A+hr@Example.COM '), 'nguyen.van.a+hr@example.com');
  assert.equal(parseWorkEmail('a@b.co'), 'a@b.co');
  const domain = `${'d'.repeat(63)}.${'d'.repeat(63)}.${'d'.repeat(63)}.com`;
  const longest = `${'a'.repeat(254 - domain.length - 1)}@${domain}`;
  assert.equal(longest.length, 254);
  assert.equal(parseWorkEmail(longest), longest);
  for (const value of [
    '',
    'a@b',
    '@example.com',
    'a@@example.com',
    'a b@example.com',
    '.a@example.com',
    'a.@example.com',
    'a..b@example.com',
    'Tên <a@example.com>',
    '"a"@example.com',
    'a@[127.0.0.1]',
    'a@example.c',
    'a@-example.com',
    'á@example.com',
    'a@exa\nmple.com',
    `x${longest}`,
    null,
    1,
  ])
    invalid(() => parseWorkEmail(value), String(value));
});

test('F2 identity: kind and number together, formats as the table CHECKs', () => {
  assert.deepEqual(
    parseIdentity({
      dateOfBirth: '1990-02-28',
      documentKind: 'cccd',
      documentNumber: '001090000001',
      taxCode: '0100000001-001',
      gender: 'female',
      phone: '+84 90 123 4567',
      workEmail: ' A@Example.com ',
    }),
    {
      dateOfBirth: '1990-02-28',
      documentKind: 'cccd',
      documentNumber: '001090000001',
      taxCode: '0100000001-001',
      gender: 'female',
      phone: '0901234567',
      workEmail: 'a@example.com',
    },
  );
  for (const [label, body] of [
    ['kind without number', { ...identity, documentKind: 'cccd' }],
    ['number without kind', { ...identity, documentNumber: '001090000001' }],
    ['lowercase number', { ...identity, documentKind: 'passport', documentNumber: 'b1234567' }],
    ['unknown kind', { ...identity, documentKind: 'driver', documentNumber: 'B1234567' }],
    ['tax code letters', { ...identity, taxCode: 'MST0100000001' }],
    ['field missing', { dateOfBirth: null, documentKind: null, documentNumber: null }],
    [
      'new fields missing',
      { dateOfBirth: null, documentKind: null, documentNumber: null, taxCode: null },
    ],
    ['unknown gender', { ...identity, gender: 'Nam' }],
    ['bad phone', { ...identity, phone: '12345' }],
    ['bad email', { ...identity, workEmail: 'not-an-email' }],
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
  invalid(() => inputText('a\u0000b', 10), 'NUL');
  invalid(() => inputText('a\nb', 10), 'newline');
  invalid(() => inputText('x'.repeat(11), 10), 'too long');
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
  assert.equal(inputLikePattern('50%_a\\'), '%50\\%\\_a\\\\%');
});

test('calendar input: holiday on weekdays, makeup on weekends, exact body, bounded year and holiday name', () => {
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
  // Saturday/Sunday take `makeup` (a full workday or back to the weekly rest), never a holiday.
  for (const [date, makeup] of [
    ['2026-11-07', true],
    ['2026-11-08', false],
  ] as const)
    assert.deepEqual(parseCalendarDay(date, { expectedVersion: '3', makeup }), {
      expectedVersion: '3',
      date,
      makeup,
    });
  invalid(() => parseCalendarDay('2026-11-02', { expectedVersion: '3', makeup: true }), 'weekday');
  invalid(() => parseCalendarDay('2026-11-07', { expectedVersion: '3' }), 'makeup missing');
  invalid(() => parseCalendarDay('2026-11-07', { expectedVersion: '3', makeup: 'true' }), 'text');
  invalid(() => parseCalendarDay('2026-11-07', { expectedVersion: '3', makeup: null }), 'null');
  invalid(
    () => parseCalendarDay('2026-11-07', { expectedVersion: '3', makeup: true, holiday: 'x' }),
    'both keys',
  );
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

test('calendar holiday range: from <= to, at most 31 calendar days, weekdays only, exact body', () => {
  const body = {
    expectedVersion: '3',
    from: '2026-09-01',
    to: '2026-09-03',
    name: ' Ngày lễ giả ',
  };
  assert.deepEqual(parseCalendarHolidays(body), {
    expectedVersion: '3',
    from: '2026-09-01',
    to: '2026-09-03',
    name: 'Ngày lễ giả',
  });
  // One day, 31 calendar days across two years, and a range that starts/ends on a weekend.
  assert.ok(parseCalendarHolidays({ ...body, to: '2026-09-01' }));
  assert.ok(parseCalendarHolidays({ ...body, from: '2026-12-20', to: '2027-01-19' }));
  assert.ok(parseCalendarHolidays({ ...body, from: '2026-11-07', to: '2026-11-10' }));
  invalid(
    () => parseCalendarHolidays({ ...body, from: '2026-12-20', to: '2027-01-20' }),
    '32 days',
  );
  invalid(
    () => parseCalendarHolidays({ ...body, from: '2026-09-04', to: '2026-09-03' }),
    'reversed',
  );
  invalid(
    () => parseCalendarHolidays({ ...body, from: '2026-11-07', to: '2026-11-08' }),
    'weekend only',
  );
  invalid(() => parseCalendarHolidays({ ...body, from: '2026-02-30' }), 'no such day');
  invalid(() => parseCalendarHolidays({ ...body, to: '2101-01-01' }), 'out of range');
  invalid(() => parseCalendarHolidays({ ...body, name: '' }), 'empty name');
  invalid(() => parseCalendarHolidays({ ...body, name: null }), 'null name');
  invalid(() => parseCalendarHolidays({ ...body, name: 'x'.repeat(201) }), 'long name');
  invalid(() => parseCalendarHolidays({ ...body, expectedVersion: 3 }), 'number version');
  invalid(() => parseCalendarHolidays({ ...body, extra: 1 }), 'extra key');
  invalid(
    () => parseCalendarHolidays({ expectedVersion: '3', from: body.from, name: 'x' }),
    'no to',
  );
  invalid(() => parseCalendarHolidays('x'), 'not an object');
});
