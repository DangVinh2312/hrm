// T5 submit rules without a database: body validation, segments per kind (slots, late/early
// times, calendar, probation per day, date bounds), overlap and the initial state (design §6.2,
// §6.4, §9; acceptance A-10..A-20, B-01..B-21). Holidays and makeup days are fixtures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  WorkRequestRejected,
  conflicts,
  initialState,
  requestSegments,
} from '../dist/modules/work-request/helpers/work-request.helper.js';
import {
  parseIdempotencyKey,
  parseRequestList,
  parseSubmitRequest,
} from '../dist/modules/work-request/work-request.validator.js';
import type { RequestKind } from '../dist/modules/work-request/work-request.types.js';

const team = '3a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';

const invalid = (run: () => unknown) => assert.throws(run, ProductInvalidRequest);

const rejected = (run: () => unknown, reason: string) =>
  assert.throws(run, (error) => error instanceof WorkRequestRejected && error.reason === reason);

test('bodies per kind are parsed into one normalized shape; unknown keys are refused (B-08, B-09)', () => {
  assert.deepEqual(
    parseSubmitRequest({
      kind: 'late-arrival',
      date: '2026-11-03',
      expectedMinute: 600,
      reason: ' Đưa con đi học ',
    }),
    {
      kind: 'late-arrival',
      teamId: null,
      reason: 'Đưa con đi học',
      date: '2026-11-03',
      expectedMinute: 600,
    },
  );
  // Dates are sorted so that a retry with another order hashes the same.
  assert.deepEqual(
    parseSubmitRequest({
      kind: 'wfh',
      teamId: team,
      dates: ['2026-11-17', '2026-11-16'],
      reason: 'Làm tại nhà',
    }),
    { kind: 'wfh', teamId: team, reason: 'Làm tại nhà', dates: ['2026-11-16', '2026-11-17'] },
  );
  assert.deepEqual(
    parseSubmitRequest({
      kind: 'unpaid-leave',
      teamId: null,
      segments: [
        { date: '2026-12-01', startMinute: 540, endMinute: 1080 },
        { date: '2026-11-30', startMinute: 540, endMinute: 780 },
      ],
      reason: 'Việc riêng',
    }),
    {
      kind: 'unpaid-leave',
      teamId: null,
      reason: 'Việc riêng',
      segments: [
        { date: '2026-11-30', startMinute: 540, endMinute: 780 },
        { date: '2026-12-01', startMinute: 540, endMinute: 1080 },
      ],
    },
  );
  const late = { kind: 'late-arrival', date: '2026-11-03', expectedMinute: 600, reason: 'x' };
  // B-09: owner, state, stage and version are never taken from the payload.
  for (const extra of ['employeeId', 'ownerAccountId', 'state', 'stage', 'version'])
    invalid(() => parseSubmitRequest({ ...late, [extra]: team }));
  // B-08: reason and expected time are required for late/early.
  invalid(() => parseSubmitRequest({ kind: 'late-arrival', date: '2026-11-03', reason: 'x' }));
  invalid(() => parseSubmitRequest({ ...late, reason: '' }));
  invalid(() => parseSubmitRequest({ ...late, reason: 'a\nb' }));
  invalid(() => parseSubmitRequest({ ...late, reason: 'x'.repeat(1001) }));
  invalid(() => parseSubmitRequest({ ...late, expectedMinute: 600.5 }));
  invalid(() => parseSubmitRequest({ ...late, expectedMinute: '600' }));
  invalid(() => parseSubmitRequest({ ...late, date: '2026-02-30' }));
  invalid(() => parseSubmitRequest({ ...late, teamId: 'not-a-uuid' }));
  invalid(() => parseSubmitRequest({ ...late, kind: 'sick-leave' }));
  // Keys of another kind are unknown keys.
  invalid(() => parseSubmitRequest({ ...late, dates: ['2026-11-03'] }));
  invalid(() => parseSubmitRequest({ kind: 'wfh', dates: [], reason: 'x' }));
  invalid(() => parseSubmitRequest(null));
  invalid(() => parseSubmitRequest([late]));
});

test('multi-day requests: ≤ 31 working days, one entry per date, never across a year (D06, B-17)', () => {
  const day = (n: number) => `2026-03-${String(n).padStart(2, '0')}`;

  const wfh = (dates: readonly string[]) =>
    parseSubmitRequest({ kind: 'wfh', dates, reason: 'Làm tại nhà' });

  const month = wfh(Array.from({ length: 31 }, (_, i) => day(i + 1)));
  assert.equal('dates' in month && month.dates.length, 31);
  invalid(() => wfh([...Array.from({ length: 31 }, (_, i) => day(i + 1)), '2026-04-01']));
  invalid(() => wfh(['2026-11-16', '2026-11-16']));
  // B-17: crossing the year is a rule of the request, checked after authorization (helper),
  // so the body parses; across months is fine (B-18).
  assert.ok(wfh(['2026-12-31', '2027-01-04']));
  assert.ok(wfh(['2026-11-30', '2026-12-01']));

  const leave = (segments: unknown) =>
    parseSubmitRequest({ kind: 'annual-leave', segments, reason: 'Nghỉ phép' });

  invalid(() =>
    leave([
      { date: '2026-11-03', startMinute: 540, endMinute: 660 },
      { date: '2026-11-03', startMinute: 840, endMinute: 960 },
    ]),
  );
  invalid(() => leave([{ date: '2026-11-03', startMinute: 540 }]));
  invalid(() => leave([{ date: '2026-11-03', startMinute: 540, endMinute: 1441 }]));
  invalid(() => leave([{ date: '2026-11-03', startMinute: 540, endMinute: 660, minutes: 120 }]));
});

test('Idempotency-Key is a lowercase UUID v4; list pages are bounded', () => {
  assert.equal(
    parseIdempotencyKey('0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21'),
    '0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21',
  );
  for (const value of [
    undefined,
    '',
    '0B9C7A8E-2F3D-4C1B-9A8E-7D6C5B4A3F21',
    '0b9c7a8e-2f3d-1c1b-9a8e-7d6c5b4a3f21',
    '0b9c7a8e-2f3d-4c1b-7a8e-7d6c5b4a3f21',
    ['0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21'],
  ])
    invalid(() => parseIdempotencyKey(value));
  assert.deepEqual(parseRequestList({}), { limit: 20, offset: 0 });
  assert.deepEqual(parseRequestList({ limit: '1', offset: '1' }), { limit: 1, offset: 1 });
  invalid(() => parseRequestList({ limit: '101' }));
  invalid(() => parseRequestList({ state: 'approved' }));
});

// Fixture week: 2026-11-02 Mon … 2026-11-06 Fri, 2026-11-07 Sat, 2026-11-08 Sun (acceptance).
const none = { paidHolidays: new Set<string>(), makeupDays: new Set<string>() };

const facts = (
  overrides: Partial<{
    calendar: typeof none;
    probationUntil: string;
    employedFrom: string;
  }> = {},
) => ({
  earliest: '2026-11-03',
  latest: '2027-02-08',
  calendar: overrides.calendar ?? none,
  statusOn: (date: string) =>
    date < (overrides.employedFrom ?? '2000-01-01')
      ? undefined
      : date < (overrides.probationUntil ?? '2000-01-01')
        ? ('probation' as const)
        : ('official' as const),
});

const leave = (
  kind: 'annual-leave' | 'unpaid-leave',
  date: string,
  startMinute: number,
  endMinute: number,
) => ({ kind, teamId: null, reason: 'x', segments: [{ date, startMinute, endMinute }] }) as const;

const late = (kind: 'late-arrival' | 'early-departure', date: string, expectedMinute: number) =>
  ({ kind, teamId: null, reason: 'x', date, expectedMinute }) as const;

const wfh = (...dates: string[]) => ({ kind: 'wfh', teamId: null, reason: 'x', dates }) as const;

test('leave slots: only 09–11, 11–13, 14–16, 16–18, 09–13, 14–18, 09–18 (A-10..A-18)', () => {
  for (const [start, end, minutes] of [
    [540, 660, 120],
    [660, 780, 120],
    [840, 960, 120],
    [960, 1080, 120],
    [540, 780, 240],
    [840, 1080, 240],
    [540, 1080, 480],
  ] as const)
    for (const kind of ['annual-leave', 'unpaid-leave'] as const)
      assert.deepEqual(requestSegments(leave(kind, '2026-11-03', start, end), facts()), [
        { date: '2026-11-03', startMinute: start, endMinute: end, minutes },
      ]);
  // 10–12 has 120 minutes but is not a slot; 12–14 and 11–14 cross lunch.
  for (const [start, end] of [
    [600, 720],
    [720, 840],
    [660, 840],
    [780, 840],
    [540, 600],
  ])
    rejected(
      () => requestSegments(leave('annual-leave', '2026-11-03', start!, end!), facts()),
      'invalid_slot',
    );
});

test('calendar: weekends and paid holidays refuse every kind; a makeup day takes work-time kinds but no leave', () => {
  const holiday = { paidHolidays: new Set(['2026-11-04']), makeupDays: new Set(['2026-11-07']) };
  for (const request of [
    leave('unpaid-leave', '2026-11-08', 540, 660),
    late('late-arrival', '2026-11-08', 600),
    wfh('2026-11-08'),
    leave('annual-leave', '2026-11-04', 540, 660),
    late('early-departure', '2026-11-04', 1000),
    wfh('2026-11-03', '2026-11-04'),
  ])
    rejected(() => requestSegments(request, facts({ calendar: holiday })), 'non_working_day');
  // ADR 0018 T4 addendum: leave on a makeup day stays refused with its own reason (T7 decides).
  rejected(
    () =>
      requestSegments(leave('annual-leave', '2026-11-07', 540, 1080), facts({ calendar: holiday })),
    'makeup_day',
  );
  assert.equal(
    requestSegments(late('late-arrival', '2026-11-07', 600), facts({ calendar: holiday })).length,
    1,
  );
  assert.deepEqual(requestSegments(wfh('2026-11-07'), facts({ calendar: holiday })), [
    { date: '2026-11-07', startMinute: 540, endMinute: 1080, minutes: 480 },
  ]);
});

test('late arrival / early departure: expected time inside a shift, counted from its edge (B-21, §9)', () => {
  const at = (kind: 'late-arrival' | 'early-departure', minute: number) =>
    requestSegments(late(kind, '2026-11-03', minute), facts())[0];

  assert.deepEqual(at('late-arrival', 600), {
    date: '2026-11-03',
    startMinute: 540,
    endMinute: 600,
    minutes: 60,
  });
  assert.deepEqual(at('late-arrival', 541)?.minutes, 1);
  assert.deepEqual(at('late-arrival', 780)?.minutes, 240);
  assert.deepEqual(at('late-arrival', 900), {
    date: '2026-11-03',
    startMinute: 840,
    endMinute: 900,
    minutes: 60,
  });
  assert.deepEqual(at('late-arrival', 1079)?.minutes, 239);
  assert.deepEqual(at('early-departure', 1020), {
    date: '2026-11-03',
    startMinute: 1020,
    endMinute: 1080,
    minutes: 60,
  });
  assert.deepEqual(at('early-departure', 600), {
    date: '2026-11-03',
    startMinute: 600,
    endMinute: 780,
    minutes: 180,
  });
  assert.deepEqual(at('early-departure', 841)?.minutes, 239);
  for (const minute of [0, 540, 781, 800, 840, 1080, 1440])
    rejected(() => at('late-arrival', minute), 'invalid_time');
  for (const minute of [540, 780, 800, 840, 1080])
    rejected(() => at('early-departure', minute), 'invalid_time');
});

test('a request never crosses a calendar year, whatever its kind (D06, B-17)', () => {
  for (const request of [
    {
      kind: 'unpaid-leave',
      teamId: null,
      reason: 'x',
      segments: [
        { date: '2026-12-31', startMinute: 540, endMinute: 1080 },
        { date: '2027-01-04', startMinute: 540, endMinute: 1080 },
      ],
    } as const,
    wfh('2026-12-31', '2027-01-04'),
  ])
    rejected(() => requestSegments(request, facts()), 'crosses_year');
  assert.equal(requestSegments(wfh('2026-11-30', '2026-12-01'), facts()).length, 2);
});

test('business-date bounds are inclusive [today − 7, today + 90] (D06, B-15, B-16)', () => {
  assert.equal(requestSegments(late('late-arrival', '2026-11-03', 600), facts()).length, 1);
  rejected(
    () => requestSegments(late('late-arrival', '2026-11-02', 600), facts()),
    'date_out_of_range',
  );
  // 2027-02-08 is a Monday, 2027-02-09 a Tuesday.
  assert.equal(requestSegments(late('late-arrival', '2027-02-08', 600), facts()).length, 1);
  rejected(
    () => requestSegments(late('late-arrival', '2027-02-09', 600), facts()),
    'date_out_of_range',
  );
});

test('probation is checked on every day: only late/early/unpaid; annual and WFH refused (§4.5, B-02..B-06)', () => {
  const probation = facts({ probationUntil: '2026-11-16' });
  for (const request of [
    leave('annual-leave', '2026-11-10', 540, 1080),
    wfh('2026-11-10'),
    // B-06: one probation day in the request refuses the whole request.
    wfh('2026-11-13', '2026-11-16'),
  ])
    rejected(() => requestSegments(request, probation), 'kind_not_allowed_in_probation');
  for (const request of [
    late('late-arrival', '2026-11-10', 600),
    late('early-departure', '2026-11-10', 1020),
    leave('unpaid-leave', '2026-11-10', 540, 1080),
    leave('annual-leave', '2026-11-16', 540, 1080),
    wfh('2026-11-16', '2026-11-17'),
  ])
    assert.ok(requestSegments(request, probation).length >= 1);
  // A day outside employment (before hire, after the last working day) refuses any kind.
  rejected(
    () =>
      requestSegments(
        late('late-arrival', '2026-11-10', 600),
        facts({ employedFrom: '2026-11-11' }),
      ),
    'not_employed',
  );
});

test('overlap with pending/approved requests: times may not cross, except late/early on a WFH day; one late/early per kind per day (D05, D06, B-12, B-19, B-20)', () => {
  const booked = (kind: RequestKind, date: string, startMinute: number, endMinute: number) => ({
    kind,
    date,
    startMinute,
    endMinute,
  });

  const segments = (request: Parameters<typeof requestSegments>[0]) =>
    requestSegments(request, facts());

  const morning = [booked('annual-leave', '2026-11-03', 540, 780)];
  assert.equal(
    conflicts('unpaid-leave', segments(leave('unpaid-leave', '2026-11-03', 660, 780)), morning),
    true,
  );
  // Adjacent is not overlapping; another day is free.
  assert.equal(
    conflicts('unpaid-leave', segments(leave('unpaid-leave', '2026-11-03', 840, 960)), morning),
    false,
  );
  assert.equal(
    conflicts('unpaid-leave', segments(leave('unpaid-leave', '2026-11-04', 540, 780)), morning),
    false,
  );
  // Late at 10:00 overlaps a morning leave; late at 14:30 after a morning leave does not.
  assert.equal(
    conflicts('late-arrival', segments(late('late-arrival', '2026-11-03', 600)), morning),
    true,
  );
  assert.equal(
    conflicts('late-arrival', segments(late('late-arrival', '2026-11-03', 870)), morning),
    false,
  );
  // B-19: on a WFH day late/early are allowed, leave and another WFH are not (either order).
  const home = [booked('wfh', '2026-11-12', 540, 1080)];
  assert.equal(
    conflicts('late-arrival', segments(late('late-arrival', '2026-11-12', 600)), home),
    false,
  );
  assert.equal(
    conflicts('early-departure', segments(late('early-departure', '2026-11-12', 1020)), home),
    false,
  );
  assert.equal(
    conflicts('annual-leave', segments(leave('annual-leave', '2026-11-12', 540, 780)), home),
    true,
  );
  assert.equal(conflicts('wfh', segments(wfh('2026-11-11', '2026-11-12')), home), true);
  assert.equal(
    conflicts('wfh', segments(wfh('2026-11-12')), [booked('late-arrival', '2026-11-12', 540, 600)]),
    false,
  );
  // B-20: a second late arrival the same day conflicts even without crossing times.
  const lateMorning = [booked('late-arrival', '2026-11-13', 540, 600)];
  assert.equal(
    conflicts('late-arrival', segments(late('late-arrival', '2026-11-13', 900)), lateMorning),
    true,
  );
  assert.equal(
    conflicts(
      'early-departure',
      segments(late('early-departure', '2026-11-13', 1020)),
      lateMorning,
    ),
    false,
  );
});

test('initial state (§6.4): the COO approves their own request at submit (even as lead), the lead of the chosen team skips the lead step, else pending_lead', () => {
  for (const submitterLeadsTeam of [true, false])
    assert.deepEqual(initialState({ submitterIsCoo: true, submitterLeadsTeam }), {
      state: 'approved',
      systemDecision: 'coo_self_approved',
    });
  assert.deepEqual(initialState({ submitterIsCoo: false, submitterLeadsTeam: true }), {
    state: 'pending_final',
    systemDecision: 'lead_skipped_submitter_is_lead',
  });
  assert.deepEqual(initialState({ submitterIsCoo: false, submitterLeadsTeam: false }), {
    state: 'pending_lead',
    systemDecision: null,
  });
});
