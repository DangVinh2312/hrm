package database_test

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/database"
)

func TestIsUniqueViolation(t *testing.T) {
	for name, tc := range map[string]struct {
		err  error
		want bool
	}{
		"unique":              {&pgconn.PgError{Code: "23505"}, true},
		"wrapped":             {fmt.Errorf("insert: %w", &pgconn.PgError{Code: "23505"}), true},
		"joined":              {errors.Join(errors.New("x"), &pgconn.PgError{Code: "23505"}), true},
		"foreign key":         {&pgconn.PgError{Code: "23503"}, false},
		"check":               {&pgconn.PgError{Code: "23514"}, false},
		"serialization":       {&pgconn.PgError{Code: "40001"}, false},
		"other class prefix":  {&pgconn.PgError{Code: "235050"}, false},
		"not a driver error":  {errors.New("23505"), false},
		"nil":                 {nil, false},
		"value not a pointer": {fmt.Errorf("x: %v", &pgconn.PgError{Code: "23505"}), false},
	} {
		t.Run(name, func(t *testing.T) {
			if got := database.IsUniqueViolation(tc.err); got != tc.want {
				t.Fatalf("got %v", got)
			}
		})
	}
}
