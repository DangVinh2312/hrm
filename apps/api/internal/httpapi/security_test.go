package httpapi_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/httpapi"
)

const (
	httpOrigin  = "http://localhost:3000"
	httpsOrigin = "https://hr.example.test"
)

func withHeaders(headers map[string][]string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/auth/oidc/begin", nil)
	for name, values := range headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	return request
}

func cookieRequest(cookies ...string) *http.Request {
	return withHeaders(map[string][]string{"Cookie": cookies})
}

func TestCookieNames(t *testing.T) {
	for origin, prefix := range map[string]string{httpOrigin: "", httpsOrigin: "__Host-"} {
		for key, name := range map[httpapi.CookieKey]string{
			httpapi.SessionCookie: "authz_session", httpapi.CSRFCookie: "authz_csrf", httpapi.BrowserCookie: "authz_browser",
		} {
			if got := httpapi.CookieName(origin, key); got != prefix+name {
				t.Errorf("%s %s: %q", origin, key, got)
			}
		}
	}
}

func TestOnlyOwnCookiesAreParsed(t *testing.T) {
	cases := map[string]struct {
		cookies []string
		origin  string
		secret  string
	}{
		"foreign junk is ignored":       {[]string{"junk; a=1; a=2; authz_session=s; =x"}, httpOrigin, "s"},
		"spaces around the pair":        {[]string{"  authz_session=s  ;b=1"}, httpOrigin, "s"},
		"malformed own value is absent": {[]string{"authz_session=a\\b"}, httpOrigin, ""},
		"value keeps its equals signs":  {[]string{"authz_session=a=b"}, httpOrigin, "a=b"},
		"no cookie":                     {nil, httpOrigin, ""},
		"empty value":                   {[]string{"authz_session="}, httpOrigin, ""},
		"other case is foreign":         {[]string{"AUTHZ_SESSION=s"}, httpOrigin, ""},
		"https needs __Host-":           {[]string{"authz_session=s"}, httpsOrigin, ""},
		"https own cookie":              {[]string{"authz_session=x; __Host-authz_session=s"}, httpsOrigin, "s"},
		"two Cookie headers":            {[]string{"a=1", "authz_session=s"}, httpOrigin, "s"},
	}
	for name, c := range cases {
		secret, err := httpapi.SessionSecret(cookieRequest(c.cookies...), c.origin)
		if err != nil || secret != c.secret {
			t.Errorf("%s: %q %v, want %q", name, secret, err, c.secret)
		}
	}
}

func TestARepeatedOwnCookieFailsClosed(t *testing.T) {
	for name, cookies := range map[string][]string{
		"one header":        {"authz_session=s; authz_session=t"},
		"same value":        {"authz_session=s; authz_session=s"},
		"two headers":       {"authz_session=s", "authz_session=t"},
		"padded repetition": {"authz_session=s;  authz_session=t "},
		"csrf":              {"authz_csrf=a; authz_csrf=b"},
	} {
		if _, err := httpapi.Cookies(cookieRequest(cookies...), httpOrigin); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestSetCookieAttributes(t *testing.T) {
	header := http.Header{}
	httpapi.SetCookie(header, httpOrigin, httpapi.CSRFCookie, "token", 3600)
	httpapi.SetCookie(header, httpOrigin, httpapi.BrowserCookie, "", 0)
	httpapi.SetCookie(header, httpsOrigin, httpapi.SessionCookie, "s", 28800)
	want := []string{
		"authz_csrf=token; Path=/; Max-Age=3600; SameSite=Lax; HttpOnly",
		"authz_browser=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly",
		"__Host-authz_session=s; Path=/; Max-Age=28800; SameSite=Lax; HttpOnly; Secure",
	}
	if got := header.Values("Set-Cookie"); !slices.Equal(got, want) {
		t.Errorf("got %q", got)
	}
}

func TestNewCSRF(t *testing.T) {
	pattern := regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	first, second := httpapi.NewCSRF(), httpapi.NewCSRF()
	if !pattern.MatchString(first) || !pattern.MatchString(second) || first == second {
		t.Errorf("%q %q", first, second)
	}
}

func csrfRequest(origin string, change func(map[string][]string)) *http.Request {
	token := strings.Repeat("a", 43)
	headers := map[string][]string{
		"Origin":       {origin},
		"Cookie":       {httpapi.CookieName(origin, httpapi.CSRFCookie) + "=" + token},
		"X-Csrf-Token": {token},
	}
	if change != nil {
		change(headers)
	}
	return withHeaders(headers)
}

func TestCSRFAcceptsTheExactOriginAndMatchingToken(t *testing.T) {
	for _, origin := range []string{httpOrigin, httpsOrigin} {
		if err := httpapi.EnforceCSRF(csrfRequest(origin, nil), origin); err != nil {
			t.Errorf("%s: %v", origin, err)
		}
	}
}

func TestCSRFRefusals(t *testing.T) {
	token := strings.Repeat("a", 43)
	cases := map[string]func(map[string][]string){
		"other origin":         func(h map[string][]string) { h["Origin"] = []string{"http://attacker.test"} },
		"origin with a slash":  func(h map[string][]string) { h["Origin"] = []string{httpOrigin + "/"} },
		"origin of other case": func(h map[string][]string) { h["Origin"] = []string{"HTTP://localhost:3000"} },
		"no origin":            func(h map[string][]string) { delete(h, "Origin") },
		"empty origin":         func(h map[string][]string) { h["Origin"] = []string{""} },
		"repeated origin":      func(h map[string][]string) { h["Origin"] = []string{httpOrigin, httpOrigin} },
		"no token":             func(h map[string][]string) { delete(h, "X-Csrf-Token") },
		"empty token":          func(h map[string][]string) { h["X-Csrf-Token"] = []string{""} },
		"repeated token":       func(h map[string][]string) { h["X-Csrf-Token"] = []string{token, token} },
		"no cookie":            func(h map[string][]string) { delete(h, "Cookie") },
		"other token":          func(h map[string][]string) { h["X-Csrf-Token"] = []string{strings.Repeat("b", 43)} },
		"short token and cookie": func(h map[string][]string) {
			h["X-Csrf-Token"] = []string{token[:42]}
			h["Cookie"] = []string{"authz_csrf=" + token[:42]}
		},
		"long token and cookie": func(h map[string][]string) {
			h["X-Csrf-Token"] = []string{token + "a"}
			h["Cookie"] = []string{"authz_csrf=" + token + "a"}
		},
		"token outside base64url": func(h map[string][]string) {
			h["X-Csrf-Token"] = []string{strings.Repeat("+", 43)}
			h["Cookie"] = []string{"authz_csrf=" + strings.Repeat("+", 43)}
		},
		"cookie of other length": func(h map[string][]string) { h["Cookie"] = []string{"authz_csrf=" + token[:42]} },
		"cookie with more bytes": func(h map[string][]string) { h["Cookie"] = []string{"authz_csrf=\xe9" + token[:42]} },
		"token with a space":     func(h map[string][]string) { h["X-Csrf-Token"] = []string{token[:42] + " "} },
	}
	for name, change := range cases {
		if err := httpapi.EnforceCSRF(csrfRequest(httpOrigin, change), httpOrigin); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestCSRFOnHTTPSNeedsTheHostCookie(t *testing.T) {
	token := strings.Repeat("a", 43)
	request := csrfRequest(httpsOrigin, func(h map[string][]string) { h["Cookie"] = []string{"authz_csrf=" + token} })
	if err := httpapi.EnforceCSRF(request, httpsOrigin); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Errorf("got %v", err)
	}
}

func TestCSRFWithARepeatedOwnCookieIsInvalid(t *testing.T) {
	token := strings.Repeat("a", 43)
	request := csrfRequest(httpOrigin, func(h map[string][]string) {
		h["Cookie"] = []string{"authz_csrf=" + token + "; authz_csrf=" + token}
	})
	if err := httpapi.EnforceCSRF(request, httpOrigin); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("got %v", err)
	}
}
