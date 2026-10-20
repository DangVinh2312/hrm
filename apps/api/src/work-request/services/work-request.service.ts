import { createHash, randomUUID } from 'node:crypto';
import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import {
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
  type ProductQuery,
  type ProductQueryContext,
} from '../../authorization/services/product-authority.service.js';
import { ApiRejection, type ApiRejectionCode } from '../../infrastructure/api-error.helper.js';
import {
  HR_TODAY,
  WORK_CALENDAR_ID,
  hrCurrent,
  hrScoped,
  registerHrObject,
} from '../../hr/hr-database.helper.js';
import { assertLeaveAvailable } from '../../leave/leave.service.js';
import {
  type BookedSegment,
  type WorkRequestRejection,
  WorkRequestRejected,
  conflicts,
  initialState,
  requestDates,
  requestSegments,
} from '../work-request.helper.js';
import type {
  RequestDetailView,
  RequestListQuery,
  RequestListView,
  SubmitRequestInput,
  SubmitResult,
} from '../work-request.types.js';

const OPERATION = 'workRequest.submit';

const date = (column: string) => `to_char(${column},'YYYY-MM-DD')`;

const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

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
 * shortcut: no closed-period guard (D07, B-22; `attendance_period` is T8); no
 * `wfhLimitExceeded` warning or `acknowledgeWfhLimit` (D04, D-07; approved WFH needs final
 * approval, T8). No leave or attendance effect is written at submit (requirement §4.3, §9).
 */
export const submitRequest: ProductCommand<SubmitCommandInput, SubmitResult> = {
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
    if (start === 'final_approval_unavailable') throw new ProductCommandRejected(start);

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
        start.state,
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
    if (start.systemDecision)
      await ctx.tx.manager.query(
        `INSERT INTO request_decision(id,request_id,stage,decision,actor_kind,system_reason)
         VALUES($1,$2,'lead','skip','system',$3)`,
        [randomUUID(), id, start.systemDecision],
      );
    const result: SubmitResult = { id, state: start.state, version: '1' };
    await ctx.tx.manager.query(
      `INSERT INTO hr_idempotency(actor_id,operation,key,payload_hash,target_id,result)
       VALUES($1,$2,CAST($3 AS uuid),$4,$5,CAST($6 AS jsonb))`,
      [ctx.actor.id, OPERATION, input.key, input.hash, id, JSON.stringify(result)],
    );
    await ctx.audit('hr.request.submit', { resource: 'workRequest', key: id, objectId });
    return result;
  },
};

/** employee.submitRequest: the employee record this session may submit for, i.e. its own. */
export const submitter: ProductQuery<undefined, string | undefined> = {
  resource: 'employee',
  action: 'submitRequest',
  run: async ({ tx, scope, actor }) => {
    const bound = hrScoped(scope, actor.id);
    const [row] = await tx.manager.query<{ id: string }[]>(
      `SELECT r.id::text AS id FROM employee r WHERE ${scope.sql} AND r.account_id = CAST(${bound.at(1)} AS uuid)`,
      bound.parameters,
    );
    return row?.id;
  },
};

/**
 * workRequest.read, "my requests": the plan's scope AND the caller's own current profile, before
 * the count and the page (newest first). Leads/HR read others' requests by detail, never here.
 */
export const ownRequests: ProductQuery<RequestListQuery, RequestListView> = {
  resource: 'workRequest',
  action: 'read',
  run: async ({ tx, scope, actor }, input) => {
    const bound = hrScoped(scope, actor.id, input.limit, input.offset);
    const [row] = await tx.manager.query<RequestListView[]>(
      `WITH scoped AS (
         SELECT r.id, r.kind, r.state, r.version, r.team_id, r.created_at FROM work_request r
          WHERE ${scope.sql}
            AND r.employee_id = (SELECT e.id FROM employee e WHERE e.account_id = CAST(${bound.at(1)} AS uuid)))
       SELECT (SELECT count(*) FROM scoped)::text AS total,
              COALESCE((SELECT json_agg(json_build_object('id', p.id, 'kind', p.kind, 'state', p.state,
                  'version', p.version::text, 'teamId', p.team_id, 'createdAt', ${instant('p.created_at')},
                  'startDate', ${date('g.first')}, 'endDate', ${date('g.last')}, 'minutes', g.minutes)
                  ORDER BY p.created_at DESC, p.id DESC)
                FROM (SELECT * FROM scoped ORDER BY created_at DESC, id DESC
                       LIMIT CAST(${bound.at(2)} AS int8) OFFSET CAST(${bound.at(3)} AS int8)) p
                CROSS JOIN LATERAL (SELECT min(s.work_date) AS first, max(s.work_date) AS last,
                       sum(s.minutes)::int AS minutes FROM work_request_segment s WHERE s.request_id = p.id) g),
                '[]'::json) AS items`,
      bound.parameters,
    );
    return { total: row?.total ?? '0', items: row?.items ?? [] };
  },
};

/** Detail of one request under the caller's plan: segments and decision history (§5.1 F4/F5). */
async function readDetail(
  { tx, scope }: ProductQueryContext,
  input: { readonly requestId: string },
): Promise<RequestDetailView | undefined> {
  const bound = hrScoped(scope, input.requestId);
  const [row] = await tx.manager.query<RequestDetailView[]>(
    `SELECT r.id, r.employee_id AS "employeeId", r.team_id AS "teamId", r.kind, r.state,
            r.version::text AS version, r.reason, ${instant('r.created_at')} AS "createdAt",
            COALESCE((SELECT json_agg(json_build_object('date', ${date('s.work_date')}, 'startMinute', s.start_minute,
                'endMinute', s.end_minute, 'minutes', s.minutes) ORDER BY s.work_date)
              FROM work_request_segment s WHERE s.request_id = r.id), '[]'::json) AS segments,
            COALESCE((SELECT json_agg(json_build_object('stage', d.stage, 'decision', d.decision,
                'actorKind', d.actor_kind, 'systemReason', d.system_reason, 'reason', d.reason,
                'decidedAt', ${instant('d.decided_at')}) ORDER BY d.decided_at, d.id)
              FROM request_decision d WHERE d.request_id = r.id), '[]'::json) AS decisions
       FROM work_request r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
    bound.parameters,
  );
  return row;
}

type DetailQuery = ProductQuery<{ readonly requestId: string }, RequestDetailView | undefined>;

/** workRequest.read detail. */
export const requestDetail: DetailQuery = {
  resource: 'workRequest',
  action: 'read',
  target: (input) => input.requestId,
  run: readDetail,
};

/**
 * workRequest.readLeadRejected detail (release 9): the same projection under the plan of the COO's
 * read-only scope (lead-owned request rejected at the lead step); every other caller's plan is
 * empty, so it answers nothing for them.
 */
export const leadRejectedDetail: DetailQuery = {
  resource: 'workRequest',
  action: 'readLeadRejected',
  target: (input) => input.requestId,
  run: readDetail,
};

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
  constructor(private readonly authorization: ProductAuthorization) {}

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
      return await this.authorization.execute(secret, submitRequest, {
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
