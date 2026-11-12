package database

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

func IsUniqueViolation(err error) bool {
	driver, ok := errors.AsType[*pgconn.PgError](err)
	return ok && driver.Code == "23505"
}
