package employee

import (
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/modules/hrbase"
)

const employeeStateSQL = `CASE WHEN r.terminated_on IS NOT NULL AND r.terminated_on < ` + hrbase.BusinessToday + ` THEN 'terminated'
 WHEN r.hired_on > ` + hrbase.BusinessToday + ` THEN 'notStarted'
 ELSE (SELECT p.status FROM employment_status_period p WHERE p.employee_id=r.id
 AND p.starts_on <= ` + hrbase.BusinessToday + ` AND (p.ends_on IS NULL OR p.ends_on > ` + hrbase.BusinessToday + `)) END`

func validState(state State) error {
	switch state {
	case StateProbation, StateOfficial, StateNotStarted, StateTerminated:
		return nil
	default:
		return errors.New("employment periods inconsistent")
	}
}

func listEmployees(ctx authority.QueryContext, input ListQuery) (authority.QueryResult[ListView], error) {
	var search *string
	if input.Search != "" {
		pattern := "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(input.Search) + "%"
		search = &pattern
	}
	args, at, err := ctx.Scope.Args(search, input.Limit, input.Offset)
	if err != nil {
		return authority.QueryResult[ListView]{}, err
	}
	window, err := hrbase.CurrentWindow("m")
	if err != nil {
		return authority.QueryResult[ListView]{}, err
	}
	rows, err := ctx.Tx.Query(fmt.Sprintf(`WITH scoped AS (
 SELECT r.id,r.code,r.full_name,%s AS state FROM employee r WHERE %s
 AND (%s::text IS NULL OR r.code ILIKE %s ESCAPE '\' OR r.full_name ILIKE %s ESCAPE '\'))
 SELECT (SELECT count(*) FROM scoped)::text,
 COALESCE((SELECT json_agg(json_build_object('id',p.id,'code',p.code,'fullName',p.full_name,'state',p.state,
 'primaryTeam',CASE WHEN t.id IS NULL THEN NULL ELSE json_build_object('id',t.id,'name',t.name) END) ORDER BY p.code)
 FROM (SELECT * FROM scoped ORDER BY code LIMIT CAST(%s AS int8) OFFSET CAST(%s AS int8)) p
 LEFT JOIN team_membership m ON m.employee_id=p.id AND m.is_primary AND %s
 LEFT JOIN team t ON t.id=m.team_id),'[]'::json)`, employeeStateSQL, ctx.Scope.SQL, at(1), at(1), at(1), at(2), at(3), window), args...)
	if err != nil {
		return authority.QueryResult[ListView]{}, err
	}
	view, err := pgx.CollectExactlyOneRow(rows, func(row pgx.CollectableRow) (ListView, error) {
		var value ListView
		err := row.Scan(&value.Total, &value.Items)
		return value, err
	})
	if err != nil {
		return authority.QueryResult[ListView]{}, err
	}
	for _, item := range view.Items {
		if err := validState(item.State); err != nil {
			return authority.QueryResult[ListView]{}, err
		}
	}
	return authority.QueryResult[ListView]{Found: true, Value: view}, nil
}

func employeeDetail(ctx authority.QueryContext, id string) (authority.QueryResult[View], error) {
	args, at, err := ctx.Scope.Args(id)
	if err != nil {
		return authority.QueryResult[View]{}, err
	}
	window, err := hrbase.CurrentWindow("m")
	if err != nil {
		return authority.QueryResult[View]{}, err
	}
	rows, err := ctx.Tx.Query(fmt.Sprintf(`SELECT r.id::text,r.code,r.full_name,to_char(r.hired_on,'YYYY-MM-DD'),
 to_char(r.terminated_on,'YYYY-MM-DD'),%s AS state,r.version::text,r.account_id::text,r.job_position,r.classification,
 COALESCE((SELECT json_agg(json_build_object('status',p.status,'startsOn',to_char(p.starts_on,'YYYY-MM-DD'),
 'endsOn',to_char(p.ends_on,'YYYY-MM-DD')) ORDER BY p.starts_on) FROM employment_status_period p WHERE p.employee_id=r.id),'[]'::json),
 COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name,'primary',m.is_primary,
 'since',to_char(m.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY m.is_primary DESC,t.name)
 FROM team_membership m JOIN team t ON t.id=m.team_id WHERE m.employee_id=r.id AND %s),'[]'::json)
 FROM employee r WHERE %s AND r.id=CAST(%s AS uuid)`, employeeStateSQL, window, ctx.Scope.SQL, at(1)), args...)
	if err != nil {
		return authority.QueryResult[View]{}, err
	}
	values, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (View, error) {
		var value View
		var state *State
		err := row.Scan(&value.ID, &value.Code, &value.FullName, &value.HiredOn, &value.TerminatedOn, &state, &value.Version, &value.AccountID, &value.Position, &value.Classification, &value.Periods, &value.Teams)
		if err != nil {
			return View{}, err
		}
		if state != nil {
			value.State = *state
		}
		return value, validState(value.State)
	})
	if err != nil || len(values) == 0 {
		return authority.QueryResult[View]{}, err
	}
	return authority.QueryResult[View]{Found: true, Value: values[0]}, nil
}

func identityDetail(ctx authority.QueryContext, id string) (authority.QueryResult[IdentityView], error) {
	args, at, err := ctx.Scope.Args(id)
	if err != nil {
		return authority.QueryResult[IdentityView]{}, err
	}
	rows, err := ctx.Tx.Query(fmt.Sprintf(`SELECT r.employee_id::text,r.version::text,to_char(r.date_of_birth,'YYYY-MM-DD'),
 r.document_kind,r.document_number,r.tax_code,r.gender,r.phone,r.work_email FROM employee_identity r
 WHERE %s AND r.employee_id=CAST(%s AS uuid)`, ctx.Scope.SQL, at(1)), args...)
	if err != nil {
		return authority.QueryResult[IdentityView]{}, err
	}
	values, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (IdentityView, error) {
		var value IdentityView
		err := row.Scan(&value.EmployeeID, &value.Version, &value.DateOfBirth, &value.DocumentKind, &value.DocumentNumber, &value.TaxCode, &value.Gender, &value.Phone, &value.WorkEmail)
		return value, err
	})
	if err != nil || len(values) == 0 {
		return authority.QueryResult[IdentityView]{}, err
	}
	return authority.QueryResult[IdentityView]{Found: true, Value: values[0]}, nil
}

func leaveRates(ctx authority.QueryContext, id string) (authority.QueryResult[LeaveRateListView], error) {
	args, at, err := ctx.Scope.Args(id)
	if err != nil {
		return authority.QueryResult[LeaveRateListView]{}, err
	}
	rows, err := ctx.Tx.Query(fmt.Sprintf(`SELECT r.id::text,to_char(r.effective_from,'YYYY-MM-DD'),r.annual_minutes FROM leave_rate r
 WHERE %s AND r.employee_id=CAST(%s AS uuid) ORDER BY r.effective_from DESC LIMIT 100`, ctx.Scope.SQL, at(1)), args...)
	if err != nil {
		return authority.QueryResult[LeaveRateListView]{}, err
	}
	items, err := pgx.CollectRows(rows, pgx.RowToStructByPos[LeaveRateView])
	return authority.QueryResult[LeaveRateListView]{Found: true, Value: LeaveRateListView{Items: items}}, err
}

type ownView struct {
	Own    *OwnEmployee
	Others bool
}

func ownEmployee(ctx authority.QueryContext, _ struct{}) (authority.QueryResult[ownView], error) {
	args, at, err := ctx.Scope.Args(ctx.Actor.ID)
	if err != nil {
		return authority.QueryResult[ownView]{}, err
	}
	rows, err := ctx.Tx.Query(fmt.Sprintf(`SELECT
 (SELECT json_build_object('id',r.id,'code',r.code,'fullName',r.full_name) FROM employee r WHERE %s AND r.account_id=CAST(%s AS uuid)),
 EXISTS(SELECT 1 FROM employee r WHERE %s AND r.account_id IS DISTINCT FROM CAST(%s AS uuid))`, ctx.Scope.SQL, at(1), ctx.Scope.SQL, at(1)), args...)
	if err != nil {
		return authority.QueryResult[ownView]{}, err
	}
	view, err := pgx.CollectExactlyOneRow(rows, func(row pgx.CollectableRow) (ownView, error) {
		var value ownView
		err := row.Scan(&value.Own, &value.Others)
		return value, err
	})
	return authority.QueryResult[ownView]{Found: true, Value: view}, err
}
