package offline

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/database"
)

const (
	roleExists      = `SELECT 1 FROM role_definition WHERE role_key=$1`
	provisionOIDC   = `SELECT public.provision_oidc_account($1,$2,$3,$4)`
	insertFirstRole = `INSERT INTO user_role(user_id,role_key) VALUES($1,$2)`
)

// ErrUnknownRole is an enrollment whose role is not defined; nothing is written.
var ErrUnknownRole = errors.New("--role must be an existing role")

// Enrollment is checked by the caller: a canonical user id other than the offline actor, a canonical login
// email, a non-empty issuer and a role key reference.
type Enrollment struct{ UserID, Email, Issuer, RoleKey string }

// Enroll creates a pending IAM account that waits 7 days for the first verified login of its email at the
// issuer, with its first role, under the exclusive fence. provision_oidc_account refuses an issuer that is
// not an enabled provider (22023); a taken email fails with 23505.
func Enroll(ctx context.Context, runner *database.Runner, input Enrollment) error {
	_, err := database.Run(ctx, runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		rows, err := tx.Query(roleExists, []byte(input.RoleKey))
		if err != nil {
			return struct{}{}, err
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[int32])
		if err != nil {
			return struct{}{}, err
		}
		if len(found) == 0 {
			return struct{}{}, ErrUnknownRole
		}
		if _, err := tx.Exec(provisionOIDC, input.UserID, input.Email, input.Issuer, audit.OfflineActor); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(insertFirstRole, input.UserID, []byte(input.RoleKey)); err != nil {
			return struct{}{}, err
		}
		if err := audit.Append(tx, audit.Event{Kind: audit.KindIdentityEnroll, Actor: audit.OfflineActor,
			Detail: audit.Enrollment{TargetUserID: input.UserID, Method: "oidc"}}); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, audit.Append(tx, audit.Event{Kind: audit.KindPermissionRoleAssign, Actor: audit.OfflineActor,
			Detail: audit.PermissionChange{
				Permission: "account.assignRole", RoleKey: input.RoleKey, TargetUserID: input.UserID,
				Target: audit.RequestedKey{Resource: "account", KeyKind: core.KeyUUID, Key: input.UserID, ObjectID: input.UserID},
			}})
	}, database.RunOptions{})
	return err
}
