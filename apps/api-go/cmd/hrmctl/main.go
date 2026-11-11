// Command hrmctl runs the offline operations. Its output never holds a secret or a driver message.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api-go/internal/authorization/manifest"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/offline"
)

func main() {
	if err := run(context.Background(), os.Args[1:], os.Getenv, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, failureLine(err))
		os.Exit(1)
	}
}

// usageError names a variable, a flag or a command, never a value.
type usageError struct {
	message string
}

func (e *usageError) Error() string { return e.message }

const expectedCommand = "Expected provision|migrate|sync|enroll|purge-sessions|reset-mfa|reset-root-mfa"

// commandFlags is the whole set of flags each command takes; any other flag, such as the removed
// --subject and --method, is refused.
var commandFlags = map[string][]string{
	"provision":      nil,
	"migrate":        nil,
	"sync":           nil,
	"enroll":         {"--user", "--email", "--issuer", "--role"},
	"purge-sessions": {"--retention-days"},
	"reset-mfa":      {"--user", "--operation", "--approval", "--reason"},
	"reset-root-mfa": {"--user", "--operation", "--approval", "--reason"},
}

// flagName keeps an unexpected flag out of the failure line unless it is plainly a name: a mistyped
// --user=<email> would otherwise print the address.
var flagName = regexp.MustCompile(`^--[a-z][a-z-]{0,31}$`)

func failureLine(err error) string {
	parts := []string{"Product operation failed"}
	var usage *usageError
	if errors.As(err, &usage) {
		parts = append(parts, usage.message)
	}
	var rejection *manifest.Rejection
	if errors.As(err, &rejection) {
		parts = append(parts, rejection.Reason)
	}
	for _, known := range []error{
		offline.ErrMissingCredential, offline.ErrUnsafeRole, offline.ErrUnsafeOwner, offline.ErrCredentialRefused,
		offline.ErrInvalidPurge, offline.ErrUnknownRole, offline.ErrInvalidMFAReset, offline.ErrNotIAMAccount, offline.ErrNotRootAccount,
	} {
		if errors.Is(err, known) {
			parts = append(parts, known.Error())
		}
	}
	var driver *pgconn.PgError
	if errors.As(err, &driver) {
		parts = append(parts, driver.Code)
	}
	return strings.Join(parts, " ") + "; no secrets are printed. Check inputs, privileges and migration/data mapping requirements."
}

// parseFlags takes `--flag value` pairs, each flag once. `pnpm run <script> -- --flag value` forwards the
// end-of-options marker, so one leading `--` is dropped; anywhere else it is an invalid flag.
func parseFlags(command string, args []string) (map[string]string, error) {
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	flags := map[string]string{}
	for i := 0; i < len(args); i += 2 {
		key := args[i]
		_, seen := flags[key]
		if !strings.HasPrefix(key, "--") || i+1 >= len(args) || args[i+1] == "" || seen {
			return nil, &usageError{message: "Expected unique --option value pairs"}
		}
		if !slices.Contains(commandFlags[command], key) {
			if !flagName.MatchString(key) {
				return nil, &usageError{message: "Unexpected option"}
			}
			return nil, &usageError{message: "Unexpected option " + key}
		}
		flags[key] = args[i+1]
	}
	return flags, nil
}

func run(ctx context.Context, args []string, env func(string) string, out io.Writer) error {
	if len(args) == 0 {
		return &usageError{message: expectedCommand}
	}
	command := args[0]
	if _, known := commandFlags[command]; !known {
		return &usageError{message: expectedCommand}
	}
	flags, err := parseFlags(command, args[1:])
	if err != nil {
		return err
	}
	var line string
	switch command {
	case "provision":
		line, err = "Product database provisioned; credentials are never printed.", provision(ctx, env)
	case "migrate":
		line, err = "Applied forward migrations.", migrate(ctx, env)
	case "sync":
		line, err = "Product manifest synchronized.", syncManifest(ctx, env)
	case "enroll":
		line, err = "Pending account enrolled for its first verified Google login within 7 days.", enroll(ctx, env, flags)
	case "purge-sessions":
		line, err = purgeSessions(ctx, env, flags)
	case "reset-mfa", "reset-root-mfa":
		line, err = resetMFA(ctx, env, flags, command == "reset-root-mfa")
	}
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(out, line)
	return err
}

func required(env func(string) string, name string) (string, error) {
	value := env(name)
	if value == "" {
		return "", &usageError{message: name + " is required"}
	}
	return value, nil
}

// tlsMode refuses a NODE_ENV the API refuses, so a typo cannot turn TLS off. Production always verifies.
// Elsewhere it follows PGSSLMODE as the TypeScript CLI does through pg 8.x (connection-parameters.js),
// where every TLS mode verifies the certificate and the host; no-verify and unknown values are refused
// rather than weakened.
func tlsMode(env func(string) string) (database.TLSMode, error) {
	switch env("NODE_ENV") {
	case "production":
		return database.TLSVerifyFull, nil
	case "", "development", "test":
	default:
		return 0, &usageError{message: "NODE_ENV must be development, test or production"}
	}
	switch env("PGSSLMODE") {
	case "", "disable":
		return database.TLSDisabled, nil
	case "prefer", "require", "verify-ca", "verify-full":
		return database.TLSVerifyFull, nil
	default:
		return 0, &usageError{message: "PGSSLMODE must be disable, prefer, require, verify-ca or verify-full"}
	}
}

func connection(raw, name string, tls database.TLSMode) (offline.Connection, error) {
	invalid := &usageError{message: name + " must be a PostgreSQL URL"}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.User == nil || parsed.User.Username() == "" || parsed.Hostname() == "" {
		return offline.Connection{}, invalid
	}
	port := 5432
	if value := parsed.Port(); value != "" {
		port, err = strconv.Atoi(value)
		if err != nil {
			return offline.Connection{}, invalid
		}
	}
	password, _ := parsed.User.Password()
	return offline.Connection{
		Host:     parsed.Hostname(),
		Port:     port,
		Username: parsed.User.Username(),
		Password: password,
		Database: strings.TrimPrefix(parsed.Path, "/"),
		TLS:      tls,
	}, nil
}

func provision(ctx context.Context, env func(string) string) error {
	raw, err := required(env, "DATABASE_ADMIN_URL")
	if err != nil {
		return err
	}
	tls, err := tlsMode(env)
	if err != nil {
		return err
	}
	admin, err := connection(raw, "DATABASE_ADMIN_URL", tls)
	if err != nil {
		return err
	}
	name, err := required(env, "PRODUCT_DATABASE_NAME")
	if err != nil {
		return err
	}
	if err := offline.CreateDatabase(ctx, admin, name); err != nil {
		if errors.Is(err, offline.ErrInvalidDatabaseName) {
			return &usageError{message: "Invalid PRODUCT_DATABASE_NAME"}
		}
		return err
	}
	passwords := offline.Passwords{}
	for _, entry := range []struct {
		variable string
		target   *string
	}{
		{"PRODUCT_DATA_PASSWORD", &passwords.Data},
		{"PRODUCT_IDENTITY_PASSWORD", &passwords.Identity},
		{"PRODUCT_AUTHORITY_PASSWORD", &passwords.Authority},
		{"PRODUCT_SYNC_PASSWORD", &passwords.Sync},
		{"PRODUCT_MIGRATION_PASSWORD", &passwords.Migration},
		{"PRODUCT_BOOTSTRAP_PASSWORD", &passwords.Bootstrap},
		{"PRODUCT_OUTBOX_PASSWORD", &passwords.Outbox},
	} {
		value, err := required(env, entry.variable)
		if err != nil {
			return err
		}
		*entry.target = value
	}
	admin.Database = name
	return offline.Provision(ctx, admin, passwords)
}

func migrate(ctx context.Context, env func(string) string) error {
	raw, err := required(env, "PRODUCT_MIGRATION_DATABASE_URL")
	if err != nil {
		return err
	}
	tls, err := tlsMode(env)
	if err != nil {
		return err
	}
	settings, err := connection(raw, "PRODUCT_MIGRATION_DATABASE_URL", tls)
	if err != nil {
		return err
	}
	if settings.Database == "" {
		return &usageError{message: "PRODUCT_MIGRATION_DATABASE_URL must be a PostgreSQL URL"}
	}
	return offline.Migrate(ctx, settings)
}
