package manifest

import (
	"github.com/jackc/pgx/v5"

	"hrm/api/internal/database"
)

func objectID(tx *database.Tx, release Release, end Endpoint) (*string, error) {
	resource, exists := release.declarations.Resource(end.Type)
	if !exists {
		return nil, reject("invalid_release")
	}
	rows, err := tx.Query(`SELECT object_id::text AS id FROM object_ref WHERE type_key = $1 AND key_kind = $2 AND key_bytes = $3`, []byte(end.Type), resource.KeyKind, []byte(end.Key.Value))
	if err != nil {
		return nil, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(found) == 0 {
		return nil, err
	}
	return &found[0], nil
}

func applySeeds(tx *database.Tx, release Release, created map[string]bool) error {
	for _, role := range release.source.Roles {
		rows, err := tx.Query("SELECT managed_by, label FROM role_definition WHERE role_key = $1", []byte(role.Key))
		if err != nil {
			return err
		}
		type state struct{ ManagedBy, Label string }
		found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[state])
		if err != nil {
			return err
		}
		if len(found) == 0 {
			if _, err := tx.Exec(`INSERT INTO role_definition(role_key, managed_by, label) VALUES ($1, 'code', $2)`, []byte(role.Key), role.Label); err != nil {
				return err
			}
		} else if found[0].ManagedBy != "code" {
			return reject("collision")
		} else if found[0].Label != role.Label {
			if _, err := tx.Exec("UPDATE role_definition SET label = $2 WHERE role_key = $1", []byte(role.Key), role.Label); err != nil {
				return err
			}
		}
	}
	for _, grant := range release.source.DefaultGrants {
		if !created[grant.Permission] {
			continue
		}
		id, err := grantID(grant)
		if err != nil {
			return err
		}
		parameters, err := canonical(grant.Parameters)
		if err != nil {
			return err
		}
		inserted, err := tx.Exec(`INSERT INTO policy_rule (rule_id,permission_key,user_id,role_key,effect,template_key,template_version,parameters,managed_by) VALUES ($1, $2, NULL, $3, 'allow', $4, $5, $6, 'code') ON CONFLICT DO NOTHING`, id, []byte(grant.Permission), []byte(grant.Role), []byte(grant.Template.Key), grant.Template.Version, parameters)
		if err != nil {
			return err
		}
		if inserted.RowsAffected() == 0 {
			rows, err := tx.Query(`SELECT 1 FROM policy_rule WHERE rule_id=$1 AND permission_key=$2 AND user_id IS NULL
          AND role_key=$3 AND effect='allow' AND template_key=$4 AND template_version=$5
          AND parameters=$6::jsonb AND managed_by='code' AND system_owner IS NULL`, id, []byte(grant.Permission), []byte(grant.Role), []byte(grant.Template.Key), grant.Template.Version, parameters)
			if err != nil {
				return err
			}
			matching, err := pgx.CollectRows(rows, pgx.RowTo[int])
			if err != nil {
				return err
			}
			if len(matching) != 1 {
				return reject("collision")
			}
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
		if source == nil || target == nil {
			return reject("missing_reference")
		}
		rows, err := tx.Query(`SELECT convert_from(seed_owner, 'UTF8') AS owner, convert_from(seed_key, 'UTF8') AS key FROM relation_edge
       WHERE relation_key = $1 AND relation_version = $2 AND source_object = $3 AND target_object = $4`, []byte(seed.Relation.Key), seed.Relation.Version, *source, *target)
		if err != nil {
			return err
		}
		type occupant struct{ Owner, Key *string }
		found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[occupant])
		if err != nil {
			return err
		}
		if len(found) > 0 && (found[0].Owner == nil || found[0].Key == nil || *found[0].Owner != seed.Owner || *found[0].Key != seed.Key) {
			return reject("collision")
		}
		rows, err = tx.Query("SELECT 1 FROM relation_edge WHERE seed_owner = $1 AND seed_key = $2", []byte(seed.Owner), []byte(seed.Key))
		if err != nil {
			return err
		}
		own, err := pgx.CollectRows(rows, pgx.RowTo[int])
		if err != nil {
			return err
		}
		var expires *string
		if seed.ExpiresAt != "" {
			expires = &seed.ExpiresAt
		}
		if len(own) > 0 {
			_, err = tx.Exec(`UPDATE relation_edge SET relation_key = $1, relation_version = $2, source_object = $3, source_type = $4,
             target_object = $5, target_type = $6, starts_at = $7, expires_at = $8
           WHERE seed_owner = $9 AND seed_key = $10`, []byte(seed.Relation.Key), seed.Relation.Version, *source, []byte(seed.Source.Type), *target, []byte(seed.Target.Type), seed.StartsAt, expires, []byte(seed.Owner), []byte(seed.Key))
		} else {
			_, err = tx.Exec(`INSERT INTO relation_edge (relation_key, relation_version, source_object, source_type, target_object,
             target_type, starts_at, expires_at, seed_owner, seed_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, []byte(seed.Relation.Key), seed.Relation.Version, *source, []byte(seed.Source.Type), *target, []byte(seed.Target.Type), seed.StartsAt, expires, []byte(seed.Owner), []byte(seed.Key))
		}
		if err != nil {
			return err
		}
	}
	for _, removal := range release.source.RemoveSeeds {
		if _, err := tx.Exec("DELETE FROM relation_edge WHERE seed_owner = $1 AND seed_key = $2", []byte(removal.Owner), []byte(removal.Key)); err != nil {
			return err
		}
	}
	return nil
}
