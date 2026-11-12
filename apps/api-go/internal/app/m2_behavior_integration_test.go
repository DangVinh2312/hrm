//go:build integration

package app

import (
	"errors"
	"github.com/jackc/pgx/v5/pgconn"
	testdb "hrm/api-go/test"
	"hrm/api-go/test/fixture"
	"strings"
	"testing"
)

func TestM2BoundLinkRevisionRevokeAndAuditFailureRollback(t *testing.T) {
	w := newM2World(t)
	id := m2Employee(t, w)
	account := fixture.Account(t, w.stack, fixture.AccountSpec{Roles: []string{"hr.employee"}})
	request := m1Request{"/api/hr/employees/" + id + "/account", `{"expectedVersion":"1","accountId":"` + account.ID + `"}`}
	revision := w.scalar(t, "SELECT revision::text FROM authz_state WHERE singleton")
	status, body := w.send("PUT", "hr", request, nil)
	if status != 200 || body != `{"version":"2"}` {
		t.Fatalf("bound link: %d %s", status, body)
	}
	if w.scalar(t, "SELECT (revision=CAST($1 AS int8)+1)::text FROM authz_state WHERE singleton", revision) != "true" {
		t.Fatal("admin revision did not advance exactly once")
	}
	w.exec(t, "DELETE FROM user_boundary WHERE user_id=$1 AND permission_key=convert_to('employee.linkAccount','UTF8')", w.ids["hr"])
	before := w.scalar(t, m2State)
	request.body = `{"expectedVersion":"2","accountId":null}`
	status, body = w.send("PUT", "hr", request, nil)
	if status != 403 || w.scalar(t, m2State) != before {
		t.Fatalf("revoke: %d %s", status, body)
	}
	w.exec(t, `INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,convert_to('employee.linkAccount','UTF8'),convert_to('hrAdministration','UTF8'),1)`, w.ids["hr"])
	w.exec(t, `CREATE FUNCTION public.fail_m2_audit() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture audit failure''; END'; CREATE TRIGGER fail_m2_audit BEFORE INSERT ON audit_outbox FOR EACH ROW EXECUTE FUNCTION public.fail_m2_audit()`)
	before = w.scalar(t, m2State)
	status, body = w.send("PUT", "hr", request, nil)
	if status != 503 || body != `{"statusCode":503,"code":"error.unavailable"}` || w.scalar(t, m2State) != before {
		t.Fatalf("authority audit rollback: %d %s", status, body)
	}
	create := m1Request{"/api/hr/employees", m2CreateBody(w)}
	status, body = w.send("POST", "hr", create, nil)
	if status != 503 || w.scalar(t, m2State) != before {
		t.Fatalf("data audit rollback: %d %s", status, body)
	}
}

func TestM2ProfileFieldsVersionAndDatabaseChecks(t *testing.T) {
	w := newM2World(t)
	id := m2Employee(t, w)
	request := m1Request{"/api/hr/employees/" + id, `{"expectedVersion":"1","code":"PROFILE","fullName":"Updated","position":"Engineer","classification":"fullTime"}`}
	status, body := w.send("PATCH", "hr", request, nil)
	if status != 200 {
		t.Fatalf("profile update: %d %s", status, body)
	}
	status, body = w.send("GET", "hr", m1Request{target: request.target}, nil)
	if status != 200 || !strings.Contains(body, `"position":"Engineer"`) || !strings.Contains(body, `"classification":"fullTime"`) {
		t.Fatalf("F1: %d %s", status, body)
	}
	if status, _ := w.send("PATCH", "hr", request, nil); status != 409 {
		t.Fatal("stale F1 update accepted")
	}
	request.body = `{"expectedVersion":"2","code":"PROFILE","fullName":"Updated","position":null,"classification":null}`
	if status, body := w.send("PATCH", "hr", request, nil); status != 200 {
		t.Fatalf("clear F1: %d %s", status, body)
	}
	for _, tc := range []struct{ table, column, value string }{{"employee", "job_position", "bad\tposition"}, {"employee", "job_position", " bad"}, {"employee", "job_position", ""}, {"employee", "job_position", strings.Repeat("a", 101)}, {"employee", "classification", "intern"}, {"employee_identity", "gender", "unknown"}, {"employee_identity", "phone", "84901234567"}, {"employee_identity", "phone", "090123456"}, {"employee_identity", "work_email", "Upper@example.com"}, {"employee_identity", "work_email", "a@b"}} {
		key := "id"
		if tc.table == "employee_identity" {
			key = "employee_id"
		}
		_, err := w.conn.Exec(t.Context(), "UPDATE "+tc.table+" SET "+tc.column+"=$1 WHERE "+key+"=$2", tc.value, id)
		pg, ok := errors.AsType[*pgconn.PgError](err)
		if !ok || pg.Code != "23514" {
			t.Fatalf("CHECK %s.%s: %s", tc.table, tc.column, testdb.Redact(err))
		}
	}
}

func TestM2AccountLinkMovesSelfScopeAtCommit(t *testing.T) {
	w := newM2World(t)
	id := m2Employee(t, w)
	a := fixture.Account(t, w.stack, fixture.AccountSpec{Roles: []string{"hr.employee"}})
	w.ids["linked"] = a.ID
	w.secrets["linked"] = fixture.Session(t, w.stack, a.ID, fixture.SessionSpec{})
	path := "/api/hr/employees/" + id
	if status, _ := w.send("GET", "linked", m1Request{target: path}, nil); status != 404 {
		t.Fatal("unlinked account sees target")
	}
	link := m1Request{path + "/account", `{"expectedVersion":"1","accountId":"` + a.ID + `"}`}
	if status, body := w.send("PUT", "hr", link, nil); status != 200 {
		t.Fatalf("link: %d %s", status, body)
	}
	if status, body := w.send("GET", "linked", m1Request{target: path}, nil); status != 200 {
		t.Fatalf("scope after link: %d %s", status, body)
	}
	link.body = `{"expectedVersion":"2","accountId":null}`
	if status, body := w.send("PUT", "hr", link, nil); status != 200 {
		t.Fatalf("unlink: %d %s", status, body)
	}
	if status, _ := w.send("GET", "linked", m1Request{target: path}, nil); status != 404 {
		t.Fatal("scope retained after unlink")
	}
}
