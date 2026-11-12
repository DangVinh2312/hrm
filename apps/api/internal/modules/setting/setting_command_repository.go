package setting

import (
	"encoding/json/v2"
	"fmt"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/permission"
	"hrm/api/internal/modules/settingcore"
)

const (
	selectCurrent = `SELECT value, version::text AS version FROM system_setting WHERE key = $1 FOR UPDATE`
	updateCurrent = `WITH updated AS (
             UPDATE system_setting SET value = CAST($2 AS jsonb), version = version + 1,
                    updated_at = statement_timestamp(), updated_by = $3
              WHERE key = $1 RETURNING version)
           SELECT version::text AS version FROM updated`
	insertCurrent = `INSERT INTO system_setting(key, value, version, updated_at, updated_by)
           VALUES ($1, CAST($2 AS jsonb), 1, statement_timestamp(), $3)
           RETURNING version::text AS version`
	insertHistory = `INSERT INTO system_setting_history(key, version, old_value, new_value, changed_by, changed_at)
       VALUES ($1, CAST($2 AS int8), CAST($3 AS jsonb), CAST($4 AS jsonb), $5, statement_timestamp())`
)

var (
	ErrStaleVersion = fmt.Errorf("stale setting version: %w", apperror.ErrCommandRejected)
	ErrUnchanged    = fmt.Errorf("setting value unchanged: %w", apperror.ErrCommandRejected)
)

// Both commands run in write mode on the settings anchor, which Execute locks FOR NO KEY UPDATE, so
// writes of any key serialize and the later of two writers of one key sees the new version as stale.
var (
	updateRuleCommand    = updateCommand(keys.SettingActionUpdateRule, settingcore.GroupRule)
	updateProfileCommand = updateCommand(keys.SettingActionUpdateProfile, settingcore.GroupProfile)
)

type currentRow struct {
	Value   []byte
	Version string
}

func updateCommand(action keys.SettingAction, group settingcore.Group) *authority.Command[UpdateInput, UpdateResult] {
	return authority.NewCommand(string(keys.SettingResourceSetting), string(action), database.ModeWrite,
		func(UpdateInput) string { return permission.SettingID },
		func(c authority.CommandContext, input UpdateInput) (UpdateResult, error) {
			return apply(c, group, input)
		})
}

// apply is one change: one new version of one key. It does not trust its caller and validates the key,
// the group and the value again. The stored row, or the default when there is none, is the old value;
// the history records old and new in the same transaction and the audit event names the settings
// record only, never the key or the values. Nothing already recorded elsewhere is rewritten.
func apply(c authority.CommandContext, group settingcore.Group, input UpdateInput) (UpdateResult, error) {
	def, ok := settingcore.Lookup(string(input.Key))
	if !ok || def.Group != group {
		return UpdateResult{}, apperror.ErrInvalidRequest
	}
	value, err := settingcore.Validate(string(input.Key), input.Value)
	if err != nil {
		return UpdateResult{}, err
	}
	expected, err := parseVersion(input.ExpectedVersion)
	if err != nil {
		return UpdateResult{}, err
	}
	rows, err := c.Tx.Query(selectCurrent, string(input.Key))
	if err != nil {
		return UpdateResult{}, err
	}
	current, err := pgx.CollectRows(rows, pgx.RowToStructByPos[currentRow])
	if err != nil {
		return UpdateResult{}, err
	}
	version, old, statement := "0", def.Default, insertCurrent
	if len(current) == 1 {
		version, statement = current[0].Version, updateCurrent
		if old, err = settingcore.Stored(input.Key, current[0].Value); err != nil {
			return UpdateResult{}, err
		}
	}
	if version != expected {
		return UpdateResult{}, ErrStaleVersion
	}
	if old == value {
		return UpdateResult{}, ErrUnchanged
	}
	newJSON, err := json.Marshal(jsonValue(value))
	if err != nil {
		return UpdateResult{}, err
	}
	oldJSON, err := json.Marshal(jsonValue(old))
	if err != nil {
		return UpdateResult{}, err
	}
	rows, err = c.Tx.Query(statement, string(input.Key), string(newJSON), c.Actor.ID)
	if err != nil {
		return UpdateResult{}, err
	}
	written, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
	if err != nil {
		return UpdateResult{}, err
	}
	if _, err := c.Tx.Exec(insertHistory, string(input.Key), written, string(oldJSON), string(newJSON), c.Actor.ID); err != nil {
		return UpdateResult{}, err
	}
	target := authority.AuditTarget{Resource: string(keys.SettingResourceSetting), Key: c.Target.Key, ObjectID: c.Target.ObjectID}
	if err := c.Audit(audit.KindSettingUpdate, target, nil); err != nil {
		return UpdateResult{}, err
	}
	return UpdateResult{Version: written}, nil
}
