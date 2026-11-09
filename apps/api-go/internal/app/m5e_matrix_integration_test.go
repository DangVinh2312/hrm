//go:build integration

package app

import (
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"hrm/api-go/internal/httpapi"
)

var m5eCancelRoute = httpapi.Route{Method: http.MethodPost, Path: "/api/hr/requests/:id/cancel"}

func m5eCancel(approved bool) m1Row {
	row := m1Row{
		cells: m1With(m1Write(), func(c *m1Cells) {
			c.noGrant, c.deny, c.foreign, c.absent = m1Refused(404), m1Refused(404), m1Refused(404), m1Refused(404)
			c.invalid, c.extra, c.idempotency = m1Refused(400), m1Refused(400), m5aKeyReused
			c.boundary = m1NA("the permissions are outside the hrAdministration boundary package")
			c.fresh = m1NA("pending cancellation carries no fresh@1; approved freshness is checked separately below")
			c.absentEmployee = m1NA("the request is the target, no employee in the path")
		}),
		prepare: func(t *testing.T, w *m1World) m1Request {
			id := m5bRequest(t, w, w.ids["hr"])
			if approved {
				id = m5cRequest(t, w, "hr", "approved")
			}
			return m1Request{"/api/hr/requests/" + id + "/cancel", `{"expectedVersion":"1","reason":"Matrix"}`}
		},
		absent: m1Segment(4, m1Absent),
		invalid: []m1Edit{
			m1Segment(4, "bad"), m1Body(`{}`), m1Body(`[]`), m1Body(`null`),
			m1Replace(`"expectedVersion":"1"`, `"expectedVersion":1`), m1Replace(`"expectedVersion":"1"`, `"expectedVersion":"01"`),
			m1Replace(`"reason":"Matrix"`, `"reason":"   "`), m1Replace(`"reason":"Matrix"`, `"reason":1`),
			m1Replace(`"reason":"Matrix"`, `"reason":"Matrix","state":"cancelled"`),
		},
		extra: m1Extra,
		shape: regexp.MustCompile(`^\{"id":"` + m1UUID + `","state":"cancelled","version":"2"\}$`),
		audit: "hr.request.cancel", rootAudit: "hr.request.cancel", keyed: true,
		reuse: m1Replace(`"reason":"Matrix"`, `"reason":"Other"`),
	}
	if approved {
		row.audit, row.rootAudit = "hr.request.cancel-approved", "hr.request.cancel-approved"
		row.invalid = append(row.invalid, m1Body(`{"expectedVersion":"1"}`))
	}
	return row
}

func TestTheM5eCancelAnswersEveryCellOfTheMatrix(t *testing.T) {
	if !slices.Contains(httpapi.MigratedRoutes, m5eCancelRoute) {
		t.Fatal("cancel is not migrated")
	}
	w := newM5cWorld(t)
	statuses := m1ContractStatuses(t)
	for name, approved := range map[string]bool{"pending": false, "approved": true} {
		t.Run(name, func(t *testing.T) {
			row := m5eCancel(approved)
			for cell, value := range row.cells.named() {
				if value.empty() {
					t.Errorf("missing %s", cell)
				}
			}
			w.signIn(t)
			w.check(t, m5eCancelRoute, row, statuses[m5eCancelRoute])
		})
	}
}

func TestM5eApprovedCancelRequiresFreshnessAfterFindingTheRequest(t *testing.T) {
	w := newM5cWorld(t)
	r := m5eCancel(true).prepare(t, w)
	before := w.state(t)
	for _, tc := range []struct {
		request m1Request
		status  int
	}{{r, http.StatusForbidden}, {m1Segment(4, m1Absent)(r), http.StatusNotFound}} {
		status, body := w.send(http.MethodPost, "stale", tc.request, w.keyed(t, m5eCancel(true), nil))
		if !m1Refused(tc.status).answers(status, body) || w.state(t) != before {
			t.Errorf("stale: %d %s", status, body)
		}
	}
}

func TestM5eCancellationDeniesWinWhileTheRequestRemainsReadable(t *testing.T) {
	for name, approved := range map[string]bool{"pending": false, "approved": true} {
		t.Run(name, func(t *testing.T) {
			w := newM5cWorld(t)
			r := m5eCancel(approved).prepare(t, w)
			permission, template := "workRequest.cancel", "ownRequests"
			if approved {
				permission, template = "workRequest.cancelApproved", "allRequests"
			}
			w.exec(t, m1InsertRule, w.ids["hr"], permission, "allow", template)
			w.exec(t, m1InsertRule, w.ids["hr"], permission, "deny", template)
			before := w.state(t)
			read := m1Request{target: strings.TrimSuffix(r.target, "/cancel")}
			if status, body := w.send(http.MethodGet, "hr", read, nil); status != http.StatusOK || !strings.Contains(body, `"id":"`+strings.Split(r.target, "/")[4]+`"`) {
				t.Fatalf("deny affected read: %d %s", status, body)
			}
			status, body := w.send(http.MethodPost, "hr", r, w.keyed(t, m5eCancel(approved), nil))
			if !m1Refused(http.StatusNotFound).answers(status, body) {
				t.Errorf("%s deny: %d %s", permission, status, body)
			}
			if after := w.state(t); after != before {
				t.Errorf("%s deny changed state: %s -> %s", permission, before, after)
			}
		})
	}
}

func TestM5eARootCancelRetryNamesTheRequestAndAnIAMRetryWritesNothing(t *testing.T) {
	w := newM5cWorld(t)
	for actor, want := range map[string]int{"root": 1, "hr": 0} {
		r := m5eCancel(true).prepare(t, w)
		key := m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), nil)
		status, first := w.send(http.MethodPost, actor, r, key)
		if status != http.StatusOK {
			t.Fatalf("%s: %d %s", actor, status, first)
		}
		target := strings.Split(r.target, "/")[4]
		audits := `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1`
		targeted := `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND object_id IS NULL AND safe_metadata->>'principalKind'='root' AND safe_metadata->>'key'=$2`
		before := w.scalar(t, audits, w.ids[actor])
		named := w.scalar(t, targeted, w.ids[actor], target)
		state := w.state(t)
		if status, body := w.send(http.MethodPost, actor, r, key); status != http.StatusOK || body != first {
			t.Errorf("%s replay: %d %s", actor, status, body)
		}
		for query, prior := range map[string]string{audits: before, targeted: named} {
			n, err := strconv.Atoi(prior)
			if err != nil {
				t.Fatal(err)
			}
			args := []any{w.ids[actor]}
			if query == targeted {
				args = append(args, target)
			}
			if got := w.scalar(t, query, args...); got != strconv.Itoa(n+want) {
				t.Errorf("%s replay audits: %s, had %d", actor, got, n)
			}
		}
		if want == 0 && w.state(t) != state {
			t.Error("IAM replay changed state")
		}
	}
}
