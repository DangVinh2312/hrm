//go:build integration

package authentication_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"hrm/api/contract"
	"hrm/api/internal/database"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

const (
	sqlOK            = ""
	denied42501      = "42501"
	unique23505      = "23505"
	checkFailed      = "23514"
	noColumn         = "42703"
	noTable          = "42P01"
	emailOf          = `SELECT COALESCE(email_canonical,'')||'|'||email_verified FROM app_user WHERE id=$1`
	bindingRefOf     = `SELECT binding_ref::text FROM external_identity WHERE user_id=$1`
	unverifiedUser   = `INSERT INTO app_user(id,email_canonical,email_verified,state) VALUES(gen_random_uuid(),$1,false,'active') RETURNING id::text`
	insertFactorRow  = `INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id) VALUES($1,decode(repeat('ab',36),'hex'),decode(repeat('ab',12),'hex'),'k1')`
	setupChange      = `UPDATE mfa_totp SET secret_ciphertext=decode(repeat('cd',36),'hex'),secret_version=secret_version+1,created_at=statement_timestamp() WHERE user_id=$1`
	confirmRow       = `UPDATE mfa_totp SET confirmed_at=statement_timestamp(),last_used_step=100 WHERE user_id=$1`
	reencryptRow     = `UPDATE mfa_totp SET secret_ciphertext=decode(repeat('ef',36),'hex'),nonce=decode(repeat('ef',12),'hex'),key_id='k2',failed_attempts=0 WHERE user_id=$1`
	failuresRow      = `UPDATE mfa_totp SET failed_attempts=$2 WHERE user_id=$1`
	capFailures      = `UPDATE mfa_totp SET failed_attempts=LEAST(failed_attempts+1,1000) WHERE user_id=$1`
	removeRow        = `DELETE FROM mfa_totp WHERE user_id=$1`
	insertCode       = `INSERT INTO mfa_recovery_code(user_id,code_hash) VALUES($1,decode(repeat('ab',32),'hex'))`
	insertUsedCode   = `INSERT INTO mfa_recovery_code(user_id,code_hash,used_at) VALUES($1,decode(repeat('cd',32),'hex'),statement_timestamp())`
	backdateCode     = `UPDATE mfa_recovery_code SET used_at=statement_timestamp()-interval '1 second' WHERE user_id=$1`
	useCode          = `UPDATE mfa_recovery_code SET used_at=statement_timestamp() WHERE user_id=$1 AND used_at IS NULL`
	reuseCode        = `UPDATE mfa_recovery_code SET used_at=statement_timestamp() WHERE user_id=$1`
	readFactor       = `SELECT 1 FROM mfa_totp LIMIT 1`
	readFactorKey    = `SELECT key_id FROM mfa_totp LIMIT 1`
	secondBinding    = `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,'single-second',$2)`
	disabledBinding  = `INSERT INTO external_identity(issuer,subject,user_id,enabled) VALUES($1,'single-old',$2,false)`
	otherProviderRow = `INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)`
	insertPurpose    = `INSERT INTO oidc_login_attempt(state_hash,nonce,verifier,provider_issuer,provider_version,redirect_uri,expires_at,browser_hash,purpose)
    VALUES(decode(repeat('ab',32),'hex'),'n','v',$1,1,'https://app.fixture/api/auth/oidc/callback',statement_timestamp()+interval '5 minutes',decode(repeat('cd',32),'hex'),$2)`
)

// schemaStack answers SQLSTATE per statement on each login, so a refused statement aborts nothing else.
type schemaStack struct {
	t        *testing.T
	s        *test.Stack
	super    *pgx.Conn
	identity *pgxpool.Pool
}

func newSchemaStack(t *testing.T) schemaStack {
	t.Helper()
	s := test.NewDatabase(t)
	return schemaStack{t: t, s: s, super: superuser(t, s), identity: s.Pools[database.PurposeIdentity]}
}

func stateOfError(err error) string {
	if pgError, ok := errors.AsType[*pgconn.PgError](err); ok {
		return pgError.Code
	}
	if err != nil {
		return "other"
	}
	return sqlOK
}

func (s schemaStack) wantIdentity(want, sql string, args ...any) {
	s.t.Helper()
	_, err := s.identity.Exec(s.t.Context(), sql, args...)
	if got := stateOfError(err); got != want {
		s.t.Errorf("[%s] as identity: SQLSTATE %q, want %q", sql, got, want)
	}
}

func (s schemaStack) wantSuper(want, sql string, args ...any) {
	s.t.Helper()
	_, err := s.super.Exec(s.t.Context(), sql, args...)
	if got := stateOfError(err); got != want {
		s.t.Errorf("[%s] as superuser: SQLSTATE %q, want %q", sql, got, want)
	}
}

func (s schemaStack) epoch(userID string) string {
	s.t.Helper()
	return queryOne[string](s.t, s.super, epochOf, userID)
}

func (s schemaStack) wantEpochMoved(userID, before string, moved bool, name string) string {
	s.t.Helper()
	after := s.epoch(userID)
	if (after != before) != moved {
		s.t.Errorf("%s: epoch %s to %s, moved %v expected", name, before, after, moved)
	}
	return after
}

func TestAFactorOnlyMovesForwardAndEndsSessionsWhereItMust(t *testing.T) {
	s := newSchemaStack(t)
	user := fixture.Account(t, s.s, fixture.AccountSpec{}).ID
	for _, sql := range []string{
		`INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id,confirmed_at) VALUES($1,decode(repeat('ab',36),'hex'),decode(repeat('ab',12),'hex'),'k1',statement_timestamp())`,
		`INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id,last_used_step) VALUES($1,decode(repeat('ab',36),'hex'),decode(repeat('ab',12),'hex'),'k1',5)`,
		`INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id,failed_attempts) VALUES($1,decode(repeat('ab',36),'hex'),decode(repeat('ab',12),'hex'),'k1',3)`,
	} {
		s.wantIdentity(denied42501, sql, user)
	}
	s.wantIdentity(sqlOK, insertFactorRow, user)
	epoch := s.epoch(user)
	s.wantIdentity(sqlOK, setupChange, user)
	epoch = s.wantEpochMoved(user, epoch, false, "a new setup")
	s.wantIdentity(sqlOK, confirmRow, user)
	epoch = s.wantEpochMoved(user, epoch, true, "the confirmation")
	for _, change := range []string{
		"confirmed_at=NULL", "confirmed_at=statement_timestamp()", "last_used_step=99", "last_used_step=NULL",
		"secret_version=secret_version+1", "created_at=statement_timestamp()",
	} {
		s.wantIdentity(denied42501, "UPDATE mfa_totp SET "+change+" WHERE user_id=$1", user)
	}
	s.wantIdentity(sqlOK, reencryptRow, user)
	epoch = s.wantEpochMoved(user, epoch, false, "a re-encryption")
	s.wantIdentity(sqlOK, failuresRow, user, 9)
	epoch = s.wantEpochMoved(user, epoch, false, "the ninth failure")
	s.wantIdentity(sqlOK, failuresRow, user, 10)
	epoch = s.wantEpochMoved(user, epoch, true, "the tenth failure")
	s.wantIdentity(sqlOK, failuresRow, user, 11)
	s.wantEpochMoved(user, epoch, true, "a later failure")
	s.wantIdentity(sqlOK, failuresRow, user, 1000)
	epoch = s.epoch(user)
	s.wantIdentity(sqlOK, capFailures, user)
	epoch = s.wantEpochMoved(user, epoch, true, "a failure at the cap")
	s.wantIdentity(sqlOK, failuresRow, user, 0)
	epoch = s.wantEpochMoved(user, epoch, false, "the counter reset")
	s.wantIdentity(sqlOK, removeRow, user)
	s.wantEpochMoved(user, epoch, true, "removing a confirmed factor")
	s.wantIdentity(sqlOK, insertFactorRow, user)
	epoch = s.epoch(user)
	s.wantIdentity(sqlOK, removeRow, user)
	s.wantEpochMoved(user, epoch, false, "removing a setup")
}

func TestARecoveryCodeIsUsedOnceAndOtherLoginsReadNoFactor(t *testing.T) {
	s := newSchemaStack(t)
	user := fixture.Account(t, s.s, fixture.AccountSpec{}).ID
	s.wantIdentity(denied42501, insertUsedCode, user)
	s.wantIdentity(sqlOK, insertCode, user)
	s.wantIdentity(denied42501, backdateCode, user)
	s.wantIdentity(sqlOK, useCode, user)
	s.wantIdentity(denied42501, reuseCode, user)
	for _, purpose := range []database.Purpose{database.PurposeData, database.PurposeAuthority, database.PurposeSync} {
		if _, err := s.s.Pools[purpose].Exec(t.Context(), readFactor); stateOfError(err) != denied42501 {
			t.Errorf("%s reads a factor: %s", purpose, stateOfError(err))
		}
	}
	bootstrap, err := pgx.Connect(t.Context(), s.s.LoginURL("bootstrap"))
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := bootstrap.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := bootstrap.Exec(t.Context(), readFactorKey); stateOfError(err) != denied42501 {
		t.Errorf("bootstrap reads a key id: %s", stateOfError(err))
	}
}

func TestABindingKeepsItsReferenceAndIdentityWritesNoColumnOfIt(t *testing.T) {
	s := newSchemaStack(t)
	owner := fixture.Account(t, s.s, fixture.AccountSpec{})
	reference := queryOne[string](t, s.super, bindingRefOf, owner.ID)
	for _, sql := range []string{
		`UPDATE external_identity SET enabled=false,binding_version=binding_version+1 WHERE user_id=$1`,
		`UPDATE external_identity SET binding_ref=gen_random_uuid() WHERE user_id=$1`,
		`UPDATE external_identity SET user_id=$1 WHERE user_id=$1`,
		`DELETE FROM external_identity WHERE user_id=$1`,
	} {
		s.wantIdentity(denied42501, sql, owner.ID)
	}
	s.wantIdentity(denied42501, `INSERT INTO external_identity(issuer,subject,user_id,binding_ref) VALUES($1,'chosen-ref',$2,gen_random_uuid())`, test.FixtureIssuer, owner.ID)
	s.wantSuper(denied42501, `UPDATE external_identity SET binding_ref=gen_random_uuid() WHERE user_id=$1`, owner.ID)
	if got := queryOne[string](t, s.super, bindingRefOf, owner.ID); got != reference {
		t.Errorf("the reference moved to %s", got)
	}
}

func TestAnEmailChangeMustAdvanceTheEpochForEveryLogin(t *testing.T) {
	s := newSchemaStack(t)
	const email = "epoch@example.test"
	user := queryOne[string](t, s.super, unverifiedUser, email)
	before := s.epoch(user)
	for _, sql := range []string{
		`UPDATE app_user SET email_verified=true WHERE id=$1`,
		`UPDATE app_user SET email_verified=true,auth_epoch=auth_epoch WHERE id=$1`,
		`UPDATE app_user SET email_canonical='moved-'||email_canonical,auth_epoch=auth_epoch WHERE id=$1`,
		`UPDATE app_user SET email_canonical=NULL WHERE id=$1`,
	} {
		s.wantIdentity(denied42501, sql, user)
		s.wantSuper(denied42501, sql, user)
	}
	if state := queryOne[string](t, s.super, emailOf, user); state != email+"|false" {
		t.Errorf("%s", state)
	}
	s.wantSuper(sqlOK, `UPDATE app_user SET email_verified=false WHERE id=$1`, user)
	s.wantEpochMoved(user, before, false, "the same values")
	s.wantIdentity(sqlOK, `UPDATE app_user SET email_verified=true,auth_epoch=auth_epoch+1 WHERE id=$1`, user)
	s.wantEpochMoved(user, before, true, "a change with a new epoch")
	bootstrap, err := pgx.Connect(t.Context(), s.s.LoginURL("bootstrap"))
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := bootstrap.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	for _, sql := range []string{
		`UPDATE app_user SET email_canonical='boot-'||email_canonical,email_verified=false,auth_epoch=auth_epoch+1 WHERE id=$1`,
		`UPDATE app_user SET email_verified=false WHERE id=$1`,
	} {
		if _, err := bootstrap.Exec(t.Context(), sql, user); stateOfError(err) != denied42501 {
			t.Errorf("[%s] as bootstrap: %s", sql, stateOfError(err))
		}
	}
	if state := queryOne[string](t, s.super, emailOf, user); state != email+"|true" {
		t.Errorf("%s", state)
	}
}

func TestOneEnabledBindingAndNoAttemptButLoginOrActivation(t *testing.T) {
	s := newSchemaStack(t)
	const second = "https://second.fixture"
	s.wantSuper(sqlOK, otherProviderRow, second)
	owner := fixture.Account(t, s.s, fixture.AccountSpec{})
	s.wantIdentity(unique23505, secondBinding, second, owner.ID)
	s.wantSuper(unique23505, secondBinding, second, owner.ID)
	s.wantSuper(sqlOK, disabledBinding, second, owner.ID)
	for _, purpose := range []string{"link", "reauth"} {
		s.wantIdentity(checkFailed, insertPurpose, test.FixtureIssuer, purpose)
	}
	s.wantIdentity(noColumn, `SELECT linking_session_hash FROM oidc_login_attempt`)
	s.wantIdentity(noTable, `SELECT 1 FROM oidc_link_proof`)
}

// verifyAgainstTheContract is the probe of the boot with the privileges of the contract.
func verifyAgainstTheContract(t *testing.T, s *test.Stack) error {
	t.Helper()
	var expected struct {
		Application map[database.Purpose][]string `json:"applicationPrivileges"`
	}
	if err := json.Unmarshal([]byte(contract.Privileges()), &expected); err != nil {
		t.Fatal(err)
	}
	return database.VerifyPrivileges(t.Context(), s.Pools, expected.Application)
}

func TestTheProbeOfTheBootSeesDriftOfTheGuardsOfIdentity(t *testing.T) {
	s := newSchemaStack(t)
	if err := verifyAgainstTheContract(t, s.s); err != nil {
		t.Fatal(test.Redact(err))
	}
	const (
		totpGuard   = `CREATE TRIGGER protect_mfa_totp BEFORE INSERT OR UPDATE OR DELETE ON mfa_totp FOR EACH ROW EXECUTE FUNCTION public.protect_mfa_totp()`
		epochGuard  = `CREATE TRIGGER mfa_epoch AFTER UPDATE OR DELETE ON mfa_totp FOR EACH ROW EXECUTE FUNCTION public.mfa_epoch()`
		codeGuard   = `CREATE TRIGGER protect_mfa_recovery_code BEFORE INSERT OR UPDATE OR DELETE ON mfa_recovery_code FOR EACH ROW EXECUTE FUNCTION public.protect_mfa_recovery_code()`
		bindGuard   = `CREATE TRIGGER protect_binding_ref BEFORE UPDATE ON external_identity FOR EACH ROW EXECUTE FUNCTION public.protect_binding_ref()`
		replaceHead = `CREATE OR REPLACE FUNCTION public.`
		replaceTail = `() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$`
		fnEnd       = `$fn$`
	)
	gutted := func(name, body string) [2]string {
		original := queryOne[string](t, s.super, `SELECT pg_get_functiondef('public.`+name+`()'::regprocedure)`)
		return [2]string{replaceHead + name + replaceTail + body + fnEnd, original}
	}
	for _, c := range [][2]string{
		gutted("protect_mfa_totp", "BEGIN RETURN NEW; END"),
		gutted("protect_mfa_recovery_code", "BEGIN RETURN NEW; END"),
		gutted("mfa_epoch", "BEGIN RETURN NULL; END"),
		gutted("protect_binding_ref", "BEGIN RETURN NEW; END"),
		{"DROP TRIGGER protect_mfa_totp ON mfa_totp", totpGuard},
		{"DROP TRIGGER mfa_epoch ON mfa_totp", epochGuard},
		{"DROP TRIGGER protect_mfa_recovery_code ON mfa_recovery_code", codeGuard},
		{"DROP TRIGGER protect_binding_ref ON external_identity", bindGuard},
		{"ALTER TABLE mfa_totp DISABLE TRIGGER mfa_epoch", "ALTER TABLE mfa_totp ENABLE TRIGGER mfa_epoch"},
		{"ALTER TABLE mfa_recovery_code DISABLE TRIGGER protect_mfa_recovery_code", "ALTER TABLE mfa_recovery_code ENABLE TRIGGER protect_mfa_recovery_code"},
		{"ALTER TABLE external_identity DISABLE TRIGGER protect_binding_ref", "ALTER TABLE external_identity ENABLE TRIGGER protect_binding_ref"},
		{"DROP TRIGGER mfa_epoch ON mfa_totp; CREATE TRIGGER mfa_epoch AFTER UPDATE ON mfa_totp FOR EACH ROW EXECUTE FUNCTION public.mfa_epoch()", "DROP TRIGGER mfa_epoch ON mfa_totp; " + epochGuard},
		{"GRANT SELECT ON mfa_totp TO product_data", "REVOKE SELECT ON mfa_totp FROM product_data"},
		{"GRANT UPDATE(code_hash) ON mfa_recovery_code TO product_identity", "REVOKE UPDATE(code_hash) ON mfa_recovery_code FROM product_identity"},
		{"GRANT UPDATE(binding_ref) ON external_identity TO product_identity", "REVOKE UPDATE(binding_ref) ON external_identity FROM product_identity"},
		{"GRANT INSERT(binding_ref) ON external_identity TO product_identity", "REVOKE INSERT(binding_ref) ON external_identity FROM product_identity"},
		{"GRANT UPDATE(enabled,binding_version) ON external_identity TO product_identity", "REVOKE UPDATE(enabled,binding_version) ON external_identity FROM product_identity"},
		{"REVOKE INSERT(user_id) ON external_identity FROM product_identity", "GRANT INSERT(user_id) ON external_identity TO product_identity"},
	} {
		alter, restore := c[0], c[1]
		s.wantSuper(sqlOK, alter)
		if err := verifyAgainstTheContract(t, s.s); err == nil {
			t.Errorf("[%s] passes the probe", alter)
		}
		s.wantSuper(sqlOK, restore)
		if err := verifyAgainstTheContract(t, s.s); err != nil {
			t.Errorf("after [%s]: %s", restore, test.Redact(err))
		}
	}
}
