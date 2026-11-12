//go:build integration

package app

import (
	"context"
	"net/http"
	"regexp"
	"testing"
	"time"

	"hrm/api-go/test"
)

const (
	m8Revision     = `SELECT revision::text FROM authz_state WHERE singleton`
	m8RolesOf      = `SELECT count(*)::text FROM user_role WHERE user_id=$1`
	m8ShareFence   = `SELECT 1 FROM authz_state WHERE singleton FOR SHARE`
	m8AwaitsFence  = `SELECT (count(*) > 0)::text FROM pg_stat_activity WHERE datname=current_database() AND usename='product_authority' AND cardinality(pg_blocking_pids(pid))>0`
	m8AbsentRole   = "custom.m8_absent"
	m8AccountsPath = "/api/administration/accounts"
)

func m8Assign(id, role string) m1Request {
	return m1Request{m8Path(id, "/roles"), `{"roleKey":"` + role + `"}`}
}

func m8Revoke(id, role string) m1Request { return m1Request{target: m8Path(id, "/roles/"+role)} }

func m8SuspendOf(id string) m1Request {
	return m1Request{target: "/api/administration/users/" + id + "/suspend"}
}

func TestM8ARoleCommandRefusesOneselfAndHidesRootLikeAnAbsentAccount(t *testing.T) {
	w := newM8AccountWorld(t)
	hr, root := w.ids["hr"], w.ids["root"]

	w.m8Refused(t, "a revoke of a held role from oneself", "hr", http.MethodDelete, m8Revoke(hr, m1Employee), http.StatusForbidden)
	w.m8Refused(t, "a revoke of an absent role from oneself", "hr", http.MethodDelete, m8Revoke(hr, m8AbsentRole), http.StatusForbidden)
	w.m8Refused(t, "an assign of an absent role to oneself", "hr", http.MethodPost, m8Assign(hr, m8AbsentRole), http.StatusForbidden)

	for name, id := range map[string]string{"Root": root, "an absent account": m1Absent} {
		w.m8Refused(t, "an IAM revoke from "+name, "hr", http.MethodDelete, m8Revoke(id, m1Employee), http.StatusNotFound)
		w.m8Refused(t, "an IAM assign to "+name, "hr", http.MethodPost, m8Assign(id, m1Employee), http.StatusNotFound)
		w.m8RootAbsent(t, "a Root assign to "+name, http.MethodPost, m8Assign(id, m1Employee), "access.account.assignRole")
		w.m8RootAbsent(t, "a Root revoke from "+name, http.MethodDelete, m8Revoke(id, m1Employee), "access.account.revokeRole")
	}
	if held := w.scalar(t, m8RolesOf, root); held != "0" {
		t.Errorf("Root holds %s roles", held)
	}
}

func TestM8AnAccountCommandWhoseAuditFailsLeavesNoTrace(t *testing.T) {
	w := newM8AccountWorld(t)
	suspended := m8Target(t, w)
	w.exec(t, m1Suspend, suspended)
	status := func(word string) *regexp.Regexp { return regexp.MustCompile(`^\{"status":"` + word + `"\}$`) }
	attempts := []struct {
		name, method string
		r            m1Request
		shape        *regexp.Regexp
		success      int
		kind         string
	}{
		{"assign", http.MethodPost, m8Assign(m8Target(t, w), m1Admin), status("assigned"), http.StatusOK, "permission.role-assign"},
		{"revoke", http.MethodDelete, m8Revoke(m8Target(t, w, m1Admin), m1Admin), status("revoked"), http.StatusOK, "permission.role-revoke"},
		{"suspend", http.MethodPost, m8SuspendOf(m8Target(t, w)), status("suspended"), http.StatusOK, "account.suspend"},
		{"reactivate", http.MethodPost, m1Request{target: "/api/administration/users/" + suspended + "/reactivate"}, status("reactivated"), http.StatusOK, "account.reactivate"},
		{"provision", http.MethodPost, m1Request{m8AccountsPath, `{"email":"m8-audit@example.test","roleKey":"hr.employee"}`},
			regexp.MustCompile(`^\{"userId":"` + m1UUID + `","email":"m8-audit@example\.test","state":"pending"\}$`), http.StatusCreated, "account.provision"},
	}

	w.exec(t, m8RevokeAudit)
	t.Cleanup(func() {
		if _, err := w.conn.Exec(context.WithoutCancel(t.Context()), m8GrantAudit); err != nil {
			t.Error(test.Redact(err))
		}
	})
	for _, actor := range []string{"root", "hr"} {
		for _, attempt := range attempts {
			before := w.state(t)
			status, body := w.send(attempt.method, actor, attempt.r, nil)
			if status != http.StatusServiceUnavailable || body != m8Unavailable {
				t.Errorf("a %s by %s whose audit fails: %d %s", attempt.name, actor, status, body)
			}
			if after := w.state(t); after != before {
				t.Errorf("a %s by %s whose audit fails left a trace: %s -> %s", attempt.name, actor, before, after)
			}
		}
	}

	w.exec(t, m8GrantAudit)
	for i, attempt := range attempts {
		actor := []string{"hr", "root"}[i%2]
		w.succeed(t, "the same "+attempt.name, actor, attempt.method, attempt.r, attempt.shape, attempt.success, attempt.kind)
	}
}

// The deny is written by a transaction that holds a share of the fence: the shared-fence answer of the request
// does not see it, and the exclusive transaction of the command starts only after it is committed. The target
// is the actor itself, so no grant comparison runs: only the plan of the exclusive transaction can turn the
// 403 of oneself into the 404 of an account the actor does not reach.
func TestM8ADenyCommittedAfterTheSharedAnswerStillHidesTheTarget(t *testing.T) {
	w := newM8AccountWorld(t)
	oneself := m8SuspendOf(w.ids["hr"])
	w.m8Refused(t, "a suspend of oneself before the deny", "hr", http.MethodPost, oneself, http.StatusForbidden)

	holder, err := w.stack.Cluster.ConnectSuperuser(t.Context(), w.stack.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := holder.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	tx, err := holder.Begin(t.Context())
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if _, err := tx.Exec(t.Context(), m8ShareFence); err != nil {
		t.Fatal(test.Redact(err))
	}
	if _, err := tx.Exec(t.Context(), m1InsertRule, w.ids["hr"], "account.suspend", "deny", "allAccounts"); err != nil {
		t.Fatal(test.Redact(err))
	}
	account, revision := w.scalar(t, m8Epoch, w.ids["hr"]), w.scalar(t, m8Revision)
	done := make(chan m6Outcome, 1)
	go func() {
		status, body := w.send(http.MethodPost, "hr", oneself, nil)
		done <- m6Outcome{status, body}
	}()
	waited := false
	for deadline := time.Now().Add(3 * time.Second); !waited && time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		waited = w.scalar(t, m8AwaitsFence) == "true"
	}
	end := tx.Commit
	if !waited {
		end = tx.Rollback
	}
	if err := end(t.Context()); err != nil {
		t.Fatal(test.Redact(err))
	}
	outcome := <-done
	if !waited {
		t.Fatalf("the command never waited for the exclusive fence: %+v", outcome)
	}
	if !m1Refused(http.StatusNotFound).answers(outcome.status, outcome.body) {
		t.Errorf("a suspend of oneself whose deny was committed after the shared answer: %d %s", outcome.status, outcome.body)
	}
	if after := w.scalar(t, m8Epoch, w.ids["hr"]); after != account {
		t.Errorf("the refused command moved the account from %s to %s", account, after)
	}
	if after := w.scalar(t, m8Revision); after == revision {
		t.Errorf("the revision stayed %s: the command was not refused inside the exclusive transaction", revision)
	}
	w.m8Refused(t, "the same suspend once the deny is in the shared answer", "hr", http.MethodPost, oneself, http.StatusNotFound)
}
