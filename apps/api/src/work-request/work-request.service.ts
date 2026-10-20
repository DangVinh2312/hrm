import { createHash, randomUUID } from 'node:crypto';
import { ProductInvalidRequest } from '../authorization/product-data.gateway.js';
import {
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
  type ProductQuery,
} from '../authorization/services/product-authority.service.js';
import {
  HR_TODAY,
  WORK_CALENDAR_ID,
  hrCurrent,
  hrScoped,
  registerHrObject,
} from '../hr/hr-database.helper.js';
import {
  type BookedSegment,
  WorkRequestRejected,
  conflicts,
  initialState,
  requestDates,
  requestSegments,
} from './work-request.helper.js';
import type {
  RequestDetailView,
  RequestListQuery,
  RequestListView,
  SubmitRequestInput,
  SubmitResult,
} from './work-request.types.js';

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
 * shortcut: no leave balance check (D09, B-05; accrual is T7) — must be added, and pending
 * annual-leave rows submitted before it reconciled, before T7 shows balances or accrual; no
 * closed-period guard (D07, B-22; `attendance_period` is T8); no `wfhLimitExceeded` warning or
 * `acknowledgeWfhLimit` (D04, D-07; approved WFH needs final approval, T6/T8). No leave or
 * attendance effect is written at submit (requirement §4.3, §9).
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
      if (prior.hash !== input.hash) throw new ProductCommandRejected('idempotency_key_reused');
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
    if (!facts.team) throw new ProductInvalidRequest('team_not_member');
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
      if (error instanceof WorkRequestRejected) throw new ProductInvalidRequest(error.reason);
      throw error;
    }
    const booked = await ctx.tx.manager.query<BookedSegment[]>(
      `SELECT r.kind, ${date('s.work_date')} AS date, s.start_minute AS "startMinute", s.end_minute AS "endMinute"
         FROM work_request r JOIN work_request_segment s ON s.request_id = r.id
        WHERE r.employee_id = $1 AND r.state IN ('pending_lead','pending_final','approved')
          AND s.work_date = ANY(CAST($2 AS date[]))`,
      [ctx.target.key, dates],
    );
    if (conflicts(request.kind, segments, booked))
      throw new ProductCommandRejected('overlapping_request');
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

/** workRequest.read detail: segments and decision history are fields of the request (§5.1 F4/F5). */
export const requestDetail: ProductQuery<
  { readonly requestId: string },
  RequestDetailView | undefined
> = {
  resource: 'workRequest',
  action: 'read',
  target: (input) => input.requestId,
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(scope, input.requestId);
    const [row] = await tx.manager.query<RequestDetailView[]>(
      `SELECT r.id, r.employee_id AS "employeeId", r.team_id AS "teamId", r.kind, r.state,
              r.version::text AS version, r.reason, ${instant('r.created_at')} AS "createdAt",
              COALESCE((SELECT json_agg(json_build_object('date', ${date('s.work_date')}, 'startMinute', s.start_minute,
                  'endMinute', s.end_minute, 'minutes', s.minutes) ORDER BY s.work_date)
                FROM work_request_segment s WHERE s.request_id = r.id), '[]'::json) AS segments,
              COALESCE((SELECT json_agg(json_build_object('stage', d.stage, 'decision', d.decision,
                  'actorKind', d.actor_kind, 'systemReason', d.system_reason,
                  'decidedAt', ${instant('d.decided_at')}) ORDER BY d.decided_at, d.id)
                FROM request_decision d WHERE d.request_id = r.id), '[]'::json) AS decisions
         FROM work_request r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
      bound.parameters,
    );
    return row;
  },
};

export const workRequestCommands = [submitRequest] as const;

export const workRequestQueries = [submitter, ownRequests, requestDetail] as const;

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

  detail(secret: string, requestId: string): Promise<RequestDetailView | undefined> {
    return this.authorization.query(secret, requestDetail, { requestId });
  }
}
