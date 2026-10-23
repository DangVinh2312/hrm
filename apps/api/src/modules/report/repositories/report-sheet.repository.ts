import type {
  ProductQuery,
  ProductQueryContext,
} from '../../../authorization/services/product-authority.service.js';
import { WORK_CALENDAR_ID, scopedParameters } from '../../permission/permission-database.helper.js';
import {
  type AttendanceEffect,
  type AttendanceTotals,
  attendanceTotals,
} from '../../attendance/helpers/attendance-calculation.helper.js';
import {
  type SnapshotEmployee,
  verifiedSnapshot,
} from '../../attendance/helpers/attendance-snapshot.helper.js';
import {
  type EffectsGroup,
  EFFECTS_SET_BASED_MIN_ROWS,
  WFH_MONTH_LIMIT,
  adjustmentMinutesSql,
  approvedEffectsBySql,
  approvedEffectsSql,
  calendarDaysSql,
  date,
  effectsGroupsSql,
  effectsIndex,
} from '../../attendance/helpers/attendance-facts.helper.js';
import type {
  AttendanceReport,
  AttendanceReportRow,
  LateEarlyReport,
  ReportMonths,
  ReportPage,
  ReportQueryOf,
  WfhReport,
} from '../report.types.js';

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
  readonly adjustmentMinutes: number | null;
  /** Present when the page is read per row; else the page's `effects` groups carry it. */
  readonly effects?: AttendanceEffect[] | null;
}

interface SheetPage {
  readonly total: string;
  /** Stored snapshot and hash of each closed month that has a row in the page. */
  readonly closed: readonly { month: string; snapshot: unknown; hash: string }[];
  readonly rows: readonly SheetStored[];
  /** Approved effects of the employees of the page, by employee and month (never of a closed month's row). */
  readonly effects: readonly EffectsGroup[];
}

function fail(): never {
  throw new Error('Closed month row is missing from its snapshot');
}

function liveTotals(row: SheetStored, effects: AttendanceEffect[]): AttendanceTotals {
  return attendanceTotals({
    month: row.month,
    hiredOn: row.hiredOn,
    terminatedOn: row.terminatedOn,
    calendar: {
      paidHolidays: new Set(row.holidays ?? []),
      makeupDays: new Set(row.makeupDays ?? []),
    },
    effects,
    adjustmentMinutes: row.adjustmentMinutes ?? 0,
  });
}

export class ReportSheetRepository {
  /**
   * Rows of the employee × month attendance sheets in [from, to] for the caller's scope, from ONE
   * statement (one snapshot under READ COMMITTED, so approvals, the calendar, hire/leaving dates and
   * the period state are mutually consistent; design §7.3 / ADR 0017). The plan's `scope` is ANDed
   * into the employee scan BEFORE count and page, so `total` and the page never contain a row the
   * caller may not read. A month HR closed lists the employees of its stored snapshot (D07); an open
   * month lists employees employed in it. The totals come from `attendanceTotals` (live) or the
   * snapshot, whose hash is re-verified here, never from a second formula. Pages are ordered by
   * employee code, id, month. shortcut: a closed month's snapshot document is shipped whole to
   * verify its hash; per-employee snapshot rows (ADR 0018) when a month passes a few thousand employees.
   */
  async loadSheetRows(
    { tx, scope }: ProductQueryContext,
    input: ReportMonths & ReportPage,
  ): Promise<{ total: string; rows: AttendanceReportRow[] }> {
    const bound = scopedParameters(
      scope,
      input.from,
      input.to,
      input.limit,
      input.offset,
      WORK_CALENDAR_ID,
    );
    const setBased = input.limit >= EFFECTS_SET_BASED_MIN_ROWS;
    const window = {
      first: `CAST(${bound.at(1)} || '-01' AS date)`,
      next: `CAST(CAST(${bound.at(2)} || '-01' AS date) + interval '1 month' AS date)`,
    };
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
     ${
       setBased
         ? `live_page AS (SELECT id FROM page WHERE state = 'open'),
     fx AS (${approvedEffectsBySql('live_page', window)}),`
         : ''
     }
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
                        ${setBased ? '' : `CASE WHEN p.state = 'open' THEN ${approvedEffectsSql('p.id', 'p.first', 'p.next')} END AS effects,`}
                        CASE WHEN p.state = 'open' THEN ${adjustmentMinutesSql('p.id', 'p.first', 'p.next')} END AS "adjustmentMinutes"
                   FROM page p) x), '[]'::json),
       'effects', ${setBased ? effectsGroupsSql('fx') : `'[]'::json`}) AS result`,
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
    const effectsOf = effectsIndex(stored.effects);
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
          const { employeeId: _id, ...totals } =
            closed.get(row.month)?.get(row.employeeId) ?? fail();
          void _id;
          return { ...who, ...totals };
        }
        return { ...who, ...liveTotals(row, row.effects ?? effectsOf(row.employeeId, row.month)) };
      }),
    };
  }

  /** employee.reportAttendance: the full sheet per employee and month. */
  readonly attendanceReport: ProductQuery<ReportQueryOf<'attendance'>, AttendanceReport> = {
    resource: 'employee',
    action: 'reportAttendance',
    run: async (context, input) => ({
      kind: 'attendance',
      ...(await this.loadSheetRows(context, input)),
    }),
  };

  /** employee.reportLateEarly: recorded late arrivals and early departures per employee and month. */
  readonly lateEarlyReport: ProductQuery<ReportQueryOf<'late-early'>, LateEarlyReport> = {
    resource: 'employee',
    action: 'reportLateEarly',
    run: async (context, input) => {
      const { total, rows } = await this.loadSheetRows(context, input);
      return {
        kind: 'late-early',
        total,
        rows: rows.map((row) => ({
          employeeId: row.employeeId,
          employeeCode: row.employeeCode,
          employeeName: row.employeeName,
          month: row.month,
          periodState: row.periodState,
          lateCount: row.lateCount,
          lateMinutes: row.lateMinutes,
          earlyCount: row.earlyCount,
          earlyMinutes: row.earlyMinutes,
        })),
      };
    },
  };

  /** employee.reportWfh: approved WFH days per employee and month of the WFH day (D04). */
  readonly wfhReport: ProductQuery<ReportQueryOf<'wfh'>, WfhReport> = {
    resource: 'employee',
    action: 'reportWfh',
    run: async (context, input) => {
      const { total, rows } = await this.loadSheetRows(context, input);
      return {
        kind: 'wfh',
        total,
        rows: rows.map((row) => ({
          employeeId: row.employeeId,
          employeeCode: row.employeeCode,
          employeeName: row.employeeName,
          month: row.month,
          periodState: row.periodState,
          wfhDays: row.wfhDays,
          overLimit: row.wfhDays > WFH_MONTH_LIMIT,
        })),
      };
    },
  };
}
