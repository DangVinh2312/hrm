// T9 on PostgreSQL (design §5.2 report.*, §6.3, §9, §11; acceptance R-01..R-09, B-05, B-07, F-12): the six reports (birthday: 29/02 shown
// as 28/02 in a common year, day and month only) and their XLSX export with datasets of known
// totals, scope applied before count and page, the stored
// snapshot of a closed month, a live computation for an open one, the numbers equal to the leave
// balance and attendance sheet endpoints, the hash re-verified from the jsonb, and reads racing
// writes. Synthetic people only. Every month and cutoff is a fixed PAST date (2026-03..2026-07)
// or a date relative to the DB clock, so no result depends on the day the suite runs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  parseSnapshot,
  snapshotHash,
} from '../dist/modules/attendance/helpers/attendance-snapshot.helper.js';
import type { AttendanceTotals } from '../dist/modules/attendance/helpers/attendance-calculation.helper.js';
import ExcelJS from 'exceljs';
import { ProductAccessDenied } from '../dist/authorization/services/product-authority.service.js';
import { ExcelExportService } from '../dist/modules/report/services/excel-export.service.js';
import { ReportService } from '../dist/modules/report/services/report.service.js';
import type {
  ReportExportQuery,
  ReportKind,
  ReportQueryOf,
  ReportResult,
} from '../dist/modules/report/report.types.js';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';
import { attendanceFixture } from './hrm-attendance.helper.ts';

let stack: ModuleStack;
let f: ReturnType<typeof attendanceFixture>;
const codes: Record<string, string> = {};

const MARCH = '2026-03';
const APRIL = '2026-04';

const utf8 = (value: string) => Buffer.from(value, 'utf8');

type Who = string;

interface ReportInput {
  readonly kind: ReportKind;
  readonly from?: string;
  readonly to?: string;
  readonly asOn?: string;
  readonly limit?: number;
  readonly offset?: number;
}

async function report<K extends ReportKind>(
  as: Who,
  query: ReportInput & { readonly kind: K },
): Promise<Extract<ReportResult, { kind: K }>> {
  const secret = as === 'root' ? await stack.root() : f.p(as).secret;
  const result = await stack.reports.query(secret, {
    limit: 100,
    offset: 0,
    ...query,
  } as ReportQueryOf<K>);
  return result as Extract<ReportResult, { kind: K }>;
}

const months = <K extends 'attendance' | 'late-early' | 'wfh' | 'birthday'>(
  kind: K,
  from: string,
  to: string,
) => ({ kind, from, to }) as const;

const cutoff = <K extends 'leave' | 'seniority'>(kind: K, asOn: string) =>
  ({ kind, asOn }) as const;

const byCode = <R extends { employeeCode: string; month?: string }>(
  rows: readonly R[],
  who: string,
) => rows.filter((row) => row.employeeCode === codes[who]);

/** A debit row as an approval leaves it (the segment is the fixture request's own). */
const debit = (request: { id: string }, name: string, date: string, minutes: number) =>
  stack.migration.query(
    `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, source_request_id, source_work_date)
     VALUES (gen_random_uuid(), $1, 'debit', CAST($2 AS date), $3, $4, CAST($2 AS date))`,
    [f.employeeOf(name), date, minutes, request.id],
  );

const sheetTotals = (row: AttendanceTotals) => ({
  scheduledMinutes: row.scheduledMinutes,
  paidHolidayMinutes: row.paidHolidayMinutes,
  unpaidMinutes: row.unpaidMinutes,
  annualLeaveMinutes: row.annualLeaveMinutes,
  paidMinutes: row.paidMinutes,
  wfhDays: row.wfhDays,
  lateCount: row.lateCount,
  lateMinutes: row.lateMinutes,
  earlyCount: row.earlyCount,
  earlyMinutes: row.earlyMinutes,
  adjustmentMinutes: row.adjustmentMinutes,
});

before(async () => {
  // Production composition: reports read the same approved requests the approval effects write.
  stack = await startModuleStack();
  f = attendanceFixture(stack);
  await f.setup();
  for (const name of ['E1', 'E2', 'E3']) await f.hire(name, ['hr.employee']);
  await f.hire('S2', ['hr.employee'], { hiredOn: '2025-01-01' });
  await f.hire('GONE', ['hr.employee'], { hiredOn: '2025-01-06' });
  await stack.migration.query(
    `UPDATE employee SET terminated_on = DATE '2025-12-31' WHERE id = $1`,
    [f.employeeOf('GONE')],
  );
  await f.hire('NEW', ['hr.employee'], { hiredOn: '2026-03-16' });
  for (const name of ['L1', 'C', 'H', 'E1', 'E2', 'E3', 'S2', 'GONE', 'NEW'])
    codes[name] = (
      await stack.migration.query<{ code: string }[]>('SELECT code FROM employee WHERE id = $1', [
        f.employeeOf(name),
      ])
    )[0]!.code;
  // A signed-in account with no profile and no HR role.
  f.people.N = await stack.person([]);

  // E1, March 2026 (22 weekdays): unpaid 120, annual 480 + 120 with an unpaid 09–13 over it
  // (the shared 09–11 counts once, as annual; unpaid keeps 11–13), WFH on the 30th and 31st, one
  // late arrival (09:00–10:00) and one early departure (17:00–18:00).
  await f.fixtureRequest('E1', 'unpaid-leave', 'approved', ['2026-03-03'], [540, 660]);
  const annualDay = await f.fixtureRequest('E1', 'annual-leave', 'approved', ['2026-03-04']);
  const annualHalf = await f.fixtureRequest(
    'E1',
    'annual-leave',
    'approved',
    ['2026-03-05'],
    [540, 660],
  );
  await f.fixtureRequest('E1', 'unpaid-leave', 'approved', ['2026-03-05'], [540, 780]);
  const wfhMarch = await f.fixtureRequest('E1', 'wfh', 'approved', ['2026-03-30', '2026-03-31']);
  await f.fixtureRequest('E1', 'late-arrival', 'approved', ['2026-03-10'], [540, 600]);
  await f.fixtureRequest('E1', 'early-departure', 'approved', ['2026-03-12'], [1020, 1080]);
  // The WFH of 30–31 March was decided in APRIL: the report counts the day's month (R-01).
  await stack.migration.query(
    `INSERT INTO request_decision(id, request_id, stage, decision, actor_kind, actor_account_id, decided_at)
     VALUES (gen_random_uuid(), $1, 'final', 'approve', 'user', $2, TIMESTAMPTZ '2026-04-02 03:00:00+00')`,
    [wfhMarch.id, f.p('C').id],
  );
  // Waiting and refused requests never count.
  await f.fixtureRequest('E1', 'unpaid-leave', 'pending_lead', ['2026-03-18']);
  await f.fixtureRequest('E1', 'wfh', 'rejected', ['2026-03-19']);
  // E1, April: one WFH day; E2: late on the second shift in March, five WFH days in May.
  await f.fixtureRequest('E1', 'wfh', 'approved', ['2026-04-01']);
  await f.fixtureRequest('E2', 'late-arrival', 'approved', ['2026-03-17'], [840, 900]);
  await f.fixtureRequest('E2', 'wfh', 'approved', [
    '2026-05-04',
    '2026-05-05',
    '2026-05-06',
    '2026-05-07',
    '2026-05-08',
  ]);
  // E1 leave ledger: debits of the approved annual leave (the sheet's 480 + 120), two more later.
  await debit(annualDay, 'E1', '2026-03-04', 480);
  await debit(annualHalf, 'E1', '2026-03-05', 120);
  const may = await f.fixtureRequest('E1', 'annual-leave', 'approved', ['2026-05-05']);
  await debit(may, 'E1', '2026-05-05', 480);
  const july = await f.fixtureRequest('E1', 'annual-leave', 'approved', ['2026-07-06']);
  await debit(july, 'E1', '2026-07-06', 480);
  await f.fixtureRequest('E1', 'annual-leave', 'pending_lead', ['2026-08-10']);
  // E1's F2 data: no report may carry any of it (D08).
  await stack.migration.query(
    `UPDATE employee_identity SET date_of_birth = DATE '1990-02-28', document_kind = 'cccd',
            document_number = 'ZZ9988776655', tax_code = '9988776655'
      WHERE employee_id = $1`,
    [f.employeeOf('E1')],
  );
  // Birthdays (T9B): leap-born S2 (29/02), month ends H (31/12) and E3 (31/01), 1 March E2, NEW
  // whose March birthday (15th) is the day BEFORE the hire (16th), GONE who left in 2025.
  for (const [name, dob] of [
    ['S2', '2000-02-29'],
    ['E2', '1995-03-01'],
    ['E3', '1988-01-31'],
    ['NEW', '1999-03-15'],
    ['GONE', '1980-06-10'],
    ['H', '1985-12-31'],
  ] as const)
    await stack.migration.query(
      `UPDATE employee_identity SET date_of_birth = CAST($2 AS date) WHERE employee_id = $1`,
      [f.employeeOf(name), dob],
    );
});

after(() => stack?.stop());

test('attendance report: known totals per employee and month, equal to the sheet endpoint (B-22, F-01..F-13)', async () => {
  const result = await report<'attendance'>('H', months('attendance', MARCH, APRIL));
  // 9 employees minus GONE (left in 2025), per month.
  assert.equal(result.total, '16');
  assert.equal(result.rows.length, 16);
  assert.deepEqual(
    result.rows.map((row) => [row.employeeCode, row.month]),
    result.rows
      .map((row) => [row.employeeCode, row.month])
      .toSorted((a, b) => a[0]!.localeCompare(b[0]!) || a[1]!.localeCompare(b[1]!)),
    'ordered by code then month',
  );
  const [e1March, e1April] = byCode(result.rows, 'E1');
  assert.deepEqual(
    { ...sheetTotals(e1March!), month: e1March!.month, periodState: e1March!.periodState },
    {
      scheduledMinutes: 22 * 480,
      paidHolidayMinutes: 0,
      unpaidMinutes: 240,
      annualLeaveMinutes: 600,
      paidMinutes: 22 * 480 - 240,
      wfhDays: 2,
      lateCount: 1,
      lateMinutes: 60,
      earlyCount: 1,
      earlyMinutes: 60,
      adjustmentMinutes: 0,
      month: MARCH,
      periodState: 'open',
    },
  );
  assert.deepEqual(sheetTotals(e1April!), {
    scheduledMinutes: 22 * 480,
    paidHolidayMinutes: 0,
    unpaidMinutes: 0,
    annualLeaveMinutes: 0,
    paidMinutes: 22 * 480,
    wfhDays: 1,
    lateCount: 0,
    lateMinutes: 0,
    earlyCount: 0,
    earlyMinutes: 0,
    adjustmentMinutes: 0,
  });
  // The employee hired on 16 March counts from that day: 12 weekdays (F-02).
  assert.equal(byCode(result.rows, 'NEW')[0]!.scheduledMinutes, 12 * 480);
  assert.equal(byCode(result.rows, 'NEW')[1]!.scheduledMinutes, 22 * 480);
  // One source: every row equals the per-employee sheet endpoint (same pure function, same facts).
  for (const row of result.rows) {
    const sheet = await stack.attendance.period(await stack.root(), {
      employeeId: row.employeeId,
      month: row.month,
    });
    assert.deepEqual(sheetTotals(row), sheetTotals(sheet as AttendanceTotals));
  }
  // The ledger agrees with the sheet: March debits of E1 = the sheet's annual minutes.
  const [ledgerRow] = await stack.migration.query<{ n: string }[]>(
    `SELECT COALESCE(sum(minutes),0)::text AS n FROM leave_ledger
      WHERE employee_id = $1 AND entry_kind = 'debit' AND to_char(effective_on,'YYYY-MM') = $2`,
    [f.employeeOf('E1'), MARCH],
  );
  assert.equal(Number(ledgerRow!.n), e1March!.annualLeaveMinutes);
});

test('late-early and WFH reports count the day recorded, never the month it was decided (R-01, D04, D05)', async () => {
  const late = await report<'late-early'>('H', months('late-early', MARCH, MARCH));
  assert.deepEqual(
    byCode(late.rows, 'E1').map(({ lateCount, lateMinutes, earlyCount, earlyMinutes }) => ({
      lateCount,
      lateMinutes,
      earlyCount,
      earlyMinutes,
    })),
    [{ lateCount: 1, lateMinutes: 60, earlyCount: 1, earlyMinutes: 60 }],
  );
  assert.deepEqual(
    byCode(late.rows, 'E2').map((row) => [row.lateCount, row.lateMinutes, row.earlyCount]),
    [[1, 60, 0]],
  );
  assert.equal(late.rows.length, 8, 'every employed employee has a row, zeros included');
  assert.ok(late.rows.every((row) => !('wfhDays' in row)));

  const wfh = await report<'wfh'>('H', months('wfh', MARCH, '2026-05'));
  const e1 = byCode(wfh.rows, 'E1').map((row) => [row.month, row.wfhDays, row.overLimit]);
  // 30–31 March (decided on 2 April) count in March; 1 April in April; nothing in May.
  assert.deepEqual(e1, [
    [MARCH, 2, false],
    [APRIL, 1, false],
    ['2026-05', 0, false],
  ]);
  assert.deepEqual(
    byCode(wfh.rows, 'E2').map((row) => [row.month, row.wfhDays, row.overLimit]),
    [
      [MARCH, 0, false],
      [APRIL, 0, false],
      ['2026-05', 5, true],
    ],
  );
  // The pending/rejected WFH of E1 never counts; the April-decided March request is not in April.
  const april = await report<'wfh'>('H', months('wfh', APRIL, APRIL));
  assert.equal(byCode(april.rows, 'E1')[0]!.wfhDays, 1);
});

test('leave report: the D09 balance at the cutoff date, equal to the balance endpoint (D03, D09)', async () => {
  const at = async (asOn: string) => {
    const result = await report<'leave'>('H', cutoff('leave', asOn));
    return byCode(result.rows, 'E1')[0]!;
  };

  // 30 June: six months accrued (2880); used = 480 + 120 + 480; ahead = July; pending = August.
  const june = await at('2026-06-30');
  assert.deepEqual(
    {
      year: june.year,
      annualMinutes: june.annualMinutes,
      entitledMinutes: june.entitledMinutes,
      usedMinutes: june.usedMinutes,
      futureApprovedMinutes: june.futureApprovedMinutes,
      pendingMinutes: june.pendingMinutes,
      availableMinutes: june.availableMinutes,
    },
    {
      year: 2026,
      annualMinutes: 5760,
      entitledMinutes: 2880,
      usedMinutes: 1080,
      futureApprovedMinutes: 480,
      pendingMinutes: 480,
      availableMinutes: 840,
    },
  );
  // The cutoff moves the same July debit from "ahead" to "used" and one more month is accrued.
  const july = await at('2026-07-06');
  assert.deepEqual(
    [
      july.entitledMinutes,
      july.usedMinutes,
      july.futureApprovedMinutes,
      july.pendingMinutes,
      july.availableMinutes,
    ],
    [3360, 1560, 0, 480, 1320],
  );
  // Early cutoff: more is committed than accrued, so the available minutes stop at zero.
  const early = await at('2026-03-04');
  assert.deepEqual(
    [early.entitledMinutes, early.usedMinutes, early.futureApprovedMinutes, early.availableMinutes],
    [1440, 480, 1080, 0],
  );
  // Every row equals the balance endpoint for that employee and date.
  const all = await report<'leave'>('H', cutoff('leave', '2026-06-30'));
  assert.equal(all.total, '8', 'GONE left in 2025: not employed in 2026');
  for (const row of all.rows) {
    const balance = await stack.leave.balance(await stack.root(), {
      employeeId: row.employeeId,
      asOn: '2026-06-30',
    });
    const { employeeCode: _c, employeeName: _n, ...rest } = row;
    void _c;
    void _n;
    assert.deepEqual(rest, balance);
  }
  // The previous year lists the employee who left on 2025-12-31 and not the 2026 hire.
  const previous = await report<'leave'>('H', cutoff('leave', '2025-12-31'));
  assert.ok(byCode(previous.rows, 'GONE').length === 1);
  assert.equal(byCode(previous.rows, 'NEW').length, 0);
});

test('seniority report: from the employment dates, hire day and cutoff counted (R-03)', async () => {
  const end = await report<'seniority'>('H', cutoff('seniority', '2026-12-31'));

  const view = (name: string) => {
    const row = byCode(end.rows, name)[0]!;
    return [row.hiredOn, row.years, row.months, row.days, row.totalDays];
  };

  // S2 was hired on 2025-01-01 and its row was created today: 2 years, from the history.
  assert.deepEqual(view('S2'), ['2025-01-01', 2, 0, 0, 730]);
  assert.deepEqual(view('E1'), ['2026-01-05', 0, 11, 27, 361]);
  assert.deepEqual(view('NEW'), ['2026-03-16', 0, 9, 16, 291]);
  assert.equal(byCode(end.rows, 'GONE').length, 0, 'left before the cutoff');
  assert.equal(end.total, '8');
  const before2026 = await report<'seniority'>('H', cutoff('seniority', '2025-12-31'));
  assert.deepEqual(
    byCode(before2026.rows, 'GONE').map((r) => [r.years, r.months, r.days, r.totalDays]),
    [[0, 11, 26, 360]],
  );
  assert.deepEqual(
    byCode(before2026.rows, 'S2').map((r) => [r.years, r.months, r.days, r.totalDays]),
    [[1, 0, 0, 365]],
  );
  assert.equal(before2026.total, '2', 'only S2 and GONE were employed on 2025-12-31');
  // A hire after the cutoff is not listed.
  const february = await report<'seniority'>('H', cutoff('seniority', '2026-02-28'));
  assert.equal(byCode(february.rows, 'NEW').length, 0);
});

const everyQuery: ReportInput[] = [
  months('attendance', MARCH, APRIL),
  months('late-early', MARCH, APRIL),
  months('wfh', MARCH, APRIL),
  cutoff('leave', '2026-06-30'),
  cutoff('seniority', '2026-12-31'),
  months('birthday', MARCH, APRIL),
];

test('scope comes before count and page: employee, lead, CEO and a stranger get an empty page; absent = foreign', async () => {
  for (const query of everyQuery)
    for (const as of ['E1', 'L1', 'N'])
      assert.deepEqual(
        await report(as, query),
        { kind: query.kind, total: '0', rows: [] },
        `${as} ${query.kind}`,
      );
  // COO and HR read the whole company: the same rows and total for both.
  for (const query of everyQuery) {
    const coo = await report('C', query);
    const hr = await report('H', query);
    assert.deepEqual(coo, hr);
    assert.ok(Number(hr.total) > 0);
  }
  // Pagination applies to the scoped set: pages are consecutive slices of the total, no overlap.
  const full = await report<'attendance'>('H', months('attendance', MARCH, APRIL));
  const sliced = [];
  for (let offset = 0; offset < 16; offset += 5) {
    const page = await report<'attendance'>('H', {
      ...months('attendance', MARCH, APRIL),
      limit: 5,
      offset,
    });
    assert.equal(page.total, '16');
    sliced.push(...page.rows);
  }
  assert.deepEqual(sliced, full.rows);
  const past = await report<'attendance'>('H', {
    ...months('attendance', MARCH, APRIL),
    limit: 5,
    offset: 100,
  });
  assert.deepEqual([past.total, past.rows.length], ['16', 0]);
});

test('no report carries identity data: no CCCD, tax code, date of birth or contact (D08)', async () => {
  for (const query of everyQuery) {
    const text = JSON.stringify(await report('H', query));
    for (const secret of ['ZZ9988776655', '9988776655', '1990-02-28'])
      assert.ok(!text.includes(secret), `${query.kind} leaks ${secret}`);
    for (const key of ['dateOfBirth', 'documentNumber', 'taxCode', 'phone', 'workEmail', 'gender'])
      assert.ok(!text.includes(`"${key}"`), `${key} in a report`);
  }
});

test('revoking a role or adding a deny takes effect on the next report; Root reads everything and is audited', async () => {
  const query = months('attendance', MARCH, MARCH);
  const coo = await f.hire('C2', ['hr.employee', 'hr.coo'], { inTeam: false });
  assert.equal((await report<'attendance'>('C2', query)).total, '9');
  await stack.runner.run('admin', (tx) =>
    tx.manager.query('DELETE FROM user_role WHERE user_id=$1 AND role_key=$2', [
      coo.id,
      utf8('hr.coo'),
    ]),
  );
  assert.deepEqual(await report('C2', query), { kind: 'attendance', total: '0', rows: [] });
  // A deny rule on one report hides only that report, even from HR (deny wins over allow).
  const rule = randomUUID();
  await stack.migration.query(
    "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'deny',$4,1,'{}','runtime')",
    [rule, utf8('employee.reportWfh'), f.p('H').id, utf8('allEmployees')],
  );
  try {
    assert.deepEqual(await report('H', months('wfh', MARCH, MARCH)), {
      kind: 'wfh',
      total: '0',
      rows: [],
    });
    assert.ok(Number((await report('H', query)).total) > 0, 'another report is unaffected');
  } finally {
    await stack.runner.run('admin', (tx) =>
      tx.manager.query('DELETE FROM policy_rule WHERE rule_id=$1', [rule]),
    );
  }

  // Root: outside IAM, sees all rows and leaves one access event per read.
  const events = () =>
    stack.migration.query<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM audit_outbox WHERE actor_id=$1
          AND convert_from(event_kind,'UTF8') = 'access.employee.reportAttendance'`,
      [stack.rootId],
    );

  const before = Number((await events())[0]!.n);
  const root = await report<'attendance'>('root', query);
  assert.equal(root.total, '9');
  assert.equal(Number((await events())[0]!.n), before + 1);
});

test('a closed month is served from its stored snapshot even after the records change; an open month is live (D07, F-12)', async () => {
  const closeMonth = (month: string) => stack.attendance.closePeriod(f.p('H').fresh, { month });

  await closeMonth(MARCH);
  const frozen = await report<'attendance'>('H', months('attendance', MARCH, APRIL));
  const e1Frozen = byCode(frozen.rows, 'E1');
  assert.equal(e1Frozen[0]!.periodState, 'closed');
  assert.equal(e1Frozen[1]!.periodState, 'open');
  assert.equal(e1Frozen[0]!.unpaidMinutes, 240);

  // The record changes behind the close (an import fixing history, not an HTTP path): another
  // unpaid day in March, and one of E1's approved days becomes cancelled.
  await f.fixtureRequest('E1', 'unpaid-leave', 'approved', ['2026-03-06']);
  const live = await stack.attendance.period(await stack.root(), {
    employeeId: f.employeeOf('E1'),
    month: MARCH,
  });
  assert.equal(live?.unpaidMinutes, 240 + 480, 'the live sheet moved');
  const after = await report<'attendance'>('H', months('attendance', MARCH, APRIL));
  assert.deepEqual(after, frozen, 'the report still returns the snapshot');
  // Scope applies to the snapshot rows too.
  assert.deepEqual(await report('E1', months('attendance', MARCH, APRIL)), {
    kind: 'attendance',
    total: '0',
    rows: [],
  });
  assert.deepEqual(await report('C', months('attendance', MARCH, APRIL)), after);
  // Late/early and WFH read the same snapshot.
  const lateEarly = await report<'late-early'>('H', months('late-early', MARCH, MARCH));
  assert.equal(byCode(lateEarly.rows, 'E1')[0]!.lateMinutes, 60);
  assert.equal(byCode(lateEarly.rows, 'E1')[0]!.periodState, 'closed');

  // The stored hash is re-verifiable from the jsonb the database hands back.
  const [row] = await stack.migration.query<{ snapshot: unknown; snapshot_hash: string }[]>(
    `SELECT snapshot, snapshot_hash FROM attendance_period WHERE month = DATE '2026-03-01'`,
  );
  assert.equal(snapshotHash(parseSnapshot(row!.snapshot)), row!.snapshot_hash);
  const naive = (await import('node:crypto'))
    .createHash('sha256')
    .update(JSON.stringify(row!.snapshot))
    .digest('hex');
  assert.notEqual(naive, row!.snapshot_hash, 'jsonb does not keep the key order of the close');

  // A snapshot altered behind the hash is never served (fail closed); restoring it serves again.
  await stack.migration.query(
    `UPDATE attendance_period SET snapshot = jsonb_set(snapshot, '{employees,0,paidMinutes}', '1')
      WHERE month = DATE '2026-03-01'`,
  );
  await assert.rejects(report('H', months('attendance', MARCH, MARCH)), /does not match its hash/);
  await stack.migration.query(
    `UPDATE attendance_period SET snapshot = CAST($1 AS jsonb) WHERE month = DATE '2026-03-01'`,
    [JSON.stringify(row!.snapshot)],
  );
  assert.deepEqual(await report('H', months('attendance', MARCH, APRIL)), frozen);

  // Reopened, the month is computed from live data again (and includes the changed record).
  await stack.attendance.reopenPeriod(f.p('H').fresh, { month: MARCH, reason: 'Sửa dữ liệu thử' });
  const reopened = await report<'attendance'>('H', months('attendance', MARCH, MARCH));
  assert.equal(byCode(reopened.rows, 'E1')[0]!.periodState, 'open');
  assert.equal(byCode(reopened.rows, 'E1')[0]!.unpaidMinutes, 240 + 480);
});

test('reports read one snapshot: pending→approved never double counts, and a close racing a read never mixes states', async () => {
  // E3 has four waiting annual-leave days; the final approval moves each from pending to a debit
  // in one commit. At any instant used + ahead + pending must be the same four days.
  const dates = await f.days(4);
  const year = dates[0]!.slice(0, 4);
  await f.available('E3', dates[0]!, 4 * 480);
  const created = [];
  for (const date of dates)
    created.push(await f.submit('E3', f.leave('annual-leave', date, 540, 1080)));
  const observed: number[] = [];
  let writing = true;
  const writer = (async () => {
    try {
      for (const request of created) {
        const next = await stack.approvals.decide(f.p('L1').secret, f.input(request, 'approve'));
        assert.ok(next);
        const done = await f.finalDecide(next, 'approve');
        assert.equal(done?.state, 'approved');
      }
    } finally {
      writing = false;
    }
  })();
  const reader = (async () => {
    do {
      const result = await report<'leave'>('H', cutoff('leave', `${year}-12-31`));
      const row = byCode(result.rows, 'E3')[0]!;
      observed.push(row.usedMinutes + row.futureApprovedMinutes + row.pendingMinutes);
    } while (writing);
  })();
  await Promise.all([writer, reader]);
  assert.ok(observed.length >= 2, 'the read ran while the writes ran');
  assert.deepEqual([...new Set(observed)], [4 * 480], 'never pending and approved, nor neither');

  // April is open; HR closes and reopens it while reports read it: each result is whole.
  const expected = (await report<'attendance'>('H', months('attendance', APRIL, APRIL))).rows;
  let cycling = true;
  const cycle = (async () => {
    try {
      for (let i = 0; i < 3; i++) {
        await stack.attendance.closePeriod(f.p('H').fresh, { month: APRIL });
        await stack.attendance.reopenPeriod(f.p('H').fresh, { month: APRIL, reason: 'Đua thử' });
      }
    } finally {
      cycling = false;
    }
  })();
  // One statement = one snapshot: inside a single result every row of the month has the SAME
  // period state (a close committing mid-read must not split employees between live and snapshot)
  // and the totals of that state. shortcut: whether a given run observes both states depends on
  // timing, so the test asserts uniformity per result, not that both were seen.
  let reads = 0;
  const readers = (async () => {
    do {
      const { rows } = await report<'attendance'>('H', months('attendance', APRIL, APRIL));
      reads++;
      assert.equal(rows.length, expected.length);
      assert.equal(new Set(rows.map((row) => row.periodState)).size, 1, 'one state per read');
      for (const [index, row] of rows.entries())
        assert.deepEqual(sheetTotals(row), sheetTotals(expected[index]!));
    } while (cycling);
  })();
  await Promise.all([cycle, readers]);
  assert.ok(reads >= 1);
});

// ---- Birthday report (T9B, acceptance R-02) -------------------------------------------------

const birthdays = async (as: Who, from: string, to: string) =>
  (await report<'birthday'>(as, months('birthday', from, to))).rows.map((row) => [
    row.employeeCode,
    row.month,
    row.birthdayOn,
  ]);

const ordered = (rows: readonly (readonly string[])[]) =>
  rows.toSorted((a, b) => a[2]!.localeCompare(b[2]!) || a[0]!.localeCompare(b[0]!));

test('birthday report: 29/02 is shown on 28/02 in a common year and on 29/02 in a leap year (R-02)', async () => {
  // 2027 is common: S2 (born 2000-02-29) and E1 (1990-02-28) both celebrate on 28/02.
  const common = await birthdays('H', '2027-02', '2027-02');
  assert.deepEqual(
    common,
    ordered([
      [codes.E1!, '2027-02', '2027-02-28'],
      [codes.S2!, '2027-02', '2027-02-28'],
    ]),
  );
  // 2028 is a leap year: the 29th is real, the 28th stays E1's.
  assert.deepEqual(await birthdays('H', '2028-02', '2028-02'), [
    [codes.E1!, '2028-02', '2028-02-28'],
    [codes.S2!, '2028-02', '2028-02-29'],
  ]);
  // 2026 (common, past) behaves like 2027.
  assert.deepEqual(
    (await birthdays('H', '2026-02', '2026-02')).map((row) => row[2]),
    ['2026-02-28', '2026-02-28'],
  );
});

test('birthday report: month boundaries, ranges across a year, hire and leaving dates', async () => {
  // Last day of the year and of January sit in their own months.
  assert.deepEqual(await birthdays('H', '2026-12', '2027-01'), [
    [codes.H!, '2026-12', '2026-12-31'],
    [codes.E3!, '2027-01', '2027-01-31'],
  ]);
  // 28/02 and 01/03 are different months: E2 (1 March) is not in February.
  assert.equal(
    (await report<'birthday'>('H', months('birthday', '2027-02', '2027-02'))).total,
    '2',
  );
  assert.deepEqual(await birthdays('H', '2027-02', '2027-03'), [
    ...ordered([
      [codes.E1!, '2027-02', '2027-02-28'],
      [codes.S2!, '2027-02', '2027-02-28'],
    ]),
    [codes.E2!, '2027-03', '2027-03-01'],
    [codes.NEW!, '2027-03', '2027-03-15'],
  ]);
  // NEW was hired on 2026-03-16: the 15th of that March is before the hire, so it is not listed.
  assert.deepEqual(await birthdays('H', '2026-03', '2026-03'), [
    [codes.E2!, '2026-03', '2026-03-01'],
  ]);
  // GONE left on 2025-12-31: listed while employed (June 2025), not after (June 2026).
  assert.deepEqual(await birthdays('H', '2025-06', '2025-06'), [
    [codes.GONE!, '2025-06', '2025-06-10'],
  ]);
  assert.deepEqual(await birthdays('H', '2026-06', '2026-06'), []);
  // No date of birth recorded (L1, C and everyone else): never listed.
  const whole = await report<'birthday'>('H', months('birthday', '2026-07', '2027-06'));
  assert.deepEqual(
    new Set(whole.rows.map((row) => row.employeeCode)),
    new Set([codes.H, codes.E3, codes.E1, codes.S2, codes.E2, codes.NEW]),
  );
  assert.equal(whole.total, String(whole.rows.length));
});

test('birthday report: COO and HR see the same day/month rows and no birth year, CCCD or tax code (D08)', async () => {
  const query = months('birthday', '2027-02', '2027-03');
  const coo = await report<'birthday'>('C', query);
  const hr = await report<'birthday'>('H', query);
  assert.deepEqual(coo, hr);
  for (const row of coo.rows)
    assert.deepEqual(Object.keys(row).toSorted(), [
      'birthdayOn',
      'employeeCode',
      'employeeId',
      'employeeName',
      'month',
    ]);
  const text = JSON.stringify([
    await report('C', months('birthday', '2025-06', '2026-05')),
    await report('C', months('birthday', '2026-06', '2027-05')),
    await report('C', months('birthday', '2027-06', '2028-05')),
  ]);
  for (const year of ['1990', '2000', '1995', '1988', '1985', '1980', '1999'])
    assert.ok(!text.includes(year), `birth year ${year} in a birthday report`);
  for (const secret of ['ZZ9988776655', '9988776655', 'dateOfBirth', 'documentNumber', 'taxCode'])
    assert.ok(!text.includes(secret), secret);
  // Employee, Team Lead, CEO-like stranger: an empty page, scope before count and page.
  for (const as of ['E1', 'L1', 'N'])
    assert.deepEqual(await report(as, query), { kind: 'birthday', total: '0', rows: [] });
  // Pages are slices of the scoped total.
  const page = await report<'birthday'>('H', { ...query, limit: 2, offset: 1 });
  assert.equal(page.total, '4');
  assert.deepEqual(page.rows, hr.rows.slice(1, 3));
});

// ---- XLSX export (T9B, acceptance R-04, R-08) -----------------------------------------------

const exportQueries: ReportExportQuery[] = [
  months('attendance', MARCH, APRIL),
  months('late-early', MARCH, APRIL),
  months('wfh', MARCH, '2026-05'),
  cutoff('leave', '2026-06-30'),
  cutoff('seniority', '2026-12-31'),
  months('birthday', '2027-02', '2027-03'),
];

const secretOf = async (as: Who) => (as === 'root' ? stack.root() : f.p(as).secret);

async function download(as: Who, query: ReportExportQuery) {
  const file = await stack.reports.export(await secretOf(as), query);
  assert.ok(file, 'a file for a caller that stayed connected');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.content as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0]!;
  const rows = sheet.getRows(2, Math.max(sheet.rowCount - 1, 0)) ?? [];
  return {
    file,
    sheet,
    header: (sheet.getRow(1).values as string[]).slice(1),
    rows: rows.map((row) => (row.values as unknown[]).slice(1)),
  };
}

const numbersOf = (values: readonly unknown[]) =>
  values.filter((value): value is number => typeof value === 'number');

test('export: every report file reads back with the same rows and numbers as its JSON (R-04 data)', async () => {
  for (const query of exportQueries) {
    const json = await report('H', { ...query, limit: 100 });
    const { rows, file } = await download('H', query);
    assert.equal(file.fileName.endsWith('.xlsx'), true);
    assert.equal(rows.length, json.rows.length, query.kind);
    assert.equal(String(rows.length), json.total, 'not truncated');
    for (const [index, row] of json.rows.entries()) {
      assert.equal(rows[index]![0], row.employeeCode, query.kind);
      assert.equal(rows[index]![1], row.employeeName, query.kind);
      assert.deepEqual(
        numbersOf(rows[index]!),
        numbersOf(Object.values(row)),
        `${query.kind} #${index}`,
      );
    }
    // COO exports the same file content as HR (same scope, same single statement).
    const coo = await download('C', query);
    assert.deepEqual(coo.rows, rows);
  }
});

test('export: the attendance sheet agrees with the leave ledger and with the closed-month snapshot', async () => {
  const { rows, header } = await download('H', months('attendance', MARCH, MARCH));
  const annual = header.indexOf('Phút phép năm');
  const e1 = rows.find((row) => row[0] === codes.E1)!;
  const [ledger] = await stack.migration.query<{ n: string }[]>(
    `SELECT COALESCE(sum(minutes),0)::text AS n FROM leave_ledger
      WHERE employee_id = $1 AND entry_kind = 'debit' AND to_char(effective_on,'YYYY-MM') = $2`,
    [f.employeeOf('E1'), MARCH],
  );
  assert.equal(e1[annual], Number(ledger!.n));

  await stack.attendance.closePeriod(f.p('H').fresh, { month: MARCH });
  try {
    const closed = await download('H', months('attendance', MARCH, MARCH));
    const [row] = await stack.migration.query<{ snapshot: unknown }[]>(
      `SELECT snapshot FROM attendance_period WHERE month = DATE '2026-03-01'`,
    );
    const snapshot = parseSnapshot(row!.snapshot);
    assert.equal(closed.rows.length, snapshot.employees.length);
    for (const entry of snapshot.employees) {
      const { code } = (
        await stack.migration.query<{ code: string }[]>('SELECT code FROM employee WHERE id = $1', [
          entry.employeeId,
        ])
      )[0]!;
      const { employeeId: _id, ...totals } = entry;
      void _id;
      assert.deepEqual(
        numbersOf(closed.rows.find((r) => r[0] === code)!),
        Object.values(totals),
        code,
      );
    }
    // Records change behind the close: the export keeps serving the snapshot.
    await f.fixtureRequest('E1', 'unpaid-leave', 'approved', ['2026-03-09']);
    assert.deepEqual((await download('H', months('attendance', MARCH, MARCH))).rows, closed.rows);
  } finally {
    await stack.attendance.reopenPeriod(f.p('H').fresh, { month: MARCH, reason: 'Xuất thử' });
  }
});

test('export: download authorization is server side — only COO, HR and Root get a file', async () => {
  for (const query of exportQueries)
    for (const as of ['E1', 'L1', 'N'])
      await assert.rejects(
        stack.reports.export(await secretOf(as), query),
        ProductAccessDenied,
        `${as} ${query.kind}`,
      );

  // Root: a file, and the read is audited like the JSON read (one access event).
  const events = async () =>
    Number(
      (
        await stack.migration.query<{ n: string }[]>(
          `SELECT count(*)::text AS n FROM audit_outbox WHERE actor_id=$1
              AND convert_from(event_kind,'UTF8') = 'access.employee.reportSeniority'`,
          [stack.rootId],
        )
      )[0]!.n,
    );

  const before = await events();
  const root = await download('root', cutoff('seniority', '2026-12-31'));
  assert.ok(root.rows.length > 0);
  assert.equal(await events(), before + 1);
  // A deny on one report blocks its export for HR, not another report's.
  const rule = randomUUID();
  await stack.migration.query(
    "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'deny',$4,1,'{}','runtime')",
    [rule, utf8('employee.reportWfh'), f.p('H').id, utf8('allEmployees')],
  );
  try {
    await assert.rejects(
      stack.reports.export(f.p('H').secret, months('wfh', MARCH, MARCH)),
      ProductAccessDenied,
    );
    assert.ok((await download('H', months('late-early', MARCH, MARCH))).rows.length > 0);
  } finally {
    await stack.runner.run('admin', (tx) =>
      tx.manager.query('DELETE FROM policy_rule WHERE rule_id=$1', [rule]),
    );
  }
});

test('export: access revoked after the data was read and before delivery gives no file (R-04)', async () => {
  const coo = await stack.person(['hr.employee', 'hr.coo']);
  const query = months('wfh', MARCH, '2026-05');
  const plain = new ReportService(stack.authorization, stack.modules.repositories.reports);
  assert.ok(await plain.export(coo.secret, query), 'the grant works before the revoke');
  const revoking = new ReportService(stack.authorization, stack.modules.repositories.reports, {
    render: async (result: ReportResult) => {
      const buffer = await new ExcelExportService().render(result);
      await stack.runner.run('admin', (tx) =>
        tx.manager.query('DELETE FROM user_role WHERE user_id=$1 AND role_key=$2', [
          coo.id,
          utf8('hr.coo'),
        ]),
      );
      return buffer;
    },
  });
  await assert.rejects(revoking.export(coo.secret, query), ProductAccessDenied);
  await assert.rejects(plain.export(coo.secret, query), ProductAccessDenied, 'and stays revoked');
});

test('export: no identity data in any file, and hostile employee names stay text', async () => {
  const hostile = '=HYPERLINK("http://example.invalid","x")';
  const { name } = (
    await stack.migration.query<{ name: string }[]>(
      'SELECT full_name AS name FROM employee WHERE id = $1',
      [f.employeeOf('E1')],
    )
  )[0]!;
  await stack.migration.query('UPDATE employee SET full_name = $2 WHERE id = $1', [
    f.employeeOf('E1'),
    hostile,
  ]);
  try {
    for (const query of exportQueries) {
      const { sheet, rows } = await download('H', query);
      const texts = rows.flat().filter((v): v is string => typeof v === 'string');
      for (const secret of ['ZZ9988776655', '9988776655'])
        assert.ok(!texts.some((t) => t.includes(secret)), `${query.kind} leaks ${secret}`);
      for (const value of rows.flat())
        if (value instanceof Date)
          assert.ok(value.getUTCFullYear() >= 2025, `${query.kind}: a birth year as a date`);
      for (const [index, row] of rows.entries())
        if (row[0] === codes.E1) {
          const cell = sheet.getRow(index + 2).getCell(2);
          assert.equal(cell.type, ExcelJS.ValueType.String);
          assert.equal(cell.value, hostile);
        }
    }
  } finally {
    await stack.migration.query('UPDATE employee SET full_name = $2 WHERE id = $1', [
      f.employeeOf('E1'),
      name,
    ]);
  }
});

test('export: a file is one snapshot — pending→approved never double counts while writes commit', async () => {
  await f.hire('E4', ['hr.employee']);
  const dates = await f.days(4);
  const year = dates[0]!.slice(0, 4);
  await f.available('E4', dates[0]!, 4 * 480);
  const created = [];
  for (const date of dates)
    created.push(await f.submit('E4', f.leave('annual-leave', date, 540, 1080)));
  let writing = true;
  const writer = (async () => {
    try {
      for (const request of created) {
        const next = await stack.approvals.decide(f.p('L1').secret, f.input(request, 'approve'));
        assert.ok(next);
        assert.equal((await f.finalDecide(next, 'approve'))?.state, 'approved');
      }
    } finally {
      writing = false;
    }
  })();
  const observed: number[] = [];
  const reader = (async () => {
    const code = (
      await stack.migration.query<{ code: string }[]>('SELECT code FROM employee WHERE id = $1', [
        f.employeeOf('E4'),
      ])
    )[0]!.code;
    do {
      const { rows, header } = await download('H', cutoff('leave', `${year}-12-31`));
      const row = rows.find((r) => r[0] === code)!;
      observed.push(
        ['Phút đã dùng', 'Phút đã duyệt sau ngày cắt', 'Phút đang chờ']
          .map((name) => row[header.indexOf(name)] as number)
          .reduce((a, b) => a + b, 0),
      );
    } while (writing);
  })();
  await Promise.all([writer, reader]);
  assert.ok(observed.length >= 2, 'files were produced while the writes ran');
  assert.deepEqual([...new Set(observed)], [4 * 480]);
});
