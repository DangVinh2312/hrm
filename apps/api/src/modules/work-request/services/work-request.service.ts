import { createHash, randomUUID } from 'node:crypto';
import { ProductInvalidRequest } from '../../../authorization/product-data.gateway.js';
import {
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
} from '../../../authorization/services/product-authority.service.js';
import { ApiRejection, type ApiRejectionCode } from '../../../infrastructure/api-error.helper.js';
import {
  HR_TODAY,
  WORK_CALENDAR_ID,
  hrCurrent,
  registerHrObject,
} from '../../hr/hr-database.helper.js';
import { assertPeriodsOpen } from '../../attendance/attendance-facts.repository.js';
import { wfhLimitExceeded } from '../../attendance/attendance-effect.helper.js';
import { assertLeaveAvailable } from '../../leave/leave-effect.helper.js';
import {
  type ApprovedEffects,
  approvedEffects,
  requiredEffects,
} from './request-approval.service.js';
import {
  type BookedSegment,
  type WorkRequestRejection,
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
  ownRequests,
  requestDetail,
  leadRejectedDetail,
  submitter,
} from '../work-request-read.repository.js';

const OPERATION = 'workRequest.submit';

/** Input of the registered command: the target employee comes from `submitter`, never a body. */
export interface SubmitCommandInput {
  readonly employeeId: string;
  readonly key: string;
  /** SHA-256 hex of the normalized request, computed outside SQL (ADR 0017 §4). */
  readonly hash: string;
  readonly request: SubmitRequestInput;
}

/**
 * Rules with their own key (HTTP 422, api-error.helper.ts). Each is over facts the submitter may
 * know: the D06 window and the year, their own status on the day, the calendar every HR role
 * reads. The others stay the generic invalid request (400): a time outside a shift or a non-slot
 * interval (fixed rules on the input alone; acceptance A-17/B-21 keep 400) and a day outside
 * employment (only reachable around a hire or leaving date; no acceptance case asks for its own
 * key — add one with its justification when a screen needs it).
 */
const ruleCodes: Readonly<Record<WorkRequestRejection, ApiRejectionCode | undefined>> = {
  crosses_year: 'error.crossesYear',
  date_out_of_range: 'error.dateOutOfRange',
  kind_not_allowed_in_probation: 'error.kindNotAllowedInProbation',
  non_working_day: 'error.nonWorkingDay',
  makeup_day: 'error.makeupDay',
  not_employed: undefined,
  invalid_time: undefined,
  invalid_slot: undefined,
};

/**
 * Same actor, operation, key and payload already committed: the transaction rolls back (nothing
 * to write) and the stored result is returned. Thrown after the plan matched and locked the
 * employee row, so the permission is the current one (C-19).
 */
class SubmitReplayed extends Error {
  constructor(readonly result: SubmitResult) {
    super('Submit replayed');
  }
}

/** The locked employee is not the session's own profile any more: not found (404), no write. */
class SubmitterNotFound extends Error {}

/**
 * employee.submitRequest (design §6.2 `submit`, §7.3). `execute` has matched the plan
 * (`selfEmployee`) on the employee row and locked it FOR NO KEY UPDATE. `employee.account_id` is
 * UNIQUE, so this lock serializes every submit of one account: the idempotency read, the overlap
 * check and the inserts below cannot race (B-13). Lock order (ADR 0017 §2, spec §7.3): employee →
 * idempotency read → work_calendar FOR SHARE → inserts; every other writer must keep it.
 * Annual leave is checked against the accrued balance (D09, T7, `assertLeaveAvailable`): no
 * bucket lock is needed here, the employee lock serializes this account's submits and a
 * concurrent decision keeps pending + approved unchanged. The pending annual-leave rows T5
 * accepted before this check are listed for HR by `leaveReconciliation`, never changed.
 * Closed months (D07, T8): every month of the request's dates is locked FOR SHARE right after the
 * idempotency read and before the calendar (spec §7.3 steps 7 → 8), and a closed one is refused
 * with 409 `error.periodClosed`. A WFH request answers `wfhLimitExceeded` when its days would pass
 * 4 approved WFH days in a month (D04, D-07): a warning from an unlocked read, the final approver
 * rechecks under the counter lock. No leave or attendance effect is written at submit
 * (requirement §4.3, §9).
 * A COO's own request is approved here (spec §6.4 (1), C-26, D-10): after the inserts, in this
 * transaction, the effects of its kind run exactly as a final approval would (leave bucket, WFH
 * counter with the warning acknowledged, attendance period FOR SHARE), then the system decision
 * `coo_self_approved` is written and the request is born `approved` at version 1. A composition
 * without a handler for the kind refuses before anything is written (`final_approval_unavailable`,
 * fail closed). Lock order: employee → period FOR SHARE → calendar FOR SHARE → bucket → counter →
 * period FOR SHARE (again, a no-op). Nobody holds a bucket or counter while waiting for the
 * employee, the calendar or an earlier period, so no cycle (ADR 0017 §2, T8 part B).
 */
export const createSubmitRequest = (
  effects: ApprovedEffects,
): ProductCommand<SubmitCommandInput, SubmitResult> => ({
  resource: 'employee',
  action: 'submitRequest',
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
    // Spec §7.3 step 7: the months of the request, before the calendar lock of the next query.
    await assertPeriodsOpen(ctx.tx.manager, requestDates(request));
    // The plan already requires the account link; Root (never linked) cannot submit for anyone.
    const [facts] = await ctx.tx.manager.query<
      {
        earliest: string;
        latest: string;
        team: string | null;
        leads: boolean;
        coo: boolean;
        calendar: string | null;
      }[]
    >(
      `SELECT ${date(`${HR_TODAY} - 7`)} AS earliest, ${date(`${HR_TODAY} + 90`)} AS latest,
              m.team_id::text AS team,
              EXISTS (SELECT 1 FROM team_lead_assignment l WHERE l.team_id = m.team_id
                       AND l.lead_employee_id = e.id AND ${hrCurrent('l')}) AS leads,
              EXISTS (SELECT 1 FROM user_role u WHERE u.user_id = $2
                       AND u.role_key = convert_to('hr.coo','UTF8')) AS coo,
              (SELECT c.version::text FROM work_calendar c WHERE c.id = $4 FOR SHARE) AS calendar
         FROM employee e
         LEFT JOIN team_membership m ON m.employee_id = e.id AND ${hrCurrent('m')}
              AND (CASE WHEN CAST($3 AS uuid) IS NULL THEN m.is_primary ELSE m.team_id = CAST($3 AS uuid) END)
        WHERE e.id = $1 AND e.account_id = $2`,
      [ctx.target.key, ctx.actor.id, request.teamId, WORK_CALENDAR_ID],
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
      await assertLeaveAvailable(
        ctx.tx.manager,
        ctx.target.key,
        segments.map((s) => ({ date: s.date, minutes: s.minutes })),
      );
    const start = initialState({ submitterIsCoo: facts.coo, submitterLeadsTeam: facts.leads });
    // All parts must exist before anything is written (the final-approval gate, §6.3 invariant 5).
    const selfEffects =
      start.state === 'approved' ? requiredEffects[request.kind].map((part) => effects[part]) : [];
    if (selfEffects.some((effect) => effect === undefined))
      throw new ProductCommandRejected('final_approval_unavailable');
    // The D04 warning is read before this request's own days can reach the counter.
    const exceeded =
      request.kind === 'wfh'
        ? await wfhLimitExceeded(ctx.tx.manager, ctx.target.key, dates)
        : undefined;

    const id = randomUUID();
    const objectId = await registerHrObject(ctx.tx, 'workRequest', id);
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
      if (!(await ctx.reaches('workRequest', 'decideFinal', id)))
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
    await ctx.audit('hr.request.submit', { resource: 'workRequest', key: id, objectId });
    if (start.state === 'approved')
      await ctx.audit('hr.request.self-approve', { resource: 'workRequest', key: id, objectId });
    return result;
  },
});

export const submitRequest = createSubmitRequest(approvedEffects);

export const workRequestCommands = [submitRequest] as const;

export const workRequestQueries = [
  submitter,
  ownRequests,
  requestDetail,
  leadRejectedDetail,
] as const;

/** SHA-256 of the validated body; the validator emits keys in a fixed order. */
const payloadHash = (input: SubmitRequestInput) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** Work request operations bound to the registered command/queries (T5). */
export class WorkRequestService {
  /** `command` is the registered submit command; tests may pass one over their own effect set. */
  constructor(
    private readonly authorization: ProductAuthorization,
    private readonly command: ProductCommand<SubmitCommandInput, SubmitResult> = submitRequest,
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
    const employeeId = await this.authorization.query(secret, submitter, undefined);
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
    return this.authorization.query(secret, ownRequests, query);
  }

  /**
   * `workRequest.read`, else the COO's `readLeadRejected`; absent and unreadable are both
   * `undefined` (404). The second plan is empty for everyone else, so nothing widens.
   */
  async detail(secret: string, requestId: string): Promise<RequestDetailView | undefined> {
    const input = { requestId };
    return (
      (await this.authorization.query(secret, requestDetail, input)) ??
      (await this.authorization.query(secret, leadRejectedDetail, input))
    );
  }
}
