package manifest

import (
	"context"
	"slices"
	"strconv"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/audit"
	"hrm/api/internal/database"
)

func Reconcile(ctx context.Context, reconciler *Reconciler, release Release) (Result, error) {
	if reconciler == nil || reconciler.core != release.owner || release.owner == nil || !release.owner.IsValidated(release.declarations) || release.hash == "" {
		return Result{}, reject("invalid_release")
	}
	capabilities := release.declarations.Capabilities()
	for _, validator := range capabilities.Validators {
		if !slices.Contains(reconciler.capabilities.Validators, validator) {
			return Result{}, reject("missing_capability")
		}
	}
	for _, handler := range capabilities.ObligationHandlers {
		if !slices.Contains(reconciler.capabilities.ObligationHandlers, handler) {
			return Result{}, reject("missing_capability")
		}
	}
	var result Result
	work := func(tx *database.Tx) error {
		current, err := readState(tx)
		if err != nil {
			return err
		}
		sequence, err := strconv.ParseInt(release.source.Sequence, 10, 64)
		if err != nil {
			return reject("invalid_release")
		}
		previous, err := strconv.ParseInt(current.Sequence, 10, 64)
		if err != nil {
			return reject("not_ready")
		}
		if sequence == previous {
			if release.hash != current.Hash {
				return reject("conflicting_release")
			}
			if err := verifyApplied(tx, release); err != nil {
				return err
			}
			hash, err := ProtectedStateHash(tx)
			if err != nil {
				return err
			}
			if current.Materialized == nil || hash != *current.Materialized {
				return reject("not_ready")
			}
			result = Result{Revision: tx.Revision, ManifestHash: release.hash}
			return nil
		}
		if sequence < previous {
			return reject("downgrade")
		}
		genesis := false
		if current.Sequence == "0" {
			genesis, err = catalogIsEmpty(tx)
			if err != nil {
				return err
			}
		}
		if !genesis && release.source.Predecessor != current.Sequence {
			return reject("predecessor_mismatch")
		}
		if current.Sequence != "0" {
			hash, err := ProtectedStateHash(tx)
			if err != nil {
				return err
			}
			if current.Materialized == nil || hash != *current.Materialized {
				return reject("not_ready")
			}
		}
		created, err := applyDefinitions(tx, release)
		if err != nil {
			return err
		}
		if err := applyBoundaries(tx, release); err != nil {
			return err
		}
		if err := applySeeds(tx, release, created); err != nil {
			return err
		}
		for _, grant := range release.source.RemoveDefaultGrants {
			id, err := grantID(grant)
			if err != nil {
				return err
			}
			rows, err := tx.Query("WITH removed AS (DELETE FROM policy_rule WHERE rule_id=$1 AND managed_by='code' AND system_owner IS NULL RETURNING 1) SELECT * FROM removed", id)
			if err != nil {
				return err
			}
			removed, err := pgx.CollectRows(rows, pgx.RowTo[int])
			if err != nil {
				return err
			}
			if len(removed) == 0 {
				return reject("missing_reference")
			}
		}
		if err := verifyApplied(tx, release); err != nil {
			return err
		}
		materialized, err := ProtectedStateHash(tx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE authz_state SET revision=revision+1,manifest_hash=decode($1,'hex'),release_sequence=$2,min_runtime_capability=$3,materialized_hash=decode($4,'hex') WHERE singleton`, release.hash, release.source.Sequence, 1, materialized); err != nil {
			return err
		}
		revision, err := strconv.ParseInt(tx.Revision, 10, 64)
		if err != nil {
			return reject("not_ready")
		}
		published := strconv.FormatInt(revision+1, 10)
		if err := audit.Append(tx, audit.Event{Kind: audit.KindManifestSync, Actor: audit.OfflineActor, Detail: audit.ManifestSync{Sequence: release.source.Sequence, Hash: release.hash, PublishedRevision: published}}); err != nil {
			return err
		}
		result = Result{Changed: true, Revision: published, ManifestHash: release.hash}
		return nil
	}
	return database.Run(ctx, reconciler.runner, database.ModeSync, func(_ context.Context, tx *database.Tx) (Result, error) {
		err := work(tx)
		return result, err
	}, database.RunOptions{})
}

type storedState struct {
	Sequence, Hash string
	Materialized   *string
}

func readState(tx *database.Tx) (storedState, error) {
	rows, err := tx.Query(`SELECT release_sequence::text sequence,encode(manifest_hash,'hex') hash,encode(materialized_hash,'hex') materialized FROM authz_state WHERE singleton`)
	if err != nil {
		return storedState{}, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[storedState])
	if err != nil {
		return storedState{}, err
	}
	if len(found) != 1 {
		return storedState{}, reject("not_ready")
	}
	return found[0], nil
}
