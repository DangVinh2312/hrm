package permission

import (
	"context"
	"errors"
	"maps"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"hrm/api/internal/database"
)

var ErrSchemaDrift = errors.New("permission schema drift")

func VerifyWorkCalendarSchema(ctx context.Context, pool *pgxpool.Pool) error {
	rows, err := pool.Query(ctx, `SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass($1) AND conname = $2 AND contype = 'c' AND convalidated`, "public.work_calendar_change", "ck_work_calendar_change_kind")
	if err != nil {
		return err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[int])
	if err != nil {
		return err
	}
	if len(found) != 1 {
		return ErrSchemaDrift
	}
	return nil
}

func VerifySettingSchema(ctx context.Context, pool *pgxpool.Pool) error {
	rows, err := pool.Query(ctx, `SELECT 1 FROM pg_trigger
      WHERE tgrelid = to_regclass($1) AND NOT tgisinternal AND tgenabled = 'O'
        AND tgname IN ('forbid_setting_history_row_change', 'forbid_setting_history_truncate')`, "public.system_setting_history")
	if err != nil {
		return err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[int])
	if err != nil {
		return err
	}
	if len(found) != 2 {
		return ErrSchemaDrift
	}
	return nil
}

func VerifyProtection(ctx context.Context, pool *pgxpool.Pool) error {
	rows, err := pool.Query(ctx, `SELECT r.rolname AS owner,p.prosecdef AS definer,p.provolatile AS volatility,p.prosrc AS body,p.proconfig AS config,
       (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
        OR has_schema_privilege(r.oid,'public','CREATE') OR EXISTS(SELECT FROM pg_auth_members m WHERE m.member=r.oid)) AS unsafe
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
      WHERE n.nspname='public' AND p.proname='hr_register_object' AND oidvectortypes(p.proargtypes)='text, uuid'`)
	if err != nil {
		return err
	}
	type function struct {
		Owner            string
		Definer          bool
		Volatility, Body string
		Config           []string
		Unsafe           bool
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[function])
	if err != nil {
		return err
	}
	acl, err := database.FunctionOwnerGrants(ctx, pool, "product_object_owner")
	if err != nil {
		return err
	}
	want := []string{"schema:public:USAGE", "table:object_ref:INSERT", "function:hr_register_object(text, uuid):EXECUTE"}
	slices.Sort(acl)
	slices.Sort(want)
	if len(found) != 1 || !slices.Equal(acl, want) {
		return database.ErrProtectionDrift
	}
	fn := found[0]
	if fn.Owner != "product_object_owner" || !fn.Definer || fn.Volatility != "v" || fn.Body != registerObjectBody || strings.Join(fn.Config, "|") != "search_path=pg_catalog, pg_temp" || fn.Unsafe {
		return database.ErrProtectionDrift
	}
	declared := scopeViewDefinitions()
	rows, err = pool.Query(ctx, `SELECT c.relname AS name,pg_get_viewdef(c.oid,false) AS definition,
       COALESCE(c.reloptions @> ARRAY['security_invoker=true'],false) AS invoker
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='v' AND c.relname=ANY($1)`, slices.Sorted(maps.Keys(declared)))
	if err != nil {
		return err
	}
	type view struct {
		Name, Definition string
		Invoker          bool
	}
	views, err := pgx.CollectRows(rows, pgx.RowToStructByPos[view])
	if err != nil {
		return err
	}
	if len(views) != len(declared) {
		return database.ErrProtectionDrift
	}
	for _, v := range views {
		if !v.Invoker || v.Definition != declared[v.Name] {
			return database.ErrProtectionDrift
		}
	}
	return nil
}
