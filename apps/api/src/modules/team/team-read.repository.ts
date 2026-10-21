import type { ProductQuery } from '../../authorization/services/product-authority.service.js';
import { hrCurrent, hrScoped } from '../hr/helpers/hr-database.helper.js';
import type { TeamListQuery, TeamListView, TeamView } from './team.types.js';

const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const person = (e: string) =>
  `json_build_object('employeeId', ${e}.id, 'code', ${e}.code, 'fullName', ${e}.full_name)`;

/** team.read: one bounded page (name order) with current lead and member count. */
export const listTeams: ProductQuery<TeamListQuery, TeamListView> = {
  resource: 'team',
  action: 'read',
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(scope, input.limit, input.offset);
    const [row] = await tx.manager.query<TeamListView[]>(
      `WITH scoped AS (SELECT r.id, r.name FROM team r WHERE ${scope.sql})
       SELECT (SELECT count(*) FROM scoped)::text AS total,
              COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name,
                  'lead', CASE WHEN e.id IS NULL THEN NULL ELSE ${person('e')} END,
                  'memberCount', (SELECT count(*) FROM team_membership m WHERE m.team_id = p.id AND ${hrCurrent('m')}))
                  ORDER BY p.name, p.id)
                FROM (SELECT * FROM scoped ORDER BY name, id
                       LIMIT CAST(${bound.at(1)} AS int8) OFFSET CAST(${bound.at(2)} AS int8)) p
                LEFT JOIN team_lead_assignment l ON l.team_id = p.id AND ${hrCurrent('l')}
                LEFT JOIN employee e ON e.id = l.lead_employee_id), '[]'::json) AS items`,
      bound.parameters,
    );
    return { total: row?.total ?? '0', items: row?.items ?? [] };
  },
};

/** team.read detail: current members (≤ 500), current lead and lead history (≤ 50). */
export const teamDetail: ProductQuery<{ readonly teamId: string }, TeamView | undefined> = {
  resource: 'team',
  action: 'read',
  target: (input) => input.teamId,
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(scope, input.teamId);
    const [row] = await tx.manager.query<TeamView[]>(
      `SELECT r.id, r.name, r.version::text AS version,
              (SELECT ${person('e')} FROM team_lead_assignment l JOIN employee e ON e.id = l.lead_employee_id
                WHERE l.team_id = r.id AND ${hrCurrent('l')}) AS lead,
              COALESCE((SELECT json_agg(x ORDER BY x.code) FROM (
                  SELECT e.id AS "employeeId", e.code, e.full_name AS "fullName", m.is_primary AS "primary",
                         ${instant('m.starts_at')} AS since
                    FROM team_membership m JOIN employee e ON e.id = m.employee_id
                   WHERE m.team_id = r.id AND ${hrCurrent('m')} ORDER BY e.code LIMIT 500) x), '[]'::json) AS members,
              COALESCE((SELECT json_agg(h ORDER BY h."startsAt" DESC) FROM (
                  SELECT e.id AS "employeeId", e.code, e.full_name AS "fullName",
                         ${instant('l.starts_at')} AS "startsAt", ${instant('l.ends_at')} AS "endsAt"
                    FROM team_lead_assignment l JOIN employee e ON e.id = l.lead_employee_id
                   WHERE l.team_id = r.id ORDER BY l.starts_at DESC LIMIT 50) h), '[]'::json) AS "leadHistory"
         FROM team r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
      bound.parameters,
    );
    return row;
  },
};
