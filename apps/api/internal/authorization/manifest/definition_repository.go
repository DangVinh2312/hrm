package manifest

import (
	"maps"
	"slices"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/authorization/core"
	"hrm/api/internal/database"
)

func applyDefinitions(tx *database.Tx, release Release) (map[string]bool, error) {
	d := release.declarations
	for _, resource := range d.Resources() {
		rows, err := tx.Query("SELECT key_kind FROM resource_type WHERE type_key = $1", []byte(resource.Key))
		if err != nil {
			return nil, err
		}
		kinds, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return nil, err
		}
		if len(kinds) == 0 {
			if _, err := tx.Exec("INSERT INTO resource_type VALUES ($1, $2, $1)", []byte(resource.Key), resource.KeyKind); err != nil {
				return nil, err
			}
		} else if kinds[0] != string(resource.KeyKind) {
			return nil, reject("immutable_definition")
		}
	}
	for _, policy := range d.Policies() {
		form, err := canonical(policy)
		if err != nil {
			return nil, err
		}
		rows, err := tx.Query(`SELECT encode(definition_hash, 'hex') AS hash, lifecycle FROM permission_policy
       WHERE policy_key = $1 AND policy_version = $2`, []byte(policy.Key), policy.Version)
		if err != nil {
			return nil, err
		}
		found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[definitionState])
		if err != nil {
			return nil, err
		}
		lifecycle := activeLifecycle(policy.Lifecycle)
		if len(found) == 0 {
			if _, err := tx.Exec("INSERT INTO permission_policy VALUES ($1, $2, decode($3, $4), $5, $6)", []byte(policy.Key), policy.Version, digest(form), "hex", form, lifecycle); err != nil {
				return nil, err
			}
		} else if found[0].Hash != digest(form) {
			return nil, reject("immutable_definition")
		} else if found[0].Lifecycle != lifecycle {
			if _, err := tx.Exec("UPDATE permission_policy SET lifecycle = $3 WHERE policy_key = $1 AND policy_version = $2", []byte(policy.Key), policy.Version, lifecycle); err != nil {
				return nil, err
			}
		}
	}
	for _, template := range d.Templates() {
		form, err := canonical(template)
		if err != nil {
			return nil, err
		}
		rows, err := tx.Query(`SELECT encode(definition_hash, 'hex') AS hash FROM scope_template WHERE template_key = $1 AND version = $2`, []byte(template.Key), template.Version)
		if err != nil {
			return nil, err
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return nil, err
		}
		if len(found) == 0 {
			if _, err := tx.Exec(`INSERT INTO scope_template VALUES ($1, $2, decode($3, 'hex'))`, []byte(template.Key), template.Version, digest(form)); err != nil {
				return nil, err
			}
		} else if found[0] != digest(form) {
			return nil, reject("immutable_definition")
		}
	}
	for _, relation := range d.Relations() {
		if relation.Target.Kind != core.RelationTargetResource {
			continue
		}
		form, err := canonical(relation)
		if err != nil {
			return nil, err
		}
		rows, err := tx.Query(`SELECT encode(definition_hash, 'hex') AS hash FROM resource_relation_definition
       WHERE relation_key = $1 AND relation_version = $2`, []byte(relation.Key), relation.Version)
		if err != nil {
			return nil, err
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return nil, err
		}
		binding := relation.Key
		if relation.Binding.Kind == core.BindingDomain {
			binding = relation.Binding.Key
		}
		if len(found) == 0 {
			if _, err := tx.Exec(`INSERT INTO resource_relation_definition VALUES ($1, $2, $3, $4, $5, $6, decode($7, 'hex'), 'active')`, []byte(relation.Key), relation.Version, []byte(relation.SourceType), []byte(relation.Target.Type), relation.Binding.Kind, []byte(binding), digest(form)); err != nil {
				return nil, err
			}
		} else if found[0] != digest(form) {
			return nil, reject("immutable_definition")
		}
	}
	created := map[string]bool{}
	declared := []string{}
	for _, resource := range d.Resources() {
		for _, action := range slices.Sorted(maps.Keys(resource.Actions)) {
			declaration := resource.Actions[action]
			permission := resource.Key + "." + action
			declared = append(declared, permission)
			rows, err := tx.Query(`SELECT convert_from(policy_key, 'UTF8') AS policy_key, policy_version, lifecycle,
                boundary_requirement AS boundary
         FROM permission_catalog WHERE permission_key = $1`, []byte(permission))
			if err != nil {
				return nil, err
			}
			type state struct {
				Key       string
				Version   int
				Lifecycle string
				Boundary  *string
			}
			found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[state])
			if err != nil {
				return nil, err
			}
			if len(found) == 0 {
				if _, err := tx.Exec(`INSERT INTO permission_catalog VALUES ($1, $2, $3, $4, $5, 'active', $6)`, []byte(permission), []byte(resource.Key), []byte(action), []byte(declaration.Policy.Key), declaration.Policy.Version, declaration.Boundary); err != nil {
					return nil, err
				}
				created[permission] = true
			} else if f := found[0]; f.Key != declaration.Policy.Key || f.Version != declaration.Policy.Version || f.Lifecycle != "active" || f.Boundary == nil || *f.Boundary != string(declaration.Boundary) {
				if _, err := tx.Exec(`UPDATE permission_catalog SET policy_key = $2, policy_version = $3, lifecycle = 'active',
               boundary_requirement = $4
             WHERE permission_key = $1`, []byte(permission), []byte(declaration.Policy.Key), declaration.Policy.Version, declaration.Boundary); err != nil {
					return nil, err
				}
			}
		}
	}
	_, err := tx.Exec(`UPDATE permission_catalog SET lifecycle = 'deprecated',
       boundary_requirement = COALESCE(boundary_requirement, 'required')
     WHERE lifecycle = 'active' AND convert_from(permission_key, 'UTF8') <> ALL ($1::text[])`, declared)
	return created, err
}

type definitionState struct{ Hash, Lifecycle string }

func activeLifecycle(lifecycle core.Lifecycle) string {
	if lifecycle == "" {
		return "active"
	}
	return string(lifecycle)
}
