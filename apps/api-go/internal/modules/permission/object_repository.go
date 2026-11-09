package permission

import (
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/database"
)

var ErrAnchorInconsistent = errors.New("permission anchor inconsistent")

const (
	CompanyID      = "00000000-0000-4000-8000-000000000c01"
	WorkCalendarID = "00000000-0000-4000-8000-000000000c02"
	SettingID      = "00000000-0000-4000-8000-000000000c03"
	RoleID         = "00000000-0000-4000-8000-000000000c04"
)

func EnsureCompany(tx *database.Tx) error {
	return ensureAnchor(tx, string(keys.CompanyResourceCompany), "hr_company", CompanyID)
}
func EnsureWorkCalendar(tx *database.Tx) error {
	return ensureAnchor(tx, string(keys.WorkCalendarResourceWorkCalendar), "work_calendar", WorkCalendarID)
}
func EnsureSetting(tx *database.Tx) error {
	return ensureAnchor(tx, string(keys.SettingResourceSetting), "setting_anchor", SettingID)
}
func EnsureRole(tx *database.Tx) error {
	return ensureAnchor(tx, string(keys.RoleResourceRole), "role_anchor", RoleID)
}

func ensureAnchor(tx *database.Tx, resource, table, id string) error {
	if _, err := tx.Exec(`WITH registered AS (
       INSERT INTO object_ref(object_id,type_key,key_kind,key_bytes)
         VALUES (gen_random_uuid(), convert_to($2,'UTF8'), 'uuid', convert_to(CAST($1 AS text),'UTF8'))
         ON CONFLICT (type_key,key_kind,key_bytes) DO NOTHING RETURNING object_id)
     INSERT INTO `+table+`(id,object_id) SELECT CAST(CAST($1 AS text) AS uuid), object_id FROM registered
       ON CONFLICT DO NOTHING`, id, resource); err != nil {
		return err
	}
	rows, err := tx.Query(`SELECT EXISTS(SELECT 1 FROM `+table+` c JOIN object_ref o ON o.object_id=c.object_id
       WHERE c.id=CAST(CAST($1 AS text) AS uuid) AND o.type_key=convert_to($2,'UTF8')
         AND o.key_bytes=convert_to(CAST($1 AS text),'UTF8')) AS ok`, id, resource)
	if err != nil {
		return err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[bool])
	if err != nil {
		return err
	}
	if len(found) != 1 || !found[0] {
		return ErrAnchorInconsistent
	}
	return nil
}

func Register(tx *database.Tx, resource, key string) (string, error) {
	switch resource {
	case string(keys.EmployeeResourceEmployee), string(keys.TeamResourceTeam), string(keys.WorkRequestResourceWorkRequest):
	default:
		return "", ErrAnchorInconsistent
	}
	rows, err := tx.Query("SELECT public.hr_register_object($1,CAST($2 AS uuid))::text AS object_id", resource, key)
	if err != nil {
		return "", err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return "", err
	}
	if len(found) != 1 {
		return "", ErrAnchorInconsistent
	}
	return found[0], nil
}
