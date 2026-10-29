import { CompanyAction, CompanyResource } from '../permission/permission-authorization.types.js';
import { TeamAction, TeamResource } from './team-authorization.types.js';
import { randomUUID } from 'node:crypto';
import {
  ProductAccessDenied,
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
  type ProductCommandContext,
} from '../../authorization/services/product-authority.service.js';
import { COMPANY_ID } from '../permission/permission-database.helper.js';
import { BUSINESS_TODAY } from '../../infrastructure/helpers/business-time.helper.js';
import { isUniqueViolation } from '../../infrastructure/helpers/database-error.helper.js';
import type { PermissionObjectRepository } from '../permission/permission-object.repository.js';
import type { TeamReadRepository } from './team-read.repository.js';
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

const teamTarget = (ctx: ProductCommandContext) => ({
  resource: TeamResource.Team,
  key: ctx.target.key,
  objectId: ctx.target.objectId,
});

/** hrCompany.createTeam: a team without members or lead (no facts change yet). */
export const createTeam = (
  objects: PermissionObjectRepository,
): ProductCommand<TeamCreateInput, { readonly id: string }> => ({
  resource: CompanyResource.Company,
  action: CompanyAction.CreateTeam,
  mode: 'write',
  target: () => COMPANY_ID,
  run: async (ctx, input) => {
    const id = randomUUID();
    const objectId = await objects.register(ctx.tx, TeamResource.Team, id);
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
    await ctx.audit('hr.team.create', { resource: TeamResource.Team, key: id, objectId });
    return { id };
  },
});

/** team.update: rename with optimistic version; names are unique ignoring case. */
export const renameTeam: ProductCommand<TeamRenameInput, { readonly version: string }> = {
  resource: TeamResource.Team,
  action: TeamAction.Update,
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
    `SELECT account_id::text AS account, (terminated_on IS NULL OR terminated_on >= ${BUSINESS_TODAY}) AS working
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
  resource: TeamResource.Team,
  action: TeamAction.Assign,
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
  resource: TeamResource.Team,
  action: TeamAction.Assign,
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
  resource: TeamResource.Team,
  action: TeamAction.Assign,
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
    // Lead ⊆ member: the lead leaves only after a handover or `assignLead(null)`.
    const [leading] = await ctx.tx.manager.query<{ id: string }[]>(
      `SELECT id::text AS id FROM team_lead_assignment
        WHERE team_id = $1 AND lead_employee_id = $2 AND ends_at IS NULL`,
      [ctx.target.key, input.employeeId],
    );
    if (leading) throw new ProductCommandRejected('member_is_lead');
    await endMembershipRow(ctx, row.id);
    await finishAssign(ctx);
    return { status: 'ended' };
  },
};

/**
 * team.assign: replaces the current lead (at most one, D01) or leaves the team without one. A lead
 * must be an open member of that team; being both stays valid (spec §6.4(2)).
 */
export const assignLead: ProductCommand<TeamLeadInput, { readonly status: 'assigned' }> = {
  resource: TeamResource.Team,
  action: TeamAction.Assign,
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
    if (input.employeeId !== null) {
      await assignable(ctx, input.employeeId);
      // Lead ⊆ member, checked under the same exclusive fence as every membership change.
      const open = await memberships(ctx, input.employeeId);
      if (!open.some((m) => m.team === ctx.target.key))
        throw new ProductCommandRejected('lead_not_member');
    }
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

export type CreateTeamCommand = ReturnType<typeof createTeam>;

export const teamCommands = (create: CreateTeamCommand) =>
  [create, renameTeam, addMember, setPrimaryTeam, endMembership, assignLead] as const;

export const teamQueries = (reads: TeamReadRepository) =>
  [reads.listTeams, reads.teamDetail] as const;

/** Team operations bound to the registered commands/queries; `undefined` = absent or hidden. */
export class TeamService {
  constructor(
    private readonly authorization: ProductAuthorization,
    private readonly reads: TeamReadRepository,
    private readonly createTeamCommand: CreateTeamCommand,
  ) {}

  list(secret: string, query: TeamListQuery): Promise<TeamListView> {
    return this.authorization.query(secret, this.reads.listTeams, query);
  }

  detail(secret: string, teamId: string): Promise<TeamView | undefined> {
    return this.authorization.query(secret, this.reads.teamDetail, { teamId });
  }

  async create(secret: string, input: TeamCreateInput): Promise<{ readonly id: string }> {
    const created = await this.authorization.execute(secret, this.createTeamCommand, input);
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
