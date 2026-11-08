package database

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const definerSearchPath = "search_path=pg_catalog, pg_temp"

var (
	// ErrUnsafeCredential means a login is not the one its pool is for, or can do more than its grants say.
	ErrUnsafeCredential = errors.New("unsafe product credential")
	// ErrProtectionDrift means a protection function, trigger, view or owner differs from the declarations.
	ErrProtectionDrift = errors.New("product protection drift")
	// ErrUnknownOwner is a programming error of the caller.
	ErrUnknownOwner = errors.New("database: unknown function owner")

	verifyOrder = []Purpose{PurposeData, PurposeIdentity, PurposeAuthority, PurposeSync, PurposeBootstrap, PurposeOutbox}
)

type protectionFunction struct {
	name    string
	owner   string
	definer bool
	body    string
}

// PrivilegeDriftError lists grants, which hold object names only, never a value or a secret.
type PrivilegeDriftError struct {
	Purpose    Purpose
	Unexpected []string
	Missing    []string
}

func (e *PrivilegeDriftError) Error() string {
	return fmt.Sprintf("product privilege drift for %s: unexpected [%s], missing [%s]",
		e.Purpose, strings.Join(e.Unexpected, ", "), strings.Join(e.Missing, ", "))
}

// FunctionOwners gives a copy of the NOLOGIN owners of the SECURITY DEFINER functions.
func FunctionOwners() []string {
	return slices.Clone(functionOwners)
}

// grantsOf lists grantee-filtered grants on every table, column and function in a non-system schema
// (objects outside public are reported schema-qualified), plus schema grants when withSchemas.
func grantsOf(grantees string, withSchemas bool) string {
	schemas := ""
	if withSchemas {
		schemas = `SELECT 'schema:'||q.nspname AS object,a.privilege_type,a.is_grantable,a.grantee FROM pg_namespace n JOIN schemas q ON q.oid=n.oid,aclexplode(n.nspacl) a UNION ALL`
	}
	return `WITH schemas AS (SELECT oid,nspname,CASE WHEN nspname='public' THEN '' ELSE nspname||'.' END AS prefix FROM pg_namespace
        WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg\_toast%' AND nspname NOT LIKE 'pg\_temp\_%'),
      acl AS (
        ` + schemas + `
        SELECT 'table:'||q.prefix||c.relname AS object,a.privilege_type,a.is_grantable,a.grantee
          FROM pg_class c JOIN schemas q ON q.oid=c.relnamespace,aclexplode(c.relacl) a
        UNION ALL
        SELECT 'column:'||q.prefix||c.relname||'.'||t.attname,a.privilege_type,a.is_grantable,a.grantee
          FROM pg_attribute t JOIN pg_class c ON c.oid=t.attrelid JOIN schemas q ON q.oid=c.relnamespace,
          aclexplode(t.attacl) a WHERE t.attnum>0 AND NOT t.attisdropped
        UNION ALL
        SELECT 'function:'||q.prefix||p.proname||'('||oidvectortypes(p.proargtypes)||')',a.privilege_type,a.is_grantable,a.grantee
          FROM pg_proc p JOIN schemas q ON q.oid=p.pronamespace,aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)
      SELECT DISTINCT object||':'||privilege_type||CASE WHEN is_grantable THEN '+grant' ELSE '' END AS grant
        FROM acl WHERE grantee IN (` + grantees + `)`
}

func collectStrings(ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) ([]string, error) {
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// queryValid reads one boolean; no row and NULL both mean the check did not hold.
func queryValid(ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) (bool, error) {
	var valid *bool
	if err := pool.QueryRow(ctx, sql, args...).Scan(&valid); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return valid != nil && *valid, nil
}

// FunctionOwnerGrants gives the exact ACL, schema grants included, of one NOLOGIN function owner.
func FunctionOwnerGrants(ctx context.Context, pool *pgxpool.Pool, owner string) ([]string, error) {
	if !slices.Contains(functionOwners, owner) {
		return nil, ErrUnknownOwner
	}
	return collectStrings(ctx, pool, grantsOf("SELECT oid FROM pg_roles WHERE rolname='"+owner+"'", true))
}

func sameGrants(actual, wanted []string) bool {
	return len(actual) == len(wanted) && !slices.ContainsFunc(wanted, func(grant string) bool {
		return !slices.Contains(actual, grant)
	})
}

// VerifyPrivileges fails closed if credentials or narrow DB capabilities drift. Every table, column and
// function grant held directly or through PUBLIC in any non-system schema must equal the declared set
// plus expected, the grants on application-owned tables. Owning any object or schema, or CREATE on the
// database, is unsafe.
func VerifyPrivileges(ctx context.Context, pools Pools, expected map[Purpose][]string) error {
	for purpose := range pools {
		if !slices.Contains(verifyOrder, purpose) {
			return ErrUnsafeCredential
		}
	}
	for _, purpose := range verifyOrder {
		pool, present := pools[purpose]
		if !present {
			continue
		}
		if pool == nil {
			return ErrUnsafeCredential
		}
		if err := verifyLogin(ctx, pool, purpose); err != nil {
			return err
		}
		if err := verifyGrants(ctx, pool, purpose, expected[purpose]); err != nil {
			return err
		}
		if err := verifyDefinerOwners(ctx, pool); err != nil {
			return err
		}
		if err := verifyViews(ctx, pool); err != nil {
			return err
		}
		if err := verifyOwnerACLs(ctx, pool); err != nil {
			return err
		}
		if err := verifyFunctions(ctx, pool); err != nil {
			return err
		}
		if err := verifyTriggers(ctx, pool); err != nil {
			return err
		}
	}
	return nil
}

func verifyLogin(ctx context.Context, pool *pgxpool.Pool, purpose Purpose) error {
	var (
		name   string
		unsafe bool
	)
	err := pool.QueryRow(ctx, `SELECT current_user AS name,
      (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
       OR EXISTS(SELECT FROM pg_namespace n WHERE has_schema_privilege(current_user,n.oid,'CREATE'))
       OR has_database_privilege(current_user,current_database(),'CREATE')
       OR has_database_privilege(current_user,current_database(),'TEMP')
       -- a login must not be able to re-delegate the access it holds
       OR EXISTS(SELECT FROM pg_namespace n WHERE has_schema_privilege(current_user,n.oid,'USAGE WITH GRANT OPTION'))
       OR has_database_privilege(current_user,current_database(),'CONNECT WITH GRANT OPTION')
       -- replica mode skips every protection trigger
       OR has_parameter_privilege(current_user,'session_replication_role','SET')
       OR current_setting('session_replication_role')<>'origin'
       OR EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid)
       OR EXISTS(SELECT FROM pg_namespace n WHERE n.nspowner=r.oid)
       OR EXISTS(SELECT FROM pg_proc p WHERE p.proowner=r.oid)
       OR EXISTS(SELECT FROM pg_class c WHERE c.relowner=r.oid)) AS unsafe
       FROM pg_roles r WHERE r.rolname=current_user`).Scan(&name, &unsafe)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnsafeCredential
	}
	if err != nil {
		return err
	}
	if name != "product_"+string(purpose) || unsafe {
		return ErrUnsafeCredential
	}
	return nil
}

func verifyGrants(ctx context.Context, pool *pgxpool.Pool, purpose Purpose, additional []string) error {
	actual, err := collectStrings(ctx, pool, grantsOf("0,(SELECT oid FROM pg_roles WHERE rolname=current_user)", false))
	if err != nil {
		return err
	}
	wanted := map[string]bool{}
	for _, grant := range expectedPrivileges[purpose] {
		wanted[grant] = true
	}
	for _, grant := range additional {
		wanted[grant] = true
	}
	var unexpected, missing []string
	held := map[string]bool{}
	for _, grant := range actual {
		held[grant] = true
		if !wanted[grant] {
			unexpected = append(unexpected, grant)
		}
	}
	for grant := range wanted {
		if !held[grant] {
			missing = append(missing, grant)
		}
	}
	if len(unexpected) > 0 || len(missing) > 0 {
		slices.Sort(unexpected)
		slices.Sort(missing)
		return &PrivilegeDriftError{Purpose: purpose, Unexpected: unexpected, Missing: missing}
	}
	return nil
}
