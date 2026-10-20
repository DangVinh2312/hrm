import { randomUUID } from 'node:crypto';
import {
  ProductAccessDenied,
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
  type ProductCommandContext,
  type ProductQuery,
} from '../authorization/services/product-authority.service.js';
import {
  HR_COMPANY_ID,
  HR_TODAY,
  hrCurrent,
  hrScoped,
  isUniqueViolation,
  registerHrObject,
} from '../hr/hr-database.helper.js';
import { visibleOrNothing } from '../hr/hr-access.helper.js';
import { hrLikePattern } from '../hr/hr-input.helper.js';
import type {
  AccountLinkInput,
  EmployeeCreateInput,
  EmployeeIdentityUpdateInput,
  EmployeeIdentityView,
  EmployeeListQuery,
  EmployeeListView,
  EmployeeOfficialInput,
  EmployeeTerminationInput,
  EmployeeUpdateInput,
  EmployeeView,
  EmploymentState,
  HrMenu,
  HrMeView,
  LeaveRateInput,
  LeaveRateView,
} from './employee.types.js';

const date = (column: string) => `to_char(${column},'YYYY-MM-DD')`;

const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * State on the business date today. NULL only if the period chain is broken, which the commands
 * never produce; the mapper then fails closed instead of guessing a status.
 */
const stateSql = (e: string) =>
  `CASE WHEN ${e}.terminated_on IS NOT NULL AND ${e}.terminated_on < ${HR_TODAY} THEN 'terminated'
        WHEN ${e}.hired_on > ${HR_TODAY} THEN 'notStarted'
        ELSE (SELECT p.status FROM employment_status_period p WHERE p.employee_id = ${e}.id
               AND p.starts_on <= ${HR_TODAY} AND (p.ends_on IS NULL OR p.ends_on > ${HR_TODAY})) END`;

function employmentState(value: string | null): EmploymentState {
  if (
    value === 'probation' ||
    value === 'official' ||
    value === 'notStarted' ||
    value === 'terminated'
  )
    return value;
  throw new Error('Employment periods are inconsistent');
}

/** Runs one write and turns a UNIQUE violation into a 409 without naming the other record. */
async function unique<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProductCommandRejected('duplicate');
    throw error;
  }
}

/** Bumps the employee version of the locked target, if it still is `expected` (else 409). */
async function bumpEmployee(
  ctx: ProductCommandContext,
  expected: string | undefined,
): Promise<string> {
  const rows = await ctx.tx.manager.query<{ version: string }[]>(
    `WITH updated AS (UPDATE employee SET version = version + 1
       WHERE id = $1 ${expected === undefined ? '' : 'AND version = CAST($2 AS int8)'}
       RETURNING version::text AS version) SELECT * FROM updated`,
    expected === undefined ? [ctx.target.key] : [ctx.target.key, expected],
  );
  if (!rows[0]) throw new ProductCommandRejected('stale_version');
  return rows[0].version;
}

const employeeTarget = (ctx: ProductCommandContext) => ({
  resource: 'employee',
  key: ctx.target.key,
  objectId: ctx.target.objectId,
});

/** hrCompany.createEmployee: F1 + F2 + first status period + first F3 rate, one commit. */
export const createEmployee: ProductCommand<EmployeeCreateInput, { readonly id: string }> = {
  resource: 'hrCompany',
  action: 'createEmployee',
  mode: 'write',
  target: () => HR_COMPANY_ID,
  run: async (ctx, input) => {
    const id = randomUUID();
    const objectId = await registerHrObject(ctx.tx, 'employee', id);
    await unique(
      ctx.tx.manager.query(
        `INSERT INTO employee(id,object_id,code,full_name,hired_on,job_position,classification)
         VALUES($1,$2,$3,$4,CAST($5 AS date),$6,$7)`,
        [
          id,
          objectId,
          input.code,
          input.fullName,
          input.hiredOn,
          input.position,
          input.classification,
        ],
      ),
    );
    const identity = input.identity;
    await unique(
      ctx.tx.manager.query(
        `INSERT INTO employee_identity(employee_id,object_id,date_of_birth,document_kind,document_number,tax_code,gender,phone,work_email)
         VALUES($1,$2,CAST($3 AS date),$4,$5,$6,$7,$8,$9)`,
        [
          id,
          await registerHrObject(ctx.tx, 'employeeIdentity', id),
          identity.dateOfBirth,
          identity.documentKind,
          identity.documentNumber,
          identity.taxCode,
          identity.gender,
          identity.phone,
          identity.workEmail,
        ],
      ),
    );
    await ctx.tx.manager.query(
      'INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES($1,$2,$3,CAST($4 AS date))',
      [randomUUID(), id, input.status, input.hiredOn],
    );
    const rate = randomUUID();
    await ctx.tx.manager.query(
      'INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes) VALUES($1,$2,$3,CAST($4 AS date),$5)',
      [
        rate,
        await registerHrObject(ctx.tx, 'leaveRate', rate),
        id,
        input.hiredOn,
        input.annualLeaveMinutes,
      ],
    );
    await ctx.audit('hr.employee.create', { resource: 'employee', key: id, objectId });
    return { id };
  },
};

/** employee.update: code, full name, position and classification only (allowlist), optimistic version. */
export const updateEmployee: ProductCommand<EmployeeUpdateInput, { readonly version: string }> = {
  resource: 'employee',
  action: 'update',
  mode: 'write',
  target: (input) => input.employeeId,
  run: async (ctx, input) => {
    const rows = await unique(
      ctx.tx.manager.query<{ version: string }[]>(
        `WITH updated AS (UPDATE employee SET code = $2, full_name = $3, job_position = $5,
           classification = $6, version = version + 1
           WHERE id = $1 AND version = CAST($4 AS int8) RETURNING version::text AS version)
         SELECT * FROM updated`,
        [
          ctx.target.key,
          input.code,
          input.fullName,
          input.expectedVersion,
          input.position,
          input.classification,
        ],
      ),
    );
    if (!rows[0]) throw new ProductCommandRejected('stale_version');
    await ctx.audit('hr.employee.update', employeeTarget(ctx));
    return { version: rows[0].version };
  },
};

/**
 * employee.update: probation → official from `effectiveOn`. The open period must be probation and
 * start before that day; the chain stays gapless (old period ends where the new one starts).
 */
export const confirmOfficial: ProductCommand<EmployeeOfficialInput, { readonly version: string }> =
  {
    resource: 'employee',
    action: 'update',
    mode: 'write',
    target: (input) => input.employeeId,
    run: async (ctx, input) => {
      const closed = await ctx.tx.manager.query<{ id: string }[]>(
        `WITH closed AS (UPDATE employment_status_period p SET ends_on = CAST($2 AS date)
           FROM employee e
           WHERE p.employee_id = $1 AND e.id = p.employee_id AND p.ends_on IS NULL
             AND p.status = 'probation' AND p.starts_on < CAST($2 AS date)
             AND e.terminated_on IS NULL
           RETURNING p.id) SELECT * FROM closed`,
        [ctx.target.key, input.effectiveOn],
      );
      if (closed.length !== 1) throw new ProductCommandRejected('invalid_status_change');
      await ctx.tx.manager.query(
        `INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES($1,$2,'official',CAST($3 AS date))`,
        [randomUUID(), ctx.target.key, input.effectiveOn],
      );
      const version = await bumpEmployee(ctx, undefined);
      await ctx.audit('hr.employee.status', employeeTarget(ctx));
      return { version };
    },
  };

/** employee.update: last working day; closes the open period the day after. Not reversible here. */
export const terminateEmployee: ProductCommand<
  EmployeeTerminationInput,
  { readonly version: string }
> = {
  resource: 'employee',
  action: 'update',
  mode: 'write',
  target: (input) => input.employeeId,
  run: async (ctx, input) => {
    const closed = await ctx.tx.manager.query<{ id: string }[]>(
      `WITH closed AS (UPDATE employment_status_period p SET ends_on = CAST($2 AS date) + 1
         FROM employee e
         WHERE p.employee_id = $1 AND e.id = p.employee_id AND p.ends_on IS NULL
           AND p.starts_on <= CAST($2 AS date) AND e.terminated_on IS NULL
           AND e.hired_on <= CAST($2 AS date)
         RETURNING p.id) SELECT * FROM closed`,
      [ctx.target.key, input.terminatedOn],
    );
    if (closed.length !== 1) throw new ProductCommandRejected('invalid_status_change');
    await ctx.tx.manager.query(
      'UPDATE employee SET terminated_on = CAST($2 AS date) WHERE id = $1',
      [ctx.target.key, input.terminatedOn],
    );
    const version = await bumpEmployee(ctx, undefined);
    await ctx.audit('hr.employee.status', employeeTarget(ctx));
    return { version };
  },
};

/** employeeIdentity.update (F2, fresh): whole F2 replaced, optimistic version. */
export const updateIdentity: ProductCommand<
  EmployeeIdentityUpdateInput,
  { readonly version: string }
> = {
  resource: 'employeeIdentity',
  action: 'update',
  mode: 'write',
  target: (input) => input.employeeId,
  run: async (ctx, input) => {
    const { identity } = input;
    const rows = await unique(
      ctx.tx.manager.query<{ version: string }[]>(
        `WITH updated AS (UPDATE employee_identity SET date_of_birth = CAST($2 AS date),
           document_kind = $3, document_number = $4, tax_code = $5, gender = $7, phone = $8,
           work_email = $9, version = version + 1
           WHERE employee_id = $1 AND version = CAST($6 AS int8) RETURNING version::text AS version)
         SELECT * FROM updated`,
        [
          ctx.target.key,
          identity.dateOfBirth,
          identity.documentKind,
          identity.documentNumber,
          identity.taxCode,
          input.expectedVersion,
          identity.gender,
          identity.phone,
          identity.workEmail,
        ],
      ),
    );
    if (!rows[0]) throw new ProductCommandRejected('stale_version');
    await ctx.audit('hr.employee-identity.update', {
      resource: 'employeeIdentity',
      key: ctx.target.key,
      objectId: ctx.target.objectId,
    });
    return { version: rows[0].version };
  },
};

/** employee.adjustLeaveRate (F3, fresh): adds a rate row; history is never rewritten. */
export const adjustLeaveRate: ProductCommand<LeaveRateInput, { readonly id: string }> = {
  resource: 'employee',
  action: 'adjustLeaveRate',
  mode: 'write',
  target: (input) => input.employeeId,
  run: async (ctx, input) => {
    const [employee] = await ctx.tx.manager.query<{ valid: boolean }[]>(
      'SELECT hired_on <= CAST($2 AS date) AS valid FROM employee WHERE id = $1',
      [ctx.target.key, input.effectiveFrom],
    );
    if (!employee?.valid) throw new ProductCommandRejected('before_hire');
    const id = randomUUID();
    const objectId = await registerHrObject(ctx.tx, 'leaveRate', id);
    await unique(
      ctx.tx.manager.query(
        'INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes) VALUES($1,$2,$3,CAST($4 AS date),$5)',
        [id, objectId, ctx.target.key, input.effectiveFrom, input.annualMinutes],
      ),
    );
    await ctx.audit('hr.leave-rate.adjust', { resource: 'leaveRate', key: id, objectId });
    return { id };
  },
};

/**
 * employee.linkAccount (admin, fresh, boundary required): the account must be an IAM account
 * that is not suspended and not linked elsewhere (UNIQUE). Nobody moves a link to or from their
 * own account: that would hand them, or take away from them, every `self`/lead scope.
 */
export const linkAccount: ProductCommand<AccountLinkInput, { readonly version: string }> = {
  resource: 'employee',
  action: 'linkAccount',
  mode: 'admin',
  target: (input) => input.employeeId,
  run: async (ctx, input) => {
    const [employee] = await ctx.tx.manager.query<{ account: string | null; version: string }[]>(
      'SELECT account_id::text AS account, version::text AS version FROM employee WHERE id = $1',
      [ctx.target.key],
    );
    if (!employee) throw new Error('Locked target vanished');
    if (employee.version !== input.expectedVersion)
      throw new ProductCommandRejected('stale_version');
    if (employee.account === ctx.actor.id || input.accountId === ctx.actor.id)
      throw new ProductCommandRejected('self_link');
    if (employee.account === input.accountId) throw new ProductCommandRejected('unchanged');
    if (input.accountId !== null) {
      const [account] = await ctx.tx.manager.query<{ kind: string; state: string }[]>(
        'SELECT kind, state FROM app_user WHERE id = $1',
        [input.accountId],
      );
      if (account?.kind !== 'iam' || account.state === 'suspended')
        throw new ProductCommandRejected('account_unavailable');
    }
    await unique(
      ctx.tx.manager.query('UPDATE employee SET account_id = $2 WHERE id = $1', [
        ctx.target.key,
        input.accountId,
      ]),
    );
    const version = await bumpEmployee(ctx, input.expectedVersion);
    await ctx.audit('hr.employee.link-account', employeeTarget(ctx));
    return { version };
  },
};

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

export const employeeCommands = [
  createEmployee,
  updateEmployee,
  confirmOfficial,
  terminateEmployee,
  updateIdentity,
  adjustLeaveRate,
  linkAccount,
] as const;

export const employeeQueries = [
  listEmployees,
  employeeDetail,
  identityDetail,
  leaveRates,
  ownEmployee,
] as const;

/**
 * Employee operations bound to the commands/queries registered at composition. Every call is
 * one authorized transaction; `undefined` means absent or not visible (HTTP 404).
 */
export class EmployeeService {
  constructor(private readonly authorization: ProductAuthorization) {}

  list(secret: string, query: EmployeeListQuery): Promise<EmployeeListView> {
    return this.authorization.query(secret, listEmployees, query);
  }

  detail(secret: string, employeeId: string): Promise<EmployeeView | undefined> {
    return this.authorization.query(secret, employeeDetail, { employeeId });
  }

  async create(secret: string, input: EmployeeCreateInput): Promise<{ readonly id: string }> {
    const created = await this.authorization.execute(secret, createEmployee, input);
    // The anchor always exists once ready, so "not visible" can only mean no grant: 403, and
    // nothing about any record is revealed by it.
    if (!created) throw new ProductAccessDenied();
    return created;
  }

  update(secret: string, input: EmployeeUpdateInput) {
    return this.authorization.execute(secret, updateEmployee, input);
  }

  confirmOfficial(secret: string, input: EmployeeOfficialInput) {
    return this.authorization.execute(secret, confirmOfficial, input);
  }

  terminate(secret: string, input: EmployeeTerminationInput) {
    return this.authorization.execute(secret, terminateEmployee, input);
  }

  identity(secret: string, employeeId: string): Promise<EmployeeIdentityView | undefined> {
    return this.authorization.query(secret, identityDetail, { employeeId });
  }

  updateIdentity(secret: string, input: EmployeeIdentityUpdateInput) {
    return this.authorization.execute(secret, updateIdentity, input);
  }

  leaveRates(secret: string, employeeId: string): Promise<readonly LeaveRateView[]> {
    return this.authorization.query(secret, leaveRates, { employeeId });
  }

  adjustLeaveRate(secret: string, input: LeaveRateInput) {
    return this.authorization.execute(secret, adjustLeaveRate, input);
  }

  linkAccount(secret: string, input: AccountLinkInput) {
    return this.authorization.execute(secret, linkAccount, input);
  }

  /**
   * Bootstrap without `userId` (design §10.2). Menus are display only: `employees` when the caller
   * sees someone besides themself or holds company scope, `teams` when any team is visible or
   * company scope, `requests` when the caller has a linked profile and may submit (T5); each page still authorizes every read and write itself. Company scope = the
   * hrCompany.read plan reaches the anchor (`permits`: a plan without grants reaches nothing).
   */
  async me(secret: string): Promise<Omit<HrMeView, 'userId'>> {
    const employees = await visibleOrNothing(
      this.authorization.query(secret, ownEmployee, undefined),
      { own: null, others: false },
    );
    const teams = await this.authorization.permits(secret, 'team', 'read');
    const company = await this.authorization.permits(secret, 'hrCompany', 'read');
    const calendar = await this.authorization.permits(secret, 'workCalendar', 'read');
    // Only a linked profile can submit (selfEmployee); a Root or unlinked account has none.
    const requests =
      employees.own !== null &&
      (await this.authorization.permits(secret, 'employee', 'submitRequest'));
    const menus: HrMenu[] = [];
    if (requests) menus.push('requests');
    if (company || employees.others) menus.push('employees');
    if (company || teams) menus.push('teams');
    if (calendar) menus.push('calendar');
    return { employee: employees.own, menus, companyScope: company };
  }
}
