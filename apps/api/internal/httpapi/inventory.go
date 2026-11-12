package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"hrm/api/internal/authorization/enforcement"
)

// Route is a method and a path as the contract writes them.
type Route struct {
	Method string
	Path   string
}

func (r Route) String() string { return r.Method + " " + r.Path }

// ContractRoute is a route of contract/routes.json.
type ContractRoute struct {
	Route
	Classification enforcement.Classification
}

// RegisteredRoute is what Register added to a Group.
type RegisteredRoute struct {
	Route
	Classification enforcement.Classification
}

// MigratedRoutes is every route this process serves itself. It is code, not configuration: moving a
// group of routes to Go or back is a change of this table.
var MigratedRoutes = []Route{
	{"GET", "/api/health/live"},
	{"GET", "/api/health/ready"},
	{"GET", "/api/health/metrics"},
	{"GET", "/api/openapi.json"},
	{"GET", "/api/auth/csrf"},
	{"GET", "/api/auth/options"},
	{"POST", "/api/auth/logout"},
	{"POST", "/api/auth/logout-all"},
	{"GET", "/api/auth/account"},
	{"POST", "/api/auth/mfa/totp/setup"},
	{"POST", "/api/auth/mfa/totp/confirm"},
	{"POST", "/api/auth/mfa/verify"},
	{"POST", "/api/auth/mfa/recovery-codes"},
	{"DELETE", "/api/auth/mfa/totp"},
	{"POST", "/api/auth/oidc/begin"},
	{"POST", "/api/auth/oidc/activate"},
	{"GET", "/api/auth/oidc/callback"},
	{"GET", "/api/administration/settings"},
	{"GET", "/api/administration/settings/profile"},
	{"GET", "/api/administration/settings/security"},
	{"GET", "/api/administration/settings/:key/history"},
	{"PUT", "/api/administration/settings/profile/:key"},
	{"PUT", "/api/administration/settings/rule/:key"},
	{"GET", "/api/hr/teams"},
	{"POST", "/api/hr/teams"},
	{"GET", "/api/hr/teams/:id"},
	{"PATCH", "/api/hr/teams/:id"},
	{"PUT", "/api/hr/teams/:id/lead"},
	{"POST", "/api/hr/teams/:id/members"},
	{"DELETE", "/api/hr/teams/:id/members/:employeeId"},
	{"POST", "/api/hr/teams/:id/members/:employeeId/primary"},
	{"GET", "/api/auth/session"},
	{"GET", "/api/auth/me"},
	{"GET", "/api/hr/employees"},
	{"GET", "/api/hr/employees/me"},
	{"GET", "/api/hr/employees/:id"},
	{"GET", "/api/hr/employees/:id/identity"},
	{"GET", "/api/hr/employees/:id/leave-rates"},
	{"POST", "/api/hr/employees"},
	{"PATCH", "/api/hr/employees/:id"},
	{"POST", "/api/hr/employees/:id/official"},
	{"POST", "/api/hr/employees/:id/termination"},
	{"POST", "/api/hr/employees/:id/leave-rates"},
	{"PUT", "/api/hr/employees/:id/identity"},
	{"PUT", "/api/hr/employees/:id/account"},
	{"GET", "/api/hr/work-calendar"},
	{"PUT", "/api/hr/work-calendar/holidays"},
	{"PUT", "/api/hr/work-calendar/days/:date"},
	{"GET", "/api/hr/work-calendar/schedule"},
	{"PUT", "/api/hr/work-calendar/schedule/:effectiveFrom"},
	{"DELETE", "/api/hr/work-calendar/schedule/:effectiveFrom"},
	{"GET", "/api/hr/employees/:id/schedule-frames"},
	{"POST", "/api/hr/employees/:id/schedule-frames"},
	{"DELETE", "/api/hr/employees/:id/schedule-frames/:frameId"},
	{"GET", "/api/hr/employees/:id/schedule"},
	{"GET", "/api/hr/employees/:id/leave-balance"},
	{"GET", "/api/hr/leave/reconciliation"},
	{"POST", "/api/hr/employees/:id/leave-adjustments"},
	{"POST", "/api/hr/requests"},
	{"GET", "/api/hr/requests"},
	{"GET", "/api/hr/requests/:id"},
	{"POST", "/api/hr/requests/:id/decision"},
	{"POST", "/api/hr/requests/:id/cancel"},
	{"GET", "/api/hr/approvals/lead"},
	{"GET", "/api/hr/approvals/final"},
	{"GET", "/api/hr/approvals/decided"},
	{"GET", "/api/hr/employees/:id/attendance"},
	{"GET", "/api/hr/attendance/periods/:month"},
	{"POST", "/api/hr/attendance/periods/:month/close"},
	{"POST", "/api/hr/attendance/periods/:month/reopen"},
	{"GET", "/api/hr/employees/:id/attendance-adjustments"},
	{"POST", "/api/hr/employees/:id/attendance-adjustments"},
	{"GET", "/api/hr/reports/attendance"},
	{"GET", "/api/hr/reports/attendance/export"},
	{"GET", "/api/hr/reports/late-early"},
	{"GET", "/api/hr/reports/late-early/export"},
	{"GET", "/api/hr/reports/wfh"},
	{"GET", "/api/hr/reports/wfh/export"},
	{"GET", "/api/hr/reports/birthday"},
	{"GET", "/api/hr/reports/birthday/export"},
	{"GET", "/api/hr/reports/leave"},
	{"GET", "/api/hr/reports/leave/export"},
	{"GET", "/api/hr/reports/seniority"},
	{"GET", "/api/hr/reports/seniority/export"},
	{"GET", "/api/administration/roles"},
	{"GET", "/api/administration/accounts/:id/permissions"},
	{"POST", "/api/administration/roles"},
	{"PUT", "/api/administration/roles/:key"},
	{"DELETE", "/api/administration/roles/:key"},
	{"GET", "/api/administration/accounts"},
	{"POST", "/api/administration/accounts"},
	{"POST", "/api/administration/users/:id/suspend"},
	{"POST", "/api/administration/users/:id/reactivate"},
	{"POST", "/api/administration/accounts/:id/roles"},
	{"DELETE", "/api/administration/accounts/:id/roles/:roleKey"},
	{"POST", "/api/administration/accounts/:id/boundaries"},
	{"DELETE", "/api/administration/accounts/:id/boundaries/:key/:version"},
	{"PUT", "/api/administration/accounts/:id/email"},
	{"POST", "/api/administration/accounts/:id/mfa/reset"},
	{"POST", "/api/administration/accounts/:id/google/reset"},
}

// ParseContractRoutes fails on a class it does not know, so no route is ever read as public by default.
func ParseContractRoutes(document string) ([]ContractRoute, error) {
	var listed []struct {
		Method         string `json:"method"`
		Path           string `json:"path"`
		Classification struct {
			Kind     string `json:"kind"`
			Resource string `json:"resource"`
			Action   string `json:"action"`
		} `json:"classification"`
	}
	if err := json.Unmarshal([]byte(document), &listed); err != nil {
		return nil, err
	}
	if len(listed) == 0 {
		return nil, errors.New("route inventory: the contract has no routes")
	}
	routes := make([]ContractRoute, 0, len(listed))
	held := make(map[Route]bool, len(listed))
	var problems []string
	for _, route := range listed {
		classification, err := enforcement.ParseClassification(route.Classification.Kind, route.Classification.Resource, route.Classification.Action)
		if err != nil || route.Method == "" || route.Path == "" {
			return nil, fmt.Errorf("route inventory: unusable contract route %q %q", route.Method, route.Path)
		}
		parsed := Route{route.Method, route.Path}
		if held[ginSlot(parsed)] {
			problems = append(problems, "repeated "+parsed.String())
		}
		held[ginSlot(parsed)] = true
		routes = append(routes, ContractRoute{parsed, classification})
	}
	if len(problems) > 0 {
		return nil, &InventoryError{problems}
	}
	return routes, nil
}

var routeParameter = regexp.MustCompile(`:[^/]+`)

// ginSlot is what Gin cannot register twice without a panic: Register adds HEAD beside GET, and the name
// of a parameter does not tell two routes apart.
func ginSlot(route Route) Route {
	if route.Method == http.MethodHead {
		route.Method = http.MethodGet
	}
	route.Path = routeParameter.ReplaceAllString(route.Path, ":")
	return route
}

// InventoryError names routes and problems only; it is safe to print.
type InventoryError struct {
	Problems []string
}

func (e *InventoryError) Error() string {
	return "route inventory: " + strings.Join(e.Problems, "; ")
}

// CheckInventory fails unless the routes registered are exactly the contract, each listed in
// MigratedRoutes and in the class the contract gives it.
func CheckInventory(routes []RegisteredRoute, contract []ContractRoute) error {
	return checkInventory(routes, contract, MigratedRoutes)
}

func checkInventory(routes []RegisteredRoute, contract []ContractRoute, migrated []Route) error {
	var problems []string
	expected := map[Route]ContractRoute{}
	for _, route := range contract {
		expected[route.Route] = route
	}
	seen := map[Route]bool{}
	for _, route := range routes {
		want, listed := expected[route.Route]
		switch {
		case seen[route.Route]:
			problems = append(problems, "twice "+route.String())
		case !listed:
			problems = append(problems, "extra "+route.String())
		case !slices.Contains(migrated, route.Route):
			problems = append(problems, "not migrated "+route.String())
		case route.Classification != want.Classification:
			problems = append(problems, "class "+route.String())
		}
		seen[route.Route] = true
	}
	for _, route := range contract {
		if !seen[route.Route] {
			problems = append(problems, "missing "+route.String())
		}
	}
	if len(problems) == 0 {
		return nil
	}
	slices.Sort(problems)
	return &InventoryError{problems}
}
