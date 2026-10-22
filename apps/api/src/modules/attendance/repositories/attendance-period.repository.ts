import { HrResource, CompanyAction, EmployeeAction } from '../../hr/hr-authorization.types.js';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import {
  ProductCommandRejected,
  type ProductCommand,
  type ProductQuery,
} from '../../../authorization/services/product-authority.service.js';
import {
  HR_COMPANY_ID,
  HR_TODAY,
  WORK_CALENDAR_ID,
  hrScoped,
} from '../../hr/helpers/hr-database.helper.js';
import type {
  AttendancePeriodHistory,
  AttendancePeriodState,
  AttendancePeriodView,
  AttendanceQuery,
  PeriodCloseInput,
  PeriodReopenInput,
  PeriodResult,
} from '../attendance.types.js';
import { buildSnapshot, snapshotHash } from '../helpers/attendance-snapshot.helper.js';
import { totalsOf } from '../helpers/attendance-facts.helper.js';
import type { AttendanceFactsRepository } from './attendance-facts.repository.js';

export class AttendancePeriodRepository {
  readonly #facts: AttendanceFactsRepository;

  constructor(facts: AttendanceFactsRepository) {
    this.#facts = facts;
  }

  /** Row of the period locked FOR UPDATE (created if missing): HR close/reopen only. */
  async #lockPeriodForUpdate(manager: EntityManager, month: string) {
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
   * employee.readAttendance (matrix §5.2 attendance.read: self, HR; Root): the plan's scope on the
   * employee row, then the sheet of `month` (default: the current month by the DB clock in the
   * business timezone) computed from one consistent read.
   */
  readonly attendancePeriod: ProductQuery<AttendanceQuery, AttendancePeriodView | undefined> = {
    resource: HrResource.Employee,
    action: EmployeeAction.ReadAttendance,
    target: (input) => input.employeeId,
    run: async ({ tx, scope }, input) => {
      const bound = hrScoped(scope, input.employeeId, input.month);
      const [row] = await tx.manager.query<{ id: string; month: string }[]>(
        `SELECT r.id::text AS id, COALESCE(CAST(${bound.at(2)} AS text), to_char(${HR_TODAY}, 'YYYY-MM')) AS month
         FROM employee r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
        bound.parameters,
      );
      if (!row) return undefined;
      const [facts] = await this.#facts.loadAttendanceFacts(tx.manager, row.month, [row.id]);
      if (!facts) throw new Error('Employee facts are missing');
      return {
        employeeId: row.id,
        month: row.month,
        periodState: facts.periodState ?? 'open',
        ...totalsOf(row.month, facts),
      };
    },
  };

  /**
   * hrCompany.managePeriod, close (D07, F-10/F-12). The authorized anchor is the company row (not
   * the calendar row, which submit takes after the period: closing under the calendar lock would
   * invert that order). Takes the month FOR UPDATE, so it waits for every request/effect/calendar
   * writer holding it FOR SHARE and nothing new starts until it commits, computes the snapshot of
   * every employee of the month from one statement and stores it with its SHA-256 of the canonical
   * serialization (attendance-snapshot.helper.ts: fixed key and employee order, so unchanged inputs
   * hash identically after a reopen and a reader can re-verify the jsonb it reads back). Refused
   * (409) when already closed or when the month is after the current business month.
   */
  readonly closePeriod: ProductCommand<PeriodCloseInput, PeriodResult> = {
    resource: HrResource.Company,
    action: CompanyAction.ManagePeriod,
    mode: 'write',
    target: () => HR_COMPANY_ID,
    run: async (ctx, input) => {
      const { manager } = ctx.tx;
      const current = await this.#lockPeriodForUpdate(manager, input.month);
      if (current.state !== 'open') throw new ProductCommandRejected('invalid_transition');
      const [clock] = await manager.query<{ future: boolean }[]>(
        `SELECT CAST($1 || '-01' AS date) > make_date(EXTRACT(year FROM ${HR_TODAY})::int,
                EXTRACT(month FROM ${HR_TODAY})::int, 1) AS future`,
        [input.month],
      );
      if (clock?.future !== false) throw new ProductCommandRejected('future_period');
      const rows = await this.#facts.loadAttendanceFacts(manager, input.month, null);
      const [calendar] = await manager.query<{ version: string }[]>(
        `SELECT version::text AS version FROM work_calendar WHERE id = CAST($1 AS uuid)`,
        [WORK_CALENDAR_ID],
      );
      if (!calendar) throw new Error('Work calendar anchor is missing');
      const snapshot = buildSnapshot(
        input.month,
        calendar.version,
        rows.map((row) => ({ employeeId: row.id, ...totalsOf(input.month, row) })),
      );
      const hash = snapshotHash(snapshot);
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
        resource: HrResource.Company,
        key: ctx.target.key,
        objectId: ctx.target.objectId,
      });
      return { month: input.month, state: 'closed', version: updated.version };
    },
  };

  /** hrCompany.managePeriod, reopen with a reason (D07): the snapshot goes, the history stays. */
  readonly reopenPeriod: ProductCommand<PeriodReopenInput, PeriodResult> = {
    resource: HrResource.Company,
    action: CompanyAction.ManagePeriod,
    mode: 'write',
    target: () => HR_COMPANY_ID,
    run: async (ctx, input) => {
      const { manager } = ctx.tx;
      const current = await this.#lockPeriodForUpdate(manager, input.month);
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
        resource: HrResource.Company,
        key: ctx.target.key,
        objectId: ctx.target.objectId,
      });
      return { month: input.month, state: 'open', version: updated.version };
    },
  };

  /**
   * hrCompany.read on the company row: whether HR closed a month, its version and the history of
   * every close and reopen (D07), newest first, at most 50. A month nobody touched is `open`,
   * version 1, no events. Not the snapshot, its hash or the actor: the screen shows what happened
   * and why, the audit trail has who.
   */
  readonly attendancePeriodState: ProductQuery<
    { readonly month: string },
    AttendancePeriodHistory | undefined
  > = {
    resource: HrResource.Company,
    action: CompanyAction.Read,
    target: () => HR_COMPANY_ID,
    run: async ({ tx, scope }, input) => {
      const bound = hrScoped(scope, HR_COMPANY_ID, `${input.month}-01`);
      const [row] = await tx.manager.query<Omit<AttendancePeriodHistory, 'month'>[]>(
        `SELECT COALESCE(p.state, 'open') AS state, COALESCE(p.version, 1)::text AS version,
              COALESCE((SELECT json_agg(json_build_object('event', e.event, 'version', e.version::text,
                          'reason', e.reason,
                          'occurredAt', to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
                          ORDER BY e.version DESC)
                         FROM (SELECT * FROM attendance_period_event x WHERE x.month = CAST(${bound.at(2)} AS date)
                                ORDER BY x.version DESC LIMIT 50) e), '[]'::json) AS events
         FROM hr_company r
         LEFT JOIN attendance_period p ON p.month = CAST(${bound.at(2)} AS date)
        WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
        bound.parameters,
      );
      return row && { month: input.month, ...row };
    },
  };
}
