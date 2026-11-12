package audit_test

import (
	"errors"
	"testing"

	"hrm/api/internal/audit"
	"hrm/api/internal/database"
)

const actor = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

func TestAppendRefusesAnEventOutsideTheContractBeforeWriting(t *testing.T) {
	identity := &database.Tx{Mode: database.ModeIdentity, Revision: "7"}
	for name, c := range map[string]struct {
		tx    *database.Tx
		event audit.Event
	}{
		"unknown kind":          {identity, audit.Event{Kind: "identity.login", Actor: actor}},
		"empty kind":            {identity, audit.Event{Actor: actor}},
		"access kind":           {identity, audit.Event{Kind: "access.employee.read", Actor: actor}},
		"no actor":              {identity, audit.Event{Kind: audit.KindLogout}},
		"purge detail on login": {identity, audit.Event{Kind: audit.KindOIDCLogin, Actor: actor, Purge: &audit.SessionPurge{Deleted: 1}}},
		"purge without detail":  {identity, audit.Event{Kind: audit.KindSessionPurge, Actor: audit.OfflineActor}},
		"purge of nothing":      {identity, audit.Event{Kind: audit.KindSessionPurge, Actor: audit.OfflineActor, Purge: &audit.SessionPurge{}}},
		"negative retention":    {identity, audit.Event{Kind: audit.KindSessionPurge, Actor: audit.OfflineActor, Purge: &audit.SessionPurge{Deleted: 1, RetentionDays: -1}}},
		"retention over 3650":   {identity, audit.Event{Kind: audit.KindSessionPurge, Actor: audit.OfflineActor, Purge: &audit.SessionPurge{Deleted: 1, RetentionDays: 3651}}},
		"read mode":             {&database.Tx{Mode: database.ModeRead, Revision: "7"}, audit.Event{Kind: audit.KindLogout, Actor: actor}},
		"sync mode":             {&database.Tx{Mode: database.ModeSync, Revision: "7"}, audit.Event{Kind: audit.KindLogout, Actor: actor}},
		"unknown mode":          {&database.Tx{Mode: "other", Revision: "7"}, audit.Event{Kind: audit.KindLogout, Actor: actor}},
		"revision not a number": {&database.Tx{Mode: database.ModeRevoke, Revision: "7a"}, audit.Event{Kind: audit.KindLogout, Actor: actor}},
		"empty revision":        {&database.Tx{Mode: database.ModeIdentity}, audit.Event{Kind: audit.KindLogout, Actor: actor}},
		"last revision bumped":  {&database.Tx{Mode: database.ModeRevoke, Revision: "9223372036854775807"}, audit.Event{Kind: audit.KindLogout, Actor: actor}},
	} {
		if err := audit.Append(c.tx, c.event); !errors.Is(err, audit.ErrInvalidEvent) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestIdentityKindsAreTheContractSpelling(t *testing.T) {
	want := []string{
		"identity.logout", "identity.logout-all", "identity.oidc-activation", "identity.oidc-login",
		"identity.email-verify", "identity.mfa-setup", "identity.mfa-enroll", "identity.mfa-verify",
		"identity.mfa-recovery", "identity.mfa-recovery-regenerate", "identity.mfa-remove",
		"identity.mfa-verify-failed", "identity.mfa-lockout",
	}
	got := []audit.Kind{
		audit.KindLogout, audit.KindLogoutAll, audit.KindOIDCActivation, audit.KindOIDCLogin,
		audit.KindEmailVerify, audit.KindMFASetup, audit.KindMFAEnroll, audit.KindMFAVerify,
		audit.KindMFARecovery, audit.KindMFARecoveryRegenerate, audit.KindMFARemove,
		audit.KindMFAVerifyFailed, audit.KindMFALockout,
	}
	for i := range want {
		if string(got[i]) != want[i] {
			t.Errorf("%d: %q, want %q", i, got[i], want[i])
		}
	}
	if audit.KindSessionPurge != "identity.session-purge" || audit.OfflineActor != "00000000-0000-4000-8000-000000000001" {
		t.Error("offline purge spelling")
	}
}
