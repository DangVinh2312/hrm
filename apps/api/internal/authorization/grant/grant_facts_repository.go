package grant

import (
	"encoding/json/jsontext"
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/authorization/core"
	"hrm/api/internal/database"
)

// MaxFactRows caps one read for all accounts together; it is far above 2 x (300 grants x 100 roles).
const MaxFactRows = 20000

type Actor struct{ ID, Kind string }

var errNonCanonicalID = errors.New("account id is not a canonical uuid")

type factRow struct {
	Holder     string
	Source     string
	Effect     string
	Permission string
	Template   string
	Version    int
	Parameters string
}

// Read returns the rules of every role each account holds plus the rules attached to it, in one statement.
// truncated means more than maxRows rows exist: the answer is incomplete and a decision must refuse it.
// Ids must be canonical lowercase UUIDs: rows come back keyed by uuid::text, so another spelling that the
// uuid[] cast accepts would leave that account with no rules, which reads as the smallest grant set.
func Read(tx *database.Tx, c *core.Core, userIDs []string, maxRows int) (map[string][]GrantRuleFact, bool, error) {
	for _, id := range userIDs {
		if c == nil || !c.IsCanonicalUUID(id) {
			return nil, false, errNonCanonicalID
		}
	}
	rows, err := tx.Query(`SELECT holder::text, source, effect, permission, template, version, parameters::text FROM (SELECT ur.user_id AS holder, 'role' AS source, pr.effect AS effect,
              convert_from(pr.permission_key,'UTF8') AS permission,
              convert_from(pr.template_key,'UTF8') AS template,
              pr.template_version AS version, pr.parameters AS parameters
         FROM user_role ur JOIN policy_rule pr ON pr.role_key = ur.role_key
        WHERE ur.user_id = ANY(CAST($1 AS uuid[]))
       UNION ALL
       SELECT pr.user_id AS holder, 'user' AS source, pr.effect AS effect,
              convert_from(pr.permission_key,'UTF8') AS permission,
              convert_from(pr.template_key,'UTF8') AS template,
              pr.template_version AS version, pr.parameters AS parameters
         FROM policy_rule pr
        WHERE pr.user_id = ANY(CAST($1 AS uuid[]))) facts LIMIT CAST($2 AS int)`, userIDs, maxRows+1)
	if err != nil {
		return nil, false, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[factRow])
	if err != nil {
		return nil, false, err
	}
	facts := make(map[string][]GrantRuleFact, len(userIDs))
	for _, id := range userIDs {
		facts[id] = []GrantRuleFact{}
	}
	truncated := len(found) > maxRows
	for _, row := range found[:min(len(found), maxRows)] {
		parameters := jsontext.Value(row.Parameters)
		if err := parameters.Canonicalize(); err != nil {
			return nil, false, err
		}
		if _, ok := facts[row.Holder]; !ok {
			return nil, false, errors.New("grant fact for an account that was not asked")
		}
		facts[row.Holder] = append(facts[row.Holder], GrantRuleFact{Source: Source(row.Source), Effect: core.Effect(row.Effect), Permission: row.Permission, Template: core.RelationRef{Key: row.Template, Version: row.Version}, Parameters: string(parameters)})
	}
	return facts, truncated, nil
}

// WithinActor: an IAM actor may act on another account only when the target's grants are within its own.
// Root skips the comparison and reads nothing. actorGrants is what the comparison used, for a caller that also
// bounds something else by the actor's grants.
func WithinActor(tx *database.Tx, c *core.Core, actor Actor, target string) (bool, []GrantRuleFact, error) {
	switch actor.Kind {
	case "root":
		return true, []GrantRuleFact{}, nil
	case "iam":
	default:
		return false, nil, errors.New("unknown principal kind")
	}
	facts, truncated, err := Read(tx, c, []string{actor.ID, target}, MaxFactRows)
	if err != nil {
		return false, nil, err
	}
	return ProvenWithin(facts[target], facts[actor.ID], truncated), facts[actor.ID], nil
}
