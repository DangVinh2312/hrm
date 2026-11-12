//go:build integration

package offline_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api/test"
)

const historyTables = "'goose_db_version'"

// aclText prints an ACL item by item, sorted, because the order inside the array depends on the order of
// the grants. NULL stays distinct from an empty ACL: NULL means the default privileges.
func aclText(column string) string {
	return `CASE WHEN ` + column + ` IS NULL THEN '<default>' ELSE COALESCE((SELECT string_agg(item,',' ORDER BY item) FROM (
		SELECT pg_get_userbyid(a.grantor)::text||'>'||CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END||':'||a.privilege_type||CASE WHEN a.is_grantable THEN '+' ELSE '' END AS item
		FROM aclexplode(` + column + `) a) items),'<empty>') END`
}

// owned keeps what belongs to the schema: pg_catalog and the goose history table stays out.
const owned = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp\_%'`

const notHistory = `c.relname NOT IN (` + historyTables + `,'goose_db_version_id_seq')`

func catalogQueries() []string {
	return []string{
		`SELECT 'role|'||rolname||'|'||rolsuper||'|'||rolinherit||'|'||rolcreaterole||'|'||rolcreatedb||'|'||rolcanlogin||'|'||rolreplication||'|'||rolbypassrls||'|'||rolconnlimit||'|'||COALESCE(rolconfig::text,'') FROM pg_roles WHERE rolname NOT LIKE 'pg\_%'`,
		`SELECT 'member|'||r.rolname||'|'||m.rolname||'|'||g.rolname||'|'||a.admin_option||'|'||a.inherit_option||'|'||a.set_option FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor WHERE r.rolname NOT LIKE 'pg\_%'`,
		`SELECT 'database|'||datname||'|'||pg_get_userbyid(datdba)||'|'||pg_encoding_to_char(encoding)||'|'||datcollate||'|'||datctype||'|'||` + aclText("datacl") + ` FROM pg_database WHERE datname=current_database()`,
		`SELECT 'parameter|'||parname||'|'||` + aclText("paracl") + ` FROM pg_parameter_acl`,
		`SELECT 'schema|'||n.nspname||'|'||pg_get_userbyid(n.nspowner)||'|'||` + aclText("n.nspacl") + ` FROM pg_namespace n WHERE ` + owned,
		`SELECT 'default_acl|'||pg_get_userbyid(d.defaclrole)||'|'||COALESCE(n.nspname,'')||'|'||d.defaclobjtype::text||'|'||` + aclText("d.defaclacl") + ` FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace`,
		`SELECT 'extension|'||extname||'|'||extversion FROM pg_extension`,
		`SELECT 'relation|'||n.nspname||'.'||c.relname||'|'||c.relkind::text||'|'||pg_get_userbyid(c.relowner)||'|'||c.relpersistence::text||'|'||c.relreplident::text||'|'||c.relrowsecurity||'|'||c.relforcerowsecurity||'|'||COALESCE(c.reloptions::text,'')||'|'||` + aclText("c.relacl") + ` FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','S','f') AND ` + notHistory + ` AND ` + owned,
		`SELECT 'column|'||n.nspname||'.'||c.relname||'|'||t.attnum||'|'||t.attname||'|'||format_type(t.atttypid,t.atttypmod)||'|'||t.attnotnull||'|'||t.attidentity::text||'|'||t.attgenerated::text||'|'||t.attisdropped||'|'||COALESCE(pg_get_expr(d.adbin,d.adrelid),'')||'|'||COALESCE(co.collname,'')||'|'||` + aclText("t.attacl") + `
			FROM pg_attribute t JOIN pg_class c ON c.oid=t.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
			LEFT JOIN pg_attrdef d ON d.adrelid=t.attrelid AND d.adnum=t.attnum LEFT JOIN pg_collation co ON co.oid=t.attcollation AND t.attcollation<>0
			WHERE t.attnum>0 AND c.relkind IN ('r','p','v','m','f') AND ` + notHistory + ` AND ` + owned,
		`SELECT 'constraint|'||n.nspname||'.'||COALESCE(c.relname,'')||'|'||k.conname||'|'||k.contype::text||'|'||k.condeferrable||'|'||k.condeferred||'|'||k.convalidated||'|'||pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace LEFT JOIN pg_class c ON c.oid=k.conrelid WHERE COALESCE(c.relname,'') NOT IN (` + historyTables + `) AND ` + owned,
		`SELECT 'index|'||n.nspname||'.'||c.relname||'|'||pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE t.relname NOT IN (` + historyTables + `) AND ` + owned,
		`SELECT 'function|'||n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')|'||pg_get_userbyid(p.proowner)||'|'||p.prosecdef||'|'||p.provolatile::text||'|'||p.prokind::text||'|'||COALESCE(p.proconfig::text,'')||'|'||md5(p.prosrc)||'|'||CASE WHEN p.prokind IN ('f','p') THEN md5(pg_get_functiondef(p.oid)) ELSE '' END||'|'||` + aclText("p.proacl") + ` FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ` + owned,
		`SELECT 'trigger|'||c.relname||'|'||t.tgname||'|'||t.tgenabled::text||'|'||pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND ` + owned,
		`SELECT 'view|'||n.nspname||'.'||c.relname||'|'||pg_get_viewdef(c.oid,false) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('v','m') AND ` + owned,
		`SELECT 'sequence|'||n.nspname||'.'||c.relname||'|'||format_type(s.seqtypid,NULL)||'|'||s.seqstart||'|'||s.seqincrement||'|'||s.seqmax||'|'||s.seqmin||'|'||s.seqcache||'|'||s.seqcycle FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ` + notHistory + ` AND ` + owned,
		`SELECT 'type|'||n.nspname||'.'||t.typname||'|'||t.typtype::text||'|'||pg_get_userbyid(t.typowner) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typtype IN ('e','d','r','m') AND ` + owned,
		`SELECT 'enum|'||t.typname||'|'||e.enumsortorder||'|'||e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid`,
		`SELECT 'policy|'||c.relname||'|'||p.polname||'|'||p.polcmd::text||'|'||p.polpermissive||'|'||COALESCE(pg_get_expr(p.polqual,p.polrelid),'')||'|'||COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid`,
		`SELECT 'rule|'||c.relname||'|'||r.rulename||'|'||pg_get_ruledef(r.oid) FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class WHERE r.rulename<>'_RETURN'`,
	}
}

func collectLines(ctx context.Context, conn *pgx.Conn, sql string) ([]string, error) {
	rows, err := conn.Query(ctx, sql)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// generatedColumns are what a migration fills from gen_random_uuid() or the clock, so two runs of the
// same SQL cannot agree on them. Everything else in these rows is compared.
var generatedColumns = map[string][]string{
	"audit_outbox":        {"event_id", "occurred_at"},
	"work_schedule":       {"id", "created_at"},
	"work_schedule_shift": {"schedule_id"},
}

// catalogDump exports the catalog of one database and every row of every table, sorted. It runs as the
// superuser and holds fixture data only.
func catalogDump(ctx context.Context, postgres *test.Postgres, database string) (lines []string, err error) {
	conn, err := postgres.ConnectSuperuser(ctx, database)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, conn.Close(ctx)) }()
	for _, query := range catalogQueries() {
		found, err := collectLines(ctx, conn, query)
		if err != nil {
			return nil, fmt.Errorf("%.60s: %w", query, err)
		}
		lines = append(lines, found...)
	}
	tables, err := collectLines(ctx, conn, `SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN (`+historyTables+`) ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	for _, table := range tables {
		columns := "t::text"
		if dropped := generatedColumns[table]; len(dropped) > 0 {
			columns = "(to_jsonb(t)-ARRAY['" + strings.Join(dropped, "','") + "'])::text"
		}
		found, err := collectLines(ctx, conn, `SELECT 'row|`+table+`|'||`+columns+` FROM public."`+table+`" t`)
		if err != nil {
			return nil, err
		}
		lines = append(lines, found...)
		count, err := collectLines(ctx, conn, `SELECT 'count|`+table+`|'||count(*) FROM public."`+table+`"`)
		if err != nil {
			return nil, err
		}
		lines = append(lines, count...)
	}
	sort.Strings(lines)
	return lines, nil
}

// schemaDump is the second, independent check: pg_dump of the server's own version. Sorted because the
// order of GRANT lines follows the order of the ACL array; the \restrict lines hold a random token.
func schemaDump(ctx context.Context, postgres *test.Postgres, database string) ([]string, error) {
	output, err := postgres.Exec(ctx, "pg_dump", "--schema-only", "--username="+test.Superuser(),
		"--exclude-table=public.migrations", "--exclude-table=public.migrations_id_seq",
		"--exclude-table=public.goose_db_version", "--exclude-table=public.goose_db_version_id_seq", database)
	if err != nil {
		return nil, err
	}
	var lines []string
	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(line, `\restrict`) || strings.HasPrefix(line, `\unrestrict`) {
			continue
		}
		lines = append(lines, line)
	}
	sort.Strings(lines)
	return lines, nil
}

// sortedDiff lists lines present on only one side, with their multiplicity.
func sortedDiff(a, b []string) []string {
	var diff []string
	i, j := 0, 0
	for i < len(a) || j < len(b) {
		switch {
		case j >= len(b) || (i < len(a) && a[i] < b[j]):
			diff = append(diff, "- "+a[i])
			i++
		case i >= len(a) || a[i] > b[j]:
			diff = append(diff, "+ "+b[j])
			j++
		default:
			i++
			j++
		}
	}
	return diff
}

func assertSame(t *testing.T, name string, a, b []string) {
	t.Helper()
	if !slices.IsSorted(a) || !slices.IsSorted(b) {
		t.Fatalf("%s: unsorted input", name)
	}
	diff := sortedDiff(a, b)
	if len(diff) == 0 {
		return
	}
	shown := diff
	if len(shown) > 60 {
		shown = shown[:60]
	}
	for i, line := range shown {
		if len(line) > 400 {
			shown[i] = line[:400] + "…"
		}
	}
	t.Fatalf("%s differs in %d lines (%d and %d lines):\n%s", name, len(diff), len(a), len(b), strings.Join(shown, "\n"))
}
