package leavecore

import (
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/database"
)

// MaxFactsEmployees bounds one facts read; callers pass a page or a single employee.
const MaxFactsEmployees = 100

var ErrTooManyEmployees = errors.New("too many employees for one facts read")

type factsRecord struct {
	ID    string
	Facts string
}

// LoadFacts is the facts of employeeIDs for year from one statement (FactsSQL).
func LoadFacts(tx *database.Tx, employeeIDs []string, year int) (map[string]EmployeeFacts, error) {
	if len(employeeIDs) > MaxFactsEmployees {
		return nil, ErrTooManyEmployees
	}
	rows, err := tx.Query(`SELECT e.id::text, `+FactsSQL("e", "CAST($2 AS int)")+`::text
       FROM employee e WHERE e.id = ANY(CAST($1 AS uuid[]))`, employeeIDs, year)
	if err != nil {
		return nil, err
	}
	records, err := pgx.CollectRows(rows, pgx.RowToStructByPos[factsRecord])
	if err != nil {
		return nil, err
	}
	facts := make(map[string]EmployeeFacts, len(records))
	for _, record := range records {
		row, err := DecodeFactsRow([]byte(record.Facts))
		if err != nil {
			return nil, err
		}
		facts[record.ID] = FactsOf(row, year)
	}
	return facts, nil
}
