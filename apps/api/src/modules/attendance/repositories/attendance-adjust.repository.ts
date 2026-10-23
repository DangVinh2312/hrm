import { EmployeeAction, EmployeeResource } from '../../employee/employee-authorization.types.js';
import { randomUUID } from 'node:crypto';
import {
  ProductAccessDenied,
  ProductCommandRejected,
  type ProductCommand,
  type ProductQuery,
} from '../../../authorization/services/product-authority.service.js';
import { ApiRejection } from '../../../infrastructure/helpers/api-error.helper.js';
import { WORK_CALENDAR_ID, scopedParameters } from '../../permission/permission-database.helper.js';
import { replay } from '../../../infrastructure/helpers/idempotency.helper.js';
import type {
  AttendanceAdjustmentCommand,
  AttendanceAdjustmentList,
  AttendanceAdjustmentQuery,
  AttendanceAdjustmentResult,
} from '../attendance.types.js';
import { adjustmentMinutesSql, date, totalsOf } from '../helpers/attendance-facts.helper.js';
import type { AttendanceFactsRepository } from './attendance-facts.repository.js';

export const ADJUST_OPERATION = 'attendance.adjust';

/** Same actor, operation, key and payload already committed: roll back, answer the stored result. */
export class AttendanceAdjustmentReplayed extends Error {
  constructor(readonly result: AttendanceAdjustmentResult) {
    super('Attendance adjustment replayed');
  }
}

export class AttendanceAdjustRepository {
  readonly #facts: AttendanceFactsRepository;

  constructor(facts: AttendanceFactsRepository) {
    this.#facts = facts;
  }

  /**
   * employee.adjustAttendance (matrix §5.2 `attendance.adjust`: HR, fresh session, open month;
   * user decision 2026-10-22): appends ONE signed paid-minutes entry for the employee `execute`
   * locked and one day of their employment. The entry never changes a request, the calendar or the
   * leave ledger. Lock order (spec §7.3 / ADR 0017 §2, same as a submit): employee (held as the
   * target) → idempotency read → period of the day's month FOR SHARE (closed → 409
   * `error.periodClosed`) → calendar FOR SHARE (the total is computed from the calendar of one
   * version) → entry, claim, audit. A close takes the month FOR UPDATE, so it waits for this
   * transaction or finds the entry; no lock is taken after the period that a close, a calendar
   * change or a submit holds while waiting for it.
   * The month's paid total with this entry must stay >= 0: it is computed from the same statement
   * as the sheet (`loadAttendanceFacts`) under those locks, and two adjustments of one employee are
   * serialized by the employee lock, so the check cannot be overtaken by another adjustment.
   * HR cannot adjust the employee linked to their own account (guard below, same as `linkAccount`'s `self_link`).
   * shortcut: approving unpaid leave, terminating the employee or changing the calendar do not
   * re-check the total (they take no employee lock); a month driven below zero that way shows as
   * the arithmetic result and HR corrects it with a positive entry (ADR 0018 bổ sung 2026-10-22).
   */
  readonly adjustAttendance: ProductCommand<
    AttendanceAdjustmentCommand,
    AttendanceAdjustmentResult
  > = {
    resource: EmployeeResource.Employee,
    action: EmployeeAction.AdjustAttendance,
    mode: 'write',
    target: (input) => input.employeeId,
    run: async (ctx, input) => {
      const { manager } = ctx.tx;
      // Nobody adjusts their own attendance (user decision 2026-10-22, ADR 0018): the actor is the
      // verified session's account, the target's link is read under the employee lock `execute`
      // holds, so a link moved at commit cannot slip past. Root is never linked (a link needs
      // `kind = 'iam'`) so it is not caught. Refused before the idempotency read: no claim, no
      // entry, no audit; 403 `error.accessDenied` is allowed because HR already reads this row.
      const [owner] = await manager.query<{ linked: boolean }[]>(
        'SELECT account_id = $2 AS linked FROM employee WHERE id = $1',
        [ctx.target.key, ctx.actor.id],
      );
      if (owner?.linked === true) throw new ProductAccessDenied();
      const [prior] = await manager.query<{ hash: string; result: AttendanceAdjustmentResult }[]>(
        `SELECT payload_hash AS hash, result FROM hr_idempotency
        WHERE actor_id = $1 AND operation = $2 AND key = CAST($3 AS uuid)`,
        [ctx.actor.id, ADJUST_OPERATION, input.idempotencyKey],
      );
      if (prior) throw new AttendanceAdjustmentReplayed(replay(prior, input.hash));
      const [employee] = await manager.query<{ employed: boolean }[]>(
        `SELECT hired_on <= CAST($2 AS date)
              AND (terminated_on IS NULL OR terminated_on >= CAST($2 AS date)) AS employed
         FROM employee WHERE id = $1`,
        [ctx.target.key, input.workDate],
      );
      if (!employee?.employed) throw new ProductCommandRejected('outside_employment');
      await this.#facts.assertPeriodsOpen(manager, [input.workDate]);
      await manager.query('SELECT 1 FROM work_calendar WHERE id = CAST($1 AS uuid) FOR SHARE', [
        WORK_CALENDAR_ID,
      ]);
      const month = input.workDate.slice(0, 7);
      const [facts] = await this.#facts.loadAttendanceFacts(manager, month, [ctx.target.key]);
      if (!facts) throw new Error('Employee facts are missing');
      if (totalsOf(month, facts).paidMinutes + input.minutes < 0)
        throw new ProductCommandRejected('negative_total');
      const id = randomUUID();
      await manager.query(
        `INSERT INTO attendance_adjustment(id, employee_id, work_date, minutes, reason, reference, actor_account_id)
       VALUES ($1, $2, CAST($3 AS date), $4, $5, $6, $7)`,
        [
          id,
          ctx.target.key,
          input.workDate,
          input.minutes,
          input.reason,
          input.reference,
          ctx.actor.id,
        ],
      );
      const result: AttendanceAdjustmentResult = { id };
      // Two adjustments with one key for two employees are not serialized by an employee lock: the
      // later claim waits for the first and then inserts nothing — a reused key.
      const claimed = await manager.query<unknown[]>(
        `INSERT INTO hr_idempotency(actor_id,operation,key,payload_hash,target_id,result)
       VALUES($1,$2,CAST($3 AS uuid),$4,$5,CAST($6 AS jsonb))
       ON CONFLICT DO NOTHING RETURNING 1`,
        [
          ctx.actor.id,
          ADJUST_OPERATION,
          input.idempotencyKey,
          input.hash,
          ctx.target.key,
          JSON.stringify(result),
        ],
      );
      if (claimed.length !== 1) throw new ApiRejection('error.idempotencyKeyReused');
      // Ids and kind only: the minutes, the day, the reason and the reference stay out of audit.
      await ctx.audit('hr.attendance.adjust', {
        resource: EmployeeResource.Employee,
        key: ctx.target.key,
        objectId: ctx.target.objectId,
      });
      return result;
    },
  };

  /**
   * employee.readAttendanceAdjustment (HR, company scope): the entries of one month for one
   * employee, newest day first, with the month's signed total and an exact count. The plan's scope
   * is ANDed into the employee lookup, so an employee outside it is `undefined` (404), like absent.
   * The actor is not shown (the audit trail has who); the reason is read by HR only.
   */
  readonly attendanceAdjustments: ProductQuery<
    AttendanceAdjustmentQuery,
    AttendanceAdjustmentList | undefined
  > = {
    resource: EmployeeResource.Employee,
    action: EmployeeAction.ReadAttendanceAdjustment,
    target: (input) => input.employeeId,
    run: async ({ tx, scope }, input) => {
      const bound = scopedParameters(
        scope,
        input.employeeId,
        `${input.month}-01`,
        input.limit,
        input.offset,
      );
      const [row] = await tx.manager.query<{ result: AttendanceAdjustmentList }[]>(
        `SELECT json_build_object(
          'employeeId', r.id::text, 'month', to_char(m.first, 'YYYY-MM'),
          'periodState', COALESCE((SELECT p.state FROM attendance_period p WHERE p.month = m.first), 'open'),
          'adjustmentMinutes', ${adjustmentMinutesSql('r.id', 'm.first', 'm.next')},
          'total', (SELECT count(*) FROM attendance_adjustment a
                     WHERE a.employee_id = r.id AND a.work_date >= m.first AND a.work_date < m.next)::text,
          'items', COALESCE((SELECT json_agg(json_build_object(
                      'id', x.id::text, 'workDate', ${date('x.work_date')}, 'minutes', x.minutes,
                      'reason', x.reason, 'reference', x.reference,
                      'createdAt', to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
                      ORDER BY x.work_date DESC, x.created_at DESC, x.id DESC)
                     FROM (SELECT a.id, a.work_date, a.minutes, a.reason, a.reference, a.created_at
                             FROM attendance_adjustment a
                            WHERE a.employee_id = r.id AND a.work_date >= m.first AND a.work_date < m.next
                            ORDER BY a.work_date DESC, a.created_at DESC, a.id DESC
                            LIMIT CAST(${bound.at(3)} AS int8) OFFSET CAST(${bound.at(4)} AS int8)) x), '[]'::json)
        ) AS result
         FROM employee r,
              LATERAL (SELECT CAST(${bound.at(2)} AS date) AS first,
                              CAST(CAST(${bound.at(2)} AS date) + interval '1 month' AS date) AS next) m
        WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
        bound.parameters,
      );
      return row?.result;
    },
  };
}
