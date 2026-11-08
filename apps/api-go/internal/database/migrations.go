package database

import (
	"embed"
	"io/fs"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Migrations gives the goose files at the root of the returned FS.
func Migrations() (fs.FS, error) {
	return fs.Sub(migrationFiles, "migrations")
}
