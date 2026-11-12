package database

import (
	"context"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func verifyDefinerOwners(ctx context.Context, pool *pgxpool.Pool) error {
	valid, err := queryValid(ctx, pool, `SELECT
      (SELECT count(*)=2 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
        WHERE n.nspname='public' AND p.proname IN ('authz_acquire_shared_fence','resolve_session')
          AND p.prosecdef AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolbypassrls AND NOT r.rolreplication
          AND NOT has_schema_privilege(r.oid,'public','CREATE') AND NOT EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid)
          AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) AS valid`)
	if err != nil {
		return err
	}
	if !valid {
		return ErrProtectionDrift
	}
	ownerGrants, err := collectStrings(ctx, pool, grantsOf("SELECT oid FROM pg_roles WHERE rolname='product_session_owner'", true))
	if err != nil {
		return err
	}
	if !sameGrants(ownerGrants, sessionOwnerACL) {
		return ErrProtectionDrift
	}
	return nil
}

func verifyViews(ctx context.Context, pool *pgxpool.Pool) error {
	valid, err := queryValid(ctx, pool, `SELECT pg_get_viewdef(c.oid,false)=$1 AND COALESCE(c.reloptions @> ARRAY['security_invoker=true'],false) AS valid
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='iam_account' AND c.relkind='v'`, iamAccountDefinition)
	if err != nil {
		return err
	}
	if !valid {
		return ErrProtectionDrift
	}
	valid, err = queryValid(ctx, pool, `SELECT pg_get_viewdef(c.oid,false)=$1 AND r.rolname='product_account_owner'
          AND c.reloptions=ARRAY['security_barrier=true']
          AND NOT (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
            OR has_schema_privilege(r.oid,'public','CREATE') OR EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid)) AS valid
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
        WHERE n.nspname='public' AND c.relname='account_directory' AND c.relkind='v'`, accountDirectoryDefinition)
	if err != nil {
		return err
	}
	if !valid {
		return ErrProtectionDrift
	}
	return nil
}

func verifyOwnerACLs(ctx context.Context, pool *pgxpool.Pool) error {
	accountOwner, err := FunctionOwnerGrants(ctx, pool, "product_account_owner")
	if err != nil {
		return err
	}
	if !sameGrants(accountOwner, accountOwnerACL) {
		return ErrProtectionDrift
	}
	for _, entry := range []struct {
		owner string
		acl   []string
	}{
		{"product_email_owner", emailOwnerACL},
		{"product_mfa_owner", mfaOwnerACL},
		{"product_binding_owner", bindingOwnerACL},
	} {
		granted, err := FunctionOwnerGrants(ctx, pool, entry.owner)
		if err != nil {
			return err
		}
		safe, err := queryValid(ctx, pool, `SELECT NOT (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
            OR has_schema_privilege(r.oid,'public','CREATE') OR EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid)) AS valid
          FROM pg_roles r WHERE r.rolname=$1`, entry.owner)
		if err != nil {
			return err
		}
		if !safe || !sameGrants(granted, entry.acl) {
			return ErrProtectionDrift
		}
	}
	return nil
}

func verifyFunctions(ctx context.Context, pool *pgxpool.Pool) error {
	names := make([]string, 0, len(protectionFunctions))
	declared := make(map[string]protectionFunction, len(protectionFunctions))
	for _, function := range protectionFunctions {
		names = append(names, function.name)
		declared[function.name] = function
	}
	rows, err := pool.Query(ctx, `SELECT p.proname AS name,r.rolname AS owner,p.prosecdef AS definer,p.provolatile AS volatility,p.prosrc AS body,p.proconfig AS config
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
        WHERE n.nspname='public' AND p.proname=ANY($1)`, names)
	if err != nil {
		return err
	}
	type function struct {
		Name       string
		Owner      string
		Definer    bool
		Volatility string
		Body       string
		Config     []string
	}
	actual, err := pgx.CollectRows(rows, pgx.RowToStructByPos[function])
	if err != nil {
		return err
	}
	if len(actual) != len(declared) {
		return ErrProtectionDrift
	}
	for _, found := range actual {
		wanted := declared[found.Name]
		if found.Owner != wanted.owner || found.Definer != wanted.definer || found.Volatility != "v" ||
			found.Body != wanted.body || strings.Join(found.Config, "|") != definerSearchPath {
			return ErrProtectionDrift
		}
	}
	return nil
}

func verifyTriggers(ctx context.Context, pool *pgxpool.Pool) error {
	actual, err := collectStrings(ctx, pool, `SELECT c.relname||'.'||t.tgname||':'
          ||CASE WHEN fn.nspname='public' AND t.tgqual IS NULL AND t.tgnargs=0 THEN p.proname ELSE '(unexpected)' END||':'
          ||t.tgtype::text||':'
          ||COALESCE((SELECT string_agg(a.attname,',' ORDER BY a.attname) FROM pg_attribute a
            WHERE a.attrelid=t.tgrelid AND a.attnum=ANY(t.tgattr)),'')||':'
          ||t.tgenabled::text||':'||t.tgdeferrable::text||':'||t.tginitdeferred::text AS trigger
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace fn ON fn.oid=p.pronamespace
        WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname=ANY($1)`, protectedTables)
	if err != nil {
		return err
	}
	distinct := slices.Clone(actual)
	slices.Sort(distinct)
	distinct = slices.Compact(distinct)
	if len(distinct) != len(actual) || !sameGrants(actual, protectionTriggers) {
		return ErrProtectionDrift
	}
	return nil
}
