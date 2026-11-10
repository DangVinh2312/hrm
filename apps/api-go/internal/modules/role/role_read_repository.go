package role

import (
	"cmp"
	"encoding/json/v2"
	"errors"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/grant"
)

// shortcut: far above the runtime role limits (100 runtime roles, 300 grants per role) and the code roles of a
// release; a larger catalog is cut and reported as truncated, never an unbounded response. Revisit with the
// write path, which enforces the limits.
const (
	maxRoles         = 200
	maxGrantsPerRole = 500
	maxAccountRoles  = 200
	maxAccountGrants = 5000
	effectAllow      = "allow"
)

type storedRow struct {
	Key     string
	Label   string
	Source  Source
	Holders int
	Grants  string
}

type storedRole struct {
	Key     string
	Label   string
	Source  Source
	Holders int
	Grants  []GrantView
}

func pairsOf(grants []GrantView) []GrantPair {
	pairs := make([]GrantPair, len(grants))
	for i, g := range grants {
		pairs[i] = GrantPair{Permission: g.Permission, Template: TemplateRef{Key: g.Template, Version: g.Version}}
	}
	return pairs
}

// withDerived: the digest covers every stored rule as role.update reads it, the capabilities only allow rules.
func withDerived(role storedRole) (View, error) {
	digest, err := grant.GrantsDigest(role.Label, specs(pairsOf(role.Grants)))
	if err != nil {
		return View{}, err
	}
	allowed := slices.DeleteFunc(slices.Clone(role.Grants), func(g GrantView) bool { return g.Effect != effectAllow })
	return View{Key: role.Key, Label: role.Label, Source: role.Source, Holders: role.Holders, Digest: digest, Capabilities: capabilities(pairsOf(allowed)), Grants: role.Grants}, nil
}

// reaches: the plan of the action reaches the role anchor, so the caller holds the grant.
func reaches(c authority.QueryContext) (bool, error) {
	args, _, err := c.Scope.Args()
	if err != nil {
		return false, err
	}
	rows, err := c.Tx.Query(`SELECT EXISTS (SELECT 1 FROM role_anchor r WHERE `+c.Scope.SQL+`) AS ok`, args...)
	if err != nil {
		return false, err
	}
	return pgx.CollectExactlyOneRow(rows, pgx.RowTo[bool])
}

// readMatrix is role.read: roles with their rules and holder counts in one statement; a caller the plan does not
// reach finds nothing (404).
func readMatrix(catalog []GrantPair) func(authority.QueryContext, struct{}) (authority.QueryResult[MatrixView], error) {
	return func(c authority.QueryContext, _ struct{}) (authority.QueryResult[MatrixView], error) {
		var none authority.QueryResult[MatrixView]
		if ok, err := reaches(c); err != nil || !ok {
			return none, err
		}
		rows, err := c.Tx.Query(`SELECT convert_from(d.role_key,'UTF8') AS key, d.label AS label, d.managed_by AS source,
                (SELECT count(*)::int FROM user_role u WHERE u.role_key = d.role_key) AS holders,
                COALESCE((SELECT json_agg(json_build_object(
                            'permission', g.permission, 'effect', g.effect, 'template', g.template,
                            'version', g.version, 'parameters', g.parameters)
                          ORDER BY g.permission, g.template, g.version)
                   FROM (SELECT convert_from(p.permission_key,'UTF8') AS permission, p.effect AS effect,
                                convert_from(p.template_key,'UTF8') AS template,
                                p.template_version AS version, p.parameters AS parameters
                           FROM policy_rule p WHERE p.role_key = d.role_key
                          ORDER BY 1, 3, 4 LIMIT ` + strconv.Itoa(maxGrantsPerRole+1) + `) g), '[]'::json)::text AS grants
           FROM role_definition d ORDER BY d.managed_by, d.role_key LIMIT ` + strconv.Itoa(maxRoles+1))
		if err != nil {
			return none, err
		}
		found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[storedRow])
		if err != nil {
			return none, err
		}
		view := MatrixView{Roles: []View{}, Catalog: catalog, Truncated: len(found) > maxRoles}
		for _, row := range found[:min(len(found), maxRoles)] {
			role := storedRole{Key: row.Key, Label: row.Label, Source: row.Source, Holders: row.Holders}
			if err := json.Unmarshal([]byte(row.Grants), &role.Grants); err != nil {
				return none, err
			}
			view.Truncated = view.Truncated || len(role.Grants) > maxGrantsPerRole
			role.Grants = role.Grants[:min(len(role.Grants), maxGrantsPerRole)]
			derived, err := withDerived(role)
			if err != nil {
				return none, err
			}
			view.Roles = append(view.Roles, derived)
		}
		return authority.QueryResult[MatrixView]{Found: true, Value: view}, nil
	}
}

type accountColumns struct {
	OK                       bool
	Boundaries, Roles, Facts string
}

type accountRow struct {
	Roles      []HeldRole
	Boundaries []BoundaryView
	Facts      []AccountGrant
}

type grantIdentity struct {
	permission, effect, template, parameters, source string
	version                                          int
}

// distinctGrants drops repeated rules (two roles granting the same rule) and sorts by permission then template.
// Keys are ASCII, so byte order is the localeCompare order of the TypeScript API except for template pairs of
// different resources, which never share a permission.
func distinctGrants(facts []AccountGrant) ([]AccountGrant, error) {
	seen := map[grantIdentity]bool{}
	grants := []AccountGrant{}
	for _, fact := range facts {
		parameters := slices.Clone(fact.Parameters)
		if err := parameters.Canonicalize(); err != nil {
			return nil, err
		}
		id := grantIdentity{fact.Permission, fact.Effect, fact.Template, string(parameters), fact.Source, fact.Version}
		if seen[id] {
			continue
		}
		seen[id] = true
		grants = append(grants, fact)
	}
	slices.SortStableFunc(grants, func(a, b AccountGrant) int {
		return cmp.Or(strings.Compare(a.Permission, b.Permission), strings.Compare(a.Template, b.Template))
	})
	return grants, nil
}

// readAccount is account.readPermissions: the target is looked up through the IAM-only projection under the
// caller's own scope, so Root, an absent id and an account the plan does not reach all find nothing (404).
func readAccount(c authority.QueryContext, accountID string) (authority.QueryResult[AccountPermissionView], error) {
	var none authority.QueryResult[AccountPermissionView]
	args, at, err := c.Scope.Args(accountID)
	if err != nil {
		return none, err
	}
	target := `CAST(` + at(1) + ` AS uuid)`
	rows, err := c.Tx.Query(`WITH target AS (SELECT 1 FROM account_directory r WHERE `+c.Scope.SQL+` AND r.id = `+target+`),
              held AS (SELECT d.role_key AS rk, convert_from(d.role_key,'UTF8') AS key, d.label AS label, d.managed_by AS source
                         FROM user_role u JOIN role_definition d ON d.role_key = u.role_key
                        WHERE u.user_id = `+target+` AND EXISTS (SELECT 1 FROM target)
                        ORDER BY d.role_key LIMIT `+strconv.Itoa(maxAccountRoles+1)+`),
              facts AS (SELECT source, effect, permission, template, version, parameters FROM (
                          SELECT 'role' AS source, pr.effect AS effect,
                                 convert_from(pr.permission_key,'UTF8') AS permission,
                                 convert_from(pr.template_key,'UTF8') AS template,
                                 pr.template_version AS version, pr.parameters AS parameters
                            FROM user_role ur JOIN policy_rule pr ON pr.role_key = ur.role_key
                           WHERE ur.user_id = `+target+`
                          UNION ALL
                          SELECT 'user', pr.effect, convert_from(pr.permission_key,'UTF8'),
                                 convert_from(pr.template_key,'UTF8'), pr.template_version, pr.parameters
                            FROM policy_rule pr WHERE pr.user_id = `+target+`) all_facts
                         WHERE EXISTS (SELECT 1 FROM target) LIMIT `+strconv.Itoa(maxAccountGrants+1)+`)
         SELECT EXISTS (SELECT 1 FROM target) AS ok,
                COALESCE((SELECT json_agg(json_build_object('permission', convert_from(b.permission_key,'UTF8'), 'key', convert_from(b.boundary_key,'UTF8'), 'version', b.boundary_version, 'seeded', b.seed_owner IS NOT NULL) ORDER BY b.permission_key)
                            FROM user_boundary b WHERE b.user_id = `+target+` AND EXISTS (SELECT 1 FROM target)), '[]'::json)::text AS boundaries,
                COALESCE((SELECT json_agg(json_build_object('key', h.key, 'label', h.label, 'source', h.source) ORDER BY h.rk) FROM held h), '[]'::json)::text AS roles,
                COALESCE((SELECT json_agg(json_build_object('source', f.source, 'effect', f.effect, 'permission', f.permission, 'template', f.template, 'version', f.version, 'parameters', f.parameters)) FROM facts f), '[]'::json)::text AS facts`, args...)
	if err != nil {
		return none, err
	}
	stored, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByPos[accountColumns])
	if err != nil || !stored.OK {
		return none, err
	}
	var row accountRow
	if err := errors.Join(json.Unmarshal([]byte(stored.Boundaries), &row.Boundaries), json.Unmarshal([]byte(stored.Roles), &row.Roles), json.Unmarshal([]byte(stored.Facts), &row.Facts)); err != nil {
		return none, err
	}
	grants, err := distinctGrants(row.Facts[:min(len(row.Facts), maxAccountGrants)])
	if err != nil {
		return none, err
	}
	return authority.QueryResult[AccountPermissionView]{Found: true, Value: AccountPermissionView{
		Roles:      row.Roles[:min(len(row.Roles), maxAccountRoles)],
		Grants:     grants,
		Boundaries: row.Boundaries,
		Truncated:  len(row.Roles) > maxAccountRoles || len(row.Facts) > maxAccountGrants,
	}}, nil
}
