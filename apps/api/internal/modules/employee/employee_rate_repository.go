package employee

import (
	"github.com/jackc/pgx/v5"

	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/permission"
	"hrm/api/internal/modules/settingcore"
)

var leaveRateResource = string(keys.EmployeeResourceLeaveRate)

// defaultMinutes is the hr.annualLeaveDefaultMinutes setting in force, read in the transaction of the
// caller and only when a row is about to be written, so a rate that exists is never rewritten when the
// setting changes (no retroactive effect).
func defaultMinutes(tx *database.Tx) (int, error) {
	values, err := settingcore.Read(tx, []settingcore.Key{settingcore.KeyAnnualLeaveDefaultMinutes})
	if err != nil {
		return 0, err
	}
	return int(values[settingcore.KeyAnnualLeaveDefaultMinutes].Int), nil
}

// defaultRateAt writes the default rate from `from`, unless a rate dated on or before it exists (the earlier
// choice of HR, or data from before the rate started at the official period, is kept). The command holds the
// employee row lock, so the check cannot race another rate insert. It returns the audit target of the new
// row, or nil when nothing was written.
func defaultRateAt(tx *database.Tx, employeeID, from string) (*authority.AuditTarget, error) {
	rows, err := tx.Query(`SELECT EXISTS (SELECT 1 FROM leave_rate
                       WHERE employee_id = $1 AND effective_from <= CAST($2 AS date)) AS present`, employeeID, from)
	if err != nil {
		return nil, err
	}
	present, err := pgx.CollectRows(rows, pgx.RowTo[bool])
	if err != nil {
		return nil, err
	}
	if len(present) != 1 || present[0] {
		return nil, nil
	}
	minutes, err := defaultMinutes(tx)
	if err != nil {
		return nil, err
	}
	target, err := insertRate(tx, employeeID, from, minutes)
	return &target, err
}

// insertFor is the first rate of a new official employee: the given minutes, or the default setting in force.
func insertFor(tx *database.Tx, employeeID, from string, minutes LeaveMinutes) (authority.AuditTarget, error) {
	value := minutes.Minutes
	if minutes.Default {
		var err error
		if value, err = defaultMinutes(tx); err != nil {
			return authority.AuditTarget{}, err
		}
	}
	return insertRate(tx, employeeID, from, value)
}

func insertRate(tx *database.Tx, employeeID, from string, minutes int) (authority.AuditTarget, error) {
	id := newUUID()
	objectID, err := permission.Register(tx, leaveRateResource, id)
	if err != nil {
		return authority.AuditTarget{}, err
	}
	_, err = tx.Exec("INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes) VALUES($1,$2,$3,CAST($4 AS date),$5)",
		id, objectID, employeeID, from, minutes)
	if err != nil {
		return authority.AuditTarget{}, uniqueRejected(err)
	}
	return authority.AuditTarget{Resource: leaveRateResource, Key: id, ObjectID: objectID}, nil
}
