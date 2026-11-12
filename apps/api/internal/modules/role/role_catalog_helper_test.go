package role

import (
	"errors"
	"slices"
	"strconv"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/declarations"
)

// selectable derives the pairs a runtime role may pick from the declarations alone, without catalog or the
// validator: a template of the same resource, no parameters, never `document`.
func selectable(validated *core.ValidatedDeclarations) []GrantPair {
	pairs := []GrantPair{}
	for _, resource := range validated.Resources() {
		if resource.Key == "document" {
			continue
		}
		for action := range resource.Actions {
			for _, template := range validated.Templates() {
				if template.Resource == resource.Key && len(template.Parameters) == 0 {
					pairs = append(pairs, pair(resource.Key+"."+action, template.Key, template.Version))
				}
			}
		}
	}
	return pairs
}

func named(p GrantPair) string { return p.Permission + " " + p.Template.Key }

// accepted: a lone hrCompany.approvals is refused on its own, so it is checked with its pair.
func accepted(t *testing.T, validated *core.ValidatedDeclarations, candidate GrantPair) bool {
	t.Helper()
	grants := []GrantPair{candidate}
	if candidate.Permission == permissionApprovals {
		grants = append(grants, pair(permissionDecideFinal, "finalQueue", 1))
	}
	err := checkCatalog(validated, "x", grants)
	if err != nil && !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Fatalf("%v: %v", candidate, err)
	}
	return err == nil
}

func TestTheValidatorTakesExactlyThePairsOfTheCatalog(t *testing.T) {
	_, validated := release(t)
	pairs, err := catalog(validated)
	if err != nil {
		t.Fatal(err)
	}
	listed := map[GrantPair]bool{}
	for _, p := range pairs {
		listed[p] = true
	}
	if len(listed) != len(pairs) {
		t.Errorf("%d pairs, %d distinct", len(pairs), len(listed))
	}
	derived := selectable(validated)
	if len(derived) != len(pairs) {
		t.Errorf("%d pairs in the catalog, %d derived from the declarations", len(pairs), len(derived))
	}
	for _, p := range derived {
		if !listed[p] {
			t.Errorf("the catalog misses %v", p)
		}
	}

	candidates := 0
	for _, resource := range validated.Resources() {
		for action := range resource.Actions {
			for _, template := range validated.Templates() {
				candidates++
				candidate := pair(resource.Key+"."+action, template.Key, template.Version)
				if got := accepted(t, validated, candidate); got != listed[candidate] {
					t.Errorf("%v: accepted %t, listed %t", candidate, got, listed[candidate])
				}
			}
		}
	}
	if candidates <= len(pairs) {
		t.Errorf("%d candidates for %d listed pairs: nothing outside the catalog was checked", candidates, len(pairs))
	}
}

// grown is the release with extra actions on `role`, each one more pair of the catalog.
func grown(t *testing.T, c *core.Core, extra int) *core.ValidatedDeclarations {
	t.Helper()
	source := declarations.Source().Declarations
	for _, resource := range source.Resources {
		if resource.Key != "role" {
			continue
		}
		read := resource.Actions["read"]
		for i := range extra {
			resource.Actions["bound"+strconv.Itoa(i)] = read
		}
	}
	validated, err := c.Validate(source)
	if err != nil {
		t.Fatal(err)
	}
	return validated
}

func TestACatalogAboveItsBoundIsRefusedNotCut(t *testing.T) {
	c, validated := release(t)
	base, err := catalog(validated)
	if err != nil {
		t.Fatal(err)
	}
	room := maxCatalogPairs - len(base)

	full, err := catalog(grown(t, c, room))
	if err != nil || len(full) != maxCatalogPairs {
		t.Fatalf("a catalog of exactly the bound: %d pairs, %v", len(full), err)
	}
	above := grown(t, c, room+1)
	if pairs, err := catalog(above); err == nil || pairs != nil {
		t.Errorf("a catalog one above the bound: %d pairs, %v", len(pairs), err)
	}
	if operations, err := NewOperations(c, above); err == nil || operations != nil {
		t.Error("the operations were built over a catalog above its bound")
	}
}

var pinnedHighRiskPairs = []string{
	"account.assignRole allAccounts",
	"account.bindBoundary allAccounts",
	"account.changeEmail allAccounts",
	"account.provision allAccounts",
	"account.reactivate allAccounts",
	"account.read allAccounts",
	"account.readPermissions allAccounts",
	"account.resetGoogleBinding allAccounts",
	"account.resetMfa allAccounts",
	"account.revokeRole allAccounts",
	"account.suspend allAccounts",
	"account.unbindBoundary allAccounts",
	"employee.adjustAttendance ledEmployees",
	"employee.adjustAttendance selfEmployee",
	"employee.adjustLeaveBalance ledEmployees",
	"employee.adjustLeaveBalance selfEmployee",
	"employee.adjustLeaveRate ledEmployees",
	"employee.adjustLeaveRate selfEmployee",
	"employee.linkAccount allEmployees",
	"employee.linkAccount ledEmployees",
	"employee.linkAccount selfEmployee",
	"employee.manageSchedule ledEmployees",
	"employee.manageSchedule selfEmployee",
	"employee.submitRequest allEmployees",
	"employee.submitRequest ledEmployees",
	"employee.update allEmployees",
	"employee.update ledEmployees",
	"team.assign allTeams",
	"team.assign ledTeams",
	"team.assign memberTeams",
	"workRequest.cancel allRequests",
	"workRequest.cancel decidedRequests",
	"workRequest.cancel finalQueue",
	"workRequest.cancel leadRejectedLeadRequests",
	"workRequest.cancel ledRequests",
	"workRequest.cancel ownRequests",
	"workRequest.cancelApproved allRequests",
	"workRequest.cancelApproved decidedRequests",
	"workRequest.cancelApproved finalQueue",
	"workRequest.cancelApproved leadRejectedLeadRequests",
	"workRequest.cancelApproved ledRequests",
	"workRequest.cancelApproved ownRequests",
	"workRequest.decideFinal allRequests",
	"workRequest.decideFinal decidedRequests",
	"workRequest.decideFinal finalQueue",
	"workRequest.decideFinal leadRejectedLeadRequests",
	"workRequest.decideFinal ledRequests",
	"workRequest.decideFinal ownRequests",
	"workRequest.decideLead allRequests",
	"workRequest.decideLead decidedRequests",
	"workRequest.decideLead finalQueue",
	"workRequest.decideLead leadRejectedLeadRequests",
	"workRequest.decideLead ledRequests",
	"workRequest.decideLead ownRequests",
}

var pinnedHighRiskPermissions = []string{
	"account.assignRole",
	"account.bindBoundary",
	"account.changeEmail",
	"account.provision",
	"account.reactivate",
	"account.read",
	"account.readPermissions",
	"account.resetGoogleBinding",
	"account.resetMfa",
	"account.revokeRole",
	"account.suspend",
	"account.unbindBoundary",
	"employee.adjustAttendance",
	"employee.adjustLeaveBalance",
	"employee.adjustLeaveRate",
	"employee.linkAccount",
	"employee.manageSchedule",
	"employee.submitRequest",
	"employee.update",
	"team.assign",
	"workRequest.cancel",
	"workRequest.cancelApproved",
	"workRequest.decideFinal",
	"workRequest.decideLead",
}

var pinnedOtherPermissions = []string{
	"employee.read",
	"employee.readAttendance",
	"employee.readAttendanceAdjustment",
	"employee.readLeaveBalance",
	"employee.readSchedule",
	"employee.reportAttendance",
	"employee.reportBirthday",
	"employee.reportLateEarly",
	"employee.reportLeave",
	"employee.reportSeniority",
	"employee.reportWfh",
	"employeeIdentity.read",
	"employeeIdentity.update",
	"hrCompany.approvals",
	"hrCompany.createEmployee",
	"hrCompany.createTeam",
	"hrCompany.managePeriod",
	"hrCompany.read",
	"leaveRate.read",
	"role.create",
	"role.delete",
	"role.read",
	"role.update",
	"setting.read",
	"setting.readProfile",
	"setting.updateProfile",
	"setting.updateRule",
	"team.approvals",
	"team.read",
	"team.update",
	"workCalendar.manage",
	"workCalendar.manageSchedule",
	"workCalendar.read",
	"workRequest.read",
	"workRequest.readDecided",
	"workRequest.readLeadRejected",
}

func sortedUnique(values []string) []string {
	sorted := slices.Clone(values)
	slices.Sort(sorted)
	return slices.Compact(sorted)
}

func TestTheHighRiskPairsAreExactlyThePinnedListAndAllSelectable(t *testing.T) {
	_, validated := release(t)
	actual := make([]string, 0, len(riskByPair))
	for risky := range riskByPair {
		actual = append(actual, risky.permission+" "+risky.template)
	}
	slices.Sort(actual)
	if !slices.Equal(actual, pinnedHighRiskPairs) {
		t.Errorf("high-risk pairs:\n got %v\nwant %v", actual, pinnedHighRiskPairs)
	}
	offered := map[string]bool{}
	for _, p := range selectable(validated) {
		offered[named(p)] = true
	}
	for _, risky := range actual {
		if !offered[risky] {
			t.Errorf("%s carries a risk and is not a selectable pair of the release", risky)
		}
	}
}

// A permission the release adds fails here until someone decides whether it is a risk.
func TestEveryPermissionOfTheReleaseIsClassified(t *testing.T) {
	_, validated := release(t)
	offered := selectable(validated)
	if len(offered) != 142 {
		t.Errorf("%d selectable pairs, the pinned lists were decided over 142", len(offered))
	}
	permissions := make([]string, 0, len(offered))
	for _, p := range offered {
		permissions = append(permissions, p.Permission)
	}
	classified := sortedUnique(slices.Concat(pinnedHighRiskPermissions, pinnedOtherPermissions))
	if len(classified) != len(pinnedHighRiskPermissions)+len(pinnedOtherPermissions) {
		t.Error("a permission is pinned twice")
	}
	if got := sortedUnique(permissions); !slices.Equal(got, classified) {
		t.Errorf("permissions of the release:\n got %v\nwant %v", got, classified)
	}
	risky := make([]string, 0, len(riskByPair))
	for p := range riskByPair {
		risky = append(risky, p.permission)
	}
	if got := sortedUnique(risky); !slices.Equal(got, pinnedHighRiskPermissions) {
		t.Errorf("permissions carrying a risk:\n got %v\nwant %v", got, pinnedHighRiskPermissions)
	}
}

func TestOnlyThePairsOfTheClosedListCarryARiskCapability(t *testing.T) {
	_, validated := release(t)
	for _, p := range selectable(validated) {
		want := []Capability{}
		if risk, ok := riskByPair[riskPair{p.Permission, p.Template.Key}]; ok {
			want = []Capability{risk}
		}
		if got := capabilities([]GrantPair{p}); !slices.Equal(got, want) {
			t.Errorf("%s: capabilities %v, want %v", named(p), got, want)
		}
	}
	for risky, risk := range riskByPair {
		if got := capabilities([]GrantPair{pair(risky.permission, risky.template, 1)}); !slices.Equal(got, []Capability{risk}) {
			t.Errorf("%s %s: capabilities %v, want %s", risky.permission, risky.template, got, risk)
		}
	}
}

func TestSelfApprovalNeedsBothPermissionsWhateverTheirTemplates(t *testing.T) {
	approvals := pair("hrCompany.approvals", "company", 1)
	for name, c := range map[string]struct {
		grants []GrantPair
		want   []Capability
	}{
		"both, any template": {[]GrantPair{approvals, pair("workRequest.decideFinal", "x", 1)}, []Capability{CapabilitySelfApproval}},
		"both, final queue":  {[]GrantPair{pair("hrCompany.approvals", "x", 1), pair("workRequest.decideFinal", "finalQueue", 1)}, []Capability{CapabilitySelfApproval, CapabilityRequestDecision}},
		"approvals alone":    {[]GrantPair{approvals}, []Capability{}},
		"decideFinal alone":  {[]GrantPair{pair("workRequest.decideFinal", "finalQueue", 1)}, []Capability{CapabilityRequestDecision}},
		"every other class in the fixed order": {[]GrantPair{
			pair("account.read", "allAccounts", 1), pair("employee.update", "allEmployees", 1),
			pair("employee.linkAccount", "selfEmployee", 1), pair("employee.adjustLeaveRate", "selfEmployee", 1),
		}, []Capability{CapabilitySelfAdjustment, CapabilityEmployeeWrite, CapabilityAccountLink, CapabilityAccountAdministration}},
		"a pair outside the list": {[]GrantPair{pair("employee.update", "selfEmployee", 1)}, []Capability{}},
	} {
		if got := capabilities(c.grants); !slices.Equal(got, c.want) {
			t.Errorf("%s: got %v want %v", name, got, c.want)
		}
	}
}

// sameInBothOrders is sufficient, not necessary: when it is true, byte order and a collation that ranks letters
// before their case, such as the localeCompare the web sorts with, agree on two keys of [A-Za-z0-9.]. It is
// false whenever the first bytes they differ at are letters of opposite case, though the two orders may still
// agree there (Ba and bb). Checked once against Node 24.20 (ICU 78.3) over 1.2 million pairs of [abzABZ019.]:
// no pair it accepts sorts differently.
func sameInBothOrders(a, b string) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] == b[i] {
			continue
		}
		upperA, upperB := a[i] >= 'A' && a[i] <= 'Z', b[i] >= 'A' && b[i] <= 'Z'
		lowerA, lowerB := a[i] >= 'a' && a[i] <= 'z', b[i] >= 'a' && b[i] <= 'z'
		return (!upperA || !lowerB) && (!lowerA || !upperB)
	}
	return true
}

func TestByteOrderOfTheGrantsIsTheCollationOrderOfTheReleaseKeys(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"employee.read", "employee.readAttendance", true}, {"a.b", "ab", true}, {"a1", "aB", true}, {"aB", "ab", false},
		{"readB", "reada", false}, {"ownRequests", "ownedDocuments", false}, {"Team.read", "employee.read", false},
	} {
		if got := sameInBothOrders(c.a, c.b); got != c.want || sameInBothOrders(c.b, c.a) != c.want {
			t.Errorf("%s and %s: %t, want %t", c.a, c.b, got, c.want)
		}
	}

	_, validated := release(t)
	ascii := func(key string) bool {
		for i := 0; i < len(key); i++ {
			letter := key[i] >= 'A' && key[i] <= 'Z' || key[i] >= 'a' && key[i] <= 'z'
			if !letter && (key[i] < '0' || key[i] > '9') && key[i] != '.' {
				return false
			}
		}
		return key != ""
	}
	disagreeing := func(kind string, keys []string) {
		t.Helper()
		for i, a := range keys {
			if !ascii(a) {
				t.Errorf("%s %q is outside [A-Za-z0-9.]", kind, a)
			}
			for _, b := range keys[i+1:] {
				if !sameInBothOrders(a, b) {
					t.Errorf("%s %s and %s sort differently by byte and by collation", kind, a, b)
				}
			}
		}
	}
	var permissions []string
	templates := map[string][]string{}
	for _, resource := range validated.Resources() {
		for action := range resource.Actions {
			permissions = append(permissions, resource.Key+"."+action)
		}
	}
	for _, template := range validated.Templates() {
		templates[template.Resource] = append(templates[template.Resource], template.Key)
	}
	if len(permissions) < 60 || len(templates) < 10 {
		t.Fatalf("%d permissions, %d resources with templates", len(permissions), len(templates))
	}
	disagreeing("permission", permissions)
	// distinctGrants compares templates only under one permission, so only within one resource.
	for resource, keys := range templates {
		disagreeing("template of "+resource, keys)
	}
}
