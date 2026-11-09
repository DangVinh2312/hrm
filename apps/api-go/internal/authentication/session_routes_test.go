package authentication_test

import (
	"context"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/httpapi"
)

type sessionRouteFake struct {
	t           *testing.T
	calls       []string
	identityErr error
	menuErr     error
	menus       []keys.MeMenu
}

func (f *sessionRouteFake) check(secret, call string) {
	f.t.Helper()
	if secret != strings.Repeat("A", 43) {
		f.t.Fatal("unexpected session credential")
	}
	f.calls = append(f.calls, call)
}

func (f *sessionRouteFake) CurrentSession(_ context.Context, secret string) (authentication.SessionIdentity, error) {
	f.check(secret, "identity")
	return authentication.SessionIdentity{UserID: "c6e118f5-191f-4038-a4fc-a0e49a567a30", Method: "oidc", Assurance: "mfa", Kind: "root", AuthEpoch: "12", Fresh: true}, f.identityErr
}

func (f *sessionRouteFake) SessionMenus(_ context.Context, secret string) ([]keys.MeMenu, error) {
	f.check(secret, "session")
	return f.menus, f.menuErr
}

func (f *sessionRouteFake) MeMenus(_ context.Context, secret string) ([]keys.MeMenu, error) {
	f.check(secret, "me")
	return f.menus, f.menuErr
}

func sessionRouteHandler(t *testing.T, f *sessionRouteFake) http.Handler {
	t.Helper()
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	group := httpapi.NewGroup(engine.Group(""), authentication.RequestAuth{Origin: routesOrigin})
	if err := (authentication.SessionRoutes{Identity: f, Menus: f, Origin: routesOrigin}).Register(group); err != nil {
		t.Fatal(err)
	}
	if err := httpapi.CheckRoutes(engine); err != nil {
		t.Fatal(err)
	}
	routes := group.Routes()
	if len(routes) != 2 {
		t.Fatalf("registered %d routes, want 2", len(routes))
	}
	for _, route := range routes {
		if route.Method != http.MethodGet || route.Classification != enforcement.Authenticated() {
			t.Fatalf("wrong classification: %+v", route)
		}
	}
	return httpapi.NewHandler(engine)
}

func TestSessionRoutesShapeAndOrder(t *testing.T) {
	for _, route := range []string{"session", "me"} {
		for _, menus := range [][]keys.MeMenu{nil, {}, {keys.MeMenuAccounts, keys.MeMenuEmployees}} {
			t.Run(route+"/"+string(rune('0'+len(menus))), func(t *testing.T) {
				f := &sessionRouteFake{t: t, menus: menus}
				handler := sessionRouteHandler(t, f)
				answer := answerOf(handler, checkRequest(http.MethodGet, "/api/auth/"+route, "", strings.Repeat("A", 43)))
				menuJSON := `[]`
				if len(menus) > 0 {
					menuJSON = `["accounts","employees"]`
				}
				want := `{"userId":"c6e118f5-191f-4038-a4fc-a0e49a567a30",`
				if route == "session" {
					want += `"method":"oidc","assurance":"mfa",`
				}
				want += `"menus":` + menuJSON + `}`
				if answer.Code != 200 || answer.Body.String() != want {
					t.Fatalf("got %d %s, want %s", answer.Code, answer.Body, want)
				}
				if !reflect.DeepEqual(f.calls, []string{"identity", route}) {
					t.Fatalf("calls %v", f.calls)
				}
			})
		}
	}
}

func TestSessionRoutesRefuseErrors(t *testing.T) {
	for _, route := range []string{"session", "me"} {
		for _, source := range []string{"identity", "menu", "cookie"} {
			t.Run(route+"/"+source, func(t *testing.T) {
				f := &sessionRouteFake{t: t}
				status, want := 401, `{"statusCode":401,"code":"error.authenticationFailed"}`
				if source == "identity" {
					f.identityErr = apperror.ErrAuthenticationFailed
				}
				if source == "menu" {
					f.menuErr = apperror.ErrAccessDenied
					status, want = 403, `{"statusCode":403,"code":"error.accessDenied"}`
				}
				handler := sessionRouteHandler(t, f)
				secret := strings.Repeat("A", 43)
				if source == "cookie" {
					secret = ""
				}
				answer := answerOf(handler, checkRequest(http.MethodGet, "/api/auth/"+route, "", secret))
				if answer.Code != status || answer.Body.String() != want {
					t.Fatalf("got %d %s", answer.Code, answer.Body)
				}
				wantCalls := []string{"identity", route}
				if source == "identity" {
					wantCalls = []string{"identity"}
				}
				if source == "cookie" {
					wantCalls = nil
				}
				if !reflect.DeepEqual(f.calls, wantCalls) {
					t.Fatalf("calls %v, want %v", f.calls, wantCalls)
				}
			})
		}
	}
}

func TestSessionRoutesRequireDependencies(t *testing.T) {
	f := &sessionRouteFake{t: t}
	for _, routes := range []authentication.SessionRoutes{{Identity: f}, {Menus: f}, {}} {
		engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
		group := httpapi.NewGroup(engine.Group(""), authentication.RequestAuth{Origin: routesOrigin})
		if err := routes.Register(group); err == nil {
			t.Error("missing dependency accepted")
		}
		if len(group.Routes()) != 0 {
			t.Error("partial registration on missing dependency")
		}
	}
}
