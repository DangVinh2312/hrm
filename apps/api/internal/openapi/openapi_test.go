package openapi_test

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"hrm/api/contract"
	"hrm/api/internal/httpapi"
	"hrm/api/internal/openapi"
)

func TestServesTheBytesOfTheContract(t *testing.T) {
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	if err := openapi.Register(httpapi.NewGroup(engine.Group(""), nil), contract.OpenAPI()); err != nil {
		t.Fatal(err)
	}
	if err := httpapi.CheckRoutes(engine); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/openapi.json", nil))
	body := recorder.Body.String()
	if body != contract.OpenAPI() {
		t.Errorf("%d bytes, the contract has %d", len(body), len(contract.OpenAPI()))
	}
	if recorder.Code != 200 || recorder.Header().Get("Content-Type") != "application/json; charset=utf-8" ||
		recorder.Header().Get("Content-Length") != strconv.Itoa(len(body)) || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("%d %v", recorder.Code, recorder.Header())
	}
}

var parameter = regexp.MustCompile(`:([^/]+)`)

func TestTheDocumentDescribesEveryRouteOfTheContract(t *testing.T) {
	var document struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal([]byte(contract.OpenAPI()), &document); err != nil {
		t.Fatal(err)
	}
	routes, err := httpapi.ParseContractRoutes(contract.Routes())
	if err != nil {
		t.Fatal(err)
	}
	if len(routes) == 0 {
		t.Fatal("no routes")
	}
	for _, route := range routes {
		path := parameter.ReplaceAllString(route.Path, "{$1}")
		if _, documented := document.Paths[path][strings.ToLower(route.Method)]; !documented {
			t.Errorf("%s is not in the document", route)
		}
	}
}
