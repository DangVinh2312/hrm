package employee

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/apperror"
)

func TestUniqueRejectedMapsOnlyAUniqueViolation(t *testing.T) {
	unique := fmt.Errorf("insert: %w", &pgconn.PgError{Code: "23505"})
	if err := uniqueRejected(unique); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Errorf("unique violation: %v", err)
	}
	for _, code := range []string{"23503", "23514", "40001", "42501"} {
		fault := &pgconn.PgError{Code: code}
		if err := uniqueRejected(fault); !errors.Is(err, fault) || errors.Is(err, apperror.ErrCommandRejected) {
			t.Errorf("%s was turned into %v", code, err)
		}
	}
	if err := uniqueRejected(nil); err != nil {
		t.Errorf("nil became %v", err)
	}
}
