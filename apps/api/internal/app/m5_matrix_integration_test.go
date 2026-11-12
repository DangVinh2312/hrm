//go:build integration

package app

import (
	"maps"
	"net/http"
	"slices"
	"testing"

	"hrm/api/internal/httpapi"
)

var m5Routes = []httpapi.Route{
	{Method: http.MethodGet, Path: "/api/hr/employees/:id/leave-balance"},
	{Method: http.MethodGet, Path: "/api/hr/leave/reconciliation"},
	{Method: http.MethodPost, Path: "/api/hr/employees/:id/leave-adjustments"},
	{Method: http.MethodPost, Path: "/api/hr/requests"},
	{Method: http.MethodGet, Path: "/api/hr/requests"},
	{Method: http.MethodGet, Path: "/api/hr/requests/:id"},
	{Method: http.MethodPost, Path: "/api/hr/requests/:id/decision"},
	{Method: http.MethodGet, Path: "/api/hr/approvals/lead"},
	{Method: http.MethodGet, Path: "/api/hr/approvals/final"},
	{Method: http.MethodGet, Path: "/api/hr/approvals/decided"},
	{Method: http.MethodPost, Path: "/api/hr/requests/:id/cancel"},
}

func TestEveryM5RouteHasAFullMatrixIncludingAuthenticatedCommands(t *testing.T) {
	matrix := maps.Clone(m5aMatrix)
	maps.Copy(matrix, m5bMatrix)
	maps.Copy(matrix, m5cMatrix)
	matrix[m5cDecisionRoute] = m5cDecision
	matrix[m5eCancelRoute] = m5eCancel(false)
	if len(m5Routes) != 11 || len(matrix) != len(m5Routes) {
		t.Errorf("M5=%d matrix=%d, want 11/11", len(m5Routes), len(matrix))
	}
	for _, route := range m5Routes {
		if !slices.Contains(httpapi.MigratedRoutes, route) {
			t.Errorf("%s: M5 route is not migrated", route)
		}
		row, ok := matrix[route]
		if !ok {
			t.Errorf("%s: M5 route has no matrix", route)
			continue
		}
		checkMatrixRow(t, route, row)
	}
	checkMatrixRow(t, m5eCancelRoute, m5eCancel(true))
	for route := range matrix {
		if !slices.Contains(m5Routes, route) {
			t.Errorf("%s: matrix outside the explicit M5 inventory", route)
		}
	}
}
