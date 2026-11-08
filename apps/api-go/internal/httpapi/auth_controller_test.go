package httpapi_test

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"testing"

	"github.com/gin-gonic/gin"

	"hrm/api-go/contract"
	"hrm/api-go/internal/httpapi"
)

func authEngine(t *testing.T, origin string) (*gin.Engine, *httpapi.Group) {
	t.Helper()
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	group := httpapi.NewGroup(engine.Group(""), nil)
	if err := httpapi.RegisterAuth(group, origin); err != nil {
		t.Fatal(err)
	}
	if err := httpapi.CheckRoutes(engine); err != nil {
		t.Fatal(err)
	}
	return engine, group
}

func getAuth(engine *gin.Engine, path string, headers ...string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	for i := 0; i+1 < len(headers); i += 2 {
		request.Header.Add(headers[i], headers[i+1])
	}
	return serve(engine, request)
}

func assertJSONAnswer(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Errorf("status %d", response.Code)
	}
	for name, want := range map[string]string{
		"Content-Type":           "application/json; charset=utf-8",
		"Cache-Control":          "no-store",
		"X-Content-Type-Options": "nosniff",
	} {
		if got := response.Header().Values(name); !slices.Equal(got, []string{want}) {
			t.Errorf("%s: %q", name, got)
		}
	}
}

func TestCSRFIssuesATokenAndItsCookie(t *testing.T) {
	for origin, cookie := range map[string]*regexp.Regexp{
		httpOrigin:  regexp.MustCompile(`^authz_csrf=([A-Za-z0-9_-]{43}); Path=/; Max-Age=3600; SameSite=Lax; HttpOnly$`),
		httpsOrigin: regexp.MustCompile(`^__Host-authz_csrf=([A-Za-z0-9_-]{43}); Path=/; Max-Age=3600; SameSite=Lax; HttpOnly; Secure$`),
	} {
		engine, _ := authEngine(t, origin)
		response := getAuth(engine, "/api/auth/csrf")
		assertJSONAnswer(t, response)
		cookies := response.Header().Values("Set-Cookie")
		if len(cookies) != 1 {
			t.Fatalf("%s: %q", origin, cookies)
		}
		match := cookie.FindStringSubmatch(cookies[0])
		if match == nil {
			t.Fatalf("%s: %q", origin, cookies[0])
		}
		if got, want := response.Body.String(), `{"csrfToken":"`+match[1]+`"}`; got != want {
			t.Errorf("%s: %s, want %s", origin, got, want)
		}
	}
}

func TestTheIssuedTokenPassesTheCSRFCheckOfAWrite(t *testing.T) {
	for _, origin := range []string{httpOrigin, httpsOrigin} {
		engine, _ := authEngine(t, origin)
		response := getAuth(engine, "/api/auth/csrf")
		var answer struct {
			CSRFToken string `json:"csrfToken"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &answer); err != nil {
			t.Fatal(err)
		}
		write := withHeaders(map[string][]string{
			"Origin":       {origin},
			"X-Csrf-Token": {answer.CSRFToken},
			"Cookie":       {httpapi.CookieName(origin, httpapi.CSRFCookie) + "=" + answer.CSRFToken},
		})
		if err := httpapi.EnforceCSRF(write, origin); err != nil {
			t.Errorf("%s: %v", origin, err)
		}
		other := getAuth(engine, "/api/auth/csrf")
		if other.Body.String() == response.Body.String() {
			t.Errorf("%s: the token was issued twice", origin)
		}
	}
}

func TestCSRFIsPublicWhateverTheCookiesSay(t *testing.T) {
	engine, _ := authEngine(t, httpOrigin)
	for _, cookie := range []string{"authz_csrf=a; authz_csrf=b", "authz_session=a; authz_session=b", "junk"} {
		assertJSONAnswer(t, getAuth(engine, "/api/auth/csrf", "Cookie", cookie))
	}
}

func TestOptionsNamesOnlyTheSignInMethod(t *testing.T) {
	engine, _ := authEngine(t, httpOrigin)
	response := getAuth(engine, "/api/auth/options")
	assertJSONAnswer(t, response)
	if got := response.Body.String(); got != `{"methods":["oidc"]}` {
		t.Errorf("%s", got)
	}
	if cookies := response.Header().Values("Set-Cookie"); len(cookies) != 0 {
		t.Errorf("%q", cookies)
	}
}

func TestAuthRoutesAreMigratedInTheClassOfTheContract(t *testing.T) {
	contractRoutes, err := httpapi.ParseContractRoutes(contract.Routes())
	if err != nil {
		t.Fatal(err)
	}
	_, group := authEngine(t, httpOrigin)
	registered := group.Routes()
	if len(registered) != 2 {
		t.Fatalf("%+v", registered)
	}
	for _, route := range registered {
		if route.Proxied || !slices.Contains(httpapi.MigratedRoutes, route.Route) {
			t.Errorf("%s: not served here", route.Route)
		}
		index := slices.IndexFunc(contractRoutes, func(c httpapi.ContractRoute) bool { return c.Route == route.Route })
		if index < 0 || contractRoutes[index].Classification != route.Classification {
			t.Errorf("%s: not in the contract in this class", route.Route)
		}
	}
}

func TestAuthAnswersMatchTheOpenAPIExamples(t *testing.T) {
	var document struct {
		Paths map[string]struct {
			Get struct {
				Responses map[string]struct {
					Content map[string]struct {
						Example json.RawMessage `json:"example"`
					} `json:"content"`
				} `json:"responses"`
			} `json:"get"`
		} `json:"paths"`
	}
	if err := json.Unmarshal([]byte(contract.OpenAPI()), &document); err != nil {
		t.Fatal(err)
	}
	example := func(path string) json.RawMessage {
		return document.Paths[path].Get.Responses["200"].Content["application/json"].Example
	}
	engine, _ := authEngine(t, httpOrigin)
	if got, want := getAuth(engine, "/api/auth/options").Body.String(), string(example("/api/auth/options")); got != want {
		t.Errorf("options: %s, the document says %s", got, want)
	}
	var csrfExample, csrfAnswer struct {
		CSRFToken *string `json:"csrfToken"`
	}
	if err := json.Unmarshal(example("/api/auth/csrf"), &csrfExample); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(getAuth(engine, "/api/auth/csrf").Body.Bytes(), &csrfAnswer); err != nil {
		t.Fatal(err)
	}
	if csrfExample.CSRFToken == nil || csrfAnswer.CSRFToken == nil {
		t.Errorf("csrf: %+v %+v", csrfExample, csrfAnswer)
	}
}
