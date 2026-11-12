package administration

import (
	"context"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/grant"
	"hrm/api/internal/authorization/keys"
)

type boundaryChange struct {
	UserID string
	Ref    BoundaryRef
}

func (b boundaryChange) targetID() string { return b.UserID }

// changeBoundary locks the target's row, then the target's grants within the actor's (Root skips), before the
// package or any binding is read; then binds the whole package or deletes its runtime rows.
func (m commands) changeBoundary(binding bool) func(authority.AdminContext, boundaryChange) (*audit.Event, error) {
	return func(c authority.AdminContext, input boundaryChange) (*audit.Event, error) {
		if err := lockAccount(c.Tx, input.UserID); err != nil {
			return nil, err
		}
		within, _, err := grant.WithinActor(c.Tx, m.core, grant.Actor(c.Actor), input.UserID)
		if err != nil || !within {
			return nil, err
		}
		kind := audit.KindPermissionBoundaryRevoke
		if binding {
			kind = audit.KindPermissionBoundaryAssign
			err = bindPackage(c, input)
		} else {
			var gone int
			if gone, err = deleteRuntimeBoundary(c.Tx, input.UserID, input.Ref); err == nil && gone == 0 {
				err = apperror.ErrCommandRejected
			}
		}
		if err != nil {
			return nil, err
		}
		version := int(input.Ref.Version)
		return &audit.Event{Kind: kind, Actor: c.Actor.ID, Detail: audit.PermissionChange{
			Permission: c.Permission, Root: rootOutcome(c, "ok"), BoundaryKey: input.Ref.Key, BoundaryVersion: &version, TargetUserID: input.UserID,
			Target: audit.RequestedKey{Resource: string(keys.AccountResourceAccount), KeyKind: core.KeyUUID, Key: input.UserID, ObjectID: input.UserID},
		}}, nil
	}
}

// bindPackage: a boundary that is not an active package of at most MaxBoundaryPackage required permissions is
// invalid; an actor that is not Root must be bound to the whole package itself, answered before the conflict so
// it never learns what the target holds; a binding of any permission of the package already is a conflict.
func bindPackage(c authority.AdminContext, input boundaryChange) error {
	members, err := boundaryPackage(c.Tx, input.Ref)
	if err != nil {
		return err
	}
	if len(members) == 0 || len(members) > MaxBoundaryPackage {
		return apperror.ErrInvalidRequest
	}
	for _, required := range members {
		if !required {
			return apperror.ErrInvalidRequest
		}
	}
	held, bound, err := boundaryBindings(c.Tx, c.Actor.ID, input.UserID, input.Ref)
	if err != nil {
		return err
	}
	if c.Actor.Kind != "root" && held != len(members) {
		return apperror.ErrAccessDenied
	}
	if bound > 0 {
		return apperror.ErrCommandRejected
	}
	inserted, err := insertBoundary(c.Tx, input.UserID, input.Ref)
	if err == nil && inserted != len(members) {
		return apperror.ErrCommandRejected
	}
	return err
}

// BindBoundary binds the whole package of a boundary on another IAM account. Self or a package the IAM caller
// is not bound to itself is 403; a boundary that is not an active package of required permissions is 400; a
// binding on any permission of the package already is 409.
func (s *Service) BindBoundary(ctx context.Context, secret, userID string, ref BoundaryRef) error {
	if !validBoundaryRef(ref) {
		return apperror.ErrInvalidRequest
	}
	return found(onAccount(ctx, s.authorization, s.operations.core, secret, s.operations.bind, boundaryChange{UserID: userID, Ref: ref}))
}

// UnbindBoundary deletes the runtime rows of the package; it needs no hold of the caller (taking authority away
// needs no delegation). Nothing to delete is 409; rows with a seed_owner are never touched.
func (s *Service) UnbindBoundary(ctx context.Context, secret, userID string, ref BoundaryRef) error {
	if !validBoundaryRef(ref) {
		return apperror.ErrInvalidRequest
	}
	return found(onAccount(ctx, s.authorization, s.operations.core, secret, s.operations.unbind, boundaryChange{UserID: userID, Ref: ref}))
}
