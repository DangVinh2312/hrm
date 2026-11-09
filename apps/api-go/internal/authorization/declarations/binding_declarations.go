package declarations

import (
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/keys"
)

func Bindings() compiler.StorageBindings {
	return compiler.StorageBindings{
		Resources: []compiler.ResourceBinding{
			{Resource: string(keys.DocumentResourceDocument), Table: "document", ObjectIDColumn: "object_id", KeyColumn: "id", Columns: map[string]string{"title": "title", "ownerId": "owner_id", "state": "state"}, Projection: []string{"title", "state"}},
			{Resource: string(keys.AccountResourceAccount), Table: "account_directory", ObjectIDColumn: "id", KeyColumn: "id", Columns: map[string]string{"state": "state", "email": "email", "enrollment": "enrollment"}, Projection: []string{"email", "state", "enrollment"}},
			{Resource: string(keys.EmployeeResourceEmployee), Table: "employee", ObjectIDColumn: "object_id", KeyColumn: "id", Columns: map[string]string{"code": "code", "fullName": "full_name", "accountId": "account_id"}, Projection: []string{"code", "fullName"}},
			{Resource: string(keys.TeamResourceTeam), Table: "team", ObjectIDColumn: "object_id", KeyColumn: "id", Columns: map[string]string{"name": "name"}, Projection: []string{"name"}},
			{Resource: string(keys.WorkRequestResourceWorkRequest), Table: "work_request", ObjectIDColumn: "object_id", KeyColumn: "id", Columns: map[string]string{"kind": "kind", "state": "state", "version": "version"}, Projection: []string{"kind", "state", "version"}},
			{Resource: string(keys.CompanyResourceCompany), Table: "hr_company", ObjectIDColumn: "object_id", KeyColumn: "id", Columns: map[string]string{}, Projection: []string{}},
			{Resource: string(keys.EmployeeResourceEmployeeIdentity), Table: "employee_identity", ObjectIDColumn: "object_id", KeyColumn: "employee_id", Columns: map[string]string{}, Projection: []string{}},
			{Resource: string(keys.EmployeeResourceLeaveRate), Table: "leave_rate", ObjectIDColumn: "object_id", KeyColumn: "id", Columns: map[string]string{}, Projection: []string{}},
			{Resource: string(keys.WorkCalendarResourceWorkCalendar), Table: "work_calendar", ObjectIDColumn: "object_id", KeyColumn: "id", Columns: map[string]string{}, Projection: []string{}},
			{Resource: string(keys.SettingResourceSetting), Table: "setting_anchor", ObjectIDColumn: "object_id", KeyColumn: "id", Columns: map[string]string{}, Projection: []string{}},
			{Resource: string(keys.RoleResourceRole), Table: "role_anchor", ObjectIDColumn: "object_id", KeyColumn: "id", Columns: map[string]string{}, Projection: []string{}},
		},
		Domains: map[string]compiler.DomainRelationBinding{
			"hrEmployeeLead":   {Table: "hr_employee_lead", SourceColumn: "employee_id", TargetColumn: "lead_account_id"},
			"hrTeamMember":     {Table: "hr_team_member", SourceColumn: "team_id", TargetColumn: "account_id"},
			"hrTeamLead":       {Table: "hr_team_lead", SourceColumn: "team_id", TargetColumn: "lead_account_id"},
			"hrRequestOwner":   {Table: "hr_request_owner", SourceColumn: "request_id", TargetColumn: "account_id"},
			"hrRequestLead":    {Table: "hr_request_lead", SourceColumn: "request_id", TargetColumn: "lead_account_id"},
			"hrRequestDecider": {Table: "hr_request_decider", SourceColumn: "request_id", TargetColumn: "actor_account_id"},
			string(keys.WorkRequestDomainRequestLeadRejected): {Table: "hr_request_lead_rejected", SourceColumn: "request_id", TargetColumn: "owner_account_id"},
			"hrEmployeeOwner":  {Table: "hr_employee_owner", SourceColumn: "employee_id", TargetColumn: "account_id"},
			"hrLeaveRateOwner": {Table: "hr_leave_rate_owner", SourceColumn: "rate_id", TargetColumn: "account_id"},
		},
	}
}
