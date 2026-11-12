package settingcore

import (
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/database"
)

var ErrUnknownSetting = errors.New("unknown setting")

type storedRow struct {
	Key   string
	Value []byte
}

// Read is the value of each key in force: the stored row, or the registry default when there is none.
// It uses the transaction of the caller (no cache, no TTL, no lock), so a decision uses the value
// committed when it reads. One statement. A stored row outside the registry is ErrStoredInvalid.
func Read(tx *database.Tx, keys []Key) (map[Key]Value, error) {
	names := make([]string, len(keys))
	for i, key := range keys {
		if _, ok := Lookup(string(key)); !ok {
			return nil, ErrUnknownSetting
		}
		names[i] = string(key)
	}
	rows, err := tx.Query(`SELECT key, value FROM system_setting WHERE key = ANY(CAST($1 AS text[]))`, names)
	if err != nil {
		return nil, err
	}
	stored, err := pgx.CollectRows(rows, pgx.RowToStructByPos[storedRow])
	if err != nil {
		return nil, err
	}
	raw := make(map[Key][]byte, len(stored))
	for _, row := range stored {
		raw[Key(row.Key)] = row.Value
	}
	values := make(map[Key]Value, len(keys))
	for _, key := range keys {
		if value, ok := raw[key]; ok {
			checked, err := Stored(key, value)
			if err != nil {
				return nil, err
			}
			values[key] = checked
			continue
		}
		def, _ := Lookup(string(key))
		values[key] = def.Default
	}
	return values, nil
}
