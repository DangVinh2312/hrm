package test

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// shareTemplate builds the template of a runner cluster once: the first package builds it under another
// name and renames it, so a package that died half way leaves nothing the next one would clone.
func (c *cluster) shareTemplate(ctx context.Context) error {
	conn, err := c.postgres.ConnectSuperuser(ctx, maintenanceDB)
	for err != nil {
		select {
		case <-ctx.Done():
			return fmt.Errorf("runner cluster: %s", Redact(err))
		case <-time.After(poolRetryPause):
		}
		conn, err = c.postgres.ConnectSuperuser(ctx, maintenanceDB)
	}
	var built bool
	if _, err = conn.Exec(ctx, "SELECT pg_advisory_lock(1)"); err == nil {
		err = conn.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)", templateDatabase).Scan(&built)
	}
	if err == nil && !built {
		if _, err = conn.Exec(ctx, "DROP DATABASE IF EXISTS "+templateBuilding+" WITH (FORCE)"); err == nil {
			if err = c.buildTemplate(ctx, templateBuilding); err != nil {
				return errors.Join(err, conn.Close(ctx))
			}
			_, err = conn.Exec(ctx, "ALTER DATABASE "+templateBuilding+" RENAME TO "+templateDatabase)
		}
	}
	if err = errors.Join(err, conn.Close(ctx)); err != nil {
		return fmt.Errorf("runner template: %s", Redact(err))
	}
	return nil
}
