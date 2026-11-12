// Package fixture writes synthetic accounts, sessions, employees and the Root into a test database, each
// row with the login and transaction mode that writes it at runtime.
package fixture

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/database"
	"hrm/api/test"
)

const (
	defaultHiredOn = "2026-01-05"
	rootEmail      = "root@example.test"
	rootSubject    = "root-subject"

	insertAccount  = `INSERT INTO app_user(id,email_canonical,state,email_verified) VALUES($1,$2,'active',true)`
	insertBinding  = `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)`
	insertUserRole = `INSERT INTO user_role(user_id,role_key) VALUES($1,$2)`
	insertSession  = `INSERT INTO application_session(token_hash,user_id,auth_epoch,method,assurance,external_issuer,external_subject,binding_version,provider_version,authenticated_at,reauthenticated_at,expires_at)
     SELECT $1,u.id,u.auth_epoch,'oidc','oidc',e.issuer,e.subject,e.binding_version,p.version,statement_timestamp(),
       CASE WHEN $3 THEN statement_timestamp()-interval '5 seconds' END,statement_timestamp()+interval '1 hour'
     FROM app_user u JOIN external_identity e ON e.user_id=u.id AND e.enabled
       JOIN oidc_provider p ON p.issuer=e.issuer AND p.enabled
     WHERE u.id=$2 RETURNING 1`
	registerObject = `SELECT public.hr_register_object($1,CAST($2 AS uuid))::text AS object_id`
	insertEmployee = `INSERT INTO employee(id,object_id,code,full_name,hired_on,job_position,classification)
         VALUES($1,$2,$3,$4,CAST($5 AS date),$6,$7)`
	linkAccount    = `UPDATE employee SET account_id = $2 WHERE id = $1`
	dropEnrollment = `DELETE FROM oidc_email_enrollment WHERE user_id=$1`
	consumeTokens  = `UPDATE one_time_token SET consumed_at=statement_timestamp() WHERE user_id=$1 AND consumed_at IS NULL`
	activateRoot   = `UPDATE app_user SET state='active',email_verified=true,auth_epoch=auth_epoch+1 WHERE id=$1 AND state='pending'`
)

// refusal is a fixture precondition that failed; its text holds no data.
type refusal string

func (r refusal) Error() string { return string(r) }

var rootCommitted = regexp.MustCompile(`Root enrollment committed \(id ([0-9a-f-]{36})\)`)

// AccountSpec describes an active IAM account. An empty Email stores NULL; Roles may be empty.
type AccountSpec struct {
	Email string
	Roles []string
}

// AccountRow is an active IAM account with one enabled binding at test.FixtureIssuer.
type AccountRow struct{ ID, Email, Subject string }

// SessionSpec: Fresh is a step-up 5 seconds ago, as a second-factor verify leaves it.
type SessionSpec struct{ Fresh bool }

// EmployeeSpec: empty fields take a unique code, a name from it, no account and 2026-01-05.
type EmployeeSpec struct{ Code, FullName, AccountID, HiredOn string }

// EmployeeRow is the stored employee.
type EmployeeRow struct{ ID, ObjectID, Code, FullName, AccountID, HiredOn string }

// RootRow is the one Root of the database, bootstrapped and activated with one binding.
type RootRow struct{ ID, Email, OperationID, Subject string }

func newUUID(t testing.TB) string {
	t.Helper()
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	text := hex.EncodeToString(raw)
	return text[:8] + "-" + text[8:12] + "-" + text[12:16] + "-" + text[16:20] + "-" + text[20:]
}

func run(t testing.TB, s *test.Stack, mode database.Mode, work func(tx *database.Tx) error) {
	t.Helper()
	_, err := database.Run(t.Context(), s.Runner, mode, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		return struct{}{}, work(tx)
	}, database.RunOptions{})
	var reason refusal
	if errors.As(err, &reason) {
		t.Fatalf("fixture %s: %s", mode, reason)
	}
	if err != nil {
		t.Fatalf("fixture %s: %s", mode, test.Redact(err))
	}
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// Account writes the account and its binding with the identity login, and its roles in an admin transaction
// that advances the revision.
func Account(t testing.TB, s *test.Stack, spec AccountSpec) AccountRow {
	t.Helper()
	row := AccountRow{ID: newUUID(t), Email: spec.Email}
	row.Subject = "sub-" + row.ID
	run(t, s, database.ModeIdentity, func(tx *database.Tx) error {
		if _, err := tx.Exec(insertAccount, row.ID, nullable(spec.Email)); err != nil {
			return err
		}
		_, err := tx.Exec(insertBinding, test.FixtureIssuer, row.Subject, row.ID)
		return err
	})
	if len(spec.Roles) > 0 {
		run(t, s, database.ModeAdmin, func(tx *database.Tx) error {
			for _, role := range spec.Roles {
				if _, err := tx.Exec(insertUserRole, row.ID, []byte(role)); err != nil {
					return err
				}
			}
			return nil
		})
	}
	return row
}

// Session gives the secret of a new one-hour session of the account's enabled binding.
func Session(t testing.TB, s *test.Stack, userID string, spec SessionSpec) string {
	t.Helper()
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	secret := base64.RawURLEncoding.EncodeToString(raw)
	digest := sha256.Sum256([]byte(secret))
	run(t, s, database.ModeIdentity, func(tx *database.Tx) error {
		rows, err := tx.Query(insertSession, digest[:], userID, spec.Fresh)
		if err != nil {
			return err
		}
		inserted, err := pgx.CollectRows(rows, pgx.RowTo[int32])
		if err == nil && len(inserted) != 1 {
			return refusal("the account needs one enabled binding at an enabled provider")
		}
		return err
	})
	return secret
}

// Employee registers the object and inserts the row with the data login; a link to an account is the
// admin write of employee.linkAccount.
func Employee(t testing.TB, s *test.Stack, spec EmployeeSpec) EmployeeRow {
	t.Helper()
	row := EmployeeRow{ID: newUUID(t), Code: spec.Code, FullName: spec.FullName, AccountID: spec.AccountID, HiredOn: spec.HiredOn}
	if row.Code == "" {
		row.Code = "NV-" + row.ID[:8]
	}
	if row.FullName == "" {
		row.FullName = "Fixture " + row.Code
	}
	if row.HiredOn == "" {
		row.HiredOn = defaultHiredOn
	}
	run(t, s, database.ModeWrite, func(tx *database.Tx) error {
		rows, err := tx.Query(registerObject, "employee", row.ID)
		if err != nil {
			return err
		}
		if row.ObjectID, err = pgx.CollectExactlyOneRow(rows, pgx.RowTo[string]); err != nil {
			return err
		}
		_, err = tx.Exec(insertEmployee, row.ID, row.ObjectID, row.Code, row.FullName, row.HiredOn, nil, nil)
		return err
	})
	if row.AccountID != "" {
		run(t, s, database.ModeAdmin, func(tx *database.Tx) error {
			_, err := tx.Exec(linkAccount, row.ID, row.AccountID)
			return err
		})
	}
	return row
}

// Root runs `hrmctl bootstrap`, then writes what a completed activation leaves with the
// identity login: enrollment gone, binding, proofs consumed, active with a verified email and a new epoch.
func Root(t testing.TB, s *test.Stack) RootRow {
	t.Helper()
	row := RootRow{Email: rootEmail, OperationID: newUUID(t), Subject: rootSubject}
	output, err := s.Hrmctl(t.Context(), "bootstrap",
		"--operation", row.OperationID, "--issuer", test.FixtureIssuer, "--email", row.Email,
		"--activation-file", filepath.Join(t.TempDir(), "activation"))
	if err != nil {
		t.Fatalf("bootstrap: %T\n%s", err, output)
	}
	match := rootCommitted.FindStringSubmatch(output)
	if match == nil {
		t.Fatalf("bootstrap did not commit a Root:\n%s", output)
	}
	row.ID = match[1]
	run(t, s, database.ModeIdentity, func(tx *database.Tx) error {
		for _, step := range []struct {
			sql  string
			args []any
		}{
			{dropEnrollment, []any{row.ID}},
			{insertBinding, []any{test.FixtureIssuer, row.Subject, row.ID}},
			{consumeTokens, []any{row.ID}},
			{activateRoot, []any{row.ID}},
		} {
			tag, err := tx.Exec(step.sql, step.args...)
			if err != nil {
				return err
			}
			if step.sql == activateRoot && tag.RowsAffected() != 1 {
				return refusal("the Root was not pending")
			}
		}
		return nil
	})
	return row
}
