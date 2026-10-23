/** Keys of the team authorization fragment (ADR 0016, ADR 0035); values are stored strings. */
export const TeamResource = { Team: 'team' } as const;

export type TeamResource = (typeof TeamResource)[keyof typeof TeamResource];

export const TeamAction = {
  Read: 'read',
  Update: 'update',
  Assign: 'assign',
  Approvals: 'approvals',
} as const;

export type TeamAction = (typeof TeamAction)[keyof typeof TeamAction];

export const TeamTemplate = {
  MemberTeams: 'memberTeams',
  LedTeams: 'ledTeams',
  AllTeams: 'allTeams',
} as const;

export type TeamTemplate = (typeof TeamTemplate)[keyof typeof TeamTemplate];

export const TeamRelation = { TeamMember: 'team.member', TeamLead: 'team.lead' } as const;

export type TeamRelation = (typeof TeamRelation)[keyof typeof TeamRelation];

export const TeamDomain = { TeamMember: 'hrTeamMember', TeamLead: 'hrTeamLead' } as const;

export type TeamDomain = (typeof TeamDomain)[keyof typeof TeamDomain];
