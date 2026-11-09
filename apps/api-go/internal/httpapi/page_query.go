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

// InputQuery reads a raw query of exactly the keys named (distinct), each once. A key missing, repeated
// (after percent-decoding) or not named is refused, as InputPageQuery refuses it.
func InputQuery(rawQuery string, keys ...string) (map[string]string, error) {
	query, err := url.ParseQuery(rawQuery)
	if err != nil || len(query) != len(keys) {
		return nil, apperror.ErrInvalidRequest
	}
	values := make(map[string]string, len(keys))
	for _, key := range keys {
		value, ok := query[key]
		if !ok || len(value) != 1 {
			return nil, apperror.ErrInvalidRequest
		}
		values[key] = value[0]
	}
	return values, nil
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
