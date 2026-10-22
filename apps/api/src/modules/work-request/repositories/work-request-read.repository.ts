import { EmployeeAction, HrResource, WorkRequestAction } from '../../hr/hr-authorization.types.js';
import {
  type ProductQuery,
  type ProductQueryContext,
} from '../../../authorization/services/product-authority.service.js';
import { hrScoped } from '../../hr/helpers/hr-database.helper.js';
import type {
  RequestDetailView,
  RequestListQuery,
  RequestListView,
} from '../work-request.types.js';
import { date, instant } from '../helpers/work-request-sql.helper.js';

type DetailQuery = ProductQuery<{ readonly requestId: string }, RequestDetailView | undefined>;

export class WorkRequestReadRepository {
  /** Detail of one request under the caller's plan: segments and decision history (§5.1 F4/F5). */
  async #readDetail(
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

  /** employee.submitRequest: the employee record this session may submit for, i.e. its own. */
  readonly submitter: ProductQuery<undefined, string | undefined> = {
    resource: HrResource.Employee,
    action: EmployeeAction.SubmitRequest,
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
  readonly ownRequests: ProductQuery<RequestListQuery, RequestListView> = {
    resource: HrResource.WorkRequest,
    action: WorkRequestAction.Read,
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

  /** workRequest.read detail. */
  readonly requestDetail: DetailQuery = {
    resource: HrResource.WorkRequest,
    action: WorkRequestAction.Read,
    target: (input) => input.requestId,
    run: (context, input) => this.#readDetail(context, input),
  };

  /**
   * workRequest.readLeadRejected detail (release 9): the same projection under the plan of the COO's
   * read-only scope (lead-owned request rejected at the lead step); every other caller's plan is
   * empty, so it answers nothing for them.
   */
  readonly leadRejectedDetail: DetailQuery = {
    resource: HrResource.WorkRequest,
    action: WorkRequestAction.ReadLeadRejected,
    target: (input) => input.requestId,
    run: (context, input) => this.#readDetail(context, input),
  };
}
