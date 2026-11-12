package manifest

import (
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/authorization/core"
	"hrm/api/internal/database"
)

func boundaryForm(boundary core.PermissionBoundary) (string, error) {
	return canonical(struct {
		Key     string               `json:"key"`
		Version int                  `json:"version"`
		Entries []core.BoundaryEntry `json:"entries"`
	}{boundary.Key, boundary.Version, boundary.Entries})
}

func applyBoundaries(tx *database.Tx, release Release) error {
	for _, boundary := range release.declarations.Boundaries() {
		form, err := boundaryForm(boundary)
		if err != nil {
			return err
		}
		rows, err := tx.Query(`SELECT encode(definition_hash, 'hex') AS hash, lifecycle FROM permission_boundary
       WHERE boundary_key = $1 AND boundary_version = $2`, []byte(boundary.Key), boundary.Version)
		if err != nil {
			return err
		}
		found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[definitionState])
		if err != nil {
			return err
		}
		lifecycle := activeLifecycle(boundary.Lifecycle)
		if len(found) == 0 {
			if _, err := tx.Exec(`INSERT INTO permission_boundary VALUES ($1, $2, decode($3, 'hex'), $4, $5)`, []byte(boundary.Key), boundary.Version, digest(form), form, lifecycle); err != nil {
				return err
			}
			for _, entry := range boundary.Entries {
				entryForm, err := canonical(entry)
				if err != nil {
					return err
				}
				if _, err := tx.Exec(`INSERT INTO permission_boundary_entry VALUES ($1, $2, $3, $4)`, []byte(boundary.Key), boundary.Version, []byte(entry.Permission), entryForm); err != nil {
					return err
				}
			}
		} else if found[0].Hash != digest(form) {
			return reject("immutable_definition")
		} else if found[0].Lifecycle != lifecycle {
			if _, err := tx.Exec(`UPDATE permission_boundary SET lifecycle = $3
         WHERE boundary_key = $1 AND boundary_version = $2`, []byte(boundary.Key), boundary.Version, lifecycle); err != nil {
				return err
			}
		}
	}
	for _, seed := range release.source.BoundaryBindings {
		rows, err := tx.Query(`SELECT convert_from(seed_owner, 'UTF8') AS owner, convert_from(boundary_key, 'UTF8') AS key,
              boundary_version AS version
       FROM user_boundary WHERE user_id = $1 AND permission_key = $2`, seed.Identity, []byte(seed.Permission))
		if err != nil {
			return err
		}
		type occupant struct {
			Owner   *string
			Key     string
			Version int
		}
		found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[occupant])
		if err != nil {
			return err
		}
		if len(found) > 0 {
			if found[0].Owner == nil || *found[0].Owner != seed.Owner {
				return reject("collision")
			}
			if found[0].Key == seed.Boundary.Key && found[0].Version == seed.Boundary.Version {
				continue
			}
			_, err = tx.Exec(`UPDATE user_boundary SET boundary_key = $3, boundary_version = $4
             WHERE user_id = $1 AND permission_key = $2`, seed.Identity, []byte(seed.Permission), []byte(seed.Boundary.Key), seed.Boundary.Version)
		} else {
			_, err = tx.Exec(`INSERT INTO user_boundary VALUES ($1, $2, $3, $4, $5)`, seed.Identity, []byte(seed.Permission), []byte(seed.Boundary.Key), seed.Boundary.Version, []byte(seed.Owner))
		}
		if err != nil {
			var driver *pgconn.PgError
			if errors.As(err, &driver) && driver.Code == "23503" {
				return reject("missing_reference")
			}
			return err
		}
	}
	for _, removal := range release.source.RemoveBoundaryBindings {
		if _, err := tx.Exec(`DELETE FROM user_boundary
       WHERE user_id = $1 AND permission_key = $2 AND seed_owner = $3`, removal.Identity, []byte(removal.Permission), []byte(removal.Owner)); err != nil {
			return err
		}
	}
	rows, err := tx.Query(`SELECT convert_from(d.boundary_key, 'UTF8') AS key, d.boundary_version AS version
     FROM permission_boundary d
     WHERE EXISTS (
       SELECT 1 FROM user_boundary b WHERE b.boundary_key = d.boundary_key AND b.boundary_version = d.boundary_version)`)
	if err != nil {
		return err
	}
	bound, err := pgx.CollectRows(rows, pgx.RowToStructByPos[core.RelationRef])
	if err != nil {
		return err
	}
	for _, ref := range bound {
		boundary, exists := release.declarations.Boundary(ref)
		if !exists || boundary.Lifecycle == core.LifecycleRetired {
			return reject("definition_in_use")
		}
	}
	return nil
}
