//go:build integration

package authentication_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

const (
	sessionUser = `(SELECT user_id FROM application_session WHERE token_hash=$1)`
	agedSession = `UPDATE application_session SET last_seen_at=statement_timestamp()-interval '10 minutes' WHERE token_hash=$1`
	isAged      = `SELECT last_seen_at<statement_timestamp()-interval '5 minutes' FROM application_session WHERE token_hash=$1`
	countEvents = `SELECT count(*)::int FROM audit_outbox WHERE event_kind=$1 AND actor_id=$2`
)

func superuser(t *testing.T, s *test.Stack) *pgx.Conn {
	t.Helper()
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	})
	return conn
}

func exec(t *testing.T, conn *pgx.Conn, sql string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(test.Redact(err))
	}
}

func queryOne[T any](t *testing.T, conn *pgx.Conn, sql string, args ...any) T {
	t.Helper()
	var value T
	if err := conn.QueryRow(t.Context(), sql, args...).Scan(&value); err != nil {
		t.Fatal(test.Redact(err))
	}
	return value
}

func digestOf(t *testing.T, secret string) []byte {
	t.Helper()
	digest, err := credential.SessionDigest(secret)
	if err != nil {
		t.Fatal(err)
	}
	return digest
}

func resolve(t *testing.T, s *test.Stack, mode database.Mode, secret string) (authentication.SessionIdentity, error) {
	t.Helper()
	return database.Run(t.Context(), s.Runner, mode, func(_ context.Context, tx *database.Tx) (authentication.SessionIdentity, error) {
		return authentication.Authenticate(tx, digestOf(t, secret))
	}, database.RunOptions{})
}

func refused(err error) bool { return errors.Is(err, apperror.ErrAuthenticationFailed) }

func TestAuthenticateResolvesALiveSession(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	account := fixture.Account(t, s, fixture.AccountSpec{Email: "kim@example.test"})
	for _, fresh := range []bool{false, true} {
		secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{Fresh: fresh})
		got, err := resolve(t, s, database.ModeRead, secret)
		if err != nil {
			t.Fatalf("fresh %v: %s", fresh, test.Redact(err))
		}
		epoch := queryOne[string](t, conn, `SELECT auth_epoch::text FROM app_user WHERE id=$1`, account.ID)
		if got.UserID != account.ID || got.Kind != "iam" || got.AuthEpoch != epoch || got.Method != "oidc" ||
			got.Assurance != "oidc" || got.Fresh != fresh {
			t.Errorf("fresh %v: %+v", fresh, got)
		}
	}
}

func TestAuthenticateTouchesActivityOnlyInIdentityAndRevoke(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	account := fixture.Account(t, s, fixture.AccountSpec{})
	secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	digest := digestOf(t, secret)
	for mode, touches := range map[database.Mode]bool{
		database.ModeRead: false, database.ModeWrite: false, database.ModeIdentity: true, database.ModeRevoke: true,
	} {
		exec(t, conn, agedSession, digest)
		if _, err := resolve(t, s, mode, secret); err != nil {
			t.Fatalf("%s: %s", mode, test.Redact(err))
		}
		if aged := queryOne[bool](t, conn, isAged, digest); aged == touches {
			t.Errorf("%s: still aged %v", mode, aged)
		}
	}
}

func TestAuthenticateRefusesADeadSession(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	for name, kill := range map[string]string{
		"expired":   `UPDATE application_session SET created_at=statement_timestamp()-interval '2 hours',expires_at=statement_timestamp()-interval '1 second' WHERE token_hash=$1`,
		"revoked":   `UPDATE application_session SET revoked_at=statement_timestamp() WHERE token_hash=$1`,
		"idle":      `UPDATE application_session SET last_seen_at=statement_timestamp()-interval '31 minutes' WHERE token_hash=$1`,
		"new epoch": `UPDATE app_user SET auth_epoch=auth_epoch+1 WHERE id=` + sessionUser,
		"suspended": `UPDATE app_user SET state='suspended' WHERE id=` + sessionUser,
		"unbound":   `UPDATE external_identity SET enabled=false WHERE user_id=` + sessionUser,
	} {
		account := fixture.Account(t, s, fixture.AccountSpec{})
		secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
		if _, err := resolve(t, s, database.ModeRead, secret); err != nil {
			t.Fatalf("%s before: %s", name, test.Redact(err))
		}
		exec(t, conn, kill, digestOf(t, secret))
		for _, mode := range []database.Mode{database.ModeRead, database.ModeIdentity} {
			if _, err := resolve(t, s, mode, secret); !refused(err) {
				t.Errorf("%s in %s: %v", name, mode, err)
			}
		}
	}
	if _, err := resolve(t, s, database.ModeRead, credential.NewSessionSecret()); !refused(err) {
		t.Errorf("unknown secret: %v", err)
	}
}

func TestRootKindComesFromTheVerifiedSession(t *testing.T) {
	s := test.NewDatabase(t)
	root := fixture.Root(t, s)
	got, err := resolve(t, s, database.ModeRead, fixture.Session(t, s, root.ID, fixture.SessionSpec{}))
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if got.UserID != root.ID || got.Kind != "root" {
		t.Errorf("%+v", got)
	}
}

func TestLogoutEndsOneSessionAndLogoutAllEndsEveryOneOfTheAccount(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	service := authentication.NewService(s.Runner)
	account := fixture.Account(t, s, fixture.AccountSpec{})
	other := fixture.Account(t, s, fixture.AccountSpec{})
	first := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	second := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	third := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	foreign := fixture.Session(t, s, other.ID, fixture.SessionSpec{})
	events := func(kind string) int32 { return queryOne[int32](t, conn, countEvents, []byte(kind), account.ID) }

	if err := service.Logout(t.Context(), first, false); err != nil {
		t.Fatal(test.Redact(err))
	}
	if _, err := resolve(t, s, database.ModeRead, first); !refused(err) {
		t.Errorf("first after logout: %v", err)
	}
	if _, err := resolve(t, s, database.ModeRead, second); err != nil {
		t.Errorf("second after logout of first: %s", test.Redact(err))
	}
	if n := events("identity.logout"); n != 1 {
		t.Errorf("%d logout events", n)
	}

	if err := service.Logout(t.Context(), second, true); err != nil {
		t.Fatal(test.Redact(err))
	}
	for name, secret := range map[string]string{"second": second, "third": third} {
		if _, err := resolve(t, s, database.ModeRead, secret); !refused(err) {
			t.Errorf("%s after logout-all: %v", name, err)
		}
	}
	if _, err := resolve(t, s, database.ModeRead, foreign); err != nil {
		t.Errorf("another account after logout-all: %s", test.Redact(err))
	}
	if n := events("identity.logout-all"); n != 1 {
		t.Errorf("%d logout-all events", n)
	}

	for _, secret := range []string{first, third, "", "not-a-session"} {
		if err := service.Logout(t.Context(), secret, false); !refused(err) {
			t.Errorf("logout of a dead session: %v", err)
		}
	}
	if n := events("identity.logout"); n != 1 {
		t.Errorf("%d logout events after dead logouts", n)
	}
}

func TestOwnAccountListsTheEmailAndTheEnabledBinding(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	service := authentication.NewService(s.Runner)
	for _, email := range []string{"own@example.test", ""} {
		account := fixture.Account(t, s, fixture.AccountSpec{Email: email})
		reference := queryOne[string](t, conn, `SELECT binding_ref::text FROM external_identity WHERE user_id=$1`, account.ID)
		got, err := service.OwnAccount(t.Context(), fixture.Session(t, s, account.ID, fixture.SessionSpec{}))
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		emailMatches := (email == "" && got.Email == nil) || (got.Email != nil && *got.Email == email)
		want := authentication.Identity{Issuer: test.FixtureIssuer, Reference: reference}
		if !emailMatches || len(got.Identities) != 1 || got.Identities[0] != want {
			t.Errorf("email %q: %+v", email, got)
		}
	}
	if _, err := service.OwnAccount(t.Context(), credential.NewSessionSecret()); !refused(err) {
		t.Errorf("unknown session: %v", err)
	}
}

func TestHasConfirmedSecondFactorOnlyCountsAConfirmedOne(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	account := fixture.Account(t, s, fixture.AccountSpec{})
	confirmed := func() bool {
		got, err := database.Run(t.Context(), s.Runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (bool, error) {
			return authentication.HasConfirmedSecondFactor(tx, account.ID)
		}, database.RunOptions{})
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		return got
	}
	if confirmed() {
		t.Error("no factor")
	}
	exec(t, conn, `INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id) VALUES($1,$2,$3,'k1')`,
		account.ID, make([]byte, 36), make([]byte, 12))
	if confirmed() {
		t.Error("unconfirmed factor")
	}
	exec(t, conn, `UPDATE mfa_totp SET confirmed_at=statement_timestamp() WHERE user_id=$1`, account.ID)
	if !confirmed() {
		t.Error("confirmed factor")
	}
}
