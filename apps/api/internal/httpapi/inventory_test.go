package httpapi_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"hrm/api/contract"
	"hrm/api/internal/authorization/enforcement"
	"hrm/api/internal/httpapi"
)

func TestMigratedRoutesAreInTheContract(t *testing.T) {
	routes, err := httpapi.ParseContractRoutes(contract.Routes())
	if err != nil {
		t.Fatal(err)
	}
	if len(routes) != 100 || len(httpapi.MigratedRoutes) != len(routes) {
		t.Fatalf("%d routes, %d migrated", len(routes), len(httpapi.MigratedRoutes))
	}
	for _, migrated := range httpapi.MigratedRoutes {
		found := false
		for _, route := range routes {
			found = found || route.Route == migrated
		}
		if !found {
			t.Errorf("%v is not in the contract", migrated)
		}
	}
}

func TestParseContractRoutesRefusesAnUnknownClass(t *testing.T) {
	for _, document := range []string{
		`[{"method":"GET","path":"/a","classification":{"kind":"open"}}]`,
		`[{"method":"GET","path":"/a"}]`,
		`[{"method":"","path":"/a","classification":{"kind":"public"}}]`,
		`[]`,
		`{`,
	} {
		if _, err := httpapi.ParseContractRoutes(document); err == nil {
			t.Errorf("%s accepted", document)
		}
	}
}

func TestParseContractRoutesRefusesARouteGinCannotHoldTwice(t *testing.T) {
	route := func(method, path string) string {
		return `{"method":"` + method + `","path":"` + path + `","classification":{"kind":"public"}}`
	}
	for name, routes := range map[string][]string{
		"same route":     {route("GET", "/a"), route("GET", "/a")},
		"head of a get":  {route("GET", "/a"), route("HEAD", "/a")},
		"get of a head":  {route("HEAD", "/a"), route("GET", "/a")},
		"same parameter": {route("GET", "/a/:id"), route("GET", "/a/:key")},
	} {
		_, err := httpapi.ParseContractRoutes("[" + strings.Join(routes, ",") + "]")
		if err == nil {
			t.Errorf("%s accepted", name)
		} else if !strings.Contains(err.Error(), "/a") {
			t.Errorf("%s: the route is not named: %v", name, err)
		}
	}
	if _, err := httpapi.ParseContractRoutes("[" + route("GET", "/a") + "," + route("POST", "/a") + "," + route("GET", "/b") + "]"); err != nil {
		t.Error(err)
	}
}

func TestCheckInventory(t *testing.T) {
	const (
		live  = "/api/health/live"
		ready = "/api/health/ready"
		other = "/api/other"
		item  = "/api/item"
	)
	get := func(path string) httpapi.Route { return httpapi.Route{Method: http.MethodGet, Path: path} }
	public := enforcement.Public()
	contractRoutes := []httpapi.ContractRoute{
		{Route: get(live), Classification: public},
		{Route: get(ready), Classification: public},
		{Route: get(other), Classification: public},
		{Route: get(item), Classification: enforcement.Authenticated()},
	}
	migrated := []httpapi.Route{get(live), get(ready), get(other), get(item)}
	good := []httpapi.RegisteredRoute{
		{Route: get(live), Classification: public},
		{Route: get(ready), Classification: public},
		{Route: get(other), Classification: public},
		{Route: get(item), Classification: enforcement.Authenticated()},
	}
	replace := func(index int, route httpapi.RegisteredRoute) []httpapi.RegisteredRoute {
		routes := append([]httpapi.RegisteredRoute(nil), good...)
		routes[index] = route
		return routes
	}
	cases := map[string]struct {
		routes   []httpapi.RegisteredRoute
		contract []httpapi.ContractRoute
		migrated []httpapi.Route
		problem  string
	}{
		"exact":   {good, contractRoutes, migrated, ""},
		"missing": {good[:3], contractRoutes, migrated, "missing GET " + item},
		"extra": {append(append([]httpapi.RegisteredRoute(nil), good...),
			httpapi.RegisteredRoute{Route: get("/api/new"), Classification: public}), contractRoutes, migrated, "extra GET /api/new"},
		"twice":                     {append(append([]httpapi.RegisteredRoute(nil), good...), good[3]), contractRoutes, migrated, "twice GET " + item},
		"handler outside the table": {good, contractRoutes, []httpapi.Route{get(live), get(ready), get(item)}, "not migrated GET " + other},
		"weaker class":              {replace(3, httpapi.RegisteredRoute{Route: get(item), Classification: public}), contractRoutes, migrated, "class GET " + item},
		"same path other method":    {replace(3, httpapi.RegisteredRoute{Route: httpapi.Route{Method: http.MethodPost, Path: item}, Classification: enforcement.Authenticated()}), contractRoutes, migrated, "missing GET " + item},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			err := httpapi.CheckInventoryOf(c.routes, c.contract, c.migrated)
			if c.problem == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.problem) {
				t.Fatalf("%v, want %q", err, c.problem)
			}
		})
	}
}

func TestCheckInventoryUsesTheMigratedTable(t *testing.T) {
	routes, err := httpapi.ParseContractRoutes(contract.Routes())
	if err != nil {
		t.Fatal(err)
	}
	registered := make([]httpapi.RegisteredRoute, 0, len(routes)+1)
	for _, route := range routes {
		registered = append(registered, httpapi.RegisteredRoute(route))
	}
	if err := httpapi.CheckInventory(registered, routes); err != nil {
		t.Fatal(err)
	}
	outside := httpapi.ContractRoute{Route: httpapi.Route{Method: http.MethodGet, Path: "/api/health/outside"}, Classification: enforcement.Public()}
	registered = append(registered, httpapi.RegisteredRoute(outside))
	err = httpapi.CheckInventory(registered, append(routes, outside))
	if err == nil || !strings.Contains(err.Error(), "not migrated GET /api/health/outside") {
		t.Errorf("a route outside MigratedRoutes: %v", err)
	}
}

func TestRegisterRecordsTheRoutes(t *testing.T) {
	engine := newRoutes(t, nil).engine
	group := httpapi.NewGroup(engine.Group(""), nil)
	handler := func(c *gin.Context) { httpapi.WriteJSONBytes(c, http.StatusOK, []byte(`{}`)) }
	if err := httpapi.Register(group, http.MethodGet, "/x", enforcement.Public(), handler); err != nil {
		t.Fatal(err)
	}
	if err := httpapi.Register(group, http.MethodPost, "/y", enforcement.Public(), handler); err != nil {
		t.Fatal(err)
	}
	got := group.Routes()
	if len(got) != 2 || got[0] != (httpapi.RegisteredRoute{Route: httpapi.Route{Method: http.MethodGet, Path: "/x"}, Classification: enforcement.Public()}) ||
		got[1].Route != (httpapi.Route{Method: http.MethodPost, Path: "/y"}) {
		t.Errorf("%+v", got)
	}
}
