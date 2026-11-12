//go:build integration

package role

import (
	"maps"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"hrm/api/internal/database"
	"hrm/api/test"
)

func tracedRunner(t *testing.T, s *test.Stack, tracer pgx.QueryTracer) *database.Runner {
	t.Helper()
	pools := maps.Clone(s.Pools)
	for purpose, pool := range s.Pools {
		config := pool.Config()
		config.ConnConfig.Tracer = tracer
		traced, err := pgxpool.NewWithConfig(t.Context(), config)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		t.Cleanup(traced.Close)
		pools[purpose] = traced
	}
	runner, err := database.NewRunner(pools, database.RunnerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return runner
}
