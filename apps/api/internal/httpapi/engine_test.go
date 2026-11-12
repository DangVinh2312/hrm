package httpapi_test

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/enforcement"
	"hrm/api/internal/httpapi"
)

type fakeAuth struct {
	calls  int
	answer error
}

func (a *fakeAuth) Authenticate(*http.Request) error {
	a.calls++
	return a.answer
}

type routes struct {
	engine  *gin.Engine
	auth    *fakeAuth
	reached map[string]int
}

func newRoutes(t *testing.T, answer error) routes {
	t.Helper()
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	r := routes{engine: engine, auth: &fakeAuth{answer: answer}, reached: map[string]int{}}
	group := httpapi.NewGroup(engine.Group("/api"), r.auth)
	for path, classification := range map[string]enforcement.Classification{
		"/open":  enforcement.Public(),
		"/probe": enforcement.Authenticated(),
	} {
		if err := httpapi.Register(group, http.MethodGet, path, classification, func(c *gin.Context) {
			r.reached[path]++
			c.String(http.StatusOK, "reached")
		}); err != nil {
			t.Fatal(err)
		}
	}
	return r
}

func TestPublicNeedsNoCookie(t *testing.T) {
	r := newRoutes(t, apperror.ErrAuthenticationFailed)
	for _, cookie := range []string{"", "authz_session=a; authz_session=b", "junk"} {
		request := httptest.NewRequest(http.MethodGet, "/api/open", nil)
		request.Header.Set("Cookie", cookie)
		if response := serve(r.engine, request); response.Code != http.StatusOK {
			t.Errorf("cookie %q: %d", cookie, response.Code)
		}
	}
	if r.auth.calls != 0 || r.reached["/open"] != 3 {
		t.Errorf("auth %d, reached %d", r.auth.calls, r.reached["/open"])
	}
}

func TestAuthenticatedChecksBeforeTheHandler(t *testing.T) {
	for answer, status := range map[error]int{
		apperror.ErrAuthenticationFailed: 401,
		apperror.ErrInvalidRequest:       400,
	} {
		r := newRoutes(t, answer)
		response := serve(r.engine, httptest.NewRequest(http.MethodGet, "/api/probe", nil))
		assertError(t, response, status, string(apperror.CodeFor(status)))
		if r.auth.calls != 1 || r.reached["/probe"] != 0 {
			t.Errorf("auth %d, reached %d", r.auth.calls, r.reached["/probe"])
		}
	}
	r := newRoutes(t, nil)
	if response := serve(r.engine, httptest.NewRequest(http.MethodGet, "/api/probe", nil)); response.Code != http.StatusOK {
		t.Errorf("an accepted request got %d", response.Code)
	}
	if r.auth.calls != 1 || r.reached["/probe"] != 1 {
		t.Errorf("auth %d, reached %d", r.auth.calls, r.reached["/probe"])
	}
}

func TestRegisterRefusesARouteWithoutAUsableClassification(t *testing.T) {
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	handler := func(c *gin.Context) { c.Status(http.StatusOK) }
	withAuth := httpapi.NewGroup(engine.Group("/api"), &fakeAuth{})
	withoutAuth := httpapi.NewGroup(engine.Group("/other"), nil)
	cases := map[string]struct {
		group          *httpapi.Group
		classification enforcement.Classification
		handler        gin.HandlerFunc
	}{
		"no classification":                 {withAuth, enforcement.Classification{}, handler},
		"authorize before its declarations": {withAuth, enforcement.Authorize("item", "read"), handler},
		"authenticated without RequestAuth": {withoutAuth, enforcement.Authenticated(), handler},
		"no handler":                        {withAuth, enforcement.Public(), nil},
	}
	for name, c := range cases {
		if err := httpapi.Register(c.group, http.MethodGet, "/"+name, c.classification, c.handler); err == nil {
			t.Errorf("%s registered", name)
		}
	}
	for _, path := range []string{"/api/no classification", "/api/authorize before its declarations", "/other/authenticated without RequestAuth"} {
		request := httptest.NewRequest(http.MethodGet, "/", nil)
		request.URL.Path = path
		assertError(t, serve(engine, request), 404, "error.notFound")
	}
}

func TestEngineSettings(t *testing.T) {
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	if engine.RedirectTrailingSlash || engine.RedirectFixedPath || engine.ForwardedByClientIP || engine.HandleMethodNotAllowed {
		t.Errorf("trailing %v fixed %v forwarded %v method %v", engine.RedirectTrailingSlash, engine.RedirectFixedPath,
			engine.ForwardedByClientIP, engine.HandleMethodNotAllowed)
	}
	if !engine.UseRawPath || !engine.UnescapePathValues {
		t.Errorf("raw path %v unescape %v", engine.UseRawPath, engine.UnescapePathValues)
	}
}

func TestStrangePathsNeitherRedirectNorPassTheGuard(t *testing.T) {
	cases := []struct {
		method string
		target string
		status int
	}{
		{http.MethodGet, "/api/open/", 404},
		{http.MethodGet, "/api/probe/", 404},
		{http.MethodGet, "/api/Open", 404},
		{http.MethodGet, "/API/open", 404},
		{http.MethodGet, "/api/PROBE", 404},
		{http.MethodGet, "/api/open//", 404},
		{http.MethodGet, "//api/open", 404},
		{http.MethodGet, "/api//open", 404},
		{http.MethodGet, "/api/./open", 404},
		{http.MethodGet, "/api/../api/open", 404},
		{http.MethodGet, "/api/open%2F", 404},
		{http.MethodGet, "/open", 404},
		{http.MethodGet, "/api/unknown", 404},
		{http.MethodPost, "/api/open", 404},
		{http.MethodDelete, "/api/probe", 404},
		{http.MethodHead, "/api/open", 200},
		{http.MethodHead, "/API/open/", 404},
		{http.MethodHead, "/api/probe", 401},
		{http.MethodHead, "/api/unknown", 404},
		{http.MethodOptions, "/api/open", 404},
		{http.MethodGet, "/api/%6Fpen", 404},
		{http.MethodGet, "/api/%70robe", 404},
		{http.MethodGet, "/api/%FF", 400},
		{http.MethodGet, "/%C0%AF", 400},
		{http.MethodGet, "/api/open?redirect=//evil.test", 200},
		{http.MethodGet, "/api/open?a=%FF", 200},
	}
	for _, c := range cases {
		r := newRoutes(t, apperror.ErrAuthenticationFailed)
		response := httptest.NewRecorder()
		httpapi.NewHandler(r.engine).ServeHTTP(response, httptest.NewRequest(c.method, c.target, nil))
		if response.Code != c.status || response.Header().Get("Location") != "" {
			t.Errorf("%s %s: %d location %q, want %d", c.method, c.target, response.Code, response.Header().Get("Location"), c.status)
		}
		if c.status == 404 && c.method != http.MethodHead {
			assertError(t, response, 404, "error.notFound")
		}
		if r.reached["/probe"] != 0 {
			t.Errorf("%s %s reached the authenticated handler", c.method, c.target)
		}
	}
}

func TestAParameterKeepsItsCaseAndEscapes(t *testing.T) {
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	group := httpapi.NewGroup(engine.Group(""), nil)
	var seen, target string
	if err := httpapi.Register(group, http.MethodGet, "/api/items/:id/sub", enforcement.Public(), func(c *gin.Context) {
		seen, target = c.Param("id"), c.Request.RequestURI
	}); err != nil {
		t.Fatal(err)
	}
	if err := httpapi.Register(group, http.MethodGet, "/api/items/me/sub", enforcement.Public(), func(c *gin.Context) {
		seen = "static"
	}); err != nil {
		t.Fatal(err)
	}
	for request, want := range map[string]string{
		"/api/items/AbC/sub":     "AbC",
		"/api/items/a%2Fb/sub":   "a/b",
		"/api/items/a%252Fb/sub": "a%2Fb",
		"/api/items/%41/sub":     "A",
		"/api/items/a+b/sub":     "a+b",
		"/api/items/a+b%2Fc/sub": "a+b/c",
		"/api/items/a%20b/sub":   "a b",
		"/api/items/me/sub":      "static",
	} {
		seen, target = "", ""
		incoming := httptest.NewRequest(http.MethodGet, request, nil)
		incoming.RequestURI = request
		httpapi.NewHandler(engine).ServeHTTP(httptest.NewRecorder(), incoming)
		if seen != want {
			t.Errorf("%s: %q, want %q", request, seen, want)
		}
		if want != "static" && target != request {
			t.Errorf("%s: the original target became %q", request, target)
		}
	}
}

func TestServerBounds(t *testing.T) {
	server := httpapi.NewServer(http.NotFoundHandler(), 3000)
	if !server.DisableGeneralOptionsHandler {
		t.Error("OPTIONS * must reach the engine")
	}
	if server.Addr != ":3000" || server.MaxHeaderBytes != 16384 || server.ReadHeaderTimeout != 60*time.Second ||
		server.ReadTimeout != 300*time.Second || server.IdleTimeout != 5*time.Second || server.WriteTimeout != 0 {
		t.Errorf("addr %q header %d read header %v read %v idle %v write %v", server.Addr, server.MaxHeaderBytes,
			server.ReadHeaderTimeout, server.ReadTimeout, server.IdleTimeout, server.WriteTimeout)
	}
}

func TestRecoverIsTheFirstMiddleware(t *testing.T) {
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	if len(engine.Handlers) == 0 {
		t.Fatal("no middleware")
	}
	if name := runtime.FuncForPC(reflect.ValueOf(engine.Handlers[0]).Pointer()).Name(); !strings.Contains(name, "recoverAndLog") {
		t.Errorf("first middleware %s", name)
	}
}

func TestCheckRoutesRefusesARouteOutsideRegister(t *testing.T) {
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	group := httpapi.NewGroup(engine.Group("/api"), &fakeAuth{})
	ok := func(c *gin.Context) { c.Status(http.StatusOK) }
	if err := httpapi.Register(group, http.MethodGet, "/open", enforcement.Public(), ok); err != nil {
		t.Fatal(err)
	}
	if err := httpapi.Register(group, http.MethodPost, "/probe", enforcement.Authenticated(), ok); err != nil {
		t.Fatal(err)
	}
	if err := httpapi.CheckRoutes(engine); err != nil {
		t.Fatalf("registered routes refused: %v", err)
	}
	for name, add := range map[string]func(*gin.Engine){
		"engine GET":   func(e *gin.Engine) { e.GET("/api/raw", ok) },
		"group POST":   func(e *gin.Engine) { e.Group("/api").POST("/raw", ok) },
		"group Handle": func(e *gin.Engine) { e.Group("/x").Handle(http.MethodPut, "/raw", ok) },
		"Any":          func(e *gin.Engine) { e.Any("/raw", ok) },
		"static file":  func(e *gin.Engine) { e.StaticFile("/raw", "engine.go") },
		"after Use":    func(e *gin.Engine) { e.Use().GET("/raw", ok) },
	} {
		fresh := httpapi.NewEngine(slog.New(slog.DiscardHandler))
		add(fresh)
		if err := httpapi.CheckRoutes(fresh); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
