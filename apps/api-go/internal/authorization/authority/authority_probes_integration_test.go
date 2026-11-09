//go:build integration

package authority_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/database"
)

type queryCounts struct {
	sessions, facts, fences, probes int
	pause                           time.Duration
}
type factsTraceKey struct{}

func (c *queryCounts) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "resolve_session") {
		c.sessions++
	}
	if strings.Contains(data.SQL, "FROM policy_rule WHERE") {
		c.facts++
	}
	if strings.Contains(data.SQL, "authz_acquire_shared_fence") {
		c.fences++
	}
	if strings.HasPrefix(data.SQL, "SELECT EXISTS") {
		c.probes++
	}
	return context.WithValue(ctx, factsTraceKey{}, strings.Contains(data.SQL, "resolve_session"))
}
func (c *queryCounts) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if facts, _ := ctx.Value(factsTraceKey{}).(bool); facts && c.pause > 0 {
		time.Sleep(c.pause)
	}
}

func TestPermitBatchUsesOneFencedSessionFactsStatementAndOneProbe(t *testing.T) {
	f := newAuthorityFixture(t)
	counts := &queryCounts{}
	config := f.s.Pools[database.PurposeData].Config()
	config.MaxConns = 1
	config.ConnConfig.Tracer = counts
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	requireDB(t, err)
	t.Cleanup(pool.Close)
	runner, err := database.NewRunner(database.Pools{database.PurposeData: pool}, database.RunnerOptions{})
	requireDB(t, err)
	stack := *f.s
	stack.Runner = runner
	traced := *f
	traced.s = &stack
	a := traced.authority(t, authority.DefaultCapabilities())
	queries := []authority.PermitQuery{{{Resource: "document", Action: "read"}}, {{Resource: "document", Action: "update"}}, {{Resource: "missing", Action: "read"}, {Resource: "document", Action: "read"}}}
	answers, err := a.PermitsMany(t.Context(), f.secret, queries)
	requireDB(t, err)
	if len(answers) != 3 || !answers[0] || answers[1] || !answers[2] {
		t.Fatal("pair facts were mixed or any-of changed")
	}
	if counts.sessions != 1 || counts.facts != 1 || counts.fences != 1 || counts.probes != 1 {
		t.Fatalf("sessions=%d facts=%d fences=%d probes=%d", counts.sessions, counts.facts, counts.fences, counts.probes)
	}
	*counts = queryCounts{pause: 2100 * time.Millisecond}
	answers, err = a.PermitsMany(t.Context(), f.secret, queries)
	requireDB(t, err)
	for _, allowed := range answers {
		if allowed {
			t.Fatal("expired shared decision window allowed a probe")
		}
	}
}
