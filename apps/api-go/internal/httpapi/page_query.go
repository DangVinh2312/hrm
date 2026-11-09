package httpapi

import (
	"net/url"
	"regexp"
	"slices"
	"strconv"

	"hrm/api-go/internal/apperror"
)

const (
	defaultPageLimit = 20
	maxPageLimit     = 100
	maxPageOffset    = 10_000
)

var pageNumber = regexp.MustCompile(`^[0-9]{1,5}$`)

type Page struct {
	Limit, Offset int
	Extra         map[string]string
}

// InputPageQuery reads ?limit=&offset= and the declared extra keys from a raw query. A repeated key
// (after percent-decoding) or a key nobody declared is refused: the first value must never win silently.
func InputPageQuery(rawQuery string, extra ...string) (Page, error) {
	query, err := url.ParseQuery(rawQuery)
	if err != nil {
		return Page{}, apperror.ErrInvalidRequest
	}
	page := Page{Limit: defaultPageLimit, Extra: map[string]string{}}
	for key, values := range query {
		if len(values) != 1 {
			return Page{}, apperror.ErrInvalidRequest
		}
		value := values[0]
		switch {
		case key == "limit" || key == "offset":
			number, err := parsePageNumber(value)
			if err != nil {
				return Page{}, err
			}
			if key == "limit" {
				page.Limit = number
			} else {
				page.Offset = number
			}
		case slices.Contains(extra, key):
			page.Extra[key] = value
		default:
			return Page{}, apperror.ErrInvalidRequest
		}
	}
	if page.Limit < 1 || page.Limit > maxPageLimit || page.Offset > maxPageOffset {
		return Page{}, apperror.ErrInvalidRequest
	}
	return page, nil
}

func parsePageNumber(value string) (int, error) {
	if !pageNumber.MatchString(value) {
		return 0, apperror.ErrInvalidRequest
	}
	number, err := strconv.Atoi(value)
	if err != nil {
		return 0, apperror.ErrInvalidRequest
	}
	return number, nil
}
