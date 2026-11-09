package declarations

import (
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/keys"
)

func relations() []core.RelationDeclaration {
	return []core.RelationDeclaration{
		{Key: string(keys.EmployeeRelationEmployeeLead), Version: 1, SourceType: string(keys.EmployeeResourceEmployee), Target: core.RelationTarget{Kind: "identity"}, Binding: core.RelationBinding{Kind: "domain", Key: string(keys.EmployeeDomainEmployeeLead)}},
		{Key: string(keys.EmployeeRelationEmployeeIdentityOwner), Version: 1, SourceType: string(keys.EmployeeResourceEmployeeIdentity), Target: core.RelationTarget{Kind: "identity"}, Binding: core.RelationBinding{Kind: "domain", Key: string(keys.EmployeeDomainEmployeeOwner)}},
		{Key: string(keys.EmployeeRelationLeaveRateOwner), Version: 1, SourceType: string(keys.EmployeeResourceLeaveRate), Target: core.RelationTarget{Kind: "identity"}, Binding: core.RelationBinding{Kind: "domain", Key: string(keys.EmployeeDomainLeaveRateOwner)}},
		{Key: string(keys.TeamRelationTeamLead), Version: 1, SourceType: string(keys.TeamResourceTeam), Target: core.RelationTarget{Kind: "identity"}, Binding: core.RelationBinding{Kind: "domain", Key: string(keys.TeamDomainTeamLead)}},
		{Key: string(keys.TeamRelationTeamMember), Version: 1, SourceType: string(keys.TeamResourceTeam), Target: core.RelationTarget{Kind: "identity"}, Binding: core.RelationBinding{Kind: "domain", Key: string(keys.TeamDomainTeamMember)}},
		{Key: string(keys.WorkRequestRelationRequestDecider), Version: 1, SourceType: string(keys.WorkRequestResourceWorkRequest), Target: core.RelationTarget{Kind: "identity"}, Binding: core.RelationBinding{Kind: "domain", Key: string(keys.WorkRequestDomainRequestDecider)}},
		{Key: string(keys.WorkRequestRelationRequestLead), Version: 1, SourceType: string(keys.WorkRequestResourceWorkRequest), Target: core.RelationTarget{Kind: "identity"}, Binding: core.RelationBinding{Kind: "domain", Key: string(keys.WorkRequestDomainRequestLead)}},
		{Key: string(keys.WorkRequestRelationRequestLeadRejectedLeadOwned), Version: 1, SourceType: string(keys.WorkRequestResourceWorkRequest), Target: core.RelationTarget{Kind: "identity"}, Binding: core.RelationBinding{Kind: "domain", Key: string(keys.WorkRequestDomainRequestLeadRejected)}},
		{Key: string(keys.WorkRequestRelationRequestOwner), Version: 1, SourceType: string(keys.WorkRequestResourceWorkRequest), Target: core.RelationTarget{Kind: "identity"}, Binding: core.RelationBinding{Kind: "domain", Key: string(keys.WorkRequestDomainRequestOwner)}},
	}
}
