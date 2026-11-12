package main

import (
	"context"
	"errors"
	"os"

	"hrm/api/internal/authorization/declarations"
	"hrm/api/internal/authorization/manifest"
	"hrm/api/internal/database"
	"hrm/api/internal/offline"
)

const bootstrapURL = "PRODUCT_BOOTSTRAP_DATABASE_URL"

// withActivationFile reserves the file before any state changes, so an old proof is never overwritten.
// work returns the secret only when it committed one; without it the file is removed. The secret goes
// only into the file.
func withActivationFile(name string, work func() (string, error)) error {
	if name == "" {
		return &usageError{message: "--activation-file outside the repository/logs is required"}
	}
	file, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // the offline operator names the file; O_EXCL never opens an existing one
	if err != nil {
		return &usageError{message: "--activation-file must name a new file"}
	}
	secret, err := work()
	if err == nil && secret != "" {
		_, err = file.WriteString(secret + "\n")
	}
	err = errors.Join(err, file.Close())
	if err != nil || secret == "" {
		err = errors.Join(err, os.Remove(name))
	}
	return err
}

func bootstrap(ctx context.Context, env func(string) string, flags map[string]string) (string, error) {
	c, err := declarations.NewCore()
	if err != nil {
		return "", err
	}
	if !c.IsCanonicalUUID(flags["--operation"]) {
		return "", &usageError{message: "Explicit canonical --operation required"}
	}
	if flags["--issuer"] == "" || flags["--email"] == "" {
		return "", &usageError{message: "--issuer and --email required"}
	}
	input, err := offline.NewRootBootstrap(c, flags["--operation"], flags["--issuer"], flags["--email"])
	if err != nil {
		return "", err
	}
	release, err := manifest.Prepare(declarations.Source(), c)
	if err != nil {
		return "", err
	}
	var line string
	err = withActivationFile(flags["--activation-file"], func() (string, error) {
		runner, pools, err := openRunner(ctx, env, bootstrapURL, database.PurposeBootstrap)
		if err != nil {
			return "", err
		}
		defer pools.Close()
		result, err := offline.BootstrapRoot(ctx, runner, release, input)
		if err != nil {
			return "", err
		}
		// The id is not a secret: revoke-root and reset-root-mfa take it as --user.
		line = "Operation already committed (id " + result.UserID + "); marker and Root unchanged."
		if result.Initialized {
			line = "Root enrollment committed (id " + result.UserID + "); activation still required."
		}
		return result.Secret, nil
	})
	return line, err
}

func reissueRoot(ctx context.Context, env func(string) string, flags map[string]string) (string, error) {
	if flags["--issuer"] == "" {
		return "", &usageError{message: "--issuer required"}
	}
	return "Root activation proof reissued; earlier proofs are void.", withActivationFile(flags["--activation-file"], func() (string, error) {
		runner, pools, err := openRunner(ctx, env, bootstrapURL, database.PurposeBootstrap)
		if err != nil {
			return "", err
		}
		defer pools.Close()
		return offline.ReissueRoot(ctx, runner, flags["--issuer"])
	})
}

func revokeRoot(ctx context.Context, env func(string) string, flags map[string]string) (string, error) {
	c, err := declarations.NewCore()
	if err != nil {
		return "", err
	}
	if !c.IsCanonicalUUID(flags["--user"]) || !c.IsCanonicalUUID(flags["--operation"]) {
		return "", &usageError{message: "Explicit canonical --user and --operation required"}
	}
	if flags["--approval"] == "" || flags["--reason"] == "" {
		return "", &usageError{message: "Root revocation requires --approval and --reason"}
	}
	input, err := offline.NewRootRevocation(c, flags["--user"], flags["--operation"], flags["--approval"], flags["--reason"])
	if err != nil {
		return "", err
	}
	runner, pools, err := openRunner(ctx, env, bootstrapURL, database.PurposeBootstrap)
	if err != nil {
		return "", err
	}
	defer pools.Close()
	revoked, err := offline.RevokeRoot(ctx, runner, input)
	if err != nil || !revoked {
		return "No unsuspended Root for this user; nothing changed.", err
	}
	return "Root suspended and its sessions revoked; marker unchanged.", nil
}

func setRootEmail(ctx context.Context, env func(string) string, flags map[string]string) (string, error) {
	c, err := declarations.NewCore()
	if err != nil {
		return "", err
	}
	if !c.IsCanonicalUUID(flags["--user"]) || !c.IsCanonicalUUID(flags["--operation"]) {
		return "", &usageError{message: "Explicit canonical --user and --operation required"}
	}
	if flags["--email"] == "" {
		return "", &usageError{message: "--email required"}
	}
	input, err := offline.NewRootEmail(c, flags["--user"], flags["--operation"], flags["--email"])
	if err != nil {
		return "", err
	}
	runner, pools, err := openRunner(ctx, env, bootstrapURL, database.PurposeBootstrap)
	if err != nil {
		return "", err
	}
	defer pools.Close()
	changed, err := offline.SetRootEmail(ctx, runner, input)
	if err != nil || !changed {
		return "Root already has this email; nothing changed.", err
	}
	return "Root email set, unverified until the next verified Google sign-in; its sessions ended.", nil
}
