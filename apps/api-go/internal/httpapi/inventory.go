package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"hrm/api-go/internal/authorization/enforcement"
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

// RegisteredRoute is what Register and RegisterProxied added to a Group. A proxied route carries the
// public class of this process: NestJS applies the class the contract gives it.
type RegisteredRoute struct {
	Route
	Classification enforcement.Classification
	Proxied        bool
}

// MigratedRoutes is every route this process serves itself. It is code, not configuration: moving a
// group of routes to Go or back is a change of this table.
var MigratedRoutes = []Route{
	{"GET", "/api/health/live"},
	{"GET", "/api/health/ready"},
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

// CheckInventory fails unless the routes registered are exactly the contract, split by MigratedRoutes
// into served here and proxied, with a served route in the class the contract gives it.
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
		isMigrated := slices.Contains(migrated, route.Route)
		switch {
		case seen[route.Route]:
			problems = append(problems, "twice "+route.String())
		case !listed:
			problems = append(problems, "extra "+route.String())
		case route.Proxied && isMigrated:
			problems = append(problems, "proxied "+route.String())
		case !route.Proxied && !isMigrated:
			problems = append(problems, "not migrated "+route.String())
		case !route.Proxied && route.Classification != want.Classification:
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
