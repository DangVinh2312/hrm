package main

import (
	"context"

	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/authorization/manifest"
	"hrm/api-go/internal/config"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/permission"
)

func syncManifest(ctx context.Context, env func(string) string) error {
	settings := map[string]string{}
	for _, key := range []string{"PRODUCT_DATA_DATABASE_URL", "PRODUCT_IDENTITY_DATABASE_URL", "PRODUCT_AUTHORITY_DATABASE_URL", "PRODUCT_SYNC_DATABASE_URL", "DATABASE_ADMIN_URL", "PRODUCT_MIGRATION_DATABASE_URL", "PRODUCT_BOOTSTRAP_DATABASE_URL", "PRODUCT_OUTBOX_DATABASE_URL"} {
		settings[key] = env(key)
	}
	urls, err := config.RuntimeDatabases(settings)
	if err != nil {
		return err
	}
	tls, err := tlsMode(env)
	if err != nil {
		return err
	}
	pools, err := database.OpenPools(ctx, map[database.Purpose]string{database.PurposeData: urls.Data, database.PurposeIdentity: urls.Identity, database.PurposeAuthority: urls.Authority, database.PurposeSync: urls.Sync}, tls)
	if err != nil {
		return err
	}
	defer pools.Close()
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
	if _, err := manifest.Reconcile(ctx, reconciler, release); err != nil {
		return err
	}
	for _, ensure := range []func(*database.Tx) error{permission.EnsureCompany, permission.EnsureWorkCalendar, permission.EnsureSetting, permission.EnsureRole} {
		if _, err := database.Run(ctx, runner, database.ModeSync, func(_ context.Context, tx *database.Tx) (struct{}, error) { return struct{}{}, ensure(tx) }, database.RunOptions{}); err != nil {
			return err
		}
	}
	return nil
}
