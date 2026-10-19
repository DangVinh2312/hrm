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
import type {
  TeamCreateInput,
  TeamLeadInput,
  TeamListQuery,
  TeamListView,
  TeamMemberInput,
  TeamMembershipRef,
  TeamRenameInput,
  TeamView,
} from './team.types.js';

const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const person = (e: string) =>
  `json_build_object('employeeId', ${e}.id, 'code', ${e}.code, 'fullName', ${e}.full_name)`;

const teamTarget = (ctx: ProductCommandContext) => ({
  resource: 'team',
  key: ctx.target.key,
  objectId: ctx.target.objectId,
});

/** hrCompany.createTeam: a team without members or lead (no facts change yet). */
export const createTeam: ProductCommand<TeamCreateInput, { readonly id: string }> = {
  resource: 'hrCompany',
  action: 'createTeam',
  mode: 'write',
  target: () => HR_COMPANY_ID,
  run: async (ctx, input) => {
    const id = randomUUID();
    const objectId = await registerHrObject(ctx.tx, 'team', id);
    try {
      await ctx.tx.manager.query('INSERT INTO team(id,object_id,name) VALUES($1,$2,$3)', [
        id,
        objectId,
        input.name,
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ProductCommandRejected('duplicate');
      throw error;
    }
    await ctx.audit('hr.team.create', { resource: 'team', key: id, objectId });
    return { id };
  },
};

/** team.update: rename with optimistic version; names are unique ignoring case. */
export const renameTeam: ProductCommand<TeamRenameInput, { readonly version: string }> = {
  resource: 'team',
  action: 'update',
  mode: 'write',
  target: (input) => input.teamId,
  run: async (ctx, input) => {
    let rows: { version: string }[];
    try {
      rows = await ctx.tx.manager.query<{ version: string }[]>(
        `WITH updated AS (UPDATE team SET name = $2, version = version + 1
           WHERE id = $1 AND version = CAST($3 AS int8) RETURNING version::text AS version)
         SELECT * FROM updated`,
        [ctx.target.key, input.name, input.expectedVersion],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ProductCommandRejected('duplicate');
      throw error;
    }
    if (!rows[0]) throw new ProductCommandRejected('stale_version');
    await ctx.audit('hr.team.update', teamTarget(ctx));
    return { version: rows[0].version };
  },
};

/**
 * Guards of every membership/lead change, Root included: the employee exists and still works
 * (not past the last working day), and is not the caller's own profile — adding oneself to a team,
 * choosing one's own primary team or becoming lead would pick who approves one's requests or
 * whose requests one approves (no self escalation, AGENTS.md).
 */
async function assignable(ctx: ProductCommandContext, employeeId: string): Promise<void> {
  const [row] = await ctx.tx.manager.query<{ account: string | null; working: boolean }[]>(
    `SELECT account_id::text AS account, (terminated_on IS NULL OR terminated_on >= ${HR_TODAY}) AS working
       FROM employee WHERE id = $1`,
    [employeeId],
  );
  if (!row?.working) throw new ProductCommandRejected('employee_unavailable');
  if (row.account === ctx.actor.id) throw new ProductCommandRejected('self_assignment');
}

interface Membership {
  readonly id: string;
  readonly team: string;
  readonly primary: boolean;
}

/** Current memberships of one employee; facts change runs under the exclusive fence (§7.1). */
const memberships = (ctx: ProductCommandContext, employeeId: string) =>
  ctx.tx.manager.query<Membership[]>(
    `SELECT id::text AS id, team_id::text AS team, is_primary AS "primary"
       FROM team_membership WHERE employee_id = $1 AND ends_at IS NULL ORDER BY id`,
    [employeeId],
  );

const endMembershipRow = (ctx: ProductCommandContext, id: string) =>
  ctx.tx.manager.query(
    'UPDATE team_membership SET ends_at = statement_timestamp() WHERE id = $1 AND ends_at IS NULL',
    [id],
  );

const addMembershipRow = (
  ctx: ProductCommandContext,
  team: string,
  employeeId: string,
  primary: boolean,
) =>
  ctx.tx.manager.query(
    'INSERT INTO team_membership(id,employee_id,team_id,is_primary,starts_at) VALUES($1,$2,$3,$4,statement_timestamp())',
    [randomUUID(), employeeId, team, primary],
  );

/** Ends the current primary row and re-adds that team as secondary (history stays exact). */
async function demotePrimary(
  ctx: ProductCommandContext,
  employeeId: string,
  current: readonly Membership[],
): Promise<void> {
  const primary = current.find((m) => m.primary);
  if (!primary) return;
  await endMembershipRow(ctx, primary.id);
  await addMembershipRow(ctx, primary.team, employeeId, false);
}

async function finishAssign(ctx: ProductCommandContext): Promise<void> {
  await ctx.tx.manager.query('UPDATE team SET version = version + 1 WHERE id = $1', [
    ctx.target.key,
  ]);
  await ctx.audit('hr.team.assign', teamTarget(ctx));
}

/** team.assign: adds a member; `primary` moves the primary flag here (first team is primary). */
export const addMember: ProductCommand<TeamMemberInput, { readonly status: 'added' }> = {
  resource: 'team',
  action: 'assign',
  mode: 'admin',
  target: (input) => input.teamId,
  run: async (ctx, input) => {
    await assignable(ctx, input.employeeId);
    const current = await memberships(ctx, input.employeeId);
    if (current.some((m) => m.team === ctx.target.key))
      throw new ProductCommandRejected('already_member');
    const primary = current.length === 0 || input.primary;
    if (primary) await demotePrimary(ctx, input.employeeId, current);
    await addMembershipRow(ctx, ctx.target.key, input.employeeId, primary);
    await finishAssign(ctx);
    return { status: 'added' };
  },
};

/** team.assign: this existing membership becomes the employee's primary team. */
export const setPrimaryTeam: ProductCommand<TeamMembershipRef, { readonly status: 'primary' }> = {
  resource: 'team',
  action: 'assign',
  mode: 'admin',
  target: (input) => input.teamId,
  run: async (ctx, input) => {
    await assignable(ctx, input.employeeId);
    const current = await memberships(ctx, input.employeeId);
    const row = current.find((m) => m.team === ctx.target.key);
    if (!row) throw new ProductCommandRejected('not_member');
    if (row.primary) throw new ProductCommandRejected('unchanged');
    await demotePrimary(ctx, input.employeeId, current);
    await endMembershipRow(ctx, row.id);
    await addMembershipRow(ctx, ctx.target.key, input.employeeId, true);
    await finishAssign(ctx);
    return { status: 'primary' };
  },
};

/**
 * team.assign: ends a membership. A primary membership ends only when it is the last one, so an
 * employee with teams always has exactly one primary team (design §8).
 */
export const endMembership: ProductCommand<TeamMembershipRef, { readonly status: 'ended' }> = {
  resource: 'team',
  action: 'assign',
  mode: 'admin',
  target: (input) => input.teamId,
  run: async (ctx, input) => {
    const [employee] = await ctx.tx.manager.query<{ account: string | null }[]>(
      'SELECT account_id::text AS account FROM employee WHERE id = $1',
      [input.employeeId],
    );
    if (!employee) throw new ProductCommandRejected('not_member');
    if (employee.account === ctx.actor.id) throw new ProductCommandRejected('self_assignment');
    const current = await memberships(ctx, input.employeeId);
    const row = current.find((m) => m.team === ctx.target.key);
    if (!row) throw new ProductCommandRejected('not_member');
    if (row.primary && current.length > 1) throw new ProductCommandRejected('primary_required');
    await endMembershipRow(ctx, row.id);
    await finishAssign(ctx);
    return { status: 'ended' };
  },
};

/** team.assign: replaces the current lead (at most one, D01) or leaves the team without one. */
export const assignLead: ProductCommand<TeamLeadInput, { readonly status: 'assigned' }> = {
  resource: 'team',
  action: 'assign',
  mode: 'admin',
  target: (input) => input.teamId,
  run: async (ctx, input) => {
    const [lead] = await ctx.tx.manager.query<{ id: string; employee: string }[]>(
      `SELECT id::text AS id, lead_employee_id::text AS employee
         FROM team_lead_assignment WHERE team_id = $1 AND ends_at IS NULL`,
      [ctx.target.key],
    );
    if ((lead?.employee ?? null) === input.employeeId)
      throw new ProductCommandRejected('unchanged');
    if (input.employeeId !== null) await assignable(ctx, input.employeeId);
    if (lead)
      await ctx.tx.manager.query(
        'UPDATE team_lead_assignment SET ends_at = statement_timestamp() WHERE id = $1',
        [lead.id],
      );
    if (input.employeeId !== null)
      await ctx.tx.manager.query(
        'INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES($1,$2,$3,statement_timestamp())',
        [randomUUID(), ctx.target.key, input.employeeId],
      );
    await finishAssign(ctx);
    return { status: 'assigned' };
  },
};

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

export const teamCommands = [
  createTeam,
  renameTeam,
  addMember,
  setPrimaryTeam,
  endMembership,
  assignLead,
] as const;

export const teamQueries = [listTeams, teamDetail] as const;

/** Team operations bound to the registered commands/queries; `undefined` = absent or hidden. */
export class TeamService {
  constructor(private readonly authorization: ProductAuthorization) {}

  list(secret: string, query: TeamListQuery): Promise<TeamListView> {
    return this.authorization.query(secret, listTeams, query);
  }

  detail(secret: string, teamId: string): Promise<TeamView | undefined> {
    return this.authorization.query(secret, teamDetail, { teamId });
  }

  async create(secret: string, input: TeamCreateInput): Promise<{ readonly id: string }> {
    const created = await this.authorization.execute(secret, createTeam, input);
    // As for employees: the anchor always exists, so "not visible" means no grant (403).
    if (!created) throw new ProductAccessDenied();
    return created;
  }

  rename(secret: string, input: TeamRenameInput) {
    return this.authorization.execute(secret, renameTeam, input);
  }

  addMember(secret: string, input: TeamMemberInput) {
    return this.authorization.execute(secret, addMember, input);
  }

  setPrimary(secret: string, input: TeamMembershipRef) {
    return this.authorization.execute(secret, setPrimaryTeam, input);
  }

  endMembership(secret: string, input: TeamMembershipRef) {
    return this.authorization.execute(secret, endMembership, input);
  }

  assignLead(secret: string, input: TeamLeadInput) {
    return this.authorization.execute(secret, assignLead, input);
  }
}
