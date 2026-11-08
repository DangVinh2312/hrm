package database

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Purpose names a login; each has its own pool, and a mode never falls back to another one.
type Purpose string

const (
	PurposeData      Purpose = "data"
	PurposeIdentity  Purpose = "identity"
	PurposeAuthority Purpose = "authority"
	PurposeSync      Purpose = "sync"
	PurposeBootstrap Purpose = "bootstrap"
	PurposeOutbox    Purpose = "outbox"
)

// TLSMode has no usable zero value: a caller that forgot it gets an error, not a plain connection.
type TLSMode int

const (
	_ TLSMode = iota
	TLSVerifyFull
	TLSDisabled
)

const (
	// poolWait is outside the timeouts on the server, as connectionTimeoutMillis is; the check before
	// commit still counts it.
	poolWait = 2 * time.Second

	sslDisable    = "disable"
	sslVerifyFull = "verify-full"
)

var (
	poolSizes = map[Purpose]int32{
		PurposeData:      5,
		PurposeIdentity:  2,
		PurposeAuthority: 2,
		PurposeSync:      1,
		// The offline commands: productDataSourceOptions gives them 10.
		PurposeBootstrap: 10,
		PurposeOutbox:    10,
	}
	errInvalidConnection = errors.New("database: invalid connection settings")
)

// Pools holds a pool for each login this process may use.
type Pools map[Purpose]*pgxpool.Pool

// Close closes every pool.
func (p Pools) Close() {
	for _, pool := range p {
		pool.Close()
	}
}

// TLSForEnvironment decides TLS for the API; hrmctl also reads PGSSLMODE outside production. The URL has
// no say: pgconn would read sslmode from it, and its default `prefer` can fall back to no encryption.
func TLSForEnvironment(nodeEnv string) TLSMode {
	if nodeEnv == "production" {
		return TLSVerifyFull
	}
	return TLSDisabled
}

// connectionString keeps only what config validated. Query parameters could change the host, the TLS
// mode or the exec mode, and an explicit sslmode wins over PGSSLMODE. No error here holds the URL.
func connectionString(raw string, mode TLSMode) (string, error) {
	var sslMode string
	switch mode {
	case TLSVerifyFull:
		sslMode = sslVerifyFull
	case TLSDisabled:
		sslMode = sslDisable
	default:
		return "", errInvalidConnection
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") {
		return "", errInvalidConnection
	}
	if strings.Contains(parsed.Host, ",") {
		return "", errInvalidConnection
	}
	clean := url.URL{
		Scheme:   parsed.Scheme,
		User:     parsed.User,
		Host:     parsed.Host,
		Path:     parsed.Path,
		RawPath:  parsed.RawPath,
		RawQuery: url.Values{"sslmode": {sslMode}, "sslnegotiation": {"postgres"}}.Encode(),
	}
	return clean.String(), nil
}

func applyConnectionPolicy(config *pgx.ConnConfig) {
	config.DefaultQueryExecMode = pgx.QueryExecModeExec
	config.StatementCacheCapacity = 0
	config.DescriptionCacheCapacity = 0
	config.ConnectTimeout = poolWait
}

// NewConnConfig builds the settings of a single connection, for offline commands.
func NewConnConfig(raw string, mode TLSMode) (*pgx.ConnConfig, error) {
	connection, err := connectionString(raw, mode)
	if err != nil {
		return nil, err
	}
	config, err := pgx.ParseConfig(connection)
	if err != nil {
		return nil, errInvalidConnection
	}
	applyConnectionPolicy(config)
	return config, nil
}

// NewPoolConfig builds the settings of the pool of one login.
func NewPoolConfig(purpose Purpose, raw string, mode TLSMode) (*pgxpool.Config, error) {
	size, known := poolSizes[purpose]
	if !known {
		return nil, errInvalidConnection
	}
	connection, err := connectionString(raw, mode)
	if err != nil {
		return nil, err
	}
	config, err := pgxpool.ParseConfig(connection)
	if err != nil {
		return nil, errInvalidConnection
	}
	config.MaxConns = size
	config.MinConns = 0
	applyConnectionPolicy(config.ConnConfig)
	return config, nil
}

// NewPool creates the pool without connecting.
func NewPool(ctx context.Context, config *pgxpool.Config) (*pgxpool.Pool, error) {
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, errInvalidConnection
	}
	return pool, nil
}

// OpenPools connects each login before returning, so a wrong credential fails the boot. On error every
// pool is closed again.
func OpenPools(ctx context.Context, urls map[Purpose]string, mode TLSMode) (Pools, error) {
	pools := Pools{}
	for purpose, raw := range urls {
		config, err := NewPoolConfig(purpose, raw, mode)
		if err != nil {
			pools.Close()
			return nil, err
		}
		pool, err := NewPool(ctx, config)
		if err != nil {
			pools.Close()
			return nil, err
		}
		pools[purpose] = pool
		connect, cancel := context.WithTimeout(ctx, poolWait)
		err = pool.Ping(connect)
		cancel()
		if err != nil {
			pools.Close()
			return nil, connectionFailure(err)
		}
	}
	return pools, nil
}

// connectionFailure keeps the SQLSTATE of a refused login, or says the server did not answer in time, and
// drops the rest of the driver message.
func connectionFailure(err error) error {
	if code := failureCode(err, false); code != "" {
		return &UnavailableError{Code: code}
	}
	return &UnavailableError{Code: codeConnection}
}
