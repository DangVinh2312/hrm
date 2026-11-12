package role

import (
	"cmp"
	"errors"
	"slices"
	"strings"

	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/grant"
)

const maxCatalogPairs = 500

// selfApproval: a role holding both can submit and finally approve its own request; approvals alone makes
// every submit of its holder end in final_approval_unavailable.
const (
	permissionApprovals   = "hrCompany.approvals"
	permissionDecideFinal = "workRequest.decideFinal"
)

func isDocument(permission string) bool { return strings.HasPrefix(permission, "document.") }

func holds(grants []GrantPair, permission string) bool {
	return slices.ContainsFunc(grants, func(g GrantPair) bool { return g.Permission == permission })
}

func lacksFinalDecision(grants []GrantPair) bool {
	return holds(grants, permissionApprovals) && !holds(grants, permissionDecideFinal)
}

// catalog is every single pair CheckRoleGrants accepts, document excluded, sorted by permission then template.
// A catalog above its bound is a release defect, refused when the operations are built rather than cut.
func catalog(declarations *core.ValidatedDeclarations) ([]GrantPair, error) {
	pairs := []GrantPair{}
	templates := declarations.Templates()
	for _, resource := range declarations.Resources() {
		if resource.Key == "document" {
			continue
		}
		for action := range resource.Actions {
			for _, template := range templates {
				pair := GrantPair{Permission: resource.Key + "." + action, Template: TemplateRef{Key: template.Key, Version: template.Version}}
				if grant.CheckRoleGrants(declarations, specs([]GrantPair{pair})) == grant.GrantsOK {
					pairs = append(pairs, pair)
				}
			}
		}
	}
	if len(pairs) > maxCatalogPairs {
		return nil, errors.New("role catalog above its bound")
	}
	slices.SortFunc(pairs, func(a, b GrantPair) int {
		return cmp.Or(strings.Compare(a.Permission, b.Permission), strings.Compare(a.Template.Key, b.Template.Key), cmp.Compare(a.Template.Version, b.Template.Version))
	})
	return pairs, nil
}

type Capability string

const (
	CapabilitySelfApproval          Capability = "selfApproval"
	CapabilityRequestDecision       Capability = "requestDecision"
	CapabilitySelfAdjustment        Capability = "selfAdjustment"
	CapabilityEmployeeWrite         Capability = "employeeWrite"
	CapabilityAccountLink           Capability = "accountLink"
	CapabilityAccountAdministration Capability = "accountAdministration"
)

var capabilityOrder = []Capability{CapabilitySelfApproval, CapabilityRequestDecision, CapabilitySelfAdjustment, CapabilityEmployeeWrite, CapabilityAccountLink, CapabilityAccountAdministration}

var requestTemplates = []string{"allRequests", "decidedRequests", "finalQueue", "leadRejectedLeadRequests", "ledRequests", "ownRequests"}

var riskRules = []struct {
	risk        Capability
	permissions []string
	templates   []string
}{
	{CapabilityRequestDecision, []string{"workRequest.decideFinal", "workRequest.decideLead", "workRequest.cancelApproved", "workRequest.cancel"}, requestTemplates},
	{CapabilitySelfAdjustment, []string{"employee.adjustLeaveBalance", "employee.adjustLeaveRate", "employee.adjustAttendance", "employee.manageSchedule"}, []string{"selfEmployee", "ledEmployees"}},
	{CapabilityEmployeeWrite, []string{"employee.update", "employee.submitRequest"}, []string{"allEmployees", "ledEmployees"}},
	{CapabilityAccountLink, []string{"employee.linkAccount"}, []string{"allEmployees", "ledEmployees", "selfEmployee"}},
	{CapabilityAccountLink, []string{"team.assign"}, []string{"allTeams", "ledTeams", "memberTeams"}},
	{CapabilityAccountAdministration, []string{
		"account.assignRole", "account.bindBoundary", "account.changeEmail", "account.provision", "account.reactivate", "account.read",
		"account.readPermissions", "account.resetGoogleBinding", "account.resetMfa", "account.revokeRole", "account.suspend", "account.unbindBoundary",
	}, []string{"allAccounts"}},
}

type riskPair struct{ permission, template string }

var riskByPair = func() map[riskPair]Capability {
	risks := map[riskPair]Capability{}
	for _, rule := range riskRules {
		for _, permission := range rule.permissions {
			for _, template := range rule.templates {
				risks[riskPair{permission, template}] = rule.risk
			}
		}
	}
	return risks
}()

// capabilities is every risk class the grants carry, in capabilityOrder; the web warns from this list only.
func capabilities(grants []GrantPair) []Capability {
	found := map[Capability]bool{CapabilitySelfApproval: holds(grants, permissionApprovals) && holds(grants, permissionDecideFinal)}
	for _, g := range grants {
		if risk, ok := riskByPair[riskPair{g.Permission, g.Template.Key}]; ok {
			found[risk] = true
		}
	}
	out := []Capability{}
	for _, capability := range capabilityOrder {
		if found[capability] {
			out = append(out, capability)
		}
	}
	return out
}
