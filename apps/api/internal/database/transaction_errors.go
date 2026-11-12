package database

import (
	"context"
	"errors"
	"io"
	"net"
	"regexp"
	"slices"
	"syscall"

	"github.com/jackc/pgx/v5/pgconn"
)

// RuntimeCapability lists the authorization features this runtime enforces; sync raises the database
// minimum to it. 1 = permission boundaries. Bump it when a release can carry facts an older runtime
// would ignore, in NestJS as well while both run.
const RuntimeCapability = 1

const (
	codeConnection            = "connection"
	codeDeadline              = "deadline"
	codeCapabilityUnavailable = "capability_unavailable"
	codeFenceMissing          = "fence_missing"
	codePoolTimeout           = "pool_timeout"
	codeRuntimeIncompatible   = "runtime_incompatible"
)

// ConflictError is a retryable conflict that persisted after every attempt (409).
type ConflictError struct {
	Code string
}

func (e *ConflictError) Error() string {
	return "Transaction conflict (" + e.Code + ") persisted after retries"
}

// UnavailableError means authority could not decide: timeout, lost connection, missing fence (503).
// It keeps the code only, because a driver error can carry data of the statement.
type UnavailableError struct {
	Code string
}

func (e *UnavailableError) Error() string {
	return "Authority unavailable (" + e.Code + ")"
}

var (
	retryableCodes = []string{"40P01", "40001", "55P03"}
	unavailable    = regexp.MustCompile(`^(?:08|53|57|25P0[34])`)
)

func isRetryable(code string) bool {
	return slices.Contains(retryableCodes, code)
}

func isUnavailable(code string) bool {
	return code == codeConnection || code == codeDeadline || code == "AZ001" || code == "P0002" ||
		(code != "" && unavailable.MatchString(code))
}

// failureCode gives the SQLSTATE of a driver error, or a code of this package for a failure without one.
// connectionClosed covers errors pgconn does not export, such as a statement on a connection that died.
func failureCode(err error, connectionClosed bool) string {
	var driver *pgconn.PgError
	if errors.As(err, &driver) {
		return driver.Code
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return codeDeadline
	}
	var connect *pgconn.ConnectError
	var network net.Error
	if connectionClosed || errors.As(err, &connect) || errors.As(err, &network) ||
		errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) {
		return codeConnection
	}
	return ""
}
