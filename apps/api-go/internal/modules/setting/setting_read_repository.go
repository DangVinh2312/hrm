package setting

import (
	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/modules/settingcore"
)

const (
	selectSettings = `SELECT key, value, version::text AS version, to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt" FROM system_setting`
	countHistory   = `SELECT count(*)::text AS total FROM system_setting_history WHERE key = $1`
	selectHistory  = `SELECT version::text AS version, old_value AS "oldValue", new_value AS "newValue",
                to_char(changed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "changedAt"
           FROM system_setting_history WHERE key = $1
          ORDER BY version DESC LIMIT $2 OFFSET $3`
)

type none struct{}

type historyRow struct {
	Version   string
	OldValue  []byte
	NewValue  []byte
	ChangedAt string
}

// The plan's scope is the singleton anchor of the resource, so a caller without the grant reaches
// nothing and the query answers not found.
var (
	listQuery     = authority.NewQuery(string(keys.SettingResourceSetting), string(keys.SettingActionRead), nil, readList)
	profileQuery  = authority.NewQuery(string(keys.SettingResourceSetting), string(keys.SettingActionReadProfile), nil, readProfile)
	historyQuery  = authority.NewQuery(string(keys.SettingResourceSetting), string(keys.SettingActionRead), nil, readHistory)
	securityQuery = authority.NewQuery(string(keys.SettingResourceSetting), string(keys.SettingActionRead), nil, readSecurity)
)

func reaches(c authority.QueryContext) (bool, error) {
	args, _, err := c.Scope.Args()
	if err != nil {
		return false, err
	}
	rows, err := c.Tx.Query(`SELECT EXISTS (SELECT 1 FROM setting_anchor r WHERE `+c.Scope.SQL+`) AS ok`, args...)
	if err != nil {
		return false, err
	}
	return pgx.CollectExactlyOneRow(rows, pgx.RowTo[bool])
}

func readList(c authority.QueryContext, _ none) (authority.QueryResult[[]View], error) {
	var result authority.QueryResult[[]View]
	if ok, err := reaches(c); err != nil || !ok {
		return result, err
	}
	rows, err := c.Tx.Query(selectSettings)
	if err != nil {
		return result, err
	}
	stored, err := pgx.CollectRows(rows, pgx.RowToStructByPos[storedSetting])
	if err != nil {
		return result, err
	}
	views, err := settingViews(stored)
	return authority.QueryResult[[]View]{Found: err == nil, Value: views}, err
}

func readProfile(c authority.QueryContext, _ none) (authority.QueryResult[ProfileView], error) {
	var result authority.QueryResult[ProfileView]
	if ok, err := reaches(c); err != nil || !ok {
		return result, err
	}
	values, err := settingcore.Read(c.Tx, []settingcore.Key{settingcore.KeyCompanyName, settingcore.KeyCompanyDefaultLocale})
	if err != nil {
		return result, err
	}
	view := ProfileView{CompanyName: values[settingcore.KeyCompanyName].Text, DefaultLocale: values[settingcore.KeyCompanyDefaultLocale].Text}
	return authority.QueryResult[ProfileView]{Found: true, Value: view}, nil
}

// readHistory is the changes of one key, newest first; empty for a key nobody wrote.
func readHistory(c authority.QueryContext, query HistoryQuery) (authority.QueryResult[HistoryView], error) {
	var result authority.QueryResult[HistoryView]
	if ok, err := reaches(c); err != nil || !ok {
		return result, err
	}
	rows, err := c.Tx.Query(countHistory, string(query.Key))
	if err != nil {
		return result, err
	}
	total, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
	if err != nil {
		return result, err
	}
	rows, err = c.Tx.Query(selectHistory, string(query.Key), query.Limit, query.Offset)
	if err != nil {
		return result, err
	}
	stored, err := pgx.CollectRows(rows, pgx.RowToStructByPos[historyRow])
	if err != nil {
		return result, err
	}
	items := make([]HistoryItem, 0, len(stored))
	for _, row := range stored {
		oldValue, err := settingcore.Stored(query.Key, row.OldValue)
		if err != nil {
			return result, err
		}
		newValue, err := settingcore.Stored(query.Key, row.NewValue)
		if err != nil {
			return result, err
		}
		items = append(items, HistoryItem{Version: row.Version, OldValue: jsonValue(oldValue), NewValue: jsonValue(newValue), ChangedAt: row.ChangedAt})
	}
	return authority.QueryResult[HistoryView]{Found: true, Value: HistoryView{Items: items, Total: total}}, nil
}

// readSecurity is a view only: no setting and no row stand behind it, so nothing here can be written.
func readSecurity(c authority.QueryContext, _ none) (authority.QueryResult[SecurityView], error) {
	ok, err := reaches(c)
	if err != nil || !ok {
		return authority.QueryResult[SecurityView]{}, err
	}
	return authority.QueryResult[SecurityView]{Found: true, Value: SecurityPolicy()}, nil
}
