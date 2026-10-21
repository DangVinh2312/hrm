import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import {
  ProductAccessDenied,
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
  type ProductQuery,
} from '../authorization/services/product-authority.service.js';
import type { ProductTransaction } from '../database/product-transaction.runner.js';
import { HR_COMPANY_ID, HR_TODAY, WORK_CALENDAR_ID, hrScoped } from '../hr/hr-database.helper.js';
import { ApiRejection } from '../infrastructure/api-error.helper.js';
import {
  type AttendanceEffect,
  type AttendanceTotals,
  attendanceTotals,
} from './attendance-calculation.helper.js';
import type {
  ApprovedAttendanceEffect,
  ApprovedWfhEffect,
  AttendancePeriodState,
  AttendancePeriodView,
  AttendanceQuery,
  PeriodCloseInput,
  PeriodReopenInput,
  PeriodResult,
} from './attendance.types.js';

/** D04: the fifth WFH day of a month and every later one needs the approver's acknowledgement. */
export const WFH_MONTH_LIMIT = 4;

const date = (column: string) => `to_char(${column},'YYYY-MM-DD')`;

/** First day of the month of a `YYYY-MM-DD` / `YYYY-MM` string. */
const firstOfMonth = (value: string) => `${value.slice(0, 7)}-01`;

/** The distinct months (first days, ascending) of business dates. */
const monthsOf = (dates: readonly string[]) => [...new Set(dates.map(firstOfMonth))].sort();

/**
 * Everything the sheet of a month depends on, for the employees asked for (or, with `ids` =
 * `null`, every employee whose employment overlaps the month), from ONE statement: a single
 * snapshot, so the calendar version, the approved segments and the period state it reports are
 * consistent and recomputing with unchanged inputs returns the same numbers (F-08).
 */
interface AttendanceFactsRow {
  readonly id: string;
  readonly hiredOn: string;
  readonly terminatedOn: string | null;
  readonly calendarVersion: string;
  readonly periodState: AttendancePeriodState | null;
  readonly holidays: string[];
  readonly makeupDays: string[];
  readonly effects: AttendanceEffect[];
}

async function loadAttendanceFacts(
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
            COALESCE((SELECT json_agg(${date('d.day')} ORDER BY d.day) FROM days d WHERE d.kind = 'paid_holiday'), '[]'::json) AS holidays,
            COALESCE((SELECT json_agg(${date('d.day')} ORDER BY d.day) FROM days d WHERE d.kind = 'makeup_workday'), '[]'::json) AS "makeupDays",
            COALESCE((SELECT json_agg(json_build_object('kind', s.kind, 'date', ${date('s.work_date')},
                        'startMinute', s.start_minute, 'endMinute', s.end_minute)
                        ORDER BY s.work_date, s.kind, s.start_minute, s.end_minute)
                       FROM work_request r JOIN work_request_segment s ON s.request_id = r.id, m
                      WHERE r.employee_id = e.id AND r.state = 'approved'
                        AND s.work_date >= m.first AND s.work_date < m.next), '[]'::json) AS effects
       FROM employee e, m
      WHERE CASE WHEN CAST($2 AS uuid[]) IS NULL
                 THEN e.hired_on < m.next AND (e.terminated_on IS NULL OR e.terminated_on >= m.first)
                 ELSE e.id = ANY(CAST($2 AS uuid[])) END
      ORDER BY e.id`,
    [month, ids === null ? null : [...ids], WORK_CALENDAR_ID],
  );
}

const totalsOf = (month: string, row: AttendanceFactsRow): AttendanceTotals =>
  attendanceTotals({
    month,
    hiredOn: row.hiredOn,
    terminatedOn: row.terminatedOn,
    calendar: { paidHolidays: new Set(row.holidays), makeupDays: new Set(row.makeupDays) },
    effects: row.effects,
  });

/**
 * Spec §7.3 step 7: lock the attendance period of every month of `dates` FOR SHARE, ascending, and
 * refuse (409 `error.periodClosed`) when one is closed (D07). The row is upserted first
 * (`INSERT … ON CONFLICT DO NOTHING`) because a month nobody closed yet has no row, and a lock
 * on a missing row would let a close commit between this check and the caller's own commit. A
 * close takes the row FOR UPDATE, so it waits for every writer holding it and no writer starts
 * after it until it commits. Called by submit (after the employee lock), by the approval effects
 * (after the request and bucket locks) and by calendar changes (after the calendar row): the
 * period row is never held while waiting for a lock taken earlier in that order by anyone but
 * its own close, and a close takes no lock after it.
 * The loop is over the months of one request or day, never more than three.
 */
export async function assertPeriodsOpen(
  manager: EntityManager,
  dates: readonly string[],
): Promise<void> {
  for (const month of monthsOf(dates)) {
    await manager.query(
      `INSERT INTO attendance_period(month) VALUES (CAST($1 AS date)) ON CONFLICT DO NOTHING`,
      [month],
    );
    const [row] = await manager.query<{ state: AttendancePeriodState }[]>(
      `SELECT state FROM attendance_period WHERE month = CAST($1 AS date) FOR SHARE`,
      [month],
    );
    if (row?.state !== 'open') throw new ApiRejection('error.periodClosed');
  }
}

/** Segments of the locked request being approved, with its employee and kind. */
async function approvedRequest(manager: EntityManager, requestId: string) {
  const [request] = await manager.query<{ employeeId: string; kind: string }[]>(
    `SELECT employee_id::text AS "employeeId", kind FROM work_request WHERE id = CAST($1 AS uuid)`,
    [requestId],
  );
  if (!request) throw new Error('Effect on a missing request');
  const dates = (
    await manager.query<{ date: string }[]>(
      `SELECT ${date('work_date')} AS date FROM work_request_segment
        WHERE request_id = CAST($1 AS uuid) ORDER BY work_date`,
      [requestId],
    )
  ).map((s) => s.date);
  if (dates.length === 0) throw new Error('A request has no segment');
  return { ...request, dates };
}

/**
 * Attendance effect of an approval (design §6.2, §9): the approved request IS the effect — the
 * sheet reads the segments of `approved` requests, so there is no second copy to write or to
 * drift when a cancellation removes it (T7/D06). What the approval must still guarantee, in its
 * own transaction, is D07: every month the request touches is open, locked FOR SHARE until commit
 * (`assertPeriodsOpen`), so a close cannot slip between this check and the approval. Internal:
 * only a decision transaction that authorized the actor, locked the request row and any bucket
 * calls it (lock order: request → bucket → period, spec §7.3).
 */
export async function applyApprovedAttendance(
  tx: ProductTransaction,
  input: ApprovedAttendanceEffect,
): Promise<void> {
  const request = await approvedRequest(tx.manager, input.requestId);
  await assertPeriodsOpen(tx.manager, request.dates);
}

/**
 * WFH counter of an approval (D04, design §6.2). One counter row per (employee, month of the WFH
 * day): upserted with `INSERT … ON CONFLICT DO NOTHING` and locked FOR UPDATE in ascending month
 * order BEFORE any count is read, so two approvals racing for the fourth/fifth day serialize
 * even when the month has no row yet (never COUNT-then-INSERT). A month that would pass
 * `WFH_MONTH_LIMIT` is refused with `error.wfhLimitAckRequired` unless the approver acknowledged
 * the warning. Raised only inside the final decision, after the plan matched the request for the
 * approver, so the count is a fact the caller who may decide it can already read. Internal like
 * `applyApprovedLeave`: request lock held by the caller, no employee or calendar lock.
 */
export async function applyApprovedWfh(
  tx: ProductTransaction,
  input: ApprovedWfhEffect,
): Promise<void> {
  const { manager } = tx;
  const request = await approvedRequest(manager, input.requestId);
  if (request.kind !== 'wfh') throw new Error('WFH effect on a request that is not WFH');
  const months = monthsOf(request.dates);
  const days = months.map((month) => request.dates.filter((d) => firstOfMonth(d) === month).length);
  const counts: number[] = [];
  for (const month of months) {
    await manager.query(
      `INSERT INTO wfh_month_counter(employee_id, month) VALUES (CAST($1 AS uuid), CAST($2 AS date))
       ON CONFLICT DO NOTHING`,
      [request.employeeId, month],
    );
    const [row] = await manager.query<{ count: number }[]>(
      `SELECT approved_count AS count FROM wfh_month_counter
        WHERE employee_id = CAST($1 AS uuid) AND month = CAST($2 AS date) FOR UPDATE`,
      [request.employeeId, month],
    );
    if (!row) throw new Error('WFH counter is missing after its upsert');
    counts.push(row.count);
  }
  if (!input.acknowledgeWfhLimit && counts.some((n, i) => n + (days[i] ?? 0) > WFH_MONTH_LIMIT))
    throw new ApiRejection('error.wfhLimitAckRequired');
  for (const [i, month] of months.entries())
    await manager.query(
      `UPDATE wfh_month_counter SET approved_count = approved_count + $3, revision = revision + 1
        WHERE employee_id = CAST($1 AS uuid) AND month = CAST($2 AS date)`,
      [request.employeeId, month, days[i]],
    );
}

/**
 * Approved WFH days of an employee in the month of each of `dates`, plus these dates, as the
 * submit warning `wfhLimitExceeded` (D04, D-07): a plain read without lock — the approver
 * rechecks under the counter lock, so a stale warning never lets a day through.
 */
export async function wfhLimitExceeded(
  manager: EntityManager,
  employeeId: string,
  dates: readonly string[],
): Promise<boolean> {
  const months = monthsOf(dates);
  const rows = await manager.query<{ month: string; count: number }[]>(
    `SELECT ${date('month')} AS month, approved_count AS count FROM wfh_month_counter
      WHERE employee_id = CAST($1 AS uuid) AND month = ANY(CAST($2 AS date[]))`,
    [employeeId, months],
  );
  return months.some(
    (month) =>
      (rows.find((r) => r.month === month)?.count ?? 0) +
        dates.filter((d) => firstOfMonth(d) === month).length >
      WFH_MONTH_LIMIT,
  );
}

/**
 * employee.readAttendance (matrix §5.2 attendance.read: self, HR; Root): the plan's scope on the
 * employee row, then the sheet of `month` (default: the current month by the DB clock in the
 * business timezone) computed from one consistent read.
 */
export const attendancePeriod: ProductQuery<AttendanceQuery, AttendancePeriodView | undefined> = {
  resource: 'employee',
  action: 'readAttendance',
  target: (input) => input.employeeId,
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(scope, input.employeeId, input.month);
    const [row] = await tx.manager.query<{ id: string; month: string }[]>(
      `SELECT r.id::text AS id, COALESCE(CAST(${bound.at(2)} AS text), to_char(${HR_TODAY}, 'YYYY-MM')) AS month
         FROM employee r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
      bound.parameters,
    );
    if (!row) return undefined;
    const [facts] = await loadAttendanceFacts(tx.manager, row.month, [row.id]);
    if (!facts) throw new Error('Employee facts are missing');
    return {
      employeeId: row.id,
      month: row.month,
      periodState: facts.periodState ?? 'open',
      ...totalsOf(row.month, facts),
    };
  },
};

/** Row of the period locked FOR UPDATE (created if missing): HR close/reopen only. */
async function lockPeriodForUpdate(manager: EntityManager, month: string) {
  await manager.query(
    `INSERT INTO attendance_period(month) VALUES (CAST($1 AS date)) ON CONFLICT DO NOTHING`,
    [`${month}-01`],
  );
  const [row] = await manager.query<{ state: AttendancePeriodState; version: string }[]>(
    `SELECT state, version::text AS version FROM attendance_period
      WHERE month = CAST($1 AS date) FOR UPDATE`,
    [`${month}-01`],
  );
  if (!row) throw new Error('Attendance period is missing after its upsert');
  return row;
}

/**
 * hrCompany.managePeriod, close (D07, F-10/F-12). The authorized anchor is the company row (not
 * the calendar row, which submit takes after the period: closing under the calendar lock would
 * invert that order). Takes the month FOR UPDATE, so it waits for every request/effect/calendar
 * writer holding it FOR SHARE and nothing new starts until it commits, computes the snapshot of
 * every employee of the month from one statement and stores it with its SHA-256 (JSON written in
 * a fixed key and employee order, so unchanged inputs hash identically after a reopen). Refused
 * (409) when already closed or when the month is after the current business month.
 */
export const closePeriod: ProductCommand<PeriodCloseInput, PeriodResult> = {
  resource: 'hrCompany',
  action: 'managePeriod',
  mode: 'write',
  target: () => HR_COMPANY_ID,
  run: async (ctx, input) => {
    const { manager } = ctx.tx;
    const current = await lockPeriodForUpdate(manager, input.month);
    if (current.state !== 'open') throw new ProductCommandRejected('invalid_transition');
    const [clock] = await manager.query<{ future: boolean }[]>(
      `SELECT CAST($1 || '-01' AS date) > make_date(EXTRACT(year FROM ${HR_TODAY})::int,
                EXTRACT(month FROM ${HR_TODAY})::int, 1) AS future`,
      [input.month],
    );
    if (clock?.future !== false) throw new ProductCommandRejected('future_period');
    const rows = await loadAttendanceFacts(manager, input.month, null);
    const [calendar] = await manager.query<{ version: string }[]>(
      `SELECT version::text AS version FROM work_calendar WHERE id = CAST($1 AS uuid)`,
      [WORK_CALENDAR_ID],
    );
    if (!calendar) throw new Error('Work calendar anchor is missing');
    const snapshot = {
      month: input.month,
      calendarVersion: calendar.version,
      employees: rows.map((row) => ({ employeeId: row.id, ...totalsOf(input.month, row) })),
    };
    const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const [updated] = await manager.query<{ version: string }[]>(
      `WITH updated AS (UPDATE attendance_period SET state = 'closed', version = version + 1,
              snapshot = CAST($2 AS jsonb), snapshot_hash = $3
        WHERE month = CAST($1 AS date) RETURNING version::text AS version)
       SELECT version FROM updated`,
      [`${input.month}-01`, JSON.stringify(snapshot), hash],
    );
    if (!updated) throw new Error('Attendance period close returned no row');
    await manager.query(
      `INSERT INTO attendance_period_event(id, month, version, event, snapshot_hash, actor_account_id)
       VALUES ($1, CAST($2 AS date), CAST($3 AS int8), 'close', $4, $5)`,
      [randomUUID(), `${input.month}-01`, updated.version, hash, ctx.actor.id],
    );
    await ctx.audit('hr.attendance-period.close', {
      resource: 'hrCompany',
      key: ctx.target.key,
      objectId: ctx.target.objectId,
    });
    return { month: input.month, state: 'closed', version: updated.version };
  },
};

/** hrCompany.managePeriod, reopen with a reason (D07): the snapshot goes, the history stays. */
export const reopenPeriod: ProductCommand<PeriodReopenInput, PeriodResult> = {
  resource: 'hrCompany',
  action: 'managePeriod',
  mode: 'write',
  target: () => HR_COMPANY_ID,
  run: async (ctx, input) => {
    const { manager } = ctx.tx;
    const current = await lockPeriodForUpdate(manager, input.month);
    if (current.state !== 'closed') throw new ProductCommandRejected('invalid_transition');
    const [updated] = await manager.query<{ version: string }[]>(
      `WITH updated AS (UPDATE attendance_period SET state = 'open', version = version + 1,
              snapshot = NULL, snapshot_hash = NULL
        WHERE month = CAST($1 AS date) RETURNING version::text AS version)
       SELECT version FROM updated`,
      [`${input.month}-01`],
    );
    if (!updated) throw new Error('Attendance period reopen returned no row');
    await manager.query(
      `INSERT INTO attendance_period_event(id, month, version, event, reason, actor_account_id)
       VALUES ($1, CAST($2 AS date), CAST($3 AS int8), 'reopen', $4, $5)`,
      [randomUUID(), `${input.month}-01`, updated.version, input.reason, ctx.actor.id],
    );
    await ctx.audit('hr.attendance-period.reopen', {
      resource: 'hrCompany',
      key: ctx.target.key,
      objectId: ctx.target.objectId,
    });
    return { month: input.month, state: 'open', version: updated.version };
  },
};

export const attendanceCommands = [closePeriod, reopenPeriod] as const;

export const attendanceQueries = [attendancePeriod] as const;

/** Attendance operations bound to the registered commands/queries (T8). */
export class AttendanceService {
  constructor(private readonly authorization: ProductAuthorization) {}

  /** `undefined`: absent or outside the caller's scope (404). */
  period(secret: string, query: AttendanceQuery): Promise<AttendancePeriodView | undefined> {
    return this.authorization.query(secret, attendancePeriod, query);
  }

  async closePeriod(secret: string, input: PeriodCloseInput): Promise<PeriodResult> {
    const result = await this.authorization.execute(secret, closePeriod, input);
    // The company anchor always exists, so "not visible" means no grant (403), as for the calendar.
    if (!result) throw new ProductAccessDenied();
    return result;
  }

  async reopenPeriod(secret: string, input: PeriodReopenInput): Promise<PeriodResult> {
    const result = await this.authorization.execute(secret, reopenPeriod, input);
    if (!result) throw new ProductAccessDenied();
    return result;
  }
}
