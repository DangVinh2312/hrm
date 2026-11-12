package test

import "context"

var (
	PostgresReady    = postgresReady
	ContainerStartup = containerStartup
	OpenPoolsWaiting = openPools
	BuildHrmctl      = buildHrmctl
)

const RunnerCluster = runnerCluster

func AttachPostgres(target string) error {
	_, err := attachPostgres(target)
	return err
}

// AttachAndClone does what a package of a runner run does first, then clones the template for a data login.
func AttachAndClone(name string) (string, error) {
	c, err := startCluster()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), databaseTimeout)
	defer cancel()
	if err := c.cloneTemplate(ctx, name); err != nil {
		return "", err
	}
	return c.postgres.LoginURL("product_data", c.passwords["data"], name) + "?sslmode=disable", nil
}
