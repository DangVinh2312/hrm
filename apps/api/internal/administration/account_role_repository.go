package administration

import (
	"encoding/json/jsontext"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/grant"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/database"
)

// MaxAccountRoles is the most roles one account may hold (ADR-13).
const MaxAccountRoles = 20

func sqlState(err error) string {
	if driver, ok := errors.AsType[*pgconn.PgError](err); ok {
		return driver.Code
	}
	return ""
}

// lockAccount serializes the commands on one account with the other writers of its row (suspend, reactivate).
func lockAccount(tx *database.Tx, userID string) error {
	_, err := tx.Exec(`SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, userID)
	return err
}

func roleExists(tx *database.Tx, roleKey string) (bool, error) {
	rows, err := tx.Query(`SELECT 1 FROM role_definition WHERE role_key=$1`, []byte(roleKey))
	if err != nil {
		return false, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[int])
	return len(found) == 1, err
}

type roleRuleRow struct {
	Effect     *string
	Permission *string
	Template   *string
	Version    *int
	Parameters *string
}

// roleRules is the rules of a role as grant facts; found is false for an absent role. At most
// keys.MaxRoleGrants rules are read: truncated means the role holds more and its inclusion in a set cannot be
// proven.
func roleRules(tx *database.Tx, roleKey string) ([]grant.GrantRuleFact, bool, bool, error) {
	rows, err := tx.Query(`SELECT pr.effect, convert_from(pr.permission_key,'UTF8') AS permission,
              convert_from(pr.template_key,'UTF8') AS template, pr.template_version AS version, pr.parameters::text
         FROM role_definition rd LEFT JOIN policy_rule pr ON pr.role_key = rd.role_key
        WHERE rd.role_key = $1 LIMIT CAST($2 AS int)`, []byte(roleKey), keys.MaxRoleGrants+1)
	if err != nil {
		return nil, false, false, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[roleRuleRow])
	if err != nil || len(found) == 0 {
		return nil, false, false, err
	}
	facts := []grant.GrantRuleFact{}
	for _, row := range found[:min(len(found), keys.MaxRoleGrants)] {
		if row.Permission == nil {
			continue
		}
		if row.Effect == nil || row.Template == nil || row.Version == nil || row.Parameters == nil {
			return nil, false, false, errors.New("incomplete policy rule of a role")
		}
		parameters := jsontext.Value(*row.Parameters)
		if err := parameters.Canonicalize(); err != nil {
			return nil, false, false, err
		}
		facts = append(facts, grant.GrantRuleFact{Source: grant.SourceRole, Effect: core.Effect(*row.Effect), Permission: *row.Permission, Template: core.RelationRef{Key: *row.Template, Version: *row.Version}, Parameters: string(parameters)})
	}
	return facts, len(found) > keys.MaxRoleGrants, true, nil
}

// holding is how many roles the account holds and whether roleKey is one of them, in one statement.
func holding(tx *database.Tx, userID, roleKey string) (int, bool, error) {
	rows, err := tx.Query(`SELECT count(*)::int AS count, COALESCE(bool_or(role_key = $2), false) AS held
         FROM user_role WHERE user_id = $1`, userID, []byte(roleKey))
	if err != nil {
		return 0, false, err
	}
	type held struct {
		Count int
		Held  bool
	}
	row, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByPos[held])
	return row.Count, row.Held, err
}

// insertAccountRole is false when the pair exists already (the primary key decides).
func insertAccountRole(tx *database.Tx, userID, roleKey string) (bool, error) {
	rows, err := tx.Query(`INSERT INTO user_role(user_id, role_key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1`, userID, []byte(roleKey))
	if err != nil {
		return false, err
	}
	inserted, err := pgx.CollectRows(rows, pgx.RowTo[int])
	return len(inserted) == 1, err
}

// deleteAccountRole is false when the pair is gone already.
func deleteAccountRole(tx *database.Tx, userID, roleKey string) (bool, error) {
	rows, err := tx.Query(`WITH gone AS (DELETE FROM user_role WHERE user_id = $1 AND role_key = $2 RETURNING 1)
       SELECT count(*)::int AS gone FROM gone`, userID, []byte(roleKey))
	if err != nil {
		return false, err
	}
	gone, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[int])
	return gone == 1, err
}

// suspendAccount ends every session of the account with its state: auth_epoch moves in the same UPDATE.
func suspendAccount(tx *database.Tx, userID string) error {
	_, err := tx.Exec(`UPDATE app_user SET state='suspended',auth_epoch=auth_epoch+1 WHERE id=$1`, userID)
	return err
}

// reactivateAccount is the SECURITY DEFINER function, which locks the row, refuses a non-IAM account and
// advances auth_epoch; an account that is not suspended (another command moved it first) is a conflict.
func reactivateAccount(tx *database.Tx, userID string) error {
	_, err := tx.Exec(`SELECT public.reactivate_iam_account($1)`, userID)
	if sqlState(err) == "55000" {
		return apperror.ErrCommandRejected
	}
	return err
}

// provisionAccount writes a pending IAM account and its 7-day enrollment at issuer; a taken email is a conflict.
func provisionAccount(tx *database.Tx, userID, email, issuer, actor string) error {
	_, err := tx.Exec(`SELECT public.provision_oidc_account($1,$2,$3,$4)`, userID, email, issuer, actor)
	if database.IsUniqueViolation(err) {
		return apperror.ErrCommandRejected
	}
	return err
}
