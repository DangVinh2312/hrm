package hrbase

import (
	"errors"
	"regexp"
)

const BusinessToday = "(statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date"

var ErrInvalidAlias = errors.New("invalid SQL alias")

var aliasGrammar = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)

func CurrentWindow(alias string) (string, error) {
	if !aliasGrammar.MatchString(alias) {
		return "", ErrInvalidAlias
	}
	return alias + ".starts_at <= statement_timestamp() AND (" + alias + ".ends_at IS NULL OR " + alias + ".ends_at > statement_timestamp())", nil
}
