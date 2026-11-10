package administration

import (
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/database"
)

// identityOperation runs one identity function under a savepoint. P0002 and the function's own "only IAM
// accounts" 42501 mean the account is absent or not IAM (it changed kind after the lookup): rolled back to the
// savepoint, so the transaction can still write Root's audit, and not found. 55000 and 23505 are the business
// refusals. Anything else, 22023 and any other 42501 (revoked EXECUTE) included, is a fault.
func identityOperation(tx *database.Tx, call func() error) (bool, error) {
	if _, err := tx.Exec(`SAVEPOINT identity_operation`); err != nil {
		return false, err
	}
	err := call()
	if err == nil {
		return true, nil
	}
	switch state := sqlState(err); {
	case state == "P0002" || state == "42501" && notIAMRefusal(err):
		_, err = tx.Exec(`ROLLBACK TO SAVEPOINT identity_operation`)
		return false, err
	case state == "55000" || state == "23505":
		return false, apperror.ErrCommandRejected
	}
	return false, err
}

func notIAMRefusal(err error) bool {
	driver, ok := errors.AsType[*pgconn.PgError](err)
	return ok && strings.HasPrefix(driver.Message, "only IAM accounts ")
}

// changeIAMAccountEmail sets the email (email_verified false), recreates a pending enrollment at issuer and
// advances auth_epoch.
func changeIAMAccountEmail(tx *database.Tx, userID, email, issuer, actor string) error {
	_, err := tx.Exec(`SELECT public.change_iam_account_email($1,$2,$3,$4)`, userID, email, issuer, actor)
	return err
}

// resetIAMMfa deletes the second factor and its recovery codes and advances auth_epoch.
func resetIAMMfa(tx *database.Tx, userID string) error {
	_, err := tx.Exec(`SELECT public.reset_iam_mfa($1)`, userID)
	return err
}

// resetIAMGoogleBinding disables the binding, invites the account again at issuer and advances auth_epoch.
func resetIAMGoogleBinding(tx *database.Tx, userID, issuer, actor string) error {
	_, err := tx.Exec(`SELECT public.reset_iam_google_binding($1,$2,$3)`, userID, issuer, actor)
	return err
}
