package httpapi

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"hrm/api-go/internal/apperror"
)

type CookieKey string

const (
	SessionCookie CookieKey = "session"
	CSRFCookie    CookieKey = "csrf"
	BrowserCookie CookieKey = "browser"
)

// singleHeader returns the value of name only when it came once; a repeated Origin or x-csrf-token is
// ambiguous and matches nothing.
func singleHeader(request *http.Request, name string) string {
	if values := request.Header.Values(name); len(values) == 1 {
		return values[0]
	}
	return ""
}

func secure(origin string) bool {
	return strings.HasPrefix(origin, "https:")
}

func CookieName(origin string, key CookieKey) string {
	if secure(origin) {
		return "__Host-authz_" + string(key)
	}
	return "authz_" + string(key)
}

// Cookies keeps only this API's cookies; net/http skips malformed ones, so cookies of other apps on
// the site cannot deny service. A repeated own cookie is ambiguous and fails closed.
func Cookies(request *http.Request, origin string) (map[string]string, error) {
	own := []string{CookieName(origin, SessionCookie), CookieName(origin, CSRFCookie), CookieName(origin, BrowserCookie)}
	result := map[string]string{}
	for _, cookie := range request.Cookies() {
		if !slices.Contains(own, cookie.Name) {
			continue
		}
		if _, repeated := result[cookie.Name]; repeated {
			return nil, apperror.ErrInvalidRequest
		}
		result[cookie.Name] = cookie.Value
	}
	return result, nil
}

func SessionSecret(request *http.Request, origin string) (string, error) {
	own, err := Cookies(request, origin)
	if err != nil {
		return "", err
	}
	return own[CookieName(origin, SessionCookie)], nil
}

func SetCookie(target http.Header, origin string, key CookieKey, value string, maxAge int) {
	cookie := CookieName(origin, key) + "=" + value + "; Path=/; Max-Age=" + strconv.Itoa(maxAge) + "; SameSite=Lax; HttpOnly"
	if secure(origin) {
		cookie += "; Secure"
	}
	target.Add("Set-Cookie", cookie)
}

func NewCSRF() string {
	random := make([]byte, 32)
	_, _ = rand.Read(random)
	return base64.RawURLEncoding.EncodeToString(random)
}

var csrfPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func EnforceCSRF(request *http.Request, origin string) error {
	own, err := Cookies(request, origin)
	if err != nil {
		return err
	}
	token := singleHeader(request, "X-Csrf-Token")
	stored := own[CookieName(origin, CSRFCookie)]
	if singleHeader(request, "Origin") != origin || !csrfPattern.MatchString(token) ||
		subtle.ConstantTimeCompare([]byte(token), []byte(stored)) != 1 {
		return apperror.ErrAccessDenied
	}
	return nil
}
