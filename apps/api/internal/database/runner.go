package database

import (
	"context"
	"errors"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Mode selects the login and the fence of a transaction.
type Mode string

const (
	ModeRead      Mode = "read"
	ModeWrite     Mode = "write"
	ModeIdentity  Mode = "identity"
	ModeRevoke    Mode = "revoke"
	ModeAdmin     Mode = "admin"
	ModeSync      Mode = "sync"
	ModeBootstrap Mode = "bootstrap"
	ModeOutbox    Mode = "outbox"
)

// Metric is a finite label: no user or record id ever goes in one.
type Metric string

const (
	MetricPoolWait     Metric = "pool_wait"
	MetricLockWait     Metric = "lock_wait"
	MetricLockHold     Metric = "lock_hold"
	MetricTransaction  Metric = "transaction"
	MetricRevokeCommit Metric = "revoke_commit"
	MetricRetry        Metric = "retry"
	MetricTimeout      Metric = "timeout"
	MetricDeadlock     Metric = "deadlock"
)

const (
	maxDeadline    = 3 * time.Second
	outboxDeadline = 2 * time.Second
	maxLockTimeout = time.Second
	maxRetries     = 2
	maxRequest     = 5 * time.Second

	// clientGrace lets the server report its own timeout first. The context deadline is the backstop for
	// a server that stopped answering.
	clientGrace     = 500 * time.Millisecond
	rollbackTimeout = time.Second
	maxSafeInteger  = int64(1)<<53 - 1

	setTimeoutsSQL  = "SELECT set_config('statement_timeout',$1,true),set_config('transaction_timeout',$1,true),set_config('lock_timeout',$2,true)"
	advisoryLockSQL = "SELECT pg_advisory_xact_lock($1)"
	sharedFenceSQL  = "SELECT public.authz_acquire_shared_fence($1)::text AS revision,0 AS required"
	exclusiveSQL    = "SELECT revision::text AS revision,min_runtime_capability AS required FROM public.authz_state WHERE singleton FOR UPDATE"
	bumpRevisionSQL = "UPDATE public.authz_state SET revision=revision+1 WHERE singleton"
)

var (
	modePurposes = map[Mode]Purpose{
		ModeRead:      PurposeData,
		ModeWrite:     PurposeData,
		ModeIdentity:  PurposeIdentity,
		ModeRevoke:    PurposeIdentity,
		ModeAdmin:     PurposeAuthority,
		ModeSync:      PurposeSync,
		ModeBootstrap: PurposeBootstrap,
		ModeOutbox:    PurposeOutbox,
	}
	// ErrInvalidRunner is a programming error of the caller, not a state of the database.
	ErrInvalidRunner = errors.New("database: invalid runner options")
	// ErrUnknownMode is a programming error of the caller.
	ErrUnknownMode = errors.New("database: unknown transaction mode")
	// ErrInvalidAdvisoryKey is a programming error of the caller.
	ErrInvalidAdvisoryKey = errors.New("database: invalid advisory lock key")
)

// RunnerOptions can only lower the limits. Zero values take the limit.
type RunnerOptions struct {
	Deadline    time.Duration
	LockTimeout time.Duration
	// MaxRetries is a pointer because zero is a valid value.
	MaxRetries *int
	OnMetric   func(metric Metric, mode Mode, value float64)
}

// RunOptions holds what differs per call.
type RunOptions struct {
	// Serialize joins a transaction-scoped advisory queue before the fence. Waiters hold no fence share,
	// so queued work cannot keep an exclusive revoke off the fence. Lock order: advisory, then fence.
	Serialize *int64
}

// Runner is the only way to a transaction: fixed-purpose pools, fence first, bounded retries.
type Runner struct {
	pools       Pools
	deadline    time.Duration
	lockTimeout time.Duration
	retries     int
	onMetric    func(metric Metric, mode Mode, value float64)
}

// NewRunner applies the hard limits; an option cannot raise them.
func NewRunner(pools Pools, options RunnerOptions) (*Runner, error) {
	if options.Deadline < 0 || options.LockTimeout < 0 {
		return nil, ErrInvalidRunner
	}
	deadline := maxDeadline
	if options.Deadline > 0 {
		deadline = min(options.Deadline, maxDeadline)
	}
	lockTimeout := min(deadline, maxLockTimeout)
	if options.LockTimeout > 0 {
		lockTimeout = min(options.LockTimeout, lockTimeout)
	}
	retries := maxRetries
	if options.MaxRetries != nil {
		if *options.MaxRetries < 0 {
			return nil, ErrInvalidRunner
		}
		retries = min(*options.MaxRetries, maxRetries)
	}
	if deadline.Milliseconds() < 1 || lockTimeout.Milliseconds() < 1 {
		return nil, ErrInvalidRunner
	}
	return &Runner{pools: pools, deadline: deadline, lockTimeout: lockTimeout, retries: retries, onMetric: options.OnMetric}, nil
}

// metric recovers because diagnostics must not change commit semantics.
func (r *Runner) metric(metric Metric, mode Mode, value float64) {
	if r.onMetric == nil {
		return
	}
	defer func() {
		if recover() != nil {
			return
		}
	}()
	r.onMetric(metric, mode, value)
}

func milliseconds(duration time.Duration) float64 {
	return float64(duration) / float64(time.Millisecond)
}

// Tx is valid only inside the callback of Run and on its goroutine. Its statements run on the deadline
// of the transaction: they take no context, so a request context cannot abort a mutation half way.
type Tx struct {
	Mode     Mode
	Revision string

	ctx    context.Context
	tx     pgx.Tx
	closed atomic.Bool
}

var errTxClosed = &UnavailableError{Code: codeConnection}

// Query fails after the callback returned. On an error rows is nil; otherwise the caller closes it.
func (t *Tx) Query(sql string, args ...any) (pgx.Rows, error) {
	if t.closed.Load() {
		return nil, errTxClosed
	}
	return t.tx.Query(t.ctx, sql, args...) //nolint:rowserrcheck // the caller owns rows and reads Err; it cannot see past a wrapper
}

// Exec runs without arguments on the simple protocol, so that form may hold several statements.
func (t *Tx) Exec(sql string, args ...any) (pgconn.CommandTag, error) {
	if t.closed.Load() {
		return pgconn.CommandTag{}, errTxClosed
	}
	return t.tx.Exec(t.ctx, sql, args...)
}

// Run executes work in one transaction under the fence of mode. The context of the caller gives values
// only: a client that disconnects does not cancel a transaction, which ends on its own deadline.
// Work runs again on a retry, so it must have no effect outside tx.
func Run[T any](ctx context.Context, r *Runner, mode Mode, work func(ctx context.Context, tx *Tx) (T, error), options RunOptions) (T, error) {
	var zero T
	purpose, known := modePurposes[mode]
	if !known {
		return zero, ErrUnknownMode
	}
	if mode == ModeOutbox && options.Serialize != nil {
		return zero, ErrInvalidRunner
	}
	if options.Serialize != nil && (*options.Serialize > maxSafeInteger || *options.Serialize < -maxSafeInteger) {
		return zero, ErrInvalidAdvisoryKey
	}
	pool := r.pools[purpose]
	if pool == nil {
		return zero, &UnavailableError{Code: codeCapabilityUnavailable}
	}
	detached := context.WithoutCancel(ctx)
	requestStart := time.Now()
	for attempt := 0; ; attempt++ {
		result, closed, err := runAttempt(detached, r, pool, mode, work, options, requestStart)
		if err == nil {
			return result, nil
		}
		var classified *UnavailableError
		if errors.As(err, &classified) {
			return zero, classified
		}
		code := failureCode(err, closed)
		if code == "40P01" {
			r.metric(MetricDeadlock, mode, 1)
		}
		if code == "55P03" || code == "57014" {
			r.metric(MetricTimeout, mode, 1)
		}
		if isRetryable(code) {
			if attempt >= r.retries || time.Since(requestStart) >= maxRequest {
				return zero, &ConflictError{Code: code}
			}
			r.metric(MetricRetry, mode, 1)
			continue
		}
		if isUnavailable(code) {
			return zero, &UnavailableError{Code: code}
		}
		return zero, err
	}
}

func runAttempt[T any](ctx context.Context, r *Runner, pool *pgxpool.Pool, mode Mode, work func(context.Context, *Tx) (T, error), options RunOptions, requestStart time.Time) (result T, connectionClosed bool, err error) {
	var zero T
	deadline := r.deadline
	if mode == ModeOutbox {
		deadline = min(deadline, outboxDeadline)
	}
	started := time.Now()
	acquire, cancelAcquire := context.WithTimeout(ctx, poolWait)
	conn, err := pool.Acquire(acquire)
	cancelAcquire()
	if err != nil {
		return zero, false, &UnavailableError{Code: acquireFailure(err)}
	}
	var locked time.Time
	defer func() {
		if !locked.IsZero() {
			r.metric(MetricLockHold, mode, milliseconds(time.Since(locked)))
		}
		r.metric(MetricTransaction, mode, milliseconds(time.Since(started)))
		connectionClosed = connectionClosed || conn.Conn().IsClosed()
		conn.Release()
	}()
	r.metric(MetricPoolWait, mode, milliseconds(time.Since(started)))

	transaction, cancel := context.WithTimeout(ctx, deadline+clientGrace)
	defer cancel()
	begun, err := conn.BeginTx(transaction, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return zero, false, err
	}
	tx := &Tx{Mode: mode, ctx: transaction, tx: begun}
	committed := false
	defer func() {
		tx.closed.Store(true)
		if !committed {
			rollback(ctx, begun)
		}
	}()

	if _, err := begun.Exec(transaction, setTimeoutsSQL, formatMilliseconds(deadline), formatMilliseconds(r.lockTimeout)); err != nil {
		return zero, false, err
	}
	wait := time.Now()
	if options.Serialize != nil {
		if _, err := begun.Exec(transaction, advisoryLockSQL, *options.Serialize); err != nil {
			return zero, false, err
		}
	}
	if mode != ModeOutbox {
		revision, err := acquireFence(transaction, begun, mode)
		if err != nil {
			return zero, false, err
		}
		locked = time.Now()
		r.metric(MetricLockWait, mode, milliseconds(locked.Sub(wait)))
		tx.Revision = revision
	}

	value, err := work(transaction, tx)
	tx.closed.Store(true)
	if err != nil {
		return zero, false, err
	}
	if mode == ModeRevoke || mode == ModeAdmin || mode == ModeBootstrap {
		if _, err := begun.Exec(transaction, bumpRevisionSQL); err != nil {
			return zero, false, err
		}
	}
	if time.Since(started) > deadline || time.Since(requestStart) > maxRequest {
		return zero, false, &UnavailableError{Code: codeDeadline}
	}
	if err := begun.Commit(transaction); err != nil {
		return zero, false, err
	}
	committed = true
	if mode == ModeRevoke {
		r.metric(MetricRevokeCommit, mode, milliseconds(time.Since(requestStart)))
	}
	return value, false, nil
}

func formatMilliseconds(duration time.Duration) string {
	return strconv.FormatInt(duration.Milliseconds(), 10) + "ms"
}

func acquireFailure(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return codePoolTimeout
	}
	return codeConnection
}

// acquireFence is the first statement that reads facts, so a later statement sees what any holder of the
// fence committed. Scan into text keeps the revision out of a JS or Go number.
func acquireFence(ctx context.Context, tx pgx.Tx, mode Mode) (string, error) {
	var (
		row      pgx.Row
		revision string
		required int
	)
	if mode == ModeRead || mode == ModeWrite || mode == ModeIdentity {
		row = tx.QueryRow(ctx, sharedFenceSQL, RuntimeCapability)
	} else {
		row = tx.QueryRow(ctx, exclusiveSQL)
	}
	if err := row.Scan(&revision, &required); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", &UnavailableError{Code: codeFenceMissing}
		}
		return "", err
	}
	if required > RuntimeCapability {
		return "", &UnavailableError{Code: codeRuntimeIncompatible}
	}
	return revision, nil
}

// rollback runs on its own context because the one of the transaction may have expired, and also while a
// panic of the callback unwinds. On failure pgx closes the connection and Release discards it.
func rollback(ctx context.Context, tx pgx.Tx) {
	bounded, cancel := context.WithTimeout(ctx, rollbackTimeout)
	defer cancel()
	if err := tx.Rollback(bounded); err != nil {
		return
	}
}
