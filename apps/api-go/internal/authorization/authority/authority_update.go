package authority

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/database"
)

func (a *Authorization) Update(ctx context.Context, secret, resource, action, key string, changes map[string]core.Scalar) (bool, error) {
	var allowed []string
	for _, write := range a.writable {
		if write.Resource == resource && write.Action == action {
			allowed = write.Fields
			break
		}
	}
	if len(changes) == 0 || len(changes) > len(allowed) {
		return false, apperror.ErrAccessDenied
	}
	fields := make([]string, 0, len(changes))
	declared, known := a.bindings.Declarations().Resource(resource)
	if !known {
		return false, apperror.ErrAccessDenied
	}
	normalized := make(map[string]core.Scalar, len(changes))
	for field := range changes {
		if !slices.Contains(allowed, field) {
			return false, apperror.ErrAccessDenied
		}
		value, err := a.bindings.Core().NormalizeValue(declared.Fields[field].Kind, core.Value(changes[field]))
		if errors.Is(err, core.ErrInvalidValue) {
			return false, apperror.ErrAccessDenied
		}
		if err != nil {
			return false, err
		}
		normalized[field] = value
		fields = append(fields, field)
	}
	slices.Sort(fields)
	return access(ctx, a, secret, Probe{resource, action}, database.ModeWrite, func(tx *database.Tx, plan *core.AuthorizedPlan, s session) (bool, *audit.Event, error) {
		objectID, err := a.target(tx, plan, key, true)
		if err != nil {
			return false, nil, err
		}
		prepared, err := a.targetSQL(tx, plan, key)
		if err != nil {
			return false, nil, err
		}
		target := audit.RequestedKey{Resource: resource, KeyKind: prepared.key.Kind, Key: prepared.key.Value, ObjectID: objectID}
		var root *audit.RootOutcome
		if s.kind == "root" {
			outcome := "ok"
			if objectID == "" {
				outcome = "absent"
			}
			root = &audit.RootOutcome{Outcome: outcome}
		}
		event := audit.Event{Kind: "data.update", Actor: string(plan.UserID()), Detail: audit.DataUpdate{Permission: plan.Permission(), Root: root, Target: target}}
		if objectID == "" {
			return false, &event, nil
		}
		binding, err := a.bindings.Resource(resource)
		if err != nil {
			return false, nil, err
		}
		params := slices.Clone(prepared.bound.Parameters)
		assignments := make([]string, 0, len(fields))
		for _, field := range fields {
			kind := declared.Fields[field].Kind
			value := normalized[field]
			column, err := compiler.QuoteIdentifier(binding.Columns[field])
			if err != nil {
				return false, nil, err
			}
			pgType, ok := compiler.FieldPgType(kind)
			if !ok {
				return false, nil, errors.New("invalid writable field kind")
			}
			if text, ok := value.AsText(); ok {
				params = append(params, compiler.TextParam(text))
			} else if flag, ok := value.AsBool(); ok {
				params = append(params, compiler.BoolParam(flag))
			} else {
				return false, nil, apperror.ErrAccessDenied
			}
			assignments = append(assignments, fmt.Sprintf("%s=CAST($%d AS %s)", column, len(params), pgType))
		}
		params = append(params, compiler.TextParam(prepared.key.Value))
		tag, err := tx.Exec(fmt.Sprintf("UPDATE %s r SET %s WHERE %s AND r.%s=CAST($%d AS %s)", prepared.table, strings.Join(assignments, ","), prepared.bound.SQL, prepared.keyColumn, len(params), prepared.keyType), driverArgs(params)...)
		if err != nil {
			return false, nil, err
		}
		if tag.RowsAffected() != 1 {
			return false, nil, errors.New("authorized update lost its target")
		}
		if s.kind == "iam" {
			if err := audit.Append(tx, event); err != nil {
				return false, nil, err
			}
		}
		return true, &event, nil
	})
}
