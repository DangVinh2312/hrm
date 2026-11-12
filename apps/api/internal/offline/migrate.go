package offline

import (
	"context"
	"database/sql"
	"errors"

	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"hrm/api/internal/database"
)

// Migrate applies every pending migration under the migration login. The first run on an empty database
// needs Provision, because the baselines hand objects to owners through SET ROLE.
func Migrate(ctx context.Context, migration Connection) error {
	return runMigrations(ctx, migration, 0)
}

func runMigrations(ctx context.Context, migration Connection, version int64) (err error) {
	config, err := database.NewConnConfig(migration.url(), migration.TLS)
	if err != nil {
		return err
	}
	db := sql.OpenDB(stdlib.GetConnector(*config))
	defer func() { err = errors.Join(err, db.Close()) }()
	files, err := database.Migrations()
	if err != nil {
		return err
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, files, goose.WithDisableGlobalRegistry(true))
	if err != nil {
		return err
	}
	if version == 0 {
		_, err = provider.Up(ctx)
		return err
	}
	_, err = provider.UpTo(ctx, version)
	return err
}
