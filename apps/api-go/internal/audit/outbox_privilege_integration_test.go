//go:build integration

package audit_test

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
)

func TestOutboxLoginHasExactlyDeliveryPrivileges(t *testing.T) {
	s, _, _ := deliveryFixture(t, 0, audit.OutboxOptions{})
	pool := s.Pools[database.PurposeOutbox]
	if err := database.VerifyPrivileges(t.Context(), database.Pools{database.PurposeOutbox: pool}, nil); err != nil {
		t.Fatal(test.Redact(err))
	}
	for _, statement := range []string{
		"SELECT 1 FROM application_session LIMIT 1",
		"SELECT 1 FROM one_time_token LIMIT 1",
		"SELECT 1 FROM app_user LIMIT 1",
		"INSERT INTO audit_outbox(event_id,actor_id,event_kind,policy_revision,occurred_at,safe_metadata) VALUES(gen_random_uuid(),gen_random_uuid(),convert_to('fixture','UTF8'),1,statement_timestamp(),'{}')",
		"DELETE FROM audit_outbox",
		"UPDATE audit_outbox SET event_kind=convert_to('fixture','UTF8')",
		"UPDATE audit_outbox SET safe_metadata='{}'",
		"UPDATE audit_outbox SET actor_id=gen_random_uuid()",
		"SELECT public.authz_acquire_shared_fence(1)",
		"SELECT * FROM public.resolve_session(sha256('fixture'))",
	} {
		_, err := pool.Exec(t.Context(), statement)
		var driver *pgconn.PgError
		if !errors.As(err, &driver) || driver.Code != "42501" {
			t.Fatalf("delivery-only ACL violated: %s", test.Redact(err))
		}
	}
}
