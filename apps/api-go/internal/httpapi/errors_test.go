package httpapi_test

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/httpapi"
)

const canary = "secret-value person@example.test"

type sqlStateError struct{}

func (sqlStateError) Error() string    { return "duplicate key value (" + canary + ")" }
func (sqlStateError) SQLState() string { return "23505" }

func newEngine(t *testing.T) (*gin.Engine, *httpapi.Group, *bytes.Buffer) {
	t.Helper()
	logs := &bytes.Buffer{}
	engine := httpapi.NewEngine(slog.New(slog.NewTextHandler(logs, nil)))
	return engine, httpapi.NewGroup(engine.Group("/api"), nil), logs
}

func serve(engine http.Handler, request *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	return recorder
}

func failing(t *testing.T, group *httpapi.Group, path string, err error) {
	t.Helper()
	if registerErr := httpapi.Register(group, http.MethodGet, path, enforcement.Public(), func(c *gin.Context) {
		httpapi.WriteError(c, err)
	}); registerErr != nil {
		t.Fatal(registerErr)
	}
}

func assertError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	want := fmt.Sprintf(`{"statusCode":%d,"code":"%s"}`, status, code)
	if response.Code != status || response.Body.String() != want {
		t.Errorf("got %d %s, want %d %s", response.Code, response.Body.String(), status, want)
	}
	if got := response.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("content-type %q", got)
	}
	for name, value := range map[string]string{
		"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
	} {
		if got := response.Header().Get(name); got != value {
			t.Errorf("%s %q, want %q", name, got, value)
		}
	}
}

func TestWriteErrorAnswersTheStatusAndKeyOnly(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{apperror.ErrInvalidRequest, 400, "error.invalidRequest"},
		{apperror.ErrAuthenticationFailed, 401, "error.authenticationFailed"},
		{fmt.Errorf("%s: %w", canary, apperror.ErrAccessDenied), 403, "error.accessDenied"},
		{apperror.ErrNotFound, 404, "error.notFound"},
		{apperror.ErrCommandRejected, 409, "error.conflict"},
		{&database.ConflictError{Code: "40001"}, 409, "error.conflict"},
		{fmt.Errorf("retry: %w", &database.ConflictError{Code: "40P01"}), 409, "error.conflict"},
		{apperror.Rejection{Code: "error.exportTooLarge"}, 422, "error.exportTooLarge"},
		{apperror.Rejection{Code: "error.notFound"}, 503, "error.unavailable"},
		{&database.UnavailableError{Code: "deadline"}, 503, "error.unavailable"},
		{errors.New(canary), 503, "error.unavailable"},
	}
	for index, c := range cases {
		engine, group, _ := newEngine(t)
		failing(t, group, "/fail", c.err)
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			assertError(t, serve(engine, httptest.NewRequest(http.MethodGet, "/api/fail", nil)), c.status, c.code)
		})
	}
}

func TestFaultsAreLoggedByTypeAndCodeWithoutTheirText(t *testing.T) {
	engine, group, logs := newEngine(t)
	failing(t, group, "/plain", fmt.Errorf("load %s: %w", canary, errors.New(canary)))
	failing(t, group, "/unavailable", fmt.Errorf("%s: %w", canary, &database.UnavailableError{Code: "deadline"}))
	failing(t, group, "/sql", fmt.Errorf("insert: %w", sqlStateError{}))
	failing(t, group, "/rejection", apperror.Rejection{Code: "error.custom"})
	failing(t, group, "/denied", apperror.ErrAccessDenied)
	for _, path := range []string{"/plain", "/unavailable", "/sql", "/rejection"} {
		logs.Reset()
		serve(engine, httptest.NewRequest(http.MethodGet, "/api"+path+"?email=person@example.test", nil))
		log := logs.String()
		if strings.Contains(log, "secret-value") || strings.Contains(log, "person@") || strings.Contains(log, "error.custom") {
			t.Errorf("%s: the log carries input: %s", path, log)
		}
		if !strings.Contains(log, "level=ERROR") {
			t.Errorf("%s: not logged: %q", path, log)
		}
	}
	for path, want := range map[string]string{
		"/plain":       "*errors.errorString",
		"/unavailable": "deadline",
		"/sql":         "23505",
		"/rejection":   "apperror.Rejection",
	} {
		logs.Reset()
		serve(engine, httptest.NewRequest(http.MethodGet, "/api"+path, nil))
		if !strings.Contains(logs.String(), want) {
			t.Errorf("%s: %q lacks %q", path, logs.String(), want)
		}
	}
	logs.Reset()
	serve(engine, httptest.NewRequest(http.MethodGet, "/api/denied", nil))
	if logs.Len() != 0 {
		t.Errorf("a planned refusal is logged: %s", logs.String())
	}
}

func TestAPanicIsUnavailableAndLoggedWithoutItsValue(t *testing.T) {
	for name, value := range map[string]any{"string": canary, "error": errors.New(canary)} {
		engine, group, logs := newEngine(t)
		if err := httpapi.Register(group, http.MethodGet, "/panic", enforcement.Public(), func(*gin.Context) {
			panic(value)
		}); err != nil {
			t.Fatal(err)
		}
		assertError(t, serve(engine, httptest.NewRequest(http.MethodGet, "/api/panic", nil)), 503, "error.unavailable")
		log := logs.String()
		if strings.Contains(log, "secret-value") || strings.Contains(log, "person@") {
			t.Errorf("%s: the log carries the panic value: %s", name, log)
		}
		if !strings.Contains(log, "panic") || !strings.Contains(log, "errors_test.go") {
			t.Errorf("%s: the log lacks the panic and its frames: %s", name, log)
		}
	}
}

func recovered(engine http.Handler, request *http.Request) (recorder *httptest.ResponseRecorder, value any) {
	recorder = httptest.NewRecorder()
	defer func() { value = recover() }()
	engine.ServeHTTP(recorder, request)
	return recorder, nil
}

func TestAbortHandlerIsPassedOnWithoutABody(t *testing.T) {
	engine, group, logs := newEngine(t)
	if err := httpapi.Register(group, http.MethodGet, "/abort", enforcement.Public(), func(*gin.Context) {
		panic(http.ErrAbortHandler)
	}); err != nil {
		t.Fatal(err)
	}
	recorder, value := recovered(engine, httptest.NewRequest(http.MethodGet, "/api/abort", nil))
	if value != http.ErrAbortHandler {
		t.Errorf("recovered %v", value)
	}
	if recorder.Body.Len() != 0 {
		t.Errorf("wrote %q on an aborted connection", recorder.Body.String())
	}
	if logs.Len() != 0 {
		t.Errorf("logged an abort: %s", logs.String())
	}
}

func TestAPanicAfterTheResponseStartedAbortsTheConnection(t *testing.T) {
	engine, group, _ := newEngine(t)
	if err := httpapi.Register(group, http.MethodGet, "/late", enforcement.Public(), func(c *gin.Context) {
		c.String(http.StatusOK, "partial")
		panic(canary)
	}); err != nil {
		t.Fatal(err)
	}
	recorder, value := recovered(engine, httptest.NewRequest(http.MethodGet, "/api/late", nil))
	if value != http.ErrAbortHandler || recorder.Body.String() != "partial" {
		t.Errorf("recovered %v, body %q", value, recorder.Body.String())
	}
}

func TestAbortHandlerClosesARealConnection(t *testing.T) {
	engine, group, _ := newEngine(t)
	if err := httpapi.Register(group, http.MethodGet, "/abort", enforcement.Public(), func(*gin.Context) {
		panic(http.ErrAbortHandler)
	}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(engine)
	defer server.Close()
	response, err := http.Get(server.URL + "/api/abort")
	if err == nil {
		if closeErr := response.Body.Close(); closeErr != nil {
			t.Error(closeErr)
		}
		t.Fatalf("got a response %d", response.StatusCode)
	}
}
