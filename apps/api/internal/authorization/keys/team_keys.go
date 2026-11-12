package keys

type TeamTemplate string

const (
	TeamTemplateMemberTeams TeamTemplate = "memberTeams"
	TeamTemplateLedTeams    TeamTemplate = "ledTeams"
	TeamTemplateAllTeams    TeamTemplate = "allTeams"
)

type TeamRelation string

const (
	TeamRelationTeamMember TeamRelation = "team.member"
	TeamRelationTeamLead   TeamRelation = "team.lead"
)

type TeamAction string

const (
	TeamActionRead      TeamAction = "read"
	TeamActionUpdate    TeamAction = "update"
	TeamActionAssign    TeamAction = "assign"
	TeamActionApprovals TeamAction = "approvals"
)

type TeamDomain string

const (
	TeamDomainTeamMember TeamDomain = "hrTeamMember"
	TeamDomainTeamLead   TeamDomain = "hrTeamLead"
)

type TeamResource string

const (
	TeamResourceTeam TeamResource = "team"
)
