package employee

import (
	"github.com/jackc/pgx/v5"
	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/authority"
)

func runOfficial(ctx authority.CommandContext, input OfficialInput) (Versioned, error) {
	if err := assertSheetsOpenFrom(ctx.Tx, input.EffectiveOn, true); err != nil {
		return Versioned{}, err
	}
	rows, err := ctx.Tx.Query(`WITH closed AS (UPDATE employment_status_period p SET ends_on=CAST($2 AS date)
 FROM employee e WHERE p.employee_id=$1 AND e.id=p.employee_id AND p.ends_on IS NULL
 AND p.status='probation' AND p.starts_on<CAST($2 AS date) AND e.terminated_on IS NULL RETURNING p.id) SELECT * FROM closed`, ctx.Target.Key, input.EffectiveOn)
	if err != nil {
		return Versioned{}, err
	}
	closed, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return Versioned{}, err
	}
	if len(closed) != 1 {
		return Versioned{}, apperror.ErrCommandRejected
	}
	_, err = ctx.Tx.Exec("INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES($1,$2,'official',CAST($3 AS date))", newUUID(), ctx.Target.Key, input.EffectiveOn)
	if err != nil {
		return Versioned{}, err
	}
	rate, err := defaultRateAt(ctx.Tx, ctx.Target.Key, input.EffectiveOn)
	if err != nil {
		return Versioned{}, err
	}
	version, err := bumpEmployee(ctx.Tx, ctx.Target.Key, nil)
	if err != nil {
		return Versioned{}, err
	}
	if err := ctx.Audit(audit.KindHREmployeeStatus, employeeTarget(ctx), nil); err != nil {
		return Versioned{}, err
	}
	if rate != nil {
		if err := ctx.Audit(audit.KindHRLeaveRateAdjust, *rate, nil); err != nil {
			return Versioned{}, err
		}
	}
	return Versioned{Version: version}, nil
}

func runTermination(ctx authority.CommandContext, input TerminationInput) (Versioned, error) {
	if err := assertSheetsOpenFrom(ctx.Tx, input.TerminatedOn, true); err != nil {
		return Versioned{}, err
	}
	rows, err := ctx.Tx.Query(`WITH closed AS (UPDATE employment_status_period p SET ends_on=CAST($2 AS date)+1
 FROM employee e WHERE p.employee_id=$1 AND e.id=p.employee_id AND p.ends_on IS NULL
 AND p.starts_on<=CAST($2 AS date) AND e.terminated_on IS NULL AND e.hired_on<=CAST($2 AS date)
 RETURNING p.id) SELECT * FROM closed`, ctx.Target.Key, input.TerminatedOn)
	if err != nil {
		return Versioned{}, err
	}
	closed, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return Versioned{}, err
	}
	if len(closed) != 1 {
		return Versioned{}, apperror.ErrCommandRejected
	}
	_, err = ctx.Tx.Exec("UPDATE employee SET terminated_on=CAST($2 AS date) WHERE id=$1", ctx.Target.Key, input.TerminatedOn)
	if err != nil {
		return Versioned{}, err
	}
	version, err := bumpEmployee(ctx.Tx, ctx.Target.Key, nil)
	if err != nil {
		return Versioned{}, err
	}
	err = ctx.Audit(audit.KindHREmployeeStatus, employeeTarget(ctx), nil)
	return Versioned{Version: version}, err
}
