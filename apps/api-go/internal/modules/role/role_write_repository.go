package role

import (
	"encoding/json/jsontext"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/database"
)

// storedRule is one rule of a role as the database holds it; Parameters is its RFC 8785 form.
type storedRule struct {
	RuleID     string
	Effect     string
	Permission string
	Template   string
	Version    int
	Parameters string
}

func runtimeRoleCount(tx *database.Tx) (int, error) {
	rows, err := tx.Query(`SELECT count(*)::int AS n FROM role_definition WHERE managed_by = 'runtime'`)
	if err != nil {
		return 0, err
	}
	return pgx.CollectExactlyOneRow(rows, pgx.RowTo[int])
}

// insertRole is false when the key is taken (the primary key decides, under the anchor lock).
func insertRole(tx *database.Tx, key, label string) (bool, error) {
	rows, err := tx.Query(`INSERT INTO role_definition(role_key, managed_by, label) VALUES ($1, 'runtime', $2)
       ON CONFLICT (role_key) DO NOTHING RETURNING 1`, []byte(key), label)
	if err != nil {
		return false, err
	}
	inserted, err := pgx.CollectRows(rows, pgx.RowTo[int])
	return len(inserted) == 1, err
}

// lockRole locks a runtime role; found is false for an absent role and for one the release owns.
func lockRole(tx *database.Tx, key string) (string, bool, error) {
	rows, err := tx.Query(`SELECT label FROM role_definition WHERE role_key = $1 AND managed_by = 'runtime' FOR UPDATE`, []byte(key))
	if err != nil {
		return "", false, err
	}
	labels, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(labels) == 0 {
		return "", false, err
	}
	return labels[0], true, nil
}

// rules reads at most keys.MaxRoleGrants rules; truncated means the role holds more, so this API did not write it.
func rules(tx *database.Tx, key string) ([]storedRule, bool, error) {
	rows, err := tx.Query(`SELECT rule_id::text, effect, convert_from(permission_key,'UTF8') AS permission,
              convert_from(template_key,'UTF8') AS template, template_version AS version, parameters::text
         FROM policy_rule WHERE role_key = $1 ORDER BY 3, 4, 5 LIMIT CAST($2 AS int)`, []byte(key), keys.MaxRoleGrants+1)
	if err != nil {
		return nil, false, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[storedRule])
	if err != nil {
		return nil, false, err
	}
	for i := range found {
		parameters := jsontext.Value(found[i].Parameters)
		if err := parameters.Canonicalize(); err != nil {
			return nil, false, err
		}
		found[i].Parameters = string(parameters)
	}
	return found[:min(len(found), keys.MaxRoleGrants)], len(found) > keys.MaxRoleGrants, nil
}

func insertRules(tx *database.Tx, key string, grants []GrantPair) error {
	if len(grants) == 0 {
		return nil
	}
	permissions, templates, versions := make([]string, len(grants)), make([]string, len(grants)), make([]int, len(grants))
	for i, g := range grants {
		permissions[i], templates[i], versions[i] = g.Permission, g.Template.Key, g.Template.Version
	}
	_, err := tx.Exec(`INSERT INTO policy_rule(rule_id, permission_key, user_id, role_key, effect, template_key,
                               template_version, parameters, managed_by)
       SELECT gen_random_uuid(), convert_to(g.permission,'UTF8'), NULL, $1, 'allow', convert_to(g.template,'UTF8'),
              g.version, '{}'::jsonb, 'runtime'
         FROM unnest($2::text[], $3::text[], $4::int[]) AS g(permission, template, version)`, []byte(key), permissions, templates, versions)
	return err
}

func deleteRules(tx *database.Tx, ruleIDs []string) error {
	if len(ruleIDs) == 0 {
		return nil
	}
	_, err := tx.Exec(`DELETE FROM policy_rule WHERE rule_id = ANY(CAST($1 AS uuid[]))`, ruleIDs)
	return err
}

func setLabel(tx *database.Tx, key, label string) error {
	_, err := tx.Exec(`UPDATE role_definition SET label = $2 WHERE role_key = $1`, []byte(key), label)
	return err
}

type references struct{ Held, Exception bool }

// referencesOf: any account in any state holds the role, or a record exception still names it.
func referencesOf(tx *database.Tx, key string) (references, error) {
	rows, err := tx.Query(`SELECT EXISTS (SELECT 1 FROM user_role WHERE role_key = $1) AS held,
              EXISTS (SELECT 1 FROM record_exception WHERE role_key = $1) AS exception`, []byte(key))
	if err != nil {
		return references{}, err
	}
	return pgx.CollectExactlyOneRow(rows, pgx.RowToStructByPos[references])
}

func deleteRole(tx *database.Tx, key string) error {
	if _, err := tx.Exec(`DELETE FROM policy_rule WHERE role_key = $1`, []byte(key)); err != nil {
		return err
	}
	_, err := tx.Exec(`DELETE FROM role_definition WHERE role_key = $1`, []byte(key))
	return err
}
