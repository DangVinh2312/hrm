package httpapi_test

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/httpapi"
)

func TestAuthorizeRegistrationRequiresDeclaredPermissionAndGuard(t *testing.T) {
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	auth := &fakeAuth{answer: apperror.ErrAuthenticationFailed}
	known := func(resource, action string) bool { return resource == "document" && action == "read" }
	group := httpapi.NewGroup(engine.Group("/api"), auth, known)
	called := false
	handler := func(c *gin.Context) { called = true; c.Status(http.StatusNoContent) }
	if err := httpapi.Register(group, http.MethodGet, "/known", enforcement.Authorize("document", "read"), handler); err != nil {
		t.Fatal(err)
	}
	if err := httpapi.Register(group, http.MethodGet, "/unknown", enforcement.Authorize("document", "missing"), handler); err == nil {
		t.Fatal("unknown permission registered")
	}
	withoutAuth := httpapi.NewGroup(engine.Group("/other"), nil, known)
	if err := httpapi.Register(withoutAuth, http.MethodGet, "/known", enforcement.Authorize("document", "read"), handler); err == nil {
		t.Fatal("authorize without cookie guard registered")
	}
	response := serve(engine, httptest.NewRequest(http.MethodGet, "/api/known", nil))
	assertError(t, response, 401, "error.authenticationFailed")
	if called || auth.calls != 1 {
		t.Fatal("handler bypassed early authentication")
	}
	auth.answer = nil
	response = serve(engine, httptest.NewRequest(http.MethodGet, "/api/known", nil))
	if response.Code != 204 || !called || auth.calls != 2 {
		t.Fatal("early guard did not pass shaped cookie to authority-backed handler")
	}
	if err := httpapi.CheckRoutes(engine); err != nil {
		t.Fatal(err)
	}
}
