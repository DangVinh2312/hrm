import { HrResource, WorkRequestAction } from '../../hr/hr-authorization.types.js';
import { type ProductQuery } from '../../../authorization/services/product-authority.service.js';
import { hrScoped } from '../../hr/helpers/hr-database.helper.js';
import type {
  ApprovalQueueView,
  DecidedRequestsView,
  RequestListQuery,
} from '../work-request.types.js';
import { date, instant } from '../helpers/work-request-sql.helper.js';

export class RequestApprovalReadRepository {
  /**
   * The caller's queue for one stage: the stage permission's plan (stage policy included) AND the
   * stage's state AND not the caller's own request, before count and page, oldest first. The lead
   * queue also requires the caller to be the current first-step approver, which the IAM plan
   * already implies and Root (no profile) never is.
   */
  #queue(stage: 'lead' | 'final'): ProductQuery<RequestListQuery, ApprovalQueueView> {
    return {
      resource: HrResource.WorkRequest,
      action: stage === 'lead' ? WorkRequestAction.DecideLead : WorkRequestAction.DecideFinal,
      run: async ({ tx, scope, actor }, input) => {
        const bound = hrScoped(scope, actor.id, input.limit, input.offset);
        const approver =
          stage === 'lead'
            ? `AND EXISTS (SELECT 1 FROM hr_request_lead l WHERE l.request_id = r.id
                            AND l.lead_account_id = CAST(${bound.at(1)} AS uuid))`
            : '';
        const [row] = await tx.manager.query<ApprovalQueueView[]>(
          `WITH scoped AS (
           SELECT r.id, r.employee_id, r.kind, r.state, r.version, r.team_id, r.created_at FROM work_request r
            WHERE ${scope.sql} AND r.state = '${stage === 'lead' ? 'pending_lead' : 'pending_final'}'
              AND r.owner_account_id <> CAST(${bound.at(1)} AS uuid) ${approver})
         SELECT (SELECT count(*) FROM scoped)::text AS total,
                COALESCE((SELECT json_agg(json_build_object('id', p.id, 'employeeId', p.employee_id,
                    'kind', p.kind, 'state', p.state, 'version', p.version::text, 'teamId', p.team_id,
                    'createdAt', ${instant('p.created_at')}, 'startDate', ${date('g.first')},
                    'endDate', ${date('g.last')}, 'minutes', g.minutes) ORDER BY p.created_at, p.id)
                  FROM (SELECT * FROM scoped ORDER BY created_at, id
                         LIMIT CAST(${bound.at(2)} AS int8) OFFSET CAST(${bound.at(3)} AS int8)) p
                  CROSS JOIN LATERAL (SELECT min(s.work_date) AS first, max(s.work_date) AS last,
                         sum(s.minutes)::int AS minutes FROM work_request_segment s WHERE s.request_id = p.id) g),
                  '[]'::json) AS items`,
          bound.parameters,
        );
        return { total: row?.total ?? '0', items: row?.items ?? [] };
      },
    };
  }

  readonly leadQueue = this.#queue('lead');

  readonly finalQueue = this.#queue('final');

  /**
   * History "Đã xử lý" (T6 part C): workRequest.readDecided's plan (the request's current
   * first-step approver for a lead, the company for the COO, everything for Root) AND decided AND
   * not the caller's own, before count and page — the queues' pattern. Decided = approved or
   * rejected, or a person's lead/final decision (so a request cancelled after one, or waiting for
   * the COO after the lead's). Each row carries its latest lead/final decision; latest first, ties
   * by id, so pages neither repeat nor skip. Release 9: each row carries the owner's full name
   * (and only that employee field); the row is already inside the caller's readDecided plan, so
   * the name reaches nobody who may not read the row.
   * ponytail: the sort key is computed for every scoped row before the page; add a stored
   * "last decided at" column + index if a scope grows past a few thousand requests.
   */
  readonly decidedQuery: ProductQuery<RequestListQuery, DecidedRequestsView> = {
    resource: HrResource.WorkRequest,
    action: WorkRequestAction.ReadDecided,
    run: async ({ tx, scope, actor }, input) => {
      const bound = hrScoped(scope, actor.id, input.limit, input.offset);
      const [row] = await tx.manager.query<DecidedRequestsView[]>(
        `WITH scoped AS (
         SELECT r.id, r.employee_id, e.full_name, r.kind, r.state, r.version, r.team_id, r.created_at,
                last_decision.stage, last_decision.decision, last_decision.actor_kind,
                last_decision.decided_at
           FROM work_request r JOIN employee e ON e.id = r.employee_id
           CROSS JOIN LATERAL (SELECT d.stage, d.decision, d.actor_kind, d.decided_at
                 FROM request_decision d WHERE d.request_id = r.id AND d.stage IN ('lead','final')
                ORDER BY d.decided_at DESC, (d.stage = 'final') DESC LIMIT 1) last_decision
          WHERE ${scope.sql} AND r.owner_account_id <> CAST(${bound.at(1)} AS uuid)
            AND (r.state IN ('approved','rejected')
                 OR EXISTS (SELECT 1 FROM request_decision u WHERE u.request_id = r.id
                             AND u.actor_kind = 'user' AND u.stage IN ('lead','final'))))
       SELECT (SELECT count(*) FROM scoped)::text AS total,
              COALESCE((SELECT json_agg(json_build_object('id', p.id, 'employeeId', p.employee_id,
                  'employeeName', p.full_name,
                  'kind', p.kind, 'state', p.state, 'version', p.version::text, 'teamId', p.team_id,
                  'createdAt', ${instant('p.created_at')}, 'startDate', ${date('g.first')},
                  'endDate', ${date('g.last')}, 'minutes', g.minutes,
                  'decision', json_build_object('stage', p.stage, 'decision', p.decision,
                    'actorKind', p.actor_kind, 'decidedAt', ${instant('p.decided_at')}))
                  ORDER BY p.decided_at DESC, p.id DESC)
                FROM (SELECT * FROM scoped ORDER BY decided_at DESC, id DESC
                       LIMIT CAST(${bound.at(2)} AS int8) OFFSET CAST(${bound.at(3)} AS int8)) p
                CROSS JOIN LATERAL (SELECT min(s.work_date) AS first, max(s.work_date) AS last,
                       sum(s.minutes)::int AS minutes FROM work_request_segment s WHERE s.request_id = p.id) g),
                '[]'::json) AS items`,
        bound.parameters,
      );
      return { total: row?.total ?? '0', items: row?.items ?? [] };
    },
  };
}
