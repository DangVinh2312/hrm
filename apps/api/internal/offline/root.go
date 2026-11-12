package offline

import (
	"context"
	"uuid"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/audit"
	"hrm/api/internal/authentication/credential"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/manifest"
	"hrm/api/internal/database"
)

const (
	lockMarker = `SELECT s.operation_id,s.target_user_id::text target,u.email_canonical email
       FROM security_bootstrap_state s LEFT JOIN app_user u ON u.id=s.target_user_id
       WHERE s.singleton FOR UPDATE OF s`
	appliedManifest   = `SELECT encode(manifest_hash,'hex') hash,encode(materialized_hash,'hex') materialized FROM authz_state WHERE singleton`
	enabledProvider   = `SELECT 1 FROM oidc_provider WHERE issuer=$1 AND enabled`
	insertPendingUser = `INSERT INTO app_user(id,email_canonical,state) VALUES($1,$2,'pending')`
	pinEnrollment     = `INSERT INTO oidc_email_enrollment(user_id,issuer,email_canonical,expires_at,created_by) VALUES($1,$2,$3,statement_timestamp()+interval '15 minutes',$4)`
	promoteRoot       = `UPDATE app_user SET kind='root' WHERE id=$1`
	insertActivation  = `INSERT INTO one_time_token(token_hash,user_id,purpose,expires_at) VALUES($1,$2,'oidc-activation',statement_timestamp()+interval '15 minutes')`
	markBootstrap     = `UPDATE security_bootstrap_state SET operation_id=$1,target_user_id=$2,initialized_at=statement_timestamp() WHERE singleton`
	lockReissueTarget = `SELECT u.id,u.state,u.kind='root' root,u.email_canonical email,
        (SELECT count(*) FROM external_identity e WHERE e.user_id=u.id)::int bindings
       FROM security_bootstrap_state b JOIN app_user u ON u.id=b.target_user_id
       WHERE b.singleton AND b.initialized_at IS NOT NULL FOR UPDATE OF b FOR NO KEY UPDATE OF u`
	consumeActivations = `UPDATE one_time_token SET consumed_at=statement_timestamp() WHERE user_id=$1 AND purpose='oidc-activation' AND consumed_at IS NULL`
	dropEnrollment     = `DELETE FROM oidc_email_enrollment WHERE user_id=$1`
)

func rejection(reason string) error { return &manifest.Rejection{Reason: reason} }

// RootBootstrap is a validated bootstrap request; only NewRootBootstrap makes a usable one.
type RootBootstrap struct{ operationID, issuer, email string }

// NewRootBootstrap canonicalizes the email; it is PII, so it is never logged or audited.
func NewRootBootstrap(c *core.Core, operationID, issuer, email string) (RootBootstrap, error) {
	canonical, err := credential.CanonicalLoginEmail(email)
	if err != nil || !c.IsCanonicalUUID(operationID) || issuer == "" {
		return RootBootstrap{}, rejection("invalid_release")
	}
	return RootBootstrap{operationID: operationID, issuer: issuer, email: canonical}, nil
}

// RootBootstrapResult holds the activation secret only when this call committed the Root.
type RootBootstrapResult struct {
	Initialized bool
	UserID      string
	Secret      string
}

// BootstrapRoot creates the one Root from an email: a pending IAM account with a generated id, promoted to
// kind 'root' in the same READ COMMITTED transaction (guard_root_kind allows only that promotion), with the
// permanent marker, the pinned enrollment and the proof. The same operation and email again changes
// nothing; any other bootstrap is a collision.
func BootstrapRoot(ctx context.Context, runner *database.Runner, release manifest.Release, input RootBootstrap) (RootBootstrapResult, error) {
	if release.Hash() == "" || input.operationID == "" {
		return RootBootstrapResult{}, rejection("invalid_release")
	}
	return database.Run(ctx, runner, database.ModeBootstrap, func(_ context.Context, tx *database.Tx) (RootBootstrapResult, error) {
		type marker struct {
			OperationID *string `db:"operation_id"`
			Target      *string `db:"target"`
			Email       *string `db:"email"`
		}
		rows, err := tx.Query(lockMarker)
		if err != nil {
			return RootBootstrapResult{}, err
		}
		markers, err := pgx.CollectRows(rows, pgx.RowToStructByName[marker])
		if err != nil {
			return RootBootstrapResult{}, err
		}
		if len(markers) != 1 {
			return RootBootstrapResult{}, rejection("not_ready")
		}
		if m := markers[0]; m.OperationID != nil {
			if *m.OperationID == input.operationID && m.Email != nil && *m.Email == input.email && m.Target != nil {
				return RootBootstrapResult{UserID: *m.Target}, nil
			}
			return RootBootstrapResult{}, rejection("collision")
		}
		if err := requireAppliedRelease(tx, release); err != nil {
			return RootBootstrapResult{}, err
		}
		if err := requireEnabledProvider(tx, input.issuer); err != nil {
			return RootBootstrapResult{}, err
		}
		userID := uuid.NewV4().String()
		if _, err := tx.Exec(insertPendingUser, userID, input.email); err != nil {
			if database.IsUniqueViolation(err) {
				return RootBootstrapResult{}, rejection("collision")
			}
			return RootBootstrapResult{}, err
		}
		if _, err := tx.Exec(pinEnrollment, userID, input.issuer, input.email, audit.OfflineActor); err != nil {
			return RootBootstrapResult{}, err
		}
		// Promotion first: guard_root_kind refuses a target that already holds a live activation token.
		if _, err := tx.Exec(promoteRoot, userID); err != nil {
			return RootBootstrapResult{}, err
		}
		secret, err := issueActivation(tx, userID)
		if err != nil {
			return RootBootstrapResult{}, err
		}
		if _, err := tx.Exec(markBootstrap, input.operationID, userID); err != nil {
			return RootBootstrapResult{}, err
		}
		return RootBootstrapResult{Initialized: true, UserID: userID, Secret: secret}, audit.Append(tx, audit.Event{
			Kind: audit.KindRootBootstrap, Actor: audit.OfflineActor,
			Detail: audit.RootBootstrap{TargetUserID: userID, OperationID: input.operationID, Method: "oidc"}})
	}, database.RunOptions{})
}

// ReissueRoot gives the still pending bootstrap Root without a binding a fresh proof; earlier proofs and
// the enrollment are replaced in the same transaction.
func ReissueRoot(ctx context.Context, runner *database.Runner, issuer string) (string, error) {
	if issuer == "" {
		return "", rejection("invalid_release")
	}
	return database.Run(ctx, runner, database.ModeBootstrap, func(_ context.Context, tx *database.Tx) (string, error) {
		type target struct {
			ID       string  `db:"id"`
			State    string  `db:"state"`
			Root     bool    `db:"root"`
			Email    *string `db:"email"`
			Bindings int32   `db:"bindings"`
		}
		rows, err := tx.Query(lockReissueTarget)
		if err != nil {
			return "", err
		}
		targets, err := pgx.CollectRows(rows, pgx.RowToStructByName[target])
		if err != nil {
			return "", err
		}
		if len(targets) != 1 || targets[0].State != "pending" || !targets[0].Root {
			return "", rejection("collision")
		}
		root := targets[0]
		if root.Email == nil || *root.Email == "" || root.Bindings != 0 {
			return "", rejection("missing_reference")
		}
		if err := requireEnabledProvider(tx, issuer); err != nil {
			return "", err
		}
		for _, step := range []struct {
			sql  string
			args []any
		}{
			{consumeActivations, []any{root.ID}},
			{dropEnrollment, []any{root.ID}},
			{pinEnrollment, []any{root.ID, issuer, *root.Email, audit.OfflineActor}},
		} {
			if _, err := tx.Exec(step.sql, step.args...); err != nil {
				return "", err
			}
		}
		secret, err := issueActivation(tx, root.ID)
		if err != nil {
			return "", err
		}
		return secret, audit.Append(tx, audit.Event{Kind: audit.KindRootReissue, Actor: audit.OfflineActor,
			Detail: audit.RootReissue{TargetUserID: root.ID, Method: "oidc"}})
	}, database.RunOptions{})
}

func requireAppliedRelease(tx *database.Tx, release manifest.Release) error {
	type state struct {
		Hash         *string `db:"hash"`
		Materialized *string `db:"materialized"`
	}
	rows, err := tx.Query(appliedManifest)
	if err != nil {
		return err
	}
	states, err := pgx.CollectRows(rows, pgx.RowToStructByName[state])
	if err != nil {
		return err
	}
	if len(states) != 1 || states[0].Hash == nil || *states[0].Hash != release.Hash() || states[0].Materialized == nil {
		return rejection("not_ready")
	}
	materialized, err := manifest.ProtectedStateHash(tx)
	if err != nil {
		return err
	}
	if *states[0].Materialized != materialized {
		return rejection("not_ready")
	}
	return nil
}

func requireEnabledProvider(tx *database.Tx, issuer string) error {
	rows, err := tx.Query(enabledProvider, issuer)
	if err != nil {
		return err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[int32])
	if err != nil {
		return err
	}
	if len(found) == 0 {
		return rejection("missing_reference")
	}
	return nil
}

// issueActivation stores only the digest; the secret goes back to the offline command after commit.
func issueActivation(tx *database.Tx, userID string) (string, error) {
	secret := credential.NewSessionSecret()
	_, err := tx.Exec(insertActivation, credential.SecretDigest(secret), userID)
	return secret, err
}
