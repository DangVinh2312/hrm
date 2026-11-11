package main

import (
	"context"
	"regexp"
	"strconv"

	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/authorization/grant"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/offline"
)

const (
	maxRetentionDays = 3650
	// A bounded run: at most 200 short transactions of 500 sessions; the operator reruns to continue.
	purgeBatches   = 200
	purgeBatchSize = 500
)

var retentionDays = regexp.MustCompile(`^[0-9]{1,4}$`)

// openRunner opens the pool of the one login a command needs, from its one URL variable.
func openRunner(ctx context.Context, env func(string) string, variable string, purpose database.Purpose) (*database.Runner, database.Pools, error) {
	raw, err := required(env, variable)
	if err != nil {
		return nil, nil, err
	}
	tls, err := tlsMode(env)
	if err != nil {
		return nil, nil, err
	}
	settings, err := connection(raw, variable, tls)
	if err != nil {
		return nil, nil, err
	}
	if settings.Database == "" {
		return nil, nil, &usageError{message: variable + " must be a PostgreSQL URL"}
	}
	pools, err := database.OpenPools(ctx, map[database.Purpose]string{purpose: raw}, tls)
	if err != nil {
		return nil, nil, err
	}
	runner, err := database.NewRunner(pools, database.RunnerOptions{})
	if err != nil {
		pools.Close()
		return nil, nil, err
	}
	return runner, pools, nil
}

func enroll(ctx context.Context, env func(string) string, flags map[string]string) error {
	c, err := declarations.NewCore()
	if err != nil {
		return err
	}
	input := offline.Enrollment{UserID: flags["--user"], Issuer: flags["--issuer"], RoleKey: flags["--role"]}
	if !c.IsCanonicalUUID(input.UserID) || input.UserID == audit.OfflineActor {
		return &usageError{message: "--user must be an explicit canonical UUID, not the offline actor id"}
	}
	if input.Issuer == "" {
		return &usageError{message: "Enrollment requires the exact --issuer"}
	}
	if !grant.IsRoleKeyReference(input.RoleKey) {
		return &usageError{message: "Enrollment requires the --role of the account"}
	}
	if input.Email, err = credential.CanonicalLoginEmail(flags["--email"]); err != nil {
		return &usageError{message: "Enrollment requires a login --email"}
	}
	runner, pools, err := openRunner(ctx, env, "PRODUCT_AUTHORITY_DATABASE_URL", database.PurposeAuthority)
	if err != nil {
		return err
	}
	defer pools.Close()
	return offline.Enroll(ctx, runner, input)
}

func purgeSessions(ctx context.Context, env func(string) string, flags map[string]string) (string, error) {
	if !retentionDays.MatchString(flags["--retention-days"]) {
		return "", &usageError{message: "--retention-days <0-3650> is required"}
	}
	days, err := strconv.Atoi(flags["--retention-days"])
	if err != nil || days > maxRetentionDays {
		return "", offline.ErrInvalidPurge
	}
	runner, pools, err := openRunner(ctx, env, "PRODUCT_IDENTITY_DATABASE_URL", database.PurposeIdentity)
	if err != nil {
		return "", err
	}
	defer pools.Close()
	deleted := 0
	for range purgeBatches {
		n, err := offline.PurgeExpiredSessions(ctx, runner, days, purgeBatchSize)
		deleted += n
		if err != nil {
			return "", err
		}
		if n < purgeBatchSize {
			break
		}
	}
	return "Purged " + strconv.Itoa(deleted) + " expired sessions.", nil
}

// resetMFA resets IAM accounts with the identity login and the Root with the bootstrap login.
func resetMFA(ctx context.Context, env func(string) string, flags map[string]string, root bool) (string, error) {
	c, err := declarations.NewCore()
	if err != nil {
		return "", err
	}
	if !c.IsCanonicalUUID(flags["--user"]) || !c.IsCanonicalUUID(flags["--operation"]) {
		return "", &usageError{message: "Explicit canonical --user and --operation required"}
	}
	if flags["--approval"] == "" || flags["--reason"] == "" {
		return "", &usageError{message: "Second factor reset requires --approval and --reason"}
	}
	reset, err := offline.NewMFAReset(c, flags["--user"], flags["--operation"], flags["--approval"], flags["--reason"])
	if err != nil {
		return "", err
	}
	variable, purpose, mode := "PRODUCT_IDENTITY_DATABASE_URL", database.PurposeIdentity, database.ModeRevoke
	if root {
		variable, purpose, mode = "PRODUCT_BOOTSTRAP_DATABASE_URL", database.PurposeBootstrap, database.ModeBootstrap
	}
	runner, pools, err := openRunner(ctx, env, variable, purpose)
	if err != nil {
		return "", err
	}
	defer pools.Close()
	removed, err := offline.ResetMFA(ctx, runner, reset, mode)
	if err != nil {
		return "", err
	}
	if !removed {
		return "No second factor; nothing changed.", nil
	}
	return "Second factor and recovery codes removed; the account sessions ended.", nil
}
