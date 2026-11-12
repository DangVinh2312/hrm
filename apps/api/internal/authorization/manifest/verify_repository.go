package manifest

import (
	"github.com/jackc/pgx/v5"

	"hrm/api/internal/database"
)

func verifyApplied(tx *database.Tx, release Release) error {
	for _, policy := range release.declarations.Policies() {
		form, err := canonical(policy)
		if err != nil {
			return err
		}
		rows, err := tx.Query(`SELECT 1 FROM permission_policy WHERE policy_key = $1 AND policy_version = $2
       AND definition_hash = decode($3, 'hex')`, []byte(policy.Key), policy.Version, digest(form))
		if err != nil {
			return err
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[int])
		if err != nil {
			return err
		}
		if len(found) == 0 {
			return reject("not_ready")
		}
	}
	for _, resource := range release.declarations.Resources() {
		for action, declaration := range resource.Actions {
			rows, err := tx.Query(`SELECT 1 FROM permission_catalog WHERE permission_key = $1 AND policy_key = $2
         AND policy_version = $3 AND lifecycle = 'active' AND boundary_requirement = $4`, []byte(resource.Key+"."+action), []byte(declaration.Policy.Key), declaration.Policy.Version, declaration.Boundary)
			if err != nil {
				return err
			}
			found, err := pgx.CollectRows(rows, pgx.RowTo[int])
			if err != nil {
				return err
			}
			if len(found) == 0 {
				return reject("not_ready")
			}
		}
	}
	for _, boundary := range release.declarations.Boundaries() {
		form, err := boundaryForm(boundary)
		if err != nil {
			return err
		}
		rows, err := tx.Query(`SELECT 1 FROM permission_boundary WHERE boundary_key = $1 AND boundary_version = $2
       AND definition_hash = decode($3, 'hex') AND lifecycle = $4`, []byte(boundary.Key), boundary.Version, digest(form), activeLifecycle(boundary.Lifecycle))
		if err != nil {
			return err
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[int])
		if err != nil {
			return err
		}
		if len(found) == 0 {
			return reject("not_ready")
		}
	}
	for _, seed := range release.source.BoundaryBindings {
		rows, err := tx.Query(`SELECT 1 FROM user_boundary WHERE user_id = $1
       AND permission_key = $2 AND boundary_key = $3 AND boundary_version = $4 AND seed_owner = $5`, seed.Identity, []byte(seed.Permission), []byte(seed.Boundary.Key), seed.Boundary.Version, []byte(seed.Owner))
		if err != nil {
			return err
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[int])
		if err != nil {
			return err
		}
		if len(found) == 0 {
			return reject("not_ready")
		}
	}
	for _, role := range release.source.Roles {
		rows, err := tx.Query(`SELECT 1 FROM role_definition WHERE role_key = $1 AND managed_by = 'code'`, []byte(role.Key))
		if err != nil {
			return err
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[int])
		if err != nil {
			return err
		}
		if len(found) == 0 {
			return reject("not_ready")
		}
	}
	for _, seed := range release.source.Seeds {
		source, err := objectID(tx, release, seed.Source)
		if err != nil {
			return err
		}
		target, err := objectID(tx, release, seed.Target)
		if err != nil {
			return err
		}
		var expires *string
		if seed.ExpiresAt != "" {
			expires = &seed.ExpiresAt
		}
		rows, err := tx.Query(`SELECT 1 FROM relation_edge WHERE seed_owner = $1 AND seed_key = $2 AND relation_key = $3
       AND relation_version = $4 AND source_object = $5 AND target_object = $6 AND starts_at = $7
       AND expires_at IS NOT DISTINCT FROM $8::timestamptz`, []byte(seed.Owner), []byte(seed.Key), []byte(seed.Relation.Key), seed.Relation.Version, source, target, seed.StartsAt, expires)
		if err != nil {
			return err
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[int])
		if err != nil {
			return err
		}
		if len(found) == 0 {
			return reject("not_ready")
		}
	}
	return nil
}
