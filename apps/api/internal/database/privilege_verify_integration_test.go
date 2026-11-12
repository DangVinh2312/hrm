//go:build integration

package database_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"hrm/api/internal/database"
)

const (
	markerKind = "CREATE CONSTRAINT TRIGGER require_root_marker_kind AFTER UPDATE OF kind ON app_user DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_root_marker_kind()"
	dropMarker = "DROP TRIGGER require_root_marker_kind ON app_user"
	kindGuard  = "CREATE TRIGGER guard_root_kind BEFORE INSERT OR UPDATE OF kind ON app_user FOR EACH ROW EXECUTE FUNCTION public.guard_root_kind()"
	lifecycle  = "CREATE TRIGGER guard_root_lifecycle BEFORE UPDATE OF state,auth_epoch ON app_user FOR EACH ROW EXECUTE FUNCTION public.guard_root_lifecycle()"
	activation = "CREATE TRIGGER guard_root_activation BEFORE INSERT ON one_time_token FOR EACH ROW EXECUTE FUNCTION public.guard_root_activation()"
	emailEpoch = "BEFORE UPDATE OF email_canonical,email_verified ON app_user FOR EACH ROW EXECUTE FUNCTION public.require_email_epoch()"
)

type drift struct{ alter, restore string }

func verify(ctx context.Context, target database.Pools) error {
	return database.VerifyPrivileges(ctx, target, expected)
}

func assertClean(t *testing.T) {
	t.Helper()
	if err := verify(testContext(t), pools); err != nil {
		t.Fatalf("the probe rejects a clean database: %v", err)
	}
}

// assertRejected applies a change, expects the probe to refuse it with the given kind of error, undoes
// the change and expects the probe to pass again.
func assertRejected(t *testing.T, target database.Pools, change drift, accepts func(error) bool) {
	t.Helper()
	asSuperuser(t, change.alter)
	defer func() {
		asSuperuser(t, change.restore)
		if err := verify(testContext(t), pools); err != nil {
			t.Errorf("restore of [%s] left drift: %v", change.alter, err)
		}
	}()
	err := verify(testContext(t), target)
	if err == nil || !accepts(err) {
		t.Errorf("[%s]: got %v", change.alter, err)
	}
	if err != nil {
		for _, secret := range []string{passwords.Data, passwords.Identity, passwords.Authority, passwords.Sync, passwords.Bootstrap, passwords.Migration, cluster.Host() + ":"} {
			if strings.Contains(err.Error(), secret) {
				t.Errorf("[%s]: the error holds a secret or a connection detail", change.alter)
			}
		}
	}
}

func isDrift(err error) bool {
	var privilege *database.PrivilegeDriftError
	return errors.As(err, &privilege) || errors.Is(err, database.ErrUnsafeCredential)
}

func isProtectionDrift(err error) bool { return errors.Is(err, database.ErrProtectionDrift) }

func onDatabase(statement string) string {
	return fmt.Sprintf("DO $$BEGIN EXECUTE format('%s',current_database()); END$$", strings.Replace(statement, "%DB", "%I", 1))
}

func TestProbePassesWithGooseVersionTable(t *testing.T) {
	assertClean(t)
	owner := querySuperuser(t, "SELECT pg_get_userbyid(relowner)::text FROM pg_class WHERE relname='goose_db_version'")
	if owner != "product_migration" {
		t.Fatalf("goose_db_version belongs to %s", owner)
	}
}

func TestProbeRefusesAnotherLoginInThePool(t *testing.T) {
	swapped := database.Pools{database.PurposeData: pools[database.PurposeIdentity]}
	if err := verify(testContext(t), swapped); !errors.Is(err, database.ErrUnsafeCredential) {
		t.Fatalf("got %v", err)
	}
}

func TestProbeNamesTheDrift(t *testing.T) {
	asSuperuser(t, "GRANT SELECT ON mfa_totp TO product_data", "REVOKE UPDATE(revision) ON authz_state FROM product_authority")
	defer asSuperuser(t, "REVOKE SELECT ON mfa_totp FROM product_data", "GRANT UPDATE(revision) ON authz_state TO product_authority")
	var privilege *database.PrivilegeDriftError
	err := verify(testContext(t), database.Pools{database.PurposeData: pools[database.PurposeData]})
	if !errors.As(err, &privilege) || privilege.Purpose != database.PurposeData || !slices.Contains(privilege.Unexpected, "table:mfa_totp:SELECT") {
		t.Fatalf("a grant too many: %v", err)
	}
	err = verify(testContext(t), database.Pools{database.PurposeAuthority: pools[database.PurposeAuthority]})
	if !errors.As(err, &privilege) || privilege.Purpose != database.PurposeAuthority || !slices.Contains(privilege.Missing, "column:authz_state.revision:UPDATE") {
		t.Fatalf("a missing grant: %v", err)
	}
}

func TestProbeRejectsAnyPrivilegeDrift(t *testing.T) {
	for _, change := range []drift{
		{"GRANT SELECT ON mfa_totp TO product_data", "REVOKE SELECT ON mfa_totp FROM product_data"},
		// Secrets a sampled probe would not cover: OIDC PKCE verifier/nonce and one-time tokens.
		{"GRANT SELECT ON oidc_login_attempt,one_time_token TO product_data", "REVOKE SELECT ON oidc_login_attempt,one_time_token FROM product_data"},
		{"GRANT SELECT(secret_ciphertext) ON mfa_totp TO product_bootstrap", "REVOKE SELECT(secret_ciphertext) ON mfa_totp FROM product_bootstrap"},
		{"GRANT INSERT ON user_boundary TO product_identity", "REVOKE INSERT ON user_boundary FROM product_identity"},
		{"GRANT SELECT ON rate_limit TO PUBLIC", "REVOKE SELECT ON rate_limit FROM PUBLIC"},
		{"GRANT SELECT ON user_role TO product_data WITH GRANT OPTION", "REVOKE GRANT OPTION FOR SELECT ON user_role FROM product_data"},
		{"REVOKE UPDATE(revision) ON authz_state FROM product_authority", "GRANT UPDATE(revision) ON authz_state TO product_authority"},
		// Outside schema public: a view re-exposing credentials.
		{"CREATE SCHEMA leak; CREATE VIEW leak.credentials AS SELECT * FROM public.mfa_totp; GRANT USAGE ON SCHEMA leak TO product_data; GRANT SELECT ON leak.credentials TO product_data", "DROP SCHEMA leak CASCADE"},
		// Ownership anywhere or database CREATE is unsafe even without a listed grant.
		{"CREATE FUNCTION public.owned() RETURNS int LANGUAGE sql AS $$SELECT 1$$; REVOKE ALL ON FUNCTION public.owned() FROM PUBLIC; ALTER FUNCTION public.owned() OWNER TO product_data", "DROP FUNCTION public.owned()"},
		{"CREATE SCHEMA extra; GRANT USAGE,CREATE ON SCHEMA extra TO product_data", "DROP SCHEMA extra"},
		{onDatabase("GRANT TEMP ON DATABASE %DB TO PUBLIC"), onDatabase("REVOKE TEMP ON DATABASE %DB FROM PUBLIC")},
		{onDatabase("GRANT CREATE ON DATABASE %DB TO product_data"), onDatabase("REVOKE CREATE ON DATABASE %DB FROM product_data")},
		// Replica mode skips every protection trigger.
		{"GRANT SET ON PARAMETER session_replication_role TO product_authority", "REVOKE SET ON PARAMETER session_replication_role FROM product_authority"},
		{"REVOKE EXECUTE ON FUNCTION public.resolve_session(bytea) FROM product_authority", "GRANT EXECUTE ON FUNCTION public.resolve_session(bytea) TO product_authority"},
		{"ALTER ROLE product_data REPLICATION", "ALTER ROLE product_data NOREPLICATION"},
	} {
		assertRejected(t, pools, change, isDrift)
	}
}

func TestProbeRejectsDriftOfEachLogin(t *testing.T) {
	for _, purpose := range runtimeLogins {
		role := "product_" + string(purpose)
		only := database.Pools{purpose: pools[purpose]}
		for _, change := range []drift{
			{"GRANT CREATE ON SCHEMA public TO " + role, "REVOKE CREATE ON SCHEMA public FROM " + role},
			{"GRANT CREATE ON SCHEMA public TO " + role + " WITH GRANT OPTION", "REVOKE CREATE ON SCHEMA public FROM " + role},
			{"CREATE SCHEMA other; GRANT USAGE,CREATE ON SCHEMA other TO " + role, "DROP SCHEMA other"},
			{onDatabase("GRANT TEMP ON DATABASE %DB TO " + role), onDatabase("REVOKE TEMP ON DATABASE %DB FROM " + role)},
			{onDatabase("GRANT TEMP ON DATABASE %DB TO " + role + " WITH GRANT OPTION"), onDatabase("REVOKE TEMP ON DATABASE %DB FROM " + role)},
			{onDatabase("GRANT CREATE ON DATABASE %DB TO " + role + " WITH GRANT OPTION"), onDatabase("REVOKE CREATE ON DATABASE %DB FROM " + role)},
			{"GRANT product_fence_owner TO " + role, "REVOKE product_fence_owner FROM " + role},
			{"GRANT product_session_owner TO " + role + " WITH ADMIN OPTION", "REVOKE product_session_owner FROM " + role},
			// Re-delegating the access a login legitimately holds is drift as well.
			{"GRANT USAGE ON SCHEMA public TO " + role + " WITH GRANT OPTION", "REVOKE GRANT OPTION FOR USAGE ON SCHEMA public FROM " + role},
			{onDatabase("GRANT CONNECT ON DATABASE %DB TO " + role + " WITH GRANT OPTION"), onDatabase("REVOKE GRANT OPTION FOR CONNECT ON DATABASE %DB FROM " + role)},
		} {
			assertRejected(t, only, change, isDrift)
		}
	}
}

func TestEveryLoginRejectsPublicCreateAndTemp(t *testing.T) {
	for _, change := range []drift{
		{"GRANT CREATE ON SCHEMA public TO PUBLIC", "REVOKE CREATE ON SCHEMA public FROM PUBLIC"},
		{"CREATE SCHEMA other; GRANT CREATE ON SCHEMA other TO PUBLIC", "DROP SCHEMA other"},
		{onDatabase("GRANT TEMP ON DATABASE %DB TO PUBLIC"), onDatabase("REVOKE TEMP ON DATABASE %DB FROM PUBLIC")},
		{onDatabase("GRANT CREATE ON DATABASE %DB TO PUBLIC"), onDatabase("REVOKE CREATE ON DATABASE %DB FROM PUBLIC")},
	} {
		asSuperuser(t, change.alter)
		for _, purpose := range runtimeLogins {
			if err := verify(testContext(t), database.Pools{purpose: pools[purpose]}); !isDrift(err) {
				t.Errorf("%s accepted [%s]: %v", purpose, change.alter, err)
			}
		}
		asSuperuser(t, change.restore)
		assertClean(t)
	}
}

func subjectTrigger(table string) string {
	return "CREATE TRIGGER guard_root_not_iam_subject BEFORE INSERT OR UPDATE ON " + table + " FOR EACH ROW EXECUTE FUNCTION public.guard_root_not_iam_subject()"
}

func replaceFunction(name, body, definer string) string {
	return "CREATE OR REPLACE FUNCTION public." + name + "() RETURNS trigger LANGUAGE plpgsql " + definer + " SET search_path=pg_catalog,pg_temp AS $fn$" + body + "$fn$"
}

func TestProbeRejectsMissingOrMiswiredProtection(t *testing.T) {
	cases := []drift{
		// Missing triggers.
		{dropMarker, markerKind},
		{"DROP TRIGGER guard_root_kind ON app_user", kindGuard},
		{"DROP TRIGGER guard_root_lifecycle ON app_user", lifecycle},
		{"DROP TRIGGER guard_root_activation ON one_time_token", activation},
		// Marker check: not deferrable, initially immediate, wrong function, wider event, WHEN, copy.
		{dropMarker + "; CREATE TRIGGER require_root_marker_kind AFTER UPDATE OF kind ON app_user FOR EACH ROW EXECUTE FUNCTION public.require_root_marker_kind()", dropMarker + "; " + markerKind},
		{dropMarker + "; CREATE CONSTRAINT TRIGGER require_root_marker_kind AFTER UPDATE OF kind ON app_user DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.require_root_marker_kind()", dropMarker + "; " + markerKind},
		{dropMarker + "; CREATE CONSTRAINT TRIGGER require_root_marker_kind AFTER UPDATE OF kind ON app_user DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.protect_product_state()", dropMarker + "; " + markerKind},
		{dropMarker + "; CREATE CONSTRAINT TRIGGER require_root_marker_kind AFTER UPDATE ON app_user DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_root_marker_kind()", dropMarker + "; " + markerKind},
		{dropMarker + "; CREATE CONSTRAINT TRIGGER require_root_marker_kind AFTER UPDATE OF kind ON app_user DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (false) EXECUTE FUNCTION public.require_root_marker_kind()", dropMarker + "; " + markerKind},
		{"CREATE CONSTRAINT TRIGGER require_root_marker_kind_copy AFTER UPDATE OF kind ON app_user DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_root_marker_kind()", "DROP TRIGGER require_root_marker_kind_copy ON app_user"},
		// Firing modes other than origin-only.
		{"ALTER TABLE user_role ENABLE REPLICA TRIGGER guard_root_not_iam_subject", "ALTER TABLE user_role ENABLE TRIGGER guard_root_not_iam_subject"},
		{"ALTER TABLE app_user ENABLE ALWAYS TRIGGER require_root_marker_kind", "ALTER TABLE app_user ENABLE TRIGGER require_root_marker_kind"},
		// Same trigger name bound to a same-named function in another schema.
		{"CREATE SCHEMA shadow; CREATE FUNCTION shadow.guard_root_activation() RETURNS trigger LANGUAGE plpgsql AS $f$BEGIN RETURN NEW; END$f$; REVOKE ALL ON FUNCTION shadow.guard_root_activation() FROM PUBLIC; DROP TRIGGER guard_root_activation ON one_time_token; CREATE TRIGGER guard_root_activation BEFORE INSERT ON one_time_token FOR EACH ROW EXECUTE FUNCTION shadow.guard_root_activation()", "DROP TRIGGER guard_root_activation ON one_time_token; " + activation + "; DROP SCHEMA shadow CASCADE"},
		// Timing, event, column list and granularity.
		{"DROP TRIGGER guard_root_activation ON one_time_token; CREATE TRIGGER guard_root_activation AFTER INSERT ON one_time_token FOR EACH ROW EXECUTE FUNCTION public.guard_root_activation()", "DROP TRIGGER guard_root_activation ON one_time_token; " + activation},
		{"DROP TRIGGER guard_root_kind ON app_user; CREATE TRIGGER guard_root_kind BEFORE UPDATE OF kind ON app_user FOR EACH ROW EXECUTE FUNCTION public.guard_root_kind()", "DROP TRIGGER guard_root_kind ON app_user; " + kindGuard},
		{"DROP TRIGGER guard_root_lifecycle ON app_user; CREATE TRIGGER guard_root_lifecycle BEFORE UPDATE OF state ON app_user FOR EACH ROW EXECUTE FUNCTION public.guard_root_lifecycle()", "DROP TRIGGER guard_root_lifecycle ON app_user; " + lifecycle},
		{"DROP TRIGGER guard_root_not_iam_subject ON user_role; CREATE TRIGGER guard_root_not_iam_subject BEFORE INSERT OR UPDATE ON user_role FOR EACH STATEMENT EXECUTE FUNCTION public.guard_root_not_iam_subject()", "DROP TRIGGER guard_root_not_iam_subject ON user_role; " + subjectTrigger("user_role")},
		// Email change means a new auth_epoch, for every login including owners.
		{replaceFunction("require_email_epoch", "BEGIN RETURN NEW; END", ""), replaceFunction("require_email_epoch", database.ProtectionBody("require_email_epoch"), "")},
		{"DROP TRIGGER require_email_epoch ON app_user", "CREATE TRIGGER require_email_epoch " + emailEpoch},
		{"DROP TRIGGER require_email_epoch ON app_user; CREATE TRIGGER require_email_epoch BEFORE UPDATE OF email_verified ON app_user FOR EACH ROW EXECUTE FUNCTION public.require_email_epoch()", "DROP TRIGGER require_email_epoch ON app_user; CREATE TRIGGER require_email_epoch " + emailEpoch},
		{"ALTER TABLE app_user DISABLE TRIGGER require_email_epoch", "ALTER TABLE app_user ENABLE TRIGGER require_email_epoch"},
		// Function inventory: overload, search_path, owner.
		{"CREATE FUNCTION public.guard_root_kind(int) RETURNS int LANGUAGE sql AS $f$SELECT 1$f$; REVOKE ALL ON FUNCTION public.guard_root_kind(int) FROM PUBLIC", "DROP FUNCTION public.guard_root_kind(int)"},
		{"ALTER FUNCTION guard_root_not_iam_subject() SET search_path=public", "ALTER FUNCTION guard_root_not_iam_subject() SET search_path=pg_catalog,pg_temp"},
		{"ALTER FUNCTION guard_root_lifecycle() OWNER TO product_migration", "ALTER FUNCTION guard_root_lifecycle() OWNER TO product_session_owner"},
		{"ALTER FUNCTION protect_product_rows() OWNER TO product_session_owner", "ALTER FUNCTION protect_product_rows() OWNER TO product_migration"},
		// No ACL the probe reads changes here, so only the owner of the function can tell.
		{"ALTER FUNCTION protect_product_rows() OWNER TO product_fence_owner", "ALTER FUNCTION protect_product_rows() OWNER TO product_migration"},
		// Owner hardening.
		{"ALTER ROLE product_session_owner LOGIN", "ALTER ROLE product_session_owner NOLOGIN"},
		{"GRANT product_data TO product_session_owner", "REVOKE product_data FROM product_session_owner"},
		{"GRANT CREATE ON SCHEMA public TO product_session_owner", "REVOKE CREATE ON SCHEMA public FROM product_session_owner"},
		// Exact owner ACL: one grant too many or one missing.
		{"GRANT SELECT(secret_ciphertext) ON mfa_totp TO product_session_owner", "REVOKE SELECT(secret_ciphertext) ON mfa_totp FROM product_session_owner"},
		{"GRANT UPDATE(state) ON app_user TO product_session_owner", "REVOKE UPDATE(state) ON app_user FROM product_session_owner"},
		{"GRANT SELECT(role_key) ON user_role TO product_session_owner", "REVOKE SELECT(role_key) ON user_role FROM product_session_owner"},
		{"REVOKE SELECT(kind) ON app_user FROM product_session_owner", "GRANT SELECT(kind) ON app_user TO product_session_owner"},
		{"REVOKE SELECT ON security_bootstrap_state FROM product_session_owner", "GRANT SELECT ON security_bootstrap_state TO product_session_owner"},
		{replaceFunction("protect_token_consumption", "BEGIN RETURN NEW; END", ""), replaceFunction("protect_token_consumption", database.ProtectionBody("protect_token_consumption"), "")},
	}
	for _, table := range []string{"user_role", "user_boundary", "policy_rule", "record_exception"} {
		cases = append(cases, drift{"DROP TRIGGER guard_root_not_iam_subject ON " + table, subjectTrigger(table)})
	}
	// Neutralized bodies behind the same name, owner and settings.
	for name, neutral := range map[string]string{
		"guard_root_kind":            "BEGIN RETURN NEW; END",
		"require_root_marker_kind":   "BEGIN RETURN NULL; END",
		"guard_root_not_iam_subject": "BEGIN RETURN NEW; END",
		"guard_root_activation":      "BEGIN RETURN NEW; END",
		"guard_root_lifecycle":       "BEGIN RETURN NEW; END",
	} {
		cases = append(cases, drift{replaceFunction(name, neutral, "SECURITY DEFINER"), replaceFunction(name, database.ProtectionBody(name), "SECURITY DEFINER")})
	}
	for _, change := range cases {
		assertRejected(t, pools, change, isProtectionDrift)
	}
}

func TestADroppedGuardCannotStartTheRuntime(t *testing.T) {
	assertRejected(t, pools, drift{
		"DROP FUNCTION public.guard_root_activation() CASCADE",
		replaceFunction("guard_root_activation", database.ProtectionBody("guard_root_activation"), "SECURITY DEFINER") + "; " + activation +
			"; REVOKE ALL ON FUNCTION public.guard_root_activation() FROM PUBLIC; ALTER FUNCTION public.guard_root_activation() OWNER TO product_session_owner",
	}, isProtectionDrift)
}

func TestProtectionFunctionACLIsExactForEveryLogin(t *testing.T) {
	for _, name := range []string{
		"guard_root_kind", "require_root_marker_kind", "guard_root_not_iam_subject",
		"guard_root_activation", "guard_root_lifecycle", "protect_token_consumption",
	} {
		change := func(grantee, suffix string) drift {
			return drift{
				"GRANT EXECUTE ON FUNCTION public." + name + "() TO " + grantee + suffix,
				"REVOKE EXECUTE ON FUNCTION public." + name + "() FROM " + grantee,
			}
		}
		for _, purpose := range runtimeLogins {
			assertRejected(t, database.Pools{purpose: pools[purpose]}, change("product_"+string(purpose), " WITH GRANT OPTION"), isDrift)
		}
		assertRejected(t, pools, change("PUBLIC", ""), isDrift)
	}
}

func TestProbeRejectsDisabledOrWeakenedProtection(t *testing.T) {
	cases := []drift{
		{"ALTER TABLE app_user DISABLE TRIGGER require_root_marker_kind", "ALTER TABLE app_user ENABLE TRIGGER require_root_marker_kind"},
		// Constraint triggers cannot be altered by DDL; simulate catalog drift as superuser.
		{"UPDATE pg_trigger SET tginitdeferred=false WHERE tgname='require_root_marker_kind'", "UPDATE pg_trigger SET tginitdeferred=true WHERE tgname='require_root_marker_kind'"},
		{"ALTER TABLE app_user DISABLE TRIGGER guard_root_kind", "ALTER TABLE app_user ENABLE TRIGGER guard_root_kind"},
		{"ALTER TABLE app_user DISABLE TRIGGER guard_root_lifecycle", "ALTER TABLE app_user ENABLE TRIGGER guard_root_lifecycle"},
		{"ALTER TABLE one_time_token DISABLE TRIGGER guard_root_activation", "ALTER TABLE one_time_token ENABLE TRIGGER guard_root_activation"},
		{"ALTER FUNCTION guard_root_kind() SECURITY INVOKER", "ALTER FUNCTION guard_root_kind() SECURITY DEFINER"},
		{"ALTER FUNCTION guard_root_activation() RESET search_path", "ALTER FUNCTION guard_root_activation() SET search_path=pg_catalog,pg_temp"},
		{"ALTER FUNCTION require_root_marker_kind() OWNER TO product_fence_owner", "ALTER FUNCTION require_root_marker_kind() OWNER TO product_session_owner"},
		{"ALTER TABLE one_time_token DISABLE TRIGGER protect_token_consumption", "ALTER TABLE one_time_token ENABLE TRIGGER protect_token_consumption"},
		{"DROP TRIGGER protect_token_consumption ON one_time_token; CREATE TRIGGER protect_token_consumption AFTER INSERT ON one_time_token FOR EACH ROW EXECUTE FUNCTION protect_token_consumption()", "DROP TRIGGER protect_token_consumption ON one_time_token; CREATE TRIGGER protect_token_consumption BEFORE UPDATE ON one_time_token FOR EACH ROW EXECUTE FUNCTION protect_token_consumption()"},
		// Same body, owner and ACL, weaker volatility: a STABLE guard reuses the snapshot of the caller
		// and misses a fact committed while it waited on the account row lock.
		{"ALTER FUNCTION public.guard_root_kind() STABLE", "ALTER FUNCTION public.guard_root_kind() VOLATILE"},
		{"ALTER FUNCTION public.protect_product_rows() IMMUTABLE", "ALTER FUNCTION public.protect_product_rows() VOLATILE"},
		// iam_account must stay the IAM-only projection: a Root row in it is visible to IAM.
		{"CREATE OR REPLACE VIEW public.iam_account WITH (security_invoker=true) AS SELECT id,state FROM public.app_user", "CREATE OR REPLACE VIEW public.iam_account WITH (security_invoker=true) AS SELECT id,state FROM public.app_user WHERE kind='iam'"},
		{"ALTER VIEW public.iam_account RESET (security_invoker)", "ALTER VIEW public.iam_account SET (security_invoker=true)"},
		// A neutralized body behind the same name, owner and settings.
		{"CREATE OR REPLACE FUNCTION public.protect_product_rows() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$BEGIN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END$fn$", replaceFunction("protect_product_rows", database.ProtectionBody("protect_product_rows"), "")},
		// Same trigger name bound to another function, event, column list or condition.
		{"DROP TRIGGER protect_account_lifecycle ON app_user; CREATE TRIGGER protect_account_lifecycle BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION protect_product_state()", "DROP TRIGGER protect_account_lifecycle ON app_user; CREATE TRIGGER protect_account_lifecycle BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION protect_account_lifecycle()"},
		{"DROP TRIGGER protect_product_rows ON user_role; CREATE TRIGGER protect_product_rows BEFORE INSERT OR DELETE ON user_role FOR EACH ROW EXECUTE FUNCTION protect_product_rows()", "DROP TRIGGER protect_product_rows ON user_role; CREATE TRIGGER protect_product_rows BEFORE INSERT OR UPDATE OR DELETE ON user_role FOR EACH ROW EXECUTE FUNCTION protect_product_rows()"},
		{"DROP TRIGGER protect_product_state ON authz_state; CREATE TRIGGER protect_product_state BEFORE UPDATE ON authz_state FOR EACH ROW WHEN (false) EXECUTE FUNCTION protect_product_state()", "DROP TRIGGER protect_product_state ON authz_state; CREATE TRIGGER protect_product_state BEFORE UPDATE ON authz_state FOR EACH ROW EXECUTE FUNCTION protect_product_state()"},
		// The authority rule trigger: disabled, neutralized, owned elsewhere or bound to INSERT only.
		{"ALTER TABLE policy_rule DISABLE TRIGGER protect_role_rules", "ALTER TABLE policy_rule ENABLE TRIGGER protect_role_rules"},
		{replaceFunction("protect_role_rules", "BEGIN RETURN NEW; END", ""), replaceFunction("protect_role_rules", database.ProtectionBody("protect_role_rules"), "")},
		{"ALTER FUNCTION protect_role_rules() OWNER TO product_session_owner", "ALTER FUNCTION protect_role_rules() OWNER TO product_migration"},
		{"DROP TRIGGER protect_role_rules ON policy_rule; CREATE TRIGGER protect_role_rules BEFORE INSERT ON policy_rule FOR EACH ROW EXECUTE FUNCTION protect_role_rules()", "DROP TRIGGER protect_role_rules ON policy_rule; CREATE TRIGGER protect_role_rules BEFORE INSERT OR UPDATE ON policy_rule FOR EACH ROW EXECUTE FUNCTION protect_role_rules()"},
		// A later trigger could rewrite a row the protection already accepted.
		{"CREATE TRIGGER zz_rewrite BEFORE INSERT ON user_role FOR EACH ROW EXECUTE FUNCTION protect_product_state()", "DROP TRIGGER zz_rewrite ON user_role"},
	}
	for _, table := range []string{"user_role", "user_boundary", "policy_rule", "record_exception"} {
		cases = append(cases, drift{"ALTER TABLE " + table + " DISABLE TRIGGER guard_root_not_iam_subject", "ALTER TABLE " + table + " ENABLE TRIGGER guard_root_not_iam_subject"})
	}
	for _, change := range cases {
		assertRejected(t, pools, change, isProtectionDrift)
	}
}

func TestFunctionOwnerGrantsRefusesAnUnknownOwner(t *testing.T) {
	if _, err := database.FunctionOwnerGrants(testContext(t), pools[database.PurposeData], "product_data"); !errors.Is(err, database.ErrUnknownOwner) {
		t.Fatalf("got %v", err)
	}
}
