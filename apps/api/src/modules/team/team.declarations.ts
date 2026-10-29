import type { SystemDeclarations } from '../../authorization/core/authorization.declarations.js';
import type { ProductReleaseSource } from '../../authorization/services/product-manifest.service.js';
import type {
  ProductDomainRelationBinding,
  ProductResourceBinding,
} from '../../authorization/product-sql.compiler.js';
import {
  boundedAction,
  defaultGrant,
  identityRelation,
  optionalAction,
  permissionKey,
  relatedScope,
  scopeTemplate,
} from '../permission/permission-declaration.helper.js';
import { PermissionPolicy, PermissionRole } from '../permission/permission-authorization.types.js';
import {
  TeamAction,
  TeamDomain,
  TeamRelation,
  TeamResource,
  TeamTemplate,
} from './team-authorization.types.js';

/**
 * Team authorization fragment: data only, composed into the release in
 * authorization/product.manifest.ts.
 */
export const teamDeclarations: Pick<
  SystemDeclarations,
  'resources' | 'policies' | 'templates' | 'boundaries' | 'relations'
> = {
  resources: [
    {
      key: TeamResource.Team,
      keyKind: 'uuid',
      fields: { name: { kind: 'string' } },
      actions: {
        [TeamAction.Read]: optionalAction(PermissionPolicy.Read),
        [TeamAction.Update]: optionalAction(PermissionPolicy.Write),
        // Membership and lead assignment decide lead scope: facts change (§7.1).
        [TeamAction.Assign]: boundedAction(PermissionPolicy.Fresh),
        // Release 8 (T6 part C): display capability, the caller is the current lead of this
        // team, for the `approvals` menu (design §10.2). It authorizes no decision or read.
        [TeamAction.Approvals]: optionalAction(PermissionPolicy.Read),
      },
    },
  ],
  relations: [
    identityRelation(TeamRelation.TeamMember, TeamResource.Team, TeamDomain.TeamMember),
    identityRelation(TeamRelation.TeamLead, TeamResource.Team, TeamDomain.TeamLead),
  ],
  policies: [],
  templates: [
    scopeTemplate(
      TeamTemplate.MemberTeams,
      TeamResource.Team,
      relatedScope(TeamRelation.TeamMember),
    ),
    scopeTemplate(TeamTemplate.LedTeams, TeamResource.Team, relatedScope(TeamRelation.TeamLead)),
    scopeTemplate(TeamTemplate.AllTeams, TeamResource.Team, { op: 'constant', value: true }),
  ],
  boundaries: [],
};

const grant = (action: TeamAction, role: PermissionRole, template: TeamTemplate) =>
  defaultGrant(permissionKey(TeamResource.Team, action), role, template);

export const teamDefaultGrants: ProductReleaseSource['defaultGrants'] = [
  grant(TeamAction.Read, PermissionRole.Employee, TeamTemplate.MemberTeams),
  grant(TeamAction.Read, PermissionRole.Employee, TeamTemplate.LedTeams),
  grant(TeamAction.Read, PermissionRole.Coo, TeamTemplate.AllTeams),
  grant(TeamAction.Read, PermissionRole.Admin, TeamTemplate.AllTeams),
  // Release 8: the approvals menu of a team lead.
  grant(TeamAction.Approvals, PermissionRole.Employee, TeamTemplate.LedTeams),
  grant(TeamAction.Update, PermissionRole.Admin, TeamTemplate.AllTeams),
  // Also needs a bound boundary for an IAM caller (`hrAdministration@1`).
  grant(TeamAction.Assign, PermissionRole.Admin, TeamTemplate.AllTeams),
];

export const teamBinding: ProductResourceBinding = {
  resource: TeamResource.Team,
  table: 'team',
  objectIdColumn: 'object_id',
  keyColumn: 'id',
  columns: { name: 'name' },
  projection: ['name'],
};

export const teamDomains: Readonly<Record<TeamDomain, ProductDomainRelationBinding>> = {
  [TeamDomain.TeamMember]: {
    table: 'hr_team_member',
    sourceColumn: 'team_id',
    targetColumn: 'account_id',
  },
  [TeamDomain.TeamLead]: {
    table: 'hr_team_lead',
    sourceColumn: 'team_id',
    targetColumn: 'lead_account_id',
  },
};
