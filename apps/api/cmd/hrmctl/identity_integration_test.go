//go:build integration

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/audit"
	"hrm/api/internal/database"
	"hrm/api/internal/offline"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

const (
	enrolledUser = "6a3c1f0e-2b4d-4e8f-9a1b-2c3d4e5f6a7b"
	otherUser    = "7b4d2f1e-3c5e-4f9a-8b2c-3d4e5f6a7b8c"
	operation    = "8c5e3f2e-4d6f-4a0b-9c3d-4e5f6a7b8c9d"

	revisionNow  = `SELECT revision::text FROM authz_state WHERE singleton`
	offlineKinds = `SELECT count(*)::int FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to($2,'UTF8')`
	anyAddress   = `SELECT count(*)::int FROM audit_outbox o WHERE position('@' in o::text)>0`
	addFactor    = `INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id) VALUES($1,decode(repeat('ab',36),'hex'),decode(repeat('ab',12),'hex'),'k1')`
	confirm      = `UPDATE mfa_totp SET confirmed_at=statement_timestamp() WHERE user_id=$1`
	addCode      = `INSERT INTO mfa_recovery_code(user_id,code_hash) VALUES($1,decode(repeat('ab',32),'hex'))`
	factorRows   = `SELECT (SELECT count(*) FROM mfa_totp WHERE user_id=$1)::int+(SELECT count(*) FROM mfa_recovery_code WHERE user_id=$1)::int`
	epochOf      = `SELECT auth_epoch::text FROM app_user WHERE id=$1`
)

type commandWorld struct {
	t    *testing.T
	s    *test.Stack
	conn *pgx.Conn
}

func newCommandWorld(t *testing.T) *commandWorld {
	t.Helper()
	s := test.NewDatabase(t)
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	})
	return &commandWorld{t: t, s: s, conn: conn}
}

// command runs hrmctl with only the URL of the login the command is documented to use.
func (w *commandWorld) command(login string, args ...string) (string, error) {
	env := map[string]string{"NODE_ENV": "test", "PGSSLMODE": "disable",
		"PRODUCT_" + strings.ToUpper(login) + "_DATABASE_URL": w.s.LoginURL(login)}
	var out bytes.Buffer
	err := run(w.t.Context(), args, func(name string) string { return env[name] }, &out)
	if err != nil && (strings.Contains(failureLine(err), "@") || strings.Contains(failureLine(err), "DATABASE_URL")) {
		w.t.Errorf("failure line holds an address or a variable: %q", failureLine(err))
	}
	if strings.Contains(out.String(), "@") {
		w.t.Errorf("stdout holds an address: %q", out.String())
	}
	return out.String(), err
}

func (w *commandWorld) text(sql string, args ...any) string {
	w.t.Helper()
	var value string
	if err := w.conn.QueryRow(w.t.Context(), sql, args...).Scan(&value); err != nil {
		w.t.Fatal(test.Redact(err))
	}
	return value
}

func (w *commandWorld) count(sql string, args ...any) int32 {
	w.t.Helper()
	var n int32
	if err := w.conn.QueryRow(w.t.Context(), sql, args...).Scan(&n); err != nil {
		w.t.Fatal(test.Redact(err))
	}
	return n
}

func digestOf(secret string) []byte {
	digest := sha256.Sum256([]byte(secret))
	return digest[:]
}

func (w *commandWorld) exec(sql string, args ...any) {
	w.t.Helper()
	if _, err := w.conn.Exec(w.t.Context(), sql, args...); err != nil {
		w.t.Fatal(test.Redact(err))
	}
}

func TestEnrollCommitsAPendingAccountItsRoleAndTwoOfflineEvents(t *testing.T) {
	w := newCommandWorld(t)
	before := w.text(revisionNow)
	enroll := func(user, email, role string, extra ...string) (string, error) {
		args := append([]string{"enroll", "--", "--user", user, "--email", email, "--issuer", test.FixtureIssuer, "--role", role}, extra...)
		return w.command("authority", args...)
	}

	if _, err := enroll(otherUser, "absent@example.test", "hr.no_such_role"); !errors.Is(err, offline.ErrUnknownRole) {
		t.Fatalf("absent role: %v", err)
	}
	if _, err := enroll(otherUser, "flag@example.test", "hr.employee", "--subject", "sub-1"); err == nil {
		t.Fatal("an unexpected flag was accepted")
	}
	if n := w.count(`SELECT count(*)::int FROM app_user WHERE id=$1`, otherUser); n != 0 || w.text(revisionNow) != before {
		t.Fatalf("a refused enrollment wrote: %d accounts", n)
	}

	out, err := enroll(enrolledUser, "New.Person@Example.test", "hr.employee")
	if err != nil {
		t.Fatal(failureLine(err))
	}
	if out != "Pending account enrolled for its first verified Google login within 7 days.\n" {
		t.Errorf("stdout %q", out)
	}
	if got := w.text(`SELECT kind||' '||state||' '||email_canonical FROM app_user WHERE id=$1`, enrolledUser); got != "iam pending new.person@example.test" {
		t.Errorf("account %q", got)
	}
	if w.count(`SELECT count(*)::int FROM oidc_email_enrollment WHERE user_id=$1 AND issuer=$2 AND created_by=$3`, enrolledUser, test.FixtureIssuer, audit.OfflineActor) != 1 ||
		w.count(`SELECT count(*)::int FROM user_role WHERE user_id=$1 AND role_key=convert_to('hr.employee','UTF8')`, enrolledUser) != 1 {
		t.Error("no pinned enrollment or first role")
	}
	if after := w.text(`SELECT (revision-1)::text FROM authz_state WHERE singleton`); after != before {
		t.Errorf("revision %s, want one past %s", after, before)
	}
	after := w.text(revisionNow)
	for kind, metadata := range map[audit.Kind]string{
		audit.KindIdentityEnroll: `{"method":"oidc","targetUserId":"` + enrolledUser + `","resultingRevision":"` + after + `"}`,
		audit.KindPermissionRoleAssign: `{"targetUserId":"` + enrolledUser + `","resultingRevision":"` + after +
			`","resource":"account","keyKind":"uuid","key":"` + enrolledUser + `","roleKey":"hr.employee"}`,
	} {
		if w.count(offlineKinds+` AND policy_revision::text=$3 AND safe_metadata=$4::jsonb`, audit.OfflineActor, string(kind), before, metadata) != 1 {
			t.Errorf("no offline %s event %s", kind, metadata)
		}
	}
	if _, err := enroll(otherUser, "new.person@example.test", "hr.employee"); !strings.Contains(failureLine(err), "23505") {
		t.Errorf("a taken email: %v", failureLine(err))
	}
	if _, err := w.command("authority", "enroll", "--user", otherUser, "--email", "other@example.test", "--issuer", "https://x.example.test", "--role", "hr.employee"); !strings.Contains(failureLine(err), "22023") {
		t.Errorf("an unknown issuer: %v", failureLine(err))
	}
	if n := w.count(`SELECT count(*)::int FROM app_user`); n != 1 {
		t.Errorf("%d accounts, want only the enrolled one", n)
	}
	if w.count(anyAddress) != 0 {
		t.Error("an audit row holds an address")
	}
}

func TestPurgeSessionsDeletesOnlyExpiredSessions(t *testing.T) {
	w := newCommandWorld(t)
	account := fixture.Account(t, w.s, fixture.AccountSpec{})
	expired := digestOf(fixture.Session(t, w.s, account.ID, fixture.SessionSpec{}))
	live := digestOf(fixture.Session(t, w.s, account.ID, fixture.SessionSpec{}))
	w.exec(`UPDATE application_session SET created_at=statement_timestamp()-interval '3 days',
      expires_at=statement_timestamp()-interval '2 days' WHERE token_hash=$1`, expired)

	if _, err := w.command("identity", "purge-sessions"); err == nil {
		t.Fatal("a purge without retention ran")
	}
	for _, want := range []string{"Purged 1 expired sessions.\n", "Purged 0 expired sessions.\n"} {
		out, err := w.command("identity", "purge-sessions", "--retention-days", "1")
		if err != nil || out != want {
			t.Fatalf("got %q, %v, want %q", out, err, want)
		}
	}
	if w.count(`SELECT count(*)::int FROM application_session WHERE token_hash=$1`, live) != 1 ||
		w.count(`SELECT count(*)::int FROM application_session WHERE token_hash=$1`, expired) != 0 {
		t.Error("the purge did not keep exactly the live session")
	}
	if w.count(offlineKinds, audit.OfflineActor, string(audit.KindSessionPurge)) != 1 {
		t.Error("not one offline purge event")
	}
}

func TestEachResetCommandResetsOnlyItsKindOfAccount(t *testing.T) {
	w := newCommandWorld(t)
	member := fixture.Account(t, w.s, fixture.AccountSpec{Email: "member@example.test"}).ID
	root := fixture.Root(t, w.s).ID
	// The identity login writes factors at runtime; the Root lifecycle guard refuses any other writer.
	for _, user := range []string{member, root} {
		_, err := database.Run(t.Context(), w.s.Runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (struct{}, error) {
			for _, step := range []string{addFactor, confirm, addCode} {
				if _, err := tx.Exec(step, user); err != nil {
					return struct{}{}, err
				}
			}
			return struct{}{}, nil
		}, database.RunOptions{})
		if err != nil {
			t.Fatal(test.Redact(err))
		}
	}
	reset := func(command, login, user string) (string, error) {
		return w.command(login, command, "--user", user, "--operation", operation, "--approval", "ticket-17", "--reason", "lost the device")
	}

	for _, tc := range []struct {
		command, login, user string
		refusal              error
	}{
		{"reset-mfa", "identity", root, offline.ErrNotIAMAccount},
		{"reset-root-mfa", "bootstrap", member, offline.ErrNotRootAccount},
		{"reset-mfa", "identity", otherUser, offline.ErrNotIAMAccount},
	} {
		if _, err := reset(tc.command, tc.login, tc.user); !errors.Is(err, tc.refusal) {
			t.Errorf("%s on the wrong account: %v", tc.command, err)
		}
	}
	if w.count(factorRows, member) != 2 || w.count(factorRows, root) != 2 || w.count(offlineKinds, audit.OfflineActor, string(audit.KindIdentityMfaReset)) != 0 {
		t.Fatal("a refused reset deleted or audited")
	}

	for i, tc := range []struct{ command, login, user string }{
		{"reset-mfa", "identity", member},
		{"reset-root-mfa", "bootstrap", root},
	} {
		epoch := w.text(epochOf, tc.user)
		out, err := reset(tc.command, tc.login, tc.user)
		if err != nil || out != "Second factor and recovery codes removed; the account sessions ended.\n" {
			t.Fatalf("%s: %q, %v", tc.command, out, err)
		}
		if w.count(factorRows, tc.user) != 0 || w.text(epochOf, tc.user) == epoch {
			t.Errorf("%s: factor left or epoch kept", tc.command)
		}
		if w.count(offlineKinds, audit.OfflineActor, string(audit.KindIdentityMfaReset)) != int32(i+1) ||
			w.count(`SELECT count(*)::int FROM audit_outbox WHERE reason='lost the device' AND safe_metadata->>'targetUserId'=$1
        AND safe_metadata->>'approval'='ticket-17' AND safe_metadata->>'operationId'=$2`, tc.user, operation) != 1 {
			t.Errorf("%s: no offline event with approval and reason", tc.command)
		}
		if out, err := reset(tc.command, tc.login, tc.user); err != nil || out != "No second factor; nothing changed.\n" {
			t.Errorf("%s again: %q, %v", tc.command, out, err)
		}
	}
	if w.count(anyAddress) != 0 {
		t.Error("an audit row holds an address")
	}
}
