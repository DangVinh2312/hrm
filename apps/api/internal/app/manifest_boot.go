package app

import (
	"context"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/authorization/declarations"
	"hrm/api/internal/authorization/manifest"
	"hrm/api/internal/config"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/permission"
)

type bootStep struct {
	name string
	run  func(context.Context, config.Config, database.Pools) error
}

func runBootSteps(ctx context.Context, cfg config.Config, pools database.Pools, checks []bootStep) error {
	for _, check := range checks {
		if err := check.run(ctx, cfg, pools); err != nil {
			return &BootError{check.name, err}
		}
	}
	return nil
}

func permissionBootSteps() []bootStep {
	return []bootStep{{"permission protection", func(ctx context.Context, _ config.Config, pools database.Pools) error {
		return permission.VerifyProtection(ctx, pools[database.PurposeData])
	}}}
}

func manifestBootSteps() []bootStep {
	checks := []bootStep{{"manifest", syncRelease}, {"oidc provider sync", syncProviders}}
	for _, anchor := range []struct {
		name   string
		ensure func(*database.Tx) error
	}{
		{"company anchor", permission.EnsureCompany}, {"work calendar anchor", permission.EnsureWorkCalendar}, {"setting anchor", permission.EnsureSetting}, {"role anchor", permission.EnsureRole},
	} {
		checks = append(checks, bootStep{anchor.name, func(ctx context.Context, _ config.Config, pools database.Pools) error {
			runner, err := database.NewRunner(pools, database.RunnerOptions{})
			if err != nil {
				return err
			}
			_, err = database.Run(ctx, runner, database.ModeSync, func(_ context.Context, tx *database.Tx) (struct{}, error) { return struct{}{}, anchor.ensure(tx) }, database.RunOptions{})
			return err
		}})
	}
	return append(checks, bootStep{"domain schema", verifyDomainSchema},
		bootStep{"work calendar schema", func(ctx context.Context, _ config.Config, pools database.Pools) error {
			return permission.VerifyWorkCalendarSchema(ctx, pools[database.PurposeData])
		}},
		bootStep{"setting schema", func(ctx context.Context, _ config.Config, pools database.Pools) error {
			return permission.VerifySettingSchema(ctx, pools[database.PurposeData])
		}},
	)
}

func syncRelease(ctx context.Context, _ config.Config, pools database.Pools) error {
	c, err := declarations.NewCore()
	if err != nil {
		return err
	}
	release, err := manifest.Prepare(declarations.Source(), c)
	if err != nil {
		return err
	}
	runner, err := database.NewRunner(pools, database.RunnerOptions{})
	if err != nil {
		return err
	}
	reconciler, err := manifest.NewReconciler(runner, c, declarations.RuntimeCapabilities())
	if err != nil {
		return err
	}
	_, err = manifest.Reconcile(ctx, reconciler, release)
	return err
}

func syncProviders(ctx context.Context, cfg config.Config, pools database.Pools) error {
	runner, err := database.NewRunner(pools, database.RunnerOptions{})
	if err != nil {
		return err
	}
	_, err = database.Run(ctx, runner, database.ModeSync, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		rows, err := tx.Query("SELECT issuer,version::text version,enabled FROM oidc_provider")
		if err != nil {
			return struct{}{}, err
		}
		type provider struct {
			Issuer, Version string
			Enabled         bool
		}
		found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[provider])
		if err != nil {
			return struct{}{}, err
		}
		declared := make([]string, 0, len(cfg.OidcProviders))
		for _, p := range cfg.OidcProviders {
			declared = append(declared, p.Issuer)
		}
		for _, p := range found {
			if p.Enabled && !slices.Contains(declared, p.Issuer) {
				return struct{}{}, errors.New("provider disable requires offline revoke")
			}
		}
		for _, p := range cfg.OidcProviders {
			index := slices.IndexFunc(found, func(existing provider) bool { return existing.Issuer == p.Issuer })
			if index >= 0 {
				if found[index].Version != p.Version || !found[index].Enabled {
					return struct{}{}, errors.New("provider drift requires release")
				}
				continue
			}
			if _, err := tx.Exec("INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,$2,true)", p.Issuer, p.Version); err != nil {
				return struct{}{}, err
			}
			if _, err := tx.Exec("UPDATE authz_state SET revision=revision+1 WHERE singleton"); err != nil {
				return struct{}{}, err
			}
		}
		return struct{}{}, nil
	}, database.RunOptions{})
	return err
}
