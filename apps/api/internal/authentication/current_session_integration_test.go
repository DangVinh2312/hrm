//go:build integration

package authentication_test

import (
	"errors"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authentication"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

func TestCurrentSessionResolvesIdentityAndTouchesActivity(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	service := authentication.NewService(s.Runner)
	account := fixture.Account(t, s, fixture.AccountSpec{})
	secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{Fresh: true})
	digest := digestOf(t, secret)
	exec(t, conn, agedSession, digest)
	got, err := service.CurrentSession(t.Context(), secret)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if got.UserID != account.ID || got.Method != "oidc" || got.Assurance != "oidc" || got.Kind != "iam" || !got.Fresh {
		t.Errorf("unexpected session identity: %+v", got)
	}
	if queryOne[bool](t, conn, isAged, digest) {
		t.Error("session activity was not touched")
	}
	root := fixture.Root(t, s)
	got, err = service.CurrentSession(t.Context(), fixture.Session(t, s, root.ID, fixture.SessionSpec{}))
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if got.UserID != root.ID || got.Kind != "root" {
		t.Errorf("unexpected Root identity: %+v", got)
	}
}

func TestCurrentSessionRefusesDeadSessions(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	service := authentication.NewService(s.Runner)
	for _, state := range []string{"expired", "logout", "suspended"} {
		t.Run(state, func(t *testing.T) {
			account := fixture.Account(t, s, fixture.AccountSpec{})
			secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
			if _, err := service.CurrentSession(t.Context(), secret); err != nil {
				t.Fatal(test.Redact(err))
			}
			switch state {
			case "expired":
				exec(t, conn, `UPDATE application_session SET created_at=statement_timestamp()-interval '2 hours',expires_at=statement_timestamp()-interval '1 second' WHERE token_hash=$1`, digestOf(t, secret))
			case "logout":
				if err := service.Logout(t.Context(), secret, false); err != nil {
					t.Fatal(test.Redact(err))
				}
			case "suspended":
				exec(t, conn, `UPDATE app_user SET state='suspended' WHERE id=$1`, account.ID)
			}
			if _, err := service.CurrentSession(t.Context(), secret); !errors.Is(err, apperror.ErrAuthenticationFailed) {
				t.Errorf("got %v", err)
			}
		})
	}
	for _, secret := range []string{"", "invalid", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"} {
		if _, err := service.CurrentSession(t.Context(), secret); !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("unknown credential: %v", err)
		}
	}
}
