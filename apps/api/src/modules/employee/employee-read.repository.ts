import type { ProductQuery } from '../../authorization/services/product-authority.service.js';
import { hrCurrent, hrScoped } from '../hr/hr-database.helper.js';
import { hrLikePattern } from '../hr/hr-input.helper.js';
import { date, employmentState, instant, stateSql } from './employee-database.helper.js';
import type {
  EmployeeIdentityView,
  EmployeeListQuery,
  EmployeeListView,
  EmployeeView,
  HrMeView,
  LeaveRateView,
} from './employee.types.js';

/** employee.read: one bounded page (code order) and the total in one statement. */
export const listEmployees: ProductQuery<EmployeeListQuery, EmployeeListView> = {
  resource: 'employee',
  action: 'read',
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(
      scope,
      input.search === undefined ? null : hrLikePattern(input.search),
      input.limit,
      input.offset,
    );
    const [row] = await tx.manager.query<
      {
        total: string;
        items: {
          id: string;
          code: string;
          fullName: string;
          state: string | null;
          teamId: string | null;
          teamName: string | null;
        }[];
      }[]
    >(
      `WITH scoped AS (
         SELECT r.id, r.code, r.full_name, ${stateSql('r')} AS state
           FROM employee r
          WHERE ${scope.sql}
            AND (${bound.at(1)}::text IS NULL OR r.code ILIKE ${bound.at(1)} ESCAPE '\\' OR r.full_name ILIKE ${bound.at(1)} ESCAPE '\\'))
       SELECT (SELECT count(*) FROM scoped)::text AS total,
              COALESCE((SELECT json_agg(json_build_object('id', p.id, 'code', p.code, 'fullName', p.full_name,
                  'state', p.state, 'teamId', t.id, 'teamName', t.name) ORDER BY p.code)
                FROM (SELECT * FROM scoped ORDER BY code LIMIT CAST(${bound.at(2)} AS int8) OFFSET CAST(${bound.at(3)} AS int8)) p
                LEFT JOIN team_membership m ON m.employee_id = p.id AND m.is_primary AND ${hrCurrent('m')}
                LEFT JOIN team t ON t.id = m.team_id), '[]'::json) AS items`,
      bound.parameters,
    );
    return {
      total: row?.total ?? '0',
      items: (row?.items ?? []).map((item) => ({
        id: item.id,
        code: item.code,
        fullName: item.fullName,
        state: employmentState(item.state),
        primaryTeam:
          item.teamId && item.teamName !== null ? { id: item.teamId, name: item.teamName } : null,
      })),
    };
  },
};

/** employee.read detail: F1 with status periods and current teams (design §5.1). */
export const employeeDetail: ProductQuery<
  { readonly employeeId: string },
  EmployeeView | undefined
> = {
  resource: 'employee',
  action: 'read',
  target: (input) => input.employeeId,
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(scope, input.employeeId);
    const [row] = await tx.manager.query<
      {
        id: string;
        code: string;
        fullName: string;
        hiredOn: string;
        terminatedOn: string | null;
        state: string | null;
        version: string;
        accountId: string | null;
        position: string | null;
        classification: EmployeeView['classification'];
        periods: EmployeeView['periods'];
        teams: EmployeeView['teams'];
      }[]
    >(
      `SELECT r.id, r.code, r.full_name AS "fullName", ${date('r.hired_on')} AS "hiredOn",
                ${date('r.terminated_on')} AS "terminatedOn", ${stateSql('r')} AS state,
                r.version::text AS version, r.account_id::text AS "accountId",
                r.job_position AS position, r.classification,
                COALESCE((SELECT json_agg(json_build_object('status', p.status, 'startsOn', ${date('p.starts_on')},
                    'endsOn', ${date('p.ends_on')}) ORDER BY p.starts_on)
                  FROM employment_status_period p WHERE p.employee_id = r.id), '[]'::json) AS periods,
                COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'primary', m.is_primary,
                    'since', ${instant('m.starts_at')}) ORDER BY m.is_primary DESC, t.name)
                  FROM team_membership m JOIN team t ON t.id = m.team_id
                  WHERE m.employee_id = r.id AND ${hrCurrent('m')}), '[]'::json) AS teams
           FROM employee r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
      bound.parameters,
    );
    return row ? { ...row, state: employmentState(row.state) } : undefined;
  },
};

/** employeeIdentity.read (F2): own record or HR only. */
export const identityDetail: ProductQuery<
  { readonly employeeId: string },
  EmployeeIdentityView | undefined
> = {
  resource: 'employeeIdentity',
  action: 'read',
  target: (input) => input.employeeId,
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(scope, input.employeeId);
    const [row] = await tx.manager.query<EmployeeIdentityView[]>(
      `SELECT r.employee_id AS "employeeId", r.version::text AS version,
              ${date('r.date_of_birth')} AS "dateOfBirth", r.document_kind AS "documentKind",
              r.document_number AS "documentNumber", r.tax_code AS "taxCode",
              r.gender, r.phone, r.work_email AS "workEmail"
         FROM employee_identity r WHERE ${scope.sql} AND r.employee_id = CAST(${bound.at(1)} AS uuid)`,
      bound.parameters,
    );
    return row;
  },
};

/** leaveRate.read (F3): visible rate rows of one employee, newest first (≤ 100). */
export const leaveRates: ProductQuery<{ readonly employeeId: string }, readonly LeaveRateView[]> = {
  resource: 'leaveRate',
  action: 'read',
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(scope, input.employeeId);
    return tx.manager.query<LeaveRateView[]>(
      `SELECT r.id, ${date('r.effective_from')} AS "effectiveFrom", r.annual_minutes AS "annualMinutes"
         FROM leave_rate r WHERE ${scope.sql} AND r.employee_id = CAST(${bound.at(1)} AS uuid)
        ORDER BY r.effective_from DESC LIMIT 100`,
      bound.parameters,
    );
  },
};

/** employee.read for the bootstrap: the caller's own profile and whether others are visible. */
export const ownEmployee: ProductQuery<
  undefined,
  { readonly own: HrMeView['employee']; readonly others: boolean }
> = {
  resource: 'employee',
  action: 'read',
  run: async ({ tx, scope, actor }) => {
    const bound = hrScoped(scope, actor.id);
    const [row] = await tx.manager.query<{ own: HrMeView['employee']; others: boolean }[]>(
      `SELECT (SELECT json_build_object('id', r.id, 'code', r.code, 'fullName', r.full_name)
                 FROM employee r WHERE ${scope.sql} AND r.account_id = CAST(${bound.at(1)} AS uuid)) AS own,
              EXISTS (SELECT 1 FROM employee r WHERE ${scope.sql}
                       AND r.account_id IS DISTINCT FROM CAST(${bound.at(1)} AS uuid)) AS others`,
      bound.parameters,
    );
    return { own: row?.own ?? null, others: row?.others === true };
  },
};
