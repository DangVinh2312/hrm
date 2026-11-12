package employee

import (
	"github.com/jackc/pgx/v5"
	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/modules/permission"
)

func runCreate(ctx authority.CommandContext, input CreateInput) (Created, error) {
	if err := assertSheetsOpenFrom(ctx.Tx, input.HiredOn, false); err != nil {
		return Created{}, err
	}
	id := newUUID()
	object, err := permission.Register(ctx.Tx, "employee", id)
	if err != nil {
		return Created{}, err
	}
	_, err = ctx.Tx.Exec(`INSERT INTO employee(id,object_id,code,full_name,hired_on,job_position,classification)
 VALUES($1,$2,$3,$4,CAST($5 AS date),$6,$7)`, id, object, input.Code, input.FullName, input.HiredOn, input.Position, input.Classification)
	if err != nil {
		return Created{}, uniqueRejected(err)
	}
	identityObject, err := permission.Register(ctx.Tx, "employeeIdentity", id)
	if err != nil {
		return Created{}, err
	}
	i := input.Identity
	_, err = ctx.Tx.Exec(`INSERT INTO employee_identity(employee_id,object_id,date_of_birth,document_kind,document_number,tax_code,gender,phone,work_email)
 VALUES($1,$2,CAST($3 AS date),$4,$5,$6,$7,$8,$9)`, id, identityObject, i.DateOfBirth, i.DocumentKind, i.DocumentNumber, i.TaxCode, i.Gender, i.Phone, i.WorkEmail)
	if err != nil {
		return Created{}, uniqueRejected(err)
	}
	_, err = ctx.Tx.Exec("INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES($1,$2,$3,CAST($4 AS date))", newUUID(), id, input.Status, input.HiredOn)
	if err != nil {
		return Created{}, err
	}
	if input.AnnualLeave != nil {
		if _, err := insertFor(ctx.Tx, id, input.HiredOn, *input.AnnualLeave); err != nil {
			return Created{}, err
		}
	}
	err = ctx.Audit(audit.KindHREmployeeCreate, authority.AuditTarget{Resource: "employee", Key: id, ObjectID: object}, nil)
	return Created{ID: id}, err
}
func runUpdate(ctx authority.CommandContext, input UpdateInput) (Versioned, error) {
	value, err := uniqueVersion(ctx.Tx, `WITH updated AS (UPDATE employee SET code=$2,full_name=$3,job_position=$5,classification=$6,version=version+1
 WHERE id=$1 AND version=CAST($4 AS int8) RETURNING version::text AS version) SELECT * FROM updated`, ctx.Target.Key, input.Code, input.FullName, input.ExpectedVersion, input.Position, input.Classification)
	if err != nil {
		return Versioned{}, err
	}
	err = ctx.Audit(audit.KindHREmployeeUpdate, employeeTarget(ctx), nil)
	return value, err
}
func runIdentityUpdate(ctx authority.CommandContext, input IdentityUpdateInput) (Versioned, error) {
	i := input.Identity
	value, err := uniqueVersion(ctx.Tx, `WITH updated AS (UPDATE employee_identity SET date_of_birth=CAST($2 AS date),document_kind=$3,
 document_number=$4,tax_code=$5,gender=$7,phone=$8,work_email=$9,version=version+1
 WHERE employee_id=$1 AND version=CAST($6 AS int8) RETURNING version::text AS version) SELECT * FROM updated`,
		ctx.Target.Key, i.DateOfBirth, i.DocumentKind, i.DocumentNumber, i.TaxCode, input.ExpectedVersion, i.Gender, i.Phone, i.WorkEmail)
	if err != nil {
		return Versioned{}, err
	}
	err = ctx.Audit(audit.KindHREmployeeIdentityUpdate, authority.AuditTarget{Resource: "employeeIdentity", Key: ctx.Target.Key, ObjectID: ctx.Target.ObjectID}, nil)
	return value, err
}
func runAdjustRate(ctx authority.CommandContext, input LeaveRateInput) (Created, error) {
	rows, err := ctx.Tx.Query("SELECT hired_on <= CAST($2 AS date) AS valid FROM employee WHERE id=$1", ctx.Target.Key, input.EffectiveFrom)
	if err != nil {
		return Created{}, err
	}
	valid, err := pgx.CollectRows(rows, pgx.RowTo[bool])
	if err != nil {
		return Created{}, err
	}
	if len(valid) != 1 || !valid[0] {
		return Created{}, apperror.ErrCommandRejected
	}
	target, err := insertRate(ctx.Tx, ctx.Target.Key, input.EffectiveFrom, input.AnnualMinutes)
	if err != nil {
		return Created{}, err
	}
	err = ctx.Audit(audit.KindHRLeaveRateAdjust, target, nil)
	return Created{ID: target.Key}, err
}

func employeeTarget(ctx authority.CommandContext) authority.AuditTarget {
	return authority.AuditTarget{Resource: "employee", Key: ctx.Target.Key, ObjectID: ctx.Target.ObjectID}
}
