package team

import (
	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/hrbase"
)

func insertTeam(tx *database.Tx, id, objectID, name string) error {
	_, err := tx.Exec("INSERT INTO team(id,object_id,name) VALUES($1,$2,$3)", id, objectID, name)
	if database.IsUniqueViolation(err) {
		return apperror.ErrCommandRejected
	}
	return err
}
func renameTeam(tx *database.Tx, teamID, name, version string) (Renamed, error) {
	rows, err := tx.Query(`WITH updated AS (UPDATE team SET name = $2, version = version + 1
           WHERE id = $1 AND version = CAST($3 AS int8) RETURNING version::text AS version)
         SELECT * FROM updated`, teamID, name, version)
	if database.IsUniqueViolation(err) {
		return Renamed{}, apperror.ErrCommandRejected
	}
	if err != nil {
		return Renamed{}, err
	}
	versions, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if database.IsUniqueViolation(err) {
		return Renamed{}, apperror.ErrCommandRejected
	}
	if err != nil {
		return Renamed{}, err
	}
	if len(versions) == 0 {
		return Renamed{}, apperror.ErrCommandRejected
	}
	return Renamed{Version: versions[0]}, nil
}
func employeeAssignable(tx *database.Tx, employeeID, actor string) error {
	rows, err := tx.Query(`SELECT account_id::text AS account, (terminated_on IS NULL OR terminated_on >= `+hrbase.BusinessToday+`) AS working
       FROM employee WHERE id = $1`, employeeID)
	if err != nil {
		return err
	}
	type employee struct {
		Account *string
		Working bool
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByName[employee])
	if err != nil {
		return err
	}
	if len(found) == 0 {
		return apperror.ErrCommandRejected
	}
	return checkAssignable(found[0].Account, found[0].Working, actor)
}
func employeeOther(tx *database.Tx, employeeID, actor string) error {
	rows, err := tx.Query("SELECT account_id::text AS account FROM employee WHERE id = $1", employeeID)
	if err != nil {
		return err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[*string])
	if err != nil {
		return err
	}
	if len(found) == 0 {
		return apperror.ErrCommandRejected
	}
	return checkOther(found[0], actor)
}
func memberships(tx *database.Tx, employeeID string) ([]membership, error) {
	rows, err := tx.Query(`SELECT id::text AS id, team_id::text AS team, is_primary AS "primary"
       FROM team_membership WHERE employee_id = $1 AND ends_at IS NULL ORDER BY id`, employeeID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[membership])
}
func endMembershipRow(tx *database.Tx, id string) error {
	_, err := tx.Exec("UPDATE team_membership SET ends_at = statement_timestamp() WHERE id = $1 AND ends_at IS NULL", id)
	return err
}
func addMembershipRow(tx *database.Tx, team, employeeID string, primary bool) error {
	_, err := tx.Exec("INSERT INTO team_membership(id,employee_id,team_id,is_primary,starts_at) VALUES($1,$2,$3,$4,statement_timestamp())", newUUID(), employeeID, team, primary)
	return err
}
func demotePrimary(tx *database.Tx, employeeID string, current []membership) error {
	for _, row := range current {
		if row.Primary {
			if err := endMembershipRow(tx, row.ID); err != nil {
				return err
			}
			return addMembershipRow(tx, row.Team, employeeID, false)
		}
	}
	return nil
}

type leadRow struct{ ID, Employee string }

func currentLead(tx *database.Tx, teamID string) (*leadRow, error) {
	rows, err := tx.Query(`SELECT id::text AS id, lead_employee_id::text AS employee
         FROM team_lead_assignment WHERE team_id = $1 AND ends_at IS NULL`, teamID)
	if err != nil {
		return nil, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByName[leadRow])
	if err != nil || len(found) == 0 {
		return nil, err
	}
	return &found[0], nil
}
func employeeLeading(tx *database.Tx, teamID, employeeID string) (bool, error) {
	rows, err := tx.Query(`SELECT id::text AS id FROM team_lead_assignment
        WHERE team_id = $1 AND lead_employee_id = $2 AND ends_at IS NULL`, teamID, employeeID)
	if err != nil {
		return false, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[string])
	return len(found) > 0, err
}
func endLeadRow(tx *database.Tx, id string) error {
	_, err := tx.Exec("UPDATE team_lead_assignment SET ends_at = statement_timestamp() WHERE id = $1", id)
	return err
}
func addLeadRow(tx *database.Tx, teamID, employeeID string) error {
	_, err := tx.Exec("INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES($1,$2,$3,statement_timestamp())", newUUID(), teamID, employeeID)
	return err
}
func advanceTeam(tx *database.Tx, teamID string) error {
	_, err := tx.Exec("UPDATE team SET version = version + 1 WHERE id = $1", teamID)
	return err
}
