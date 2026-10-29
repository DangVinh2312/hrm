import { EmployeeAction, EmployeeResource } from '../../employee/employee-authorization.types.js';
import { WorkRequestAction, WorkRequestResource } from '../work-request-authorization.types.js';
import { randomUUID } from 'node:crypto';
import { CompanyAction, CompanyResource } from '../../permission/permission-authorization.types.js';
import { ProductInvalidRequest } from '../../../authorization/product-data.gateway.js';
import {
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
} from '../../../authorization/services/product-authority.service.js';
import { ApiRejection } from '../../../infrastructure/helpers/api-error.helper.js';
import { COMPANY_ID, WORK_CALENDAR_ID } from '../../permission/permission-database.helper.js';
import {
  BUSINESS_TODAY,
  currentWindow,
} from '../../../infrastructure/helpers/business-time.helper.js';
import type { PermissionObjectRepository } from '../../permission/permission-object.repository.js';
import type { AttendanceFactsRepository } from '../../attendance/repositories/attendance-facts.repository.js';
import type { AttendanceEffectRepository } from '../../attendance/repositories/attendance-effect.repository.js';
import type { LeaveEffectRepository } from '../../leave/repositories/leave-effect.repository.js';
import type { SettingReadRepository } from '../../setting/repositories/setting-read.repository.js';
import { SettingKey } from '../../setting/setting.registry.js';
import { type ApprovedEffects, requiredEffects } from './request-approval.service.js';
import {
  type BookedSegment,
  WorkRequestRejected,
  conflicts,
  initialState,
  requestDates,
  requestSegments,
} from '../helpers/work-request.helper.js';
import type {
  RequestDetailView,
  RequestListQuery,
  RequestListView,
  SubmitRequestInput,
  SubmitResult,
} from '../work-request.types.js';
import { date } from '../helpers/work-request-sql.helper.js';
import {
  SubmitReplayed,
  SubmitterNotFound,
  payloadHash,
  ruleCodes,
  submitRuleKeys,
} from '../helpers/work-request-submit.helper.js';
import type { WorkRequestReadRepository } from '../repositories/work-request-read.repository.js';

const OPERATION = 'workRequest.submit';

/** Input of the registered command: the target employee comes from `submitter`, never a body. */
export interface SubmitCommandInput {
  readonly employeeId: string;
  readonly key: string;
  /** SHA-256 hex of the normalized request, computed outside SQL. */
  readonly hash: string;
  readonly request: SubmitRequestInput;
}

/**
 * employee.submitRequest (design §6.2 `submit`, §7.3). `execute` has matched the plan
 * (`selfEmployee`) on the employee row and locked it FOR NO KEY UPDATE. `employee.account_id` is
 * UNIQUE, so this lock serializes every submit of one account: the idempotency read, the overlap
 * check and the inserts below cannot race (B-13). Lock order (spec §7.3): employee →
 * idempotency read → work_calendar FOR SHARE → inserts; every other writer must keep it.
 * Annual leave is checked against the accrued balance (D09, T7, `assertLeaveAvailable`): no
 * bucket lock is needed here, the employee lock serializes this account's submits and a
 * concurrent decision keeps pending + approved unchanged. The pending annual-leave rows T5
 * accepted before this check are listed for HR by `leaveReconciliation`, never changed.
 * Closed months (D07, T8): every month of the request's dates is locked FOR SHARE right after the
 * idempotency read and before the calendar (spec §7.3 steps 7 → 8), and a closed one is refused
 * with 409 `error.periodClosed`. A WFH request answers `wfhLimitExceeded` when its days would pass
 * `hr.wfhMonthLimit` approved WFH days in a month (default 4) (D04, D-07): a warning from an unlocked read, the final approver
 * rechecks under the counter lock. No leave or attendance effect is written at submit
 * (requirement §4.3, §9).
 * A COO's own request is approved here (spec §6.4 (1), C-26, D-10): after the inserts, in this
 * transaction, the effects of its kind run exactly as a final approval would (leave bucket, WFH
 * counter with the warning acknowledged, attendance period FOR SHARE), then the system decision
 * `coo_self_approved` is written and the request is born `approved` at version 1. A composition
 * without a handler for the kind refuses before anything is written (`final_approval_unavailable`,
 * fail closed). Lock order: employee → period FOR SHARE → calendar FOR SHARE → bucket → counter →
 * period FOR SHARE (again, a no-op). Nobody holds a bucket or counter while waiting for the
 * employee, the calendar or an earlier period, so no cycle (T8 part B).
 */
export const createSubmitRequest = (
  objects: PermissionObjectRepository,
  effects: ApprovedEffects,
  attendanceFacts: AttendanceFactsRepository,
  attendanceEffects: AttendanceEffectRepository,
  leaveEffects: LeaveEffectRepository,
  settings: SettingReadRepository,
): ProductCommand<SubmitCommandInput, SubmitResult> => ({
  resource: EmployeeResource.Employee,
  action: EmployeeAction.SubmitRequest,
  mode: 'write',
  target: (input) => input.employeeId,
  run: async (ctx, input) => {
    const { request } = input;
    const [prior] = await ctx.tx.manager.query<{ hash: string; result: SubmitResult }[]>(
      `SELECT payload_hash AS hash, result FROM hr_idempotency
        WHERE actor_id = $1 AND operation = $2 AND key = CAST($3 AS uuid)`,
      [ctx.actor.id, OPERATION, input.key],
    );
    if (prior) {
      // The key space is the actor's own (PK starts with actor_id): says nothing about others.
      if (prior.hash !== input.hash) throw new ApiRejection('error.idempotencyKeyReused');
      throw new SubmitReplayed(prior.result);
    }
    // The rules in force now, one read for the whole submit: window, size and the WFH
    // limit of the warning. A replay above is judged by the rules it was accepted under.
    const rules = await settings.read(ctx.tx.manager, submitRuleKeys);
    if (requestDates(request).length > rules[SettingKey.RequestMaxDays])
      throw new ProductInvalidRequest('Invalid days');
    // Spec §7.3 step 7: the months of the request, before the calendar lock of the next query.
    await attendanceFacts.assertPeriodsOpen(ctx.tx.manager, requestDates(request));
    // The plan already requires the account link; Root (never linked) cannot submit for anyone.
    const [facts] = await ctx.tx.manager.query<
      {
        earliest: string;
        latest: string;
        team: string | null;
        leads: boolean;
        calendar: string | null;
      }[]
    >(
      `SELECT ${date(`${BUSINESS_TODAY} - CAST($5 AS int)`)} AS earliest,
              ${date(`${BUSINESS_TODAY} + CAST($6 AS int)`)} AS latest,
              m.team_id::text AS team,
              EXISTS (SELECT 1 FROM team_lead_assignment l WHERE l.team_id = m.team_id
                       AND l.lead_employee_id = e.id AND ${currentWindow('l')}) AS leads,
              (SELECT c.version::text FROM work_calendar c WHERE c.id = $4 FOR SHARE) AS calendar
         FROM employee e
         LEFT JOIN team_membership m ON m.employee_id = e.id AND ${currentWindow('m')}
              AND (CASE WHEN CAST($3 AS uuid) IS NULL THEN m.is_primary ELSE m.team_id = CAST($3 AS uuid) END)
        WHERE e.id = $1 AND e.account_id = $2`,
      [
        ctx.target.key,
        ctx.actor.id,
        request.teamId,
        WORK_CALENDAR_ID,
        rules[SettingKey.RequestWindowPastDays],
        rules[SettingKey.RequestWindowFutureDays],
      ],
    );
    if (!facts) throw new SubmitterNotFound();
    if (!facts.calendar) throw new Error('Work calendar anchor is missing');
    // One answer for every team id that is not a current team of the caller (or no primary
    // team): whether that id exists or who is in it is never told (C-23).
    if (!facts.team) throw new ApiRejection('error.teamNotMember');
    const dates = requestDates(request);
    // Day kinds at the calendar version locked FOR SHARE above (a concurrent change waits), and
    // the status period covering each date (written only under this employee lock).
    const days = await ctx.tx.manager.query<
      { day: string; kind: string | null; status: string | null }[]
    >(
      `SELECT ${date('d')} AS day,
              (SELECT x.kind FROM work_calendar_change x WHERE x.day = d AND x.version <= CAST($3 AS int8)
                ORDER BY x.version DESC LIMIT 1) AS kind,
              (SELECT p.status FROM employment_status_period p WHERE p.employee_id = $1
                 AND p.starts_on <= d AND (p.ends_on IS NULL OR p.ends_on > d)) AS status
         FROM unnest(CAST($2 AS date[])) AS d`,
      [ctx.target.key, dates, facts.calendar],
    );
    const status = new Map(days.map((d) => [d.day, d.status]));
    let segments;
    try {
      segments = requestSegments(request, {
        earliest: facts.earliest,
        latest: facts.latest,
        calendar: {
          paidHolidays: new Set(days.filter((d) => d.kind === 'paid_holiday').map((d) => d.day)),
          makeupDays: new Set(days.filter((d) => d.kind === 'makeup_workday').map((d) => d.day)),
        },
        statusOn: (day) => {
          const value = status.get(day);
          return value === 'probation' || value === 'official' ? value : undefined;
        },
      });
    } catch (error) {
      if (error instanceof WorkRequestRejected) {
        const code = ruleCodes[error.reason];
        throw code ? new ApiRejection(code) : new ProductInvalidRequest(error.reason);
      }
      throw error;
    }
    const booked = await ctx.tx.manager.query<BookedSegment[]>(
      `SELECT r.kind, ${date('s.work_date')} AS date, s.start_minute AS "startMinute", s.end_minute AS "endMinute"
         FROM work_request r JOIN work_request_segment s ON s.request_id = r.id
        WHERE r.employee_id = $1 AND r.state IN ('pending_lead','pending_final','approved')
          AND s.work_date = ANY(CAST($2 AS date[]))`,
      [ctx.target.key, dates],
    );
    // `booked` holds only this employee's requests; the key never says which one overlaps.
    if (conflicts(request.kind, segments, booked))
      throw new ApiRejection('error.overlappingRequest');
    if (request.kind === 'annual-leave')
      await leaveEffects.assertLeaveAvailable(
        ctx.tx.manager,
        ctx.target.key,
        segments.map((s) => ({ date: s.date, minutes: s.minutes })),
      );
    // The submitter is a COO when the company's final step is theirs by permission, whichever
    // role carries it; the right to approve this very request is checked below.
    const submitterIsCoo = await ctx.reaches(
      CompanyResource.Company,
      CompanyAction.Approvals,
      COMPANY_ID,
    );
    const start = initialState({ submitterIsCoo, submitterLeadsTeam: facts.leads });
    // All parts must exist before anything is written (the final-approval gate, §6.3 invariant 5).
    const selfEffects =
      start.state === 'approved' ? requiredEffects[request.kind].map((part) => effects[part]) : [];
    if (selfEffects.some((effect) => effect === undefined))
      throw new ProductCommandRejected('final_approval_unavailable');
    // The D04 warning is read before this request's own days can reach the counter.
    const exceeded =
      request.kind === 'wfh'
        ? await attendanceEffects.wfhLimitExceeded(
            ctx.tx.manager,
            ctx.target.key,
            dates,
            rules[SettingKey.WfhMonthLimit],
          )
        : undefined;

    const id = randomUUID();
    const objectId = await objects.register(ctx.tx, WorkRequestResource.WorkRequest, id);
    await ctx.tx.manager.query(
      `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        objectId,
        ctx.target.key,
        ctx.actor.id,
        facts.team,
        request.kind,
        // A COO's request is written as `pending_final` first: the decision-right check below
        // evaluates the real plan of `workRequest.decideFinal` (its policy scope is that state)
        // on this very row, and the row becomes `approved` after the effects.
        start.state === 'approved' ? 'pending_final' : start.state,
        request.reason,
      ],
    );
    await ctx.tx.manager.query(
      `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
       SELECT $1, $2, s.d, s.a, s.b, s.m
         FROM unnest(CAST($3 AS date[]), CAST($4 AS int2[]), CAST($5 AS int2[]), CAST($6 AS int2[])) AS s(d,a,b,m)`,
      [
        id,
        request.kind,
        segments.map((s) => s.date),
        segments.map((s) => s.startMinute),
        segments.map((s) => s.endMinute),
        segments.map((s) => s.minutes),
      ],
    );
    if (start.state === 'approved') {
      // §6.4 (1) is a final approval by the submitter: it needs the same right as `decide`
      // (grant, policy scope, deny rules, boundaries), not only the role. Without it the request
      // is refused like any COO request the gate cannot approve, and nothing is written [P].
      if (!(await ctx.reaches(WorkRequestResource.WorkRequest, WorkRequestAction.DecideFinal, id)))
        throw new ProductCommandRejected('final_approval_unavailable');
      for (const effect of selfEffects) await effect?.(ctx, id, { acknowledgeWfhLimit: true });
      await ctx.tx.manager.query(
        `UPDATE work_request SET state = 'approved' WHERE id = $1 AND state = 'pending_final'`,
        [id],
      );
    }
    if (start.systemDecision)
      await ctx.tx.manager.query(
        `INSERT INTO request_decision(id,request_id,stage,decision,actor_kind,system_reason)
         VALUES($1,$2,$3,$4,'system',$5)`,
        [
          randomUUID(),
          id,
          start.state === 'approved' ? 'final' : 'lead',
          start.state === 'approved' ? 'approve' : 'skip',
          start.systemDecision,
        ],
      );
    const result: SubmitResult = {
      id,
      state: start.state,
      version: '1',
      ...(exceeded === undefined ? {} : { wfhLimitExceeded: exceeded }),
    };
    await ctx.tx.manager.query(
      `INSERT INTO hr_idempotency(actor_id,operation,key,payload_hash,target_id,result)
       VALUES($1,$2,CAST($3 AS uuid),$4,$5,CAST($6 AS jsonb))`,
      [ctx.actor.id, OPERATION, input.key, input.hash, id, JSON.stringify(result)],
    );
    await ctx.audit('hr.request.submit', {
      resource: WorkRequestResource.WorkRequest,
      key: id,
      objectId,
    });
    if (start.state === 'approved')
      await ctx.audit('hr.request.self-approve', {
        resource: WorkRequestResource.WorkRequest,
        key: id,
        objectId,
      });
    return result;
  },
});

export type SubmitRequestCommand = ReturnType<typeof createSubmitRequest>;

export const workRequestCommands = (submitRequest: SubmitRequestCommand) =>
  [submitRequest] as const;

export const workRequestQueries = (reads: WorkRequestReadRepository) =>
  [reads.submitter, reads.ownRequests, reads.requestDetail, reads.leadRejectedDetail] as const;

/** Work request operations bound to the registered command/queries (T5). */
export class WorkRequestService {
  /** `command` is the registered submit command; tests may pass one over their own effect set. */
  constructor(
    private readonly authorization: ProductAuthorization,
    private readonly command: SubmitRequestCommand,
    private readonly reads: WorkRequestReadRepository,
  ) {}

  /**
   * `undefined`: no own profile reachable through employee.submitRequest (no role, no profile,
   * Root) — HTTP 404. A replay rechecks that permission in its own transaction (C-19).
   */
  async submit(
    secret: string,
    key: string,
    request: SubmitRequestInput,
  ): Promise<SubmitResult | undefined> {
    const employeeId = await this.authorization.query(secret, this.reads.submitter, undefined);
    if (employeeId === undefined) return undefined;
    try {
      return await this.authorization.execute(secret, this.command, {
        employeeId,
        key,
        hash: payloadHash(request),
        request,
      });
    } catch (error) {
      if (error instanceof SubmitReplayed) return error.result;
      if (error instanceof SubmitterNotFound) return undefined;
      throw error;
    }
  }

  list(secret: string, query: RequestListQuery): Promise<RequestListView> {
    return this.authorization.query(secret, this.reads.ownRequests, query);
  }

  /**
   * `workRequest.read`, else the COO's `readLeadRejected`; absent and unreadable are both
   * `undefined` (404). The second plan is empty for everyone else, so nothing widens.
   */
  async detail(secret: string, requestId: string): Promise<RequestDetailView | undefined> {
    const input = { requestId };
    return (
      (await this.authorization.query(secret, this.reads.requestDetail, input)) ??
      (await this.authorization.query(secret, this.reads.leadRejectedDetail, input))
    );
  }
}
