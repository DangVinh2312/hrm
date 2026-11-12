//go:build integration

package authentication_test

import (
	"context"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authentication"
	"hrm/api/internal/authentication/credential"
	"hrm/api/internal/config"
	"hrm/api/internal/database"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

const (
	mfaClient     = "203.0.113.7"
	currentStep   = `SELECT floor(extract(epoch FROM statement_timestamp())/30)::bigint::text`
	failedOf      = `SELECT failed_attempts::int FROM mfa_totp WHERE user_id=$1`
	keyIDOf       = `SELECT key_id FROM mfa_totp WHERE user_id=$1`
	remainingOf   = `SELECT count(*)::int FROM mfa_recovery_code WHERE user_id=$1 AND used_at IS NULL`
	agedSetup     = `UPDATE mfa_totp SET created_at=statement_timestamp()-interval '16 minutes' WHERE user_id=$1`
	unrevokedOf   = `SELECT count(*)::int FROM application_session WHERE user_id=$1 AND revoked_at IS NULL`
	wrongCodeText = "12345"

	factorUnconfirmed = `SELECT confirmed_at IS NULL FROM mfa_totp WHERE user_id=$1`
	resealFactor      = `UPDATE mfa_totp SET nonce=decode(repeat('ab',12),'hex') WHERE user_id=$1`
	lastUsedOf        = `SELECT last_used_step::text FROM mfa_totp WHERE user_id=$1`
	holdFactor        = `SELECT 1 FROM mfa_totp WHERE user_id=$1 FOR UPDATE`
)

// keyRing holds fixed fake keys: id kN is 32 bytes of N.
func keyRing(t *testing.T, current string, ids ...string) config.MfaKeyRing {
	t.Helper()
	entries := make([]string, 0, len(ids))
	for _, id := range ids {
		n, err := strconv.Atoi(strings.TrimPrefix(id, "k"))
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, id+":"+base64.StdEncoding.EncodeToString([]byte(strings.Repeat(string(rune(n)), 32))))
	}
	ring, err := config.ParseMfaKeyRing(strings.Join(entries, ","), current)
	if err != nil {
		t.Fatal(err)
	}
	return ring
}

func codeAt(t *testing.T, secret string, step uint64) string {
	t.Helper()
	raw, err := credential.Base32Decode(secret)
	if err != nil {
		t.Fatal(err)
	}
	return credential.HOTP(raw, step)
}

func stepNow(t *testing.T, conn *pgx.Conn) uint64 {
	t.Helper()
	step, err := strconv.ParseUint(queryOne[string](t, conn, currentStep), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return step
}

func fresh(t *testing.T, s *test.Stack, secret string) bool {
	t.Helper()
	identity, err := resolve(t, s, database.ModeRead, secret)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	return identity.Fresh
}

func mfaOf(t *testing.T, service *authentication.Service, secret string) authentication.MfaStatus {
	t.Helper()
	account, err := service.OwnAccount(t.Context(), secret)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	return account.Mfa
}

// enrolled sets up and confirms a factor; it answers the TOTP secret and the confirmation.
func enrolled(t *testing.T, s *test.Stack, mfa *authentication.MfaService, userID string) (string, authentication.MfaConfirmation, uint64) {
	t.Helper()
	setup, err := mfa.Setup(t.Context(), fixture.Session(t, s, userID, fixture.SessionSpec{}), mfaClient)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	step := stepNow(t, superuser(t, s))
	confirmation, err := mfa.Confirm(t.Context(), fixture.Session(t, s, userID, fixture.SessionSpec{}), codeAt(t, setup.Secret, step), mfaClient)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	return setup.Secret, confirmation, step
}

func TestSetupConfirmVerifyRecoveryAndRemove(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	service := authentication.NewService(s.Runner)
	mfa := authentication.NewMfaService(service, keyRing(t, "k1", "k1"))
	account := fixture.Account(t, s, fixture.AccountSpec{Email: "mfa@example.test"})
	events := func(kind string) int32 { return queryOne[int32](t, conn, countEvents, []byte(kind), account.ID) }
	secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	if got := mfaOf(t, service, secret); got != (authentication.MfaStatus{Status: "none"}) {
		t.Errorf("before setup: %+v", got)
	}
	setup, err := mfa.Setup(t.Context(), secret, mfaClient)
	if err != nil || !strings.HasPrefix(setup.URI, "otpauth://totp/") || !strings.Contains(setup.URI, "secret="+setup.Secret) || len(setup.Secret) != 32 {
		t.Fatalf("setup: %v", test.Redact(err))
	}
	if got := mfaOf(t, service, secret); got != (authentication.MfaStatus{Status: "pending"}) {
		t.Errorf("after setup: %+v", got)
	}
	step := stepNow(t, conn)
	if _, err := mfa.Confirm(t.Context(), secret, codeAt(t, setup.Secret, step-10), mfaClient); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("wrong code at confirmation: %v", err)
	}
	if n := queryOne[int32](t, conn, failedOf, account.ID); n != 0 {
		t.Errorf("a wrong code at confirmation is not counted: %d", n)
	}
	confirmation, err := mfa.Confirm(t.Context(), secret, codeAt(t, setup.Secret, step), mfaClient)
	if err != nil || len(confirmation.RecoveryCodes) != 10 {
		t.Fatalf("confirm: %v", test.Redact(err))
	}
	if _, err := resolve(t, s, database.ModeRead, secret); !refused(err) {
		t.Errorf("the session before the factor: %v", err)
	}
	current := confirmation.Session.Secret
	if !fresh(t, s, current) || mfaOf(t, service, current) != (authentication.MfaStatus{Status: "enabled", RecoveryCodesRemaining: 10}) {
		t.Errorf("after confirm: %+v", mfaOf(t, service, current))
	}
	if _, err := mfa.Setup(t.Context(), current, mfaClient); !errors.Is(err, apperror.ErrMfaConflict) {
		t.Errorf("setup over a confirmed factor: %v", err)
	}
	if _, err := mfa.Verify(t.Context(), current, authentication.MfaProof{Code: codeAt(t, setup.Secret, step)}, mfaClient); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("the confirmation code again: %v", err)
	}
	if n := queryOne[int32](t, conn, failedOf, account.ID); n != 1 {
		t.Errorf("a replay is counted: %d", n)
	}
	next, err := mfa.Verify(t.Context(), current, authentication.MfaProof{Code: confirmation.RecoveryCodes[0], Recovery: true}, mfaClient)
	if err != nil {
		t.Fatalf("recovery code: %s", test.Redact(err))
	}
	if _, err := resolve(t, s, database.ModeRead, current); !refused(err) || !fresh(t, s, next.Secret) {
		t.Errorf("the session continues as a fresh copy: %v", err)
	}
	if n := queryOne[int32](t, conn, failedOf, account.ID); n != 0 || queryOne[int32](t, conn, remainingOf, account.ID) != 9 {
		t.Errorf("after recovery: %d failures", n)
	}
	if got := mfaOf(t, service, next.Secret); got != (authentication.MfaStatus{Status: "enabled", RecoveryCodesRemaining: 9}) {
		t.Errorf("the status after a recovery code: %+v", got)
	}
	current = next.Secret
	if _, err := mfa.Verify(t.Context(), current, authentication.MfaProof{Code: confirmation.RecoveryCodes[0], Recovery: true}, mfaClient); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("a recovery code twice: %v", err)
	}
	if next, err = mfa.Verify(t.Context(), current, authentication.MfaProof{Code: codeAt(t, setup.Secret, step+1)}, mfaClient); err != nil {
		t.Fatalf("the next step's code: %s", test.Redact(err))
	}
	current = next.Secret
	codes, err := mfa.RegenerateRecoveryCodes(t.Context(), current, mfaClient)
	if err != nil || len(codes) != 10 || codes[0] == confirmation.RecoveryCodes[0] {
		t.Fatalf("regenerate: %v", test.Redact(err))
	}
	if _, err := mfa.Verify(t.Context(), current, authentication.MfaProof{Code: confirmation.RecoveryCodes[1], Recovery: true}, mfaClient); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("a code of the old set: %v", err)
	}
	stale := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	for name, call := range map[string]func() error{
		"regenerate": func() error { _, err := mfa.RegenerateRecoveryCodes(t.Context(), stale, mfaClient); return err },
		"remove":     func() error { _, err := mfa.Remove(t.Context(), stale, mfaClient); return err },
	} {
		if err := call(); !errors.Is(err, apperror.ErrStepUpRequired) {
			t.Errorf("%s without a step-up: %v", name, err)
		}
	}
	after, err := mfa.Remove(t.Context(), current, mfaClient)
	if err != nil || fresh(t, s, after.Secret) || mfaOf(t, service, after.Secret) != (authentication.MfaStatus{Status: "none"}) {
		t.Fatalf("remove: %v", test.Redact(err))
	}
	if _, err := resolve(t, s, database.ModeRead, stale); !refused(err) {
		t.Errorf("removal ends every other session: %v", err)
	}
	for kind, want := range map[string]int32{
		"identity.mfa-setup": 1, "identity.mfa-enroll": 1, "identity.mfa-verify": 1, "identity.mfa-recovery": 1,
		"identity.mfa-verify-failed": 3, "identity.mfa-recovery-regenerate": 1, "identity.mfa-remove": 1, "identity.mfa-lockout": 0,
	} {
		if n := events(kind); n != want {
			t.Errorf("%s: %d events", kind, n)
		}
	}
}

func TestTheTenthWrongProofInARowEndsEverySession(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	mfa := authentication.NewMfaService(authentication.NewService(s.Runner), keyRing(t, "k1", "k1"))
	account := fixture.Account(t, s, fixture.AccountSpec{})
	_, confirmation, _ := enrolled(t, s, mfa, account.ID)
	other := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	for attempt := 1; attempt <= 10; attempt++ {
		_, err := mfa.Verify(t.Context(), confirmation.Session.Secret, authentication.MfaProof{Code: wrongCodeText}, mfaClient)
		if !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Fatalf("attempt %d: %v", attempt, err)
		}
		_, err = resolve(t, s, database.ModeRead, other)
		if attempt < 10 && err != nil {
			t.Fatalf("attempt %d ended the sessions: %s", attempt, test.Redact(err))
		}
	}
	for name, secret := range map[string]string{"caller": confirmation.Session.Secret, "other": other} {
		if _, err := resolve(t, s, database.ModeRead, secret); !refused(err) {
			t.Errorf("%s after the lockout: %v", name, err)
		}
	}
	if n := queryOne[int32](t, conn, unrevokedOf, account.ID); n != 0 {
		t.Errorf("the epoch trigger ends them, the rows are revoked too: %d left", n)
	}
	events := func(kind string) int32 { return queryOne[int32](t, conn, countEvents, []byte(kind), account.ID) }
	if events("identity.mfa-verify-failed") != 10 || events("identity.mfa-lockout") != 1 {
		t.Errorf("%d failures, %d lockouts", events("identity.mfa-verify-failed"), events("identity.mfa-lockout"))
	}
}

func TestOneCodeStepsUpOnceUnderConcurrency(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	mfa := authentication.NewMfaService(authentication.NewService(s.Runner), keyRing(t, "k1", "k1"))
	account := fixture.Account(t, s, fixture.AccountSpec{})
	secret, _, step := enrolled(t, s, mfa, account.ID)
	code := codeAt(t, secret, step+1)
	sessions := []string{fixture.Session(t, s, account.ID, fixture.SessionSpec{}), fixture.Session(t, s, account.ID, fixture.SessionSpec{})}
	results := make([]error, len(sessions))
	var wait sync.WaitGroup
	for i, session := range sessions {
		wait.Go(func() {
			_, results[i] = mfa.Verify(t.Context(), session, authentication.MfaProof{Code: code}, mfaClient)
		})
	}
	wait.Wait()
	accepted := 0
	for _, err := range results {
		switch {
		case err == nil:
			accepted++
		case !errors.Is(err, apperror.ErrAuthenticationFailed):
			t.Errorf("%s", test.Redact(err))
		}
	}
	if accepted != 1 || queryOne[int32](t, conn, failedOf, account.ID) != 1 {
		t.Errorf("%d accepted", accepted)
	}
}

func TestOneRecoveryCodeStepsUpOnceUnderConcurrency(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	mfa := authentication.NewMfaService(authentication.NewService(s.Runner), keyRing(t, "k1", "k1"))
	account := fixture.Account(t, s, fixture.AccountSpec{})
	_, confirmation, _ := enrolled(t, s, mfa, account.ID)
	proof := authentication.MfaProof{Code: confirmation.RecoveryCodes[0], Recovery: true}
	sessions := []string{fixture.Session(t, s, account.ID, fixture.SessionSpec{}), fixture.Session(t, s, account.ID, fixture.SessionSpec{})}
	results := make([]error, len(sessions))
	var wait sync.WaitGroup
	for i, session := range sessions {
		wait.Go(func() {
			_, results[i] = mfa.Verify(t.Context(), session, proof, mfaClient)
		})
	}
	wait.Wait()
	accepted := 0
	for _, err := range results {
		switch {
		case err == nil:
			accepted++
		case !errors.Is(err, apperror.ErrAuthenticationFailed):
			t.Errorf("%s", test.Redact(err))
		}
	}
	if accepted != 1 || queryOne[int32](t, conn, remainingOf, account.ID) != 9 || queryOne[int32](t, conn, failedOf, account.ID) != 1 {
		t.Errorf("%d accepted, %d codes left", accepted, queryOne[int32](t, conn, remainingOf, account.ID))
	}
}

func TestAStaleSnapshotCannotConfirm(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	mfa := authentication.NewMfaService(authentication.NewService(s.Runner), keyRing(t, "k1", "k1"))
	account := fixture.Account(t, s, fixture.AccountSpec{})
	first, second := fixture.Session(t, s, account.ID, fixture.SessionSpec{}), fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	replaced, err := mfa.Setup(t.Context(), first, mfaClient)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	var current authentication.MfaSetup
	step := stepNow(t, conn)
	_, err = authentication.ConfirmAfter(t.Context(), mfa, first, codeAt(t, replaced.Secret, step), mfaClient, func() {
		var err error
		if current, err = mfa.Setup(t.Context(), second, mfaClient); err != nil {
			t.Error(test.Redact(err))
		}
	})
	if !errors.Is(err, apperror.ErrMfaConflict) {
		t.Errorf("a code of the replaced secret: %v", test.Redact(err))
	}
	if !queryOne[bool](t, conn, factorUnconfirmed, account.ID) || queryOne[int32](t, conn, remainingOf, account.ID) != 0 {
		t.Error("the replaced secret confirmed the factor")
	}
	if _, err := mfa.Confirm(t.Context(), first, codeAt(t, current.Secret, stepNow(t, conn)), mfaClient); err != nil {
		t.Errorf("the new secret: %s", test.Redact(err))
	}
}

func TestACodeMatchedBeforeTheRowChangedIsAConflictAndNotCounted(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	mfa := authentication.NewMfaService(authentication.NewService(s.Runner), keyRing(t, "k1", "k1"))
	account := fixture.Account(t, s, fixture.AccountSpec{})
	secret, confirmation, step := enrolled(t, s, mfa, account.ID)
	_, err := authentication.VerifyCodeAfter(t.Context(), mfa, confirmation.Session.Secret, codeAt(t, secret, step+1), mfaClient, func() {
		exec(t, conn, resealFactor, account.ID)
	})
	if !errors.Is(err, apperror.ErrMfaConflict) {
		t.Errorf("%v", test.Redact(err))
	}
	if n := queryOne[int32](t, conn, failedOf, account.ID); n != 0 {
		t.Errorf("a conflict is not counted: %d", n)
	}
	if used := queryOne[string](t, conn, lastUsedOf, account.ID); used != strconv.FormatUint(step, 10) {
		t.Errorf("the code was used: %s", used)
	}
	if n := queryOne[int32](t, conn, countEvents, []byte("identity.mfa-verify"), account.ID); n != 0 {
		t.Errorf("%d verify events", n)
	}
}

func TestTheSnapshotOfTheFactorTakesNoLock(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	mfa := authentication.NewMfaService(authentication.NewService(s.Runner), keyRing(t, "k1", "k1"))
	account := fixture.Account(t, s, fixture.AccountSpec{})
	secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	if _, err := mfa.Setup(t.Context(), secret, mfaClient); err != nil {
		t.Fatal(test.Redact(err))
	}
	holder, err := conn.Begin(t.Context())
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := holder.Rollback(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := holder.Exec(t.Context(), holdFactor, account.ID); err != nil {
		t.Fatal(test.Redact(err))
	}
	if err := authentication.PrepareMfa(t.Context(), mfa, secret, mfaClient); err != nil {
		t.Errorf("a held factor row: %v", test.Redact(err))
	}
}

func TestASetupSealedBeforeARotationIsResealedAndKeysAreCovered(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	service := authentication.NewService(s.Runner)
	old := authentication.NewMfaService(service, keyRing(t, "k1", "k1"))
	rotated := authentication.NewMfaService(service, keyRing(t, "k2", "k1", "k2"))
	onlyNew := authentication.NewMfaService(service, keyRing(t, "k2", "k2"))
	account := fixture.Account(t, s, fixture.AccountSpec{})
	setup, err := old.Setup(t.Context(), fixture.Session(t, s, account.ID, fixture.SessionSpec{}), mfaClient)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if err := onlyNew.VerifyKeyCoverage(t.Context()); !errors.Is(err, authentication.ErrKeyCoverage) {
		t.Errorf("a ring without k1: %v", err)
	}
	if err := rotated.VerifyKeyCoverage(t.Context()); err != nil {
		t.Errorf("a ring with k1: %s", test.Redact(err))
	}
	step := stepNow(t, conn)
	confirmation, err := rotated.Confirm(t.Context(), fixture.Session(t, s, account.ID, fixture.SessionSpec{}), codeAt(t, setup.Secret, step), mfaClient)
	if err != nil || queryOne[string](t, conn, keyIDOf, account.ID) != "k2" {
		t.Fatalf("confirm after rotation: %v", test.Redact(err))
	}
	if err := onlyNew.VerifyKeyCoverage(t.Context()); err != nil {
		t.Errorf("resealed under k2: %s", test.Redact(err))
	}
	if _, err := onlyNew.Verify(t.Context(), confirmation.Session.Secret, authentication.MfaProof{Code: codeAt(t, setup.Secret, step+1)}, mfaClient); err != nil {
		t.Errorf("opened with k2 alone: %s", test.Redact(err))
	}
	if _, err := old.Verify(t.Context(), fixture.Session(t, s, account.ID, fixture.SessionSpec{}), authentication.MfaProof{Code: wrongCodeText}, mfaClient); err == nil ||
		errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("a secret the ring cannot open is a server fault: %v", err)
	}
	if n := queryOne[int32](t, conn, failedOf, account.ID); n != 0 {
		t.Errorf("a server fault is not counted: %d", n)
	}
}

func TestASetupOlderThanFifteenMinutesIsNotConfirmed(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	mfa := authentication.NewMfaService(authentication.NewService(s.Runner), keyRing(t, "k1", "k1"))
	account := fixture.Account(t, s, fixture.AccountSpec{})
	secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	setup, err := mfa.Setup(t.Context(), secret, mfaClient)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	exec(t, conn, agedSetup, account.ID)
	if _, err := mfa.Confirm(t.Context(), secret, codeAt(t, setup.Secret, stepNow(t, conn)), mfaClient); !errors.Is(err, apperror.ErrMfaConflict) {
		t.Errorf("%v", err)
	}
	if _, err := mfa.Verify(t.Context(), secret, authentication.MfaProof{Code: wrongCodeText}, mfaClient); !errors.Is(err, apperror.ErrMfaConflict) {
		t.Errorf("verify without a confirmed factor: %v", err)
	}
}
