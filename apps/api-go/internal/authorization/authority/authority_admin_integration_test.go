//go:build integration

package authority_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/database"
	"hrm/api-go/test/fixture"
)

type commitTraceKey struct{}
type precheckPause struct {
	committed, proceed chan struct{}
	once               sync.Once
}

func (p *precheckPause) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, commitTraceKey{}, strings.EqualFold(data.SQL, "commit"))
}
func (p *precheckPause) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if committed, _ := ctx.Value(commitTraceKey{}).(bool); committed {
		p.once.Do(func() { close(p.committed); <-p.proceed })
	}
}

func adminCommand(run func(authority.CommandContext, string) (string, error)) *authority.Command[string, string] {
	return authority.NewCommand("employee", "linkAccount", database.ModeAdmin, func(key string) string { return key }, run)
}

func TestDeniedAdminDoesNotWaitForExclusiveFence(t *testing.T) {
	f := newAuthorityFixture(t)
	employee := fixture.Employee(t, f.s, fixture.EmployeeSpec{})
	secret := fixture.Session(t, f.s, f.owner.ID, fixture.SessionSpec{Fresh: true})
	command := adminCommand(func(authority.CommandContext, string) (string, error) { return "", errors.New("denied command ran") })
	a := f.authority(t, authority.DefaultCapabilities(), command)
	locker, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	requireDB(t, err)
	t.Cleanup(func() { requireDB(t, locker.Close(context.WithoutCancel(t.Context()))) })
	tx, err := locker.Begin(t.Context())
	requireDB(t, err)
	_, err = tx.Exec(t.Context(), "SELECT revision FROM authz_state WHERE singleton FOR SHARE")
	requireDB(t, err)
	done := make(chan commandOutcome, 1)
	go func() {
		result, err := authority.Execute(t.Context(), a, secret, command, employee.ID)
		done <- commandOutcome{result, err}
	}()
	var before string
	requireDB(t, f.conn.QueryRow(t.Context(), "SELECT revision::text FROM authz_state WHERE singleton").Scan(&before))
	select {
	case result := <-done:
		if result.result.Found {
			t.Fatal("grantless admin found target")
		}
		if result.err == nil {
			t.Fatal("missing boundary did not deny")
		}
	case <-time.After(500 * time.Millisecond):
		requireDB(t, tx.Rollback(t.Context()))
		t.Fatal("denied admin waited on exclusive fence")
	}
	requireDB(t, tx.Rollback(t.Context()))
	var after string
	requireDB(t, f.conn.QueryRow(t.Context(), "SELECT revision::text FROM authz_state WHERE singleton").Scan(&after))
	if before != after {
		t.Fatal("denied admin advanced revision")
	}
}

func TestAdminRechecksRevokedScopeWithoutAdvancingRevision(t *testing.T) {
	f := newAuthorityFixture(t)
	employee := fixture.Employee(t, f.s, fixture.EmployeeSpec{})
	secret := fixture.Session(t, f.s, f.owner.ID, fixture.SessionSpec{Fresh: true})
	f.exec(t, `INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,convert_to('employee.linkAccount','UTF8'),convert_to('hrAdministration','UTF8'),1)`, f.owner.ID)
	f.exec(t, `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES(gen_random_uuid(),convert_to('employee.linkAccount','UTF8'),$1,'allow',convert_to('allEmployees','UTF8'),1,'{}','runtime')`, f.owner.ID)
	command := adminCommand(func(c authority.CommandContext, _ string) (string, error) {
		if _, err := c.Tx.Exec("UPDATE employee SET account_id=$1 WHERE id=$2", f.owner.ID, c.Target.Key); err != nil {
			return "", err
		}
		return "linked", c.Audit(audit.KindHREmployeeLinkAccount, authority.AuditTarget{Resource: "employee", Key: c.Target.Key, ObjectID: c.Target.ObjectID}, nil)
	})
	pause := &precheckPause{committed: make(chan struct{}), proceed: make(chan struct{})}
	config := f.s.Pools[database.PurposeData].Config()
	config.ConnConfig.Tracer = pause
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	requireDB(t, err)
	t.Cleanup(pool.Close)
	runner, err := database.NewRunner(database.Pools{database.PurposeData: pool, database.PurposeAuthority: f.s.Pools[database.PurposeAuthority]}, database.RunnerOptions{})
	requireDB(t, err)
	stack := *f.s
	stack.Runner = runner
	traced := *f
	traced.s = &stack
	a := traced.authority(t, authority.DefaultCapabilities(), command)
	done := make(chan commandOutcome, 1)
	go func() {
		result, err := authority.Execute(t.Context(), a, secret, command, employee.ID)
		done <- commandOutcome{result, err}
	}()
	select {
	case <-pause.committed:
	case <-time.After(5 * time.Second):
		close(pause.proceed)
		t.Fatal("shared precheck did not commit")
	}
	_, err = database.Run(t.Context(), f.s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		_, err := tx.Exec(`DELETE FROM policy_rule WHERE user_id=$1 AND permission_key=convert_to('employee.linkAccount','UTF8')`, f.owner.ID)
		return struct{}{}, err
	}, database.RunOptions{})
	requireDB(t, err)
	var before string
	requireDB(t, f.conn.QueryRow(t.Context(), "SELECT revision::text FROM authz_state WHERE singleton").Scan(&before))
	close(pause.proceed)
	result := <-done
	requireDB(t, result.err)
	if result.result.Found {
		t.Fatal("revoked scope still reached admin target")
	}
	var unchanged bool
	requireDB(t, f.conn.QueryRow(t.Context(), "SELECT account_id IS NULL AND (SELECT revision::text FROM authz_state WHERE singleton)=$2 FROM employee WHERE id=$1", employee.ID, before).Scan(&unchanged))
	if !unchanged {
		t.Fatal("denied exclusive recheck changed data or revision")
	}
	f.exec(t, `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES(gen_random_uuid(),convert_to('employee.linkAccount','UTF8'),$1,'allow',convert_to('allEmployees','UTF8'),1,'{}','runtime')`, f.owner.ID)
	allowed := f.authority(t, authority.DefaultCapabilities(), command)
	committed, err := authority.Execute(t.Context(), allowed, secret, command, employee.ID)
	requireDB(t, err)
	if !committed.Found || committed.Value != "linked" {
		t.Fatal("authorized admin did not commit")
	}
	var advanced bool
	requireDB(t, f.conn.QueryRow(t.Context(), "SELECT account_id=$2 AND (SELECT revision FROM authz_state WHERE singleton)=CAST($3 AS bigint)+1 FROM employee WHERE id=$1", employee.ID, f.owner.ID, before).Scan(&advanced))
	if !advanced {
		t.Fatal("admin mutation did not advance revision exactly once")
	}
}
