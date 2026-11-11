//go:build integration

package report_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"hrm/api-go/internal/httpapi"
)

const seniorityExport = "/api/hr/reports/seniority/export?asOn=2026-12-31"

// The steps of one delivered export: the read commits, the two boundaries around the render are passed with
// no transaction open, then one second transaction probes the grant, then the last boundary.
var (
	readSteps      = []string{"begin", "settings", "commit"}
	renderedSteps  = append(slices.Clone(readSteps), "done", "done")
	deliveredSteps = append(slices.Clone(renderedSteps), "begin", "probe", "commit", "done")
)

// exportContext is the context of one export request. Export asks Done once at each of its three step
// boundaries and nothing else on the request path asks (the runner detaches from the cancellation of the
// caller), so the n-th "done" step is the n-th boundary; the control test pins that count.
type exportContext struct {
	context.Context
	trace *branchTrace
}

func (c exportContext) Done() <-chan struct{} {
	c.trace.step("done")
	return c.Context.Done()
}

// export runs one export through the HTTP handler on the calling goroutine and returns the steps it took.
// gate runs inside the request after each step; leave is the client going away.
func (f *reportFixture) export(handler http.Handler, who, target string, gate func(steps []string, leave func())) (*httptest.ResponseRecorder, []string) {
	f.t.Helper()
	ctx, leave := context.WithCancel(f.t.Context())
	defer leave()
	f.branches.watch(func(steps []string) {
		if gate != nil {
			gate(steps, leave)
		}
	})
	request := httptest.NewRequest(http.MethodGet, target, nil).WithContext(exportContext{Context: ctx, trace: f.branches})
	request.AddCookie(&http.Cookie{Name: httpapi.CookieName(reportOrigin, httpapi.SessionCookie), Value: f.secrets[who]})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response, f.branches.watch(nil)
}

func nothingSent(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	header := response.Header()
	if response.Code != http.StatusOK || response.Body.Len() != 0 || header.Get("Content-Type") != "" || header.Get("Content-Disposition") != "" {
		t.Fatalf("a client that left was sent status %d, type %q, %d bytes", response.Code, header.Get("Content-Type"), response.Body.Len())
	}
}

func sameSteps(t *testing.T, got, want []string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("export steps %v, want %v", got, want)
	}
}

func TestAStayingClientGetsTheFileAfterReadRenderAndOneRecheck(t *testing.T) {
	f := newReportFixture(t)
	handler := f.handler()
	response, steps := f.export(handler, "C", seniorityExport, nil)
	if grid := reportFile(t, response); len(grid) != 4 {
		t.Fatalf("the export has %d rows, want the three employees", len(grid)-1)
	}
	sameSteps(t, steps, deliveredSteps)
}

func TestAGrantRevokedBetweenTheReadAndTheRecheckIsRefusedWithoutAFile(t *testing.T) {
	f := newReportFixture(t)
	f.hire("C2", []string{"hr.employee", "hr.coo"}, "", false)
	handler := f.handler()
	if grid := reportFile(t, f.get(handler, "C2", seniorityExport)); len(grid) != 5 {
		t.Fatal("the grant must work before the revoke")
	}
	recheck := append(slices.Clone(renderedSteps), "begin")
	revokes := 0
	response, steps := f.export(handler, "C2", seniorityExport, func(steps []string, _ func()) {
		if slices.Equal(steps, recheck) {
			revokes++
			f.exec(`DELETE FROM user_role WHERE user_id=$1 AND role_key=convert_to('hr.coo','UTF8')`, f.accounts["C2"])
		}
	})
	if revokes != 1 {
		t.Fatalf("the grant was revoked %d times between the read and the re-check, steps %v", revokes, steps)
	}
	reportError(t, response, http.StatusForbidden, "error.accessDenied")
	sameSteps(t, steps, append(recheck, "probe", "commit"))
	reportError(t, f.get(handler, "C2", seniorityExport), http.StatusForbidden, "error.accessDenied")
}

func TestAClientGoneWhileTheFileRendersGetsNothingAndIsNotRechecked(t *testing.T) {
	f := newReportFixture(t)
	handler := f.handler()
	response, steps := f.export(handler, "C", seniorityExport, func(steps []string, leave func()) {
		if slices.Equal(steps, renderedSteps) {
			leave()
		}
	})
	nothingSent(t, response)
	sameSteps(t, steps, renderedSteps)
}

// The workbook of this dataset is over the byte budget, which only the renderer refuses, so a render shows
// as 422: after the commit of the read for the client that stays, never for the client that left.
func TestAClientGoneWhileTheDataIsReadGetsNothingAndNothingIsRendered(t *testing.T) {
	f := newReportFixture(t)
	f.longNames(3000)
	f.setting("export.maxBytes", 1<<20)
	handler := f.handler()
	read := append(slices.Clone(readSteps), "done")
	refused, steps := f.export(handler, "H", seniorityExport, nil)
	reportError(t, refused, http.StatusUnprocessableEntity, "error.exportTooLarge")
	sameSteps(t, steps, read)
	reading := readSteps[:2]
	response, steps := f.export(handler, "H", seniorityExport, func(steps []string, leave func()) {
		if slices.Equal(steps, reading) {
			leave()
		}
	})
	nothingSent(t, response)
	sameSteps(t, steps, read)
}

// The first boundary stands before the render, so a refusal that passed no boundary rendered nothing.
func TestMoreRowsThanTheBudgetAreRefusedBeforeTheRenderBoundary(t *testing.T) {
	f := newReportFixture(t)
	f.setting("export.maxRows", 2)
	handler := f.handler()
	response, steps := f.export(handler, "C", seniorityExport, nil)
	reportError(t, response, http.StatusUnprocessableEntity, "error.exportTooLarge")
	sameSteps(t, steps, readSteps)
}
