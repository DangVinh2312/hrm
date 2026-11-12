package employee

import (
	"errors"
	"github.com/jackc/pgx/v5"
	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/authority"
)

func runLinkAccount(ctx authority.CommandContext, input AccountLinkInput) (Versioned, error) {
	rows, err := ctx.Tx.Query("SELECT account_id::text,version::text FROM employee WHERE id=$1", ctx.Target.Key)
	if err != nil {
		return Versioned{}, err
	}
	type current struct {
		Account *string
		Version string
	}
	employees, err := pgx.CollectRows(rows, pgx.RowToStructByPos[current])
	if err != nil {
		return Versioned{}, err
	}
	if len(employees) != 1 {
		return Versioned{}, errors.New("locked employee vanished")
	}
	employee := employees[0]
	if employee.Version != input.ExpectedVersion {
		return Versioned{}, apperror.ErrCommandRejected
	}
	if (employee.Account != nil && *employee.Account == ctx.Actor.ID) || (input.AccountID != nil && *input.AccountID == ctx.Actor.ID) {
		return Versioned{}, apperror.ErrCommandRejected
	}
	if (employee.Account == nil && input.AccountID == nil) || (employee.Account != nil && input.AccountID != nil && *employee.Account == *input.AccountID) {
		return Versioned{}, apperror.ErrCommandRejected
	}
	if input.AccountID != nil {
		rows, err := ctx.Tx.Query("SELECT kind,state FROM app_user WHERE id=$1", *input.AccountID)
		if err != nil {
			return Versioned{}, err
		}
		type account struct{ Kind, State string }
		accounts, err := pgx.CollectRows(rows, pgx.RowToStructByPos[account])
		if err != nil {
			return Versioned{}, err
		}
		if len(accounts) != 1 || accounts[0].Kind != "iam" || accounts[0].State == "suspended" {
			return Versioned{}, apperror.ErrCommandRejected
		}
	}
	_, err = ctx.Tx.Exec("UPDATE employee SET account_id=$2 WHERE id=$1", ctx.Target.Key, input.AccountID)
	if err != nil {
		return Versioned{}, uniqueRejected(err)
	}
	version, err := bumpEmployee(ctx.Tx, ctx.Target.Key, &input.ExpectedVersion)
	if err != nil {
		return Versioned{}, err
	}
	err = ctx.Audit(audit.KindHREmployeeLinkAccount, employeeTarget(ctx), nil)
	return Versioned{Version: version}, err
}
