// Package offline holds what only the operator CLI may do: this credential must never be wired into the API.
package offline

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/database"
)

const (
	migrationLogin = "product_migration"
	revokeTimeout  = 10 * time.Second
)

var (
	// ErrMissingCredential means a password is empty or cannot be sent to PostgreSQL.
	ErrMissingCredential = errors.New("missing product credential")
	// ErrUnsafeRole means an existing role has capabilities it must not have.
	ErrUnsafeRole = errors.New("existing product role has unsafe capabilities")
	// ErrUnsafeOwner means an existing function owner has capabilities it must not have.
	ErrUnsafeOwner = errors.New("existing function owner has unsafe capabilities")
	// ErrCredentialRefused hides the driver message of CREATE ROLE, whose statement holds the password.
	ErrCredentialRefused = errors.New("unable to provision product credential")
	// ErrInvalidDatabaseName means the name is not one this command will quote into CREATE DATABASE.
	ErrInvalidDatabaseName = errors.New("invalid PRODUCT_DATABASE_NAME")

	databaseName = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)
)

// Connection is the admin principal of the offline commands.
type Connection struct {
	Host     string
	Port     int
	Username string
	Password string
	Database string
	TLS      database.TLSMode
}

func (Connection) String() string { return "offline.Connection{redacted}" }

func (Connection) GoString() string { return "offline.Connection{redacted}" }

func (c Connection) url() string {
	target := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(c.Username, c.Password),
		Host:   net.JoinHostPort(c.Host, strconv.Itoa(c.Port)),
		Path:   "/" + c.Database,
	}
	return target.String()
}

func (c Connection) on(name string) Connection {
	c.Database = name
	return c
}

func (c Connection) connect(ctx context.Context) (*pgx.Conn, error) {
	config, err := database.NewConnConfig(c.url(), c.TLS)
	if err != nil {
		return nil, err
	}
	return pgx.ConnectConfig(ctx, config)
}

// Passwords holds one password for each login provisioning creates.
type Passwords struct {
	Data      string
	Identity  string
	Authority string
	Sync      string
	Migration string
	Bootstrap string
	Outbox    string
}

func (Passwords) String() string { return "offline.Passwords{redacted}" }

func (Passwords) GoString() string { return "offline.Passwords{redacted}" }

func (p Passwords) logins() []struct{ name, password string } {
	return []struct{ name, password string }{
		{"product_data", p.Data},
		{"product_identity", p.Identity},
		{"product_authority", p.Authority},
		{"product_sync", p.Sync},
		{"product_migration", p.Migration},
		{"product_bootstrap", p.Bootstrap},
		{"product_outbox", p.Outbox},
	}
}

// CreateDatabase creates the database when absent, from the maintenance database.
func CreateDatabase(ctx context.Context, admin Connection, name string) (err error) {
	if !databaseName.MatchString(name) {
		return ErrInvalidDatabaseName
	}
	control, err := admin.on("postgres").connect(ctx)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, control.Close(ctx)) }()
	rows, err := control.Query(ctx, "SELECT 1 FROM pg_database WHERE datname=$1", name)
	if err != nil {
		return err
	}
	present, err := pgx.CollectRows(rows, pgx.RowTo[int32])
	if err != nil {
		return err
	}
	if len(present) > 0 {
		return nil
	}
	_, err = control.Exec(ctx, `CREATE DATABASE "`+name+`"`)
	return err
}

// Provision creates the roles, opens the schema to the migration login for the time of the migrations,
// runs them and closes it again. Running it again is a no-op for what is already applied.
func Provision(ctx context.Context, admin Connection, passwords Passwords) error {
	return provisionUpTo(ctx, admin, passwords, 0)
}

// provisionUpTo stops after the migration with that version; zero means every migration.
func provisionUpTo(ctx context.Context, admin Connection, passwords Passwords, version int64) (err error) {
	source, err := admin.connect(ctx)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, source.Close(ctx)) }()
	if err := ensureLogins(ctx, source, passwords); err != nil {
		return err
	}
	if err := ensureOwners(ctx, source); err != nil {
		return err
	}
	// The owners are NOLOGIN; the migration login joins them only while migrating, because it needs SET
	// ROLE to hand objects to them.
	migrated := grantForMigration(ctx, source)
	if migrated == nil {
		migration := admin
		migration.Username = migrationLogin
		migration.Password = passwords.Migration
		migrated = runMigrations(ctx, migration, version)
	}
	// The grants or the migration may have failed half way, or the caller gave up; the membership and
	// CREATE must not outlive this command anyway.
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), revokeTimeout)
	defer cancel()
	revoker := source
	// pgx learns that the server ended an idle session only on its next statement, hence the ping.
	if source.IsClosed() || source.Ping(cleanup) != nil {
		fresh, connectErr := admin.connect(cleanup)
		if connectErr != nil {
			return errors.Join(migrated, connectErr)
		}
		defer func() { err = errors.Join(err, fresh.Close(cleanup)) }()
		revoker = fresh
	}
	owners := strings.Join(database.FunctionOwners(), ",")
	_, revokeMembership := revoker.Exec(cleanup, "REVOKE "+owners+" FROM "+migrationLogin)
	_, revokeCreate := revoker.Exec(cleanup, "REVOKE CREATE ON SCHEMA public FROM "+owners)
	return errors.Join(migrated, revokeMembership, revokeCreate)
}

func ensureLogins(ctx context.Context, source *pgx.Conn, passwords Passwords) error {
	for _, login := range passwords.logins() {
		if login.password == "" || strings.Contains(login.password, "\x00") {
			return ErrMissingCredential
		}
		var unsafe [6]bool
		err := source.QueryRow(ctx, "SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,rolcanlogin FROM pg_roles WHERE rolname=$1", login.name).
			Scan(&unsafe[0], &unsafe[1], &unsafe[2], &unsafe[3], &unsafe[4], &unsafe[5])
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil {
			if unsafe[0] || unsafe[1] || unsafe[2] || unsafe[3] || unsafe[4] || !unsafe[5] {
				return ErrUnsafeRole
			}
			continue
		}
		// PostgreSQL utility statements do not accept bind parameters; quote the literal explicitly.
		literal := strings.ReplaceAll(strings.ReplaceAll(login.password, `\`, `\\`), `'`, `''`)
		statement := fmt.Sprintf("CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD E'%s'", login.name, literal)
		if _, err := source.Exec(ctx, statement); err != nil {
			return ErrCredentialRefused
		}
	}
	return nil
}

func ensureOwners(ctx context.Context, source *pgx.Conn) error {
	for _, owner := range database.FunctionOwners() {
		var present bool
		if err := source.QueryRow(ctx, "SELECT EXISTS(SELECT FROM pg_roles WHERE rolname=$1) AS present", owner).Scan(&present); err != nil {
			return err
		}
		if present {
			var unsafe bool
			if err := source.QueryRow(ctx, "SELECT (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication) unsafe FROM pg_roles WHERE rolname=$1", owner).Scan(&unsafe); err != nil {
				return err
			}
			if unsafe {
				return ErrUnsafeOwner
			}
			continue
		}
		if _, err := source.Exec(ctx, "CREATE ROLE "+owner+" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"); err != nil {
			return err
		}
	}
	return nil
}

func grantForMigration(ctx context.Context, source *pgx.Conn) error {
	owners := strings.Join(database.FunctionOwners(), ",")
	for _, statement := range []string{
		"REVOKE CREATE ON SCHEMA public FROM PUBLIC",
		// Runtime logins need no temp objects; one session's temp table would otherwise trip another
		// replica's ownership probe.
		"DO $$BEGIN EXECUTE format('REVOKE TEMP ON DATABASE %I FROM PUBLIC',current_database()); END$$",
		"GRANT USAGE ON SCHEMA public TO product_data,product_identity,product_authority,product_sync,product_bootstrap,product_outbox",
		"GRANT USAGE,CREATE ON SCHEMA public TO " + migrationLogin + "," + owners,
		"GRANT " + owners + " TO " + migrationLogin + " WITH ADMIN OPTION",
	} {
		if _, err := source.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}
