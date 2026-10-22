// Oracle of the equivalence spec (ADR 0018 bổ sung, set-based approved effects): the CORRELATED
// statements as they were at 6ea1062 (`approvedEffectsSql` / `adjustmentMinutesSql` per employee,
// `loadAttendanceFacts`, `loadSheetRows`), kept verbatim so the set-based production code is
// compared with the formulation it replaced, never with itself. Test code only.
import type { EntityManager } from 'typeorm';
import {
  type ProductQuery,
  type ProductQueryContext,
  ProductAuthorization,
} from '../dist/authorization/services/product-authority.service.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
  productBindings,
} from '../dist/authorization/product.manifest.js';
import { createProductObligations } from '../dist/authorization/helpers/product-obligations.helper.js';
import { WORK_CALENDAR_ID, hrScoped } from '../dist/modules/hr/helpers/hr-database.helper.js';
import {
  type AttendanceEffect,
  type AttendanceTotals,
  attendanceTotals,
} from '../dist/modules/attendance/helpers/attendance-calculation.helper.js';
import {
  type SnapshotEmployee,
  verifiedSnapshot,
} from '../dist/modules/attendance/helpers/attendance-snapshot.helper.js';
import {
  calendarDaysSql,
  date,
  type AttendanceFactsRow,
} from '../dist/modules/attendance/helpers/attendance-facts.helper.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import type {
  AttendanceReport,
  AttendanceReportRow,
  ReportMonths,
  ReportPage,
  ReportQueryOf,
} from '../dist/modules/report/report.types.js';
import type { HrStack } from './hrm-stack.helper.ts';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

export const oracleApprovedEffectsSql = (employee: string, first: string, next: string) =>
  `COALESCE((SELECT json_agg(json_build_object('kind', s.kind, 'date', ${date('s.work_date')},
                        'startMinute', s.start_minute, 'endMinute', s.end_minute)
                        ORDER BY s.work_date, s.kind, s.start_minute, s.end_minute)
                       FROM work_request r JOIN work_request_segment s ON s.request_id = r.id
                      WHERE r.employee_id = ${employee} AND r.state = 'approved'
                        AND s.work_date >= ${first} AND s.work_date < ${next}), '[]'::json)`;

export const oracleAdjustmentMinutesSql = (employee: string, first: string, next: string) =>
  `COALESCE((SELECT SUM(a.minutes) FROM attendance_adjustment a
              WHERE a.employee_id = ${employee} AND a.work_date >= ${first} AND a.work_date < ${next}), 0)::int`;

export async function oracleLoadAttendanceFacts(
  manager: EntityManager,
  month: string,
  ids: readonly string[] | null,
): Promise<AttendanceFactsRow[]> {
  return manager.query<AttendanceFactsRow[]>(
    `WITH m AS (SELECT CAST($1 || '-01' AS date) AS first, CAST(CAST($1 || '-01' AS date) + interval '1 month' AS date) AS next),
          cal AS (SELECT c.version FROM work_calendar c WHERE c.id = CAST($3 AS uuid)),
          days AS (SELECT DISTINCT ON (x.day) x.day, x.kind FROM work_calendar_change x, m, cal
                    WHERE x.day >= m.first AND x.day < m.next AND x.version <= cal.version
                    ORDER BY x.day, x.version DESC)
     SELECT e.id::text AS id, ${date('e.hired_on')} AS "hiredOn", ${date('e.terminated_on')} AS "terminatedOn",
            (SELECT version::text FROM cal) AS "calendarVersion",
            (SELECT p.state FROM attendance_period p, m WHERE p.month = m.first) AS "periodState",
            ${calendarDaysSql('paid_holiday', '(SELECT first FROM m)', '(SELECT next FROM m)')} AS holidays,
            ${calendarDaysSql('makeup_workday', '(SELECT first FROM m)', '(SELECT next FROM m)')} AS "makeupDays",
            ${oracleApprovedEffectsSql('e.id', '(SELECT first FROM m)', '(SELECT next FROM m)')} AS effects,
            ${oracleAdjustmentMinutesSql('e.id', '(SELECT first FROM m)', '(SELECT next FROM m)')} AS "adjustmentMinutes"
       FROM employee e, m
      WHERE CASE WHEN CAST($2 AS uuid[]) IS NULL
                 THEN e.hired_on < m.next AND (e.terminated_on IS NULL OR e.terminated_on >= m.first)
                 ELSE e.id = ANY(CAST($2 AS uuid[])) END
      ORDER BY e.id`,
    [month, ids === null ? null : [...ids], WORK_CALENDAR_ID],
  );
}

interface SheetStored {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly month: string;
  readonly periodState: 'open' | 'closed';
  readonly hiredOn: string;
  readonly terminatedOn: string | null;
  readonly holidays: string[] | null;
  readonly makeupDays: string[] | null;
  readonly effects: AttendanceEffect[] | null;
  readonly adjustmentMinutes: number | null;
}

interface SheetPage {
  readonly total: string;
  readonly closed: readonly { month: string; snapshot: unknown; hash: string }[];
  readonly rows: readonly SheetStored[];
}

/** The correlated `loadSheetRows` of 6ea1062 (statement text unchanged). */
export async function oracleLoadSheetRows(
  { tx, scope }: ProductQueryContext,
  input: ReportMonths & ReportPage,
): Promise<{ total: string; rows: AttendanceReportRow[] }> {
  const bound = hrScoped(scope, input.from, input.to, input.limit, input.offset, WORK_CALENDAR_ID);
  const [result] = await tx.manager.query<{ result: SheetPage }[]>(
    `WITH ms AS (
       SELECT CAST(g AS date) AS first, CAST(g + interval '1 month' AS date) AS next,
              COALESCE(p.state, 'open') AS state, p.snapshot, p.snapshot_hash
         FROM generate_series(CAST(${bound.at(1)} || '-01' AS timestamp), CAST(${bound.at(2)} || '-01' AS timestamp), interval '1 month') g
         LEFT JOIN attendance_period p ON p.month = CAST(g AS date)),
     pairs AS (
       SELECT r.id, r.code, r.full_name, r.hired_on, r.terminated_on, ms.first, ms.next, ms.state
         FROM employee r
         JOIN ms ON (ms.state = 'open' AND r.hired_on < ms.next
                     AND (r.terminated_on IS NULL OR r.terminated_on >= ms.first))
                 OR (ms.state = 'closed'
                     AND (ms.snapshot -> 'employees') @> jsonb_build_array(jsonb_build_object('employeeId', r.id::text)))
        WHERE ${scope.sql}),
     page AS (SELECT * FROM pairs ORDER BY code, id, first
               LIMIT CAST(${bound.at(3)} AS int8) OFFSET CAST(${bound.at(4)} AS int8)),
     cal AS (SELECT c.version FROM work_calendar c WHERE c.id = CAST(${bound.at(5)} AS uuid)),
     days AS (SELECT DISTINCT ON (x.day) x.day, x.kind FROM work_calendar_change x, cal
               WHERE x.day >= CAST(${bound.at(1)} || '-01' AS date)
                 AND x.day < CAST(CAST(${bound.at(2)} || '-01' AS date) + interval '1 month' AS date)
                 AND x.version <= cal.version
               ORDER BY x.day, x.version DESC)
     SELECT json_build_object(
       'total', (SELECT count(*) FROM pairs)::text,
       'closed', COALESCE((SELECT json_agg(json_build_object('month', to_char(ms.first, 'YYYY-MM'),
                             'snapshot', ms.snapshot, 'hash', ms.snapshot_hash))
                            FROM ms WHERE ms.state = 'closed'
                              AND EXISTS (SELECT 1 FROM page WHERE page.first = ms.first)), '[]'::json),
       'rows', COALESCE((SELECT json_agg(x ORDER BY x."employeeCode", x."employeeId", x.month) FROM (
                 SELECT p.id::text AS "employeeId", p.code AS "employeeCode", p.full_name AS "employeeName",
                        to_char(p.first, 'YYYY-MM') AS month, p.state AS "periodState",
                        ${date('p.hired_on')} AS "hiredOn", ${date('p.terminated_on')} AS "terminatedOn",
                        CASE WHEN p.state = 'open' THEN ${calendarDaysSql('paid_holiday', 'p.first', 'p.next')} END AS holidays,
                        CASE WHEN p.state = 'open' THEN ${calendarDaysSql('makeup_workday', 'p.first', 'p.next')} END AS "makeupDays",
                        CASE WHEN p.state = 'open' THEN ${oracleApprovedEffectsSql('p.id', 'p.first', 'p.next')} END AS effects,
                        CASE WHEN p.state = 'open' THEN ${oracleAdjustmentMinutesSql('p.id', 'p.first', 'p.next')} END AS "adjustmentMinutes"
                   FROM page p) x), '[]'::json)) AS result`,
    bound.parameters,
  );
  if (!result) throw new Error('Report returned no row');
  const stored = result.result;
  const closed = new Map<string, ReadonlyMap<string, SnapshotEmployee>>(
    stored.closed.map(({ month, snapshot, hash }) => [
      month,
      new Map(verifiedSnapshot(month, snapshot, hash).employees.map((e) => [e.employeeId, e])),
    ]),
  );
  return {
    total: stored.total,
    rows: stored.rows.map((row) => {
      const who = {
        employeeId: row.employeeId,
        employeeCode: row.employeeCode,
        employeeName: row.employeeName,
        month: row.month,
        periodState: row.periodState,
      };
      if (row.periodState === 'closed') {
        const found = closed.get(row.month)?.get(row.employeeId);
        if (!found) throw new Error('Closed month row is missing from its snapshot');
        const { employeeId: _id, ...totals } = found;
        void _id;
        return { ...who, ...totals };
      }
      const live: AttendanceTotals = attendanceTotals({
        month: row.month,
        hiredOn: row.hiredOn,
        terminatedOn: row.terminatedOn,
        calendar: {
          paidHolidays: new Set(row.holidays ?? []),
          makeupDays: new Set(row.makeupDays ?? []),
        },
        effects: row.effects ?? [],
        adjustmentMinutes: row.adjustmentMinutes ?? 0,
      });
      return { ...who, ...live };
    }),
  };
}

export const oracleAttendanceReport: ProductQuery<ReportQueryOf<'attendance'>, AttendanceReport> = {
  resource: 'employee',
  action: 'reportAttendance',
  run: async (context, input) => ({
    kind: 'attendance',
    ...(await oracleLoadSheetRows(context, input)),
  }),
};

/** An authorization over the same runner and release as `stack`, registering only the oracle report. */
export function oracleAuthorization(stack: HrStack): ProductAuthorization {
  const core = createProductAuthorizationCore();
  const release = createProductRelease(core);
  return new ProductAuthorization(
    stack.runner,
    audit,
    new ProductBindingRegistry(core, release.declarations, productBindings),
    {
      validators: { 'fresh@1': (_params, input) => input.context.freshAuthentication === true },
      obligations: createProductObligations(audit),
    },
    [],
    [],
    [oracleAttendanceReport],
  );
}
