package health_test

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/health"
	"hrm/api-go/internal/httpapi"
)

type fakeUpstream bool

func (f fakeUpstream) Ready(context.Context) bool { return bool(f) }

func engineWith(t *testing.T, gate *health.Gate, upstream health.Upstream, logs *bytes.Buffer) *gin.Engine {
	t.Helper()
	engine := httpapi.NewEngine(slog.New(slog.NewTextHandler(logs, nil)))
	if err := health.Register(httpapi.NewGroup(engine.Group(""), nil), gate, upstream); err != nil {
		t.Fatal(err)
	}
	if err := httpapi.CheckRoutes(engine); err != nil {
		t.Fatal(err)
	}
	return engine
}

func get(engine *gin.Engine, path string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder
}

func TestLiveAnswersBeforeTheBootEnds(t *testing.T) {
	var logs bytes.Buffer
	response := get(engineWith(t, &health.Gate{}, fakeUpstream(false), &logs), "/api/health/live")
	if response.Code != 200 || response.Body.String() != `{"status":"ok"}` ||
		response.Header().Get("Content-Type") != "application/json; charset=utf-8" || response.Header().Get("Content-Length") != "15" {
		t.Errorf("%d %q %v", response.Code, response.Body, response.Header())
	}
}

func TestReadyNeedsTheGateAndTheUpstream(t *testing.T) {
	const notReady = `{"statusCode":503,"code":"error.unavailable"}`
	marked := &health.Gate{}
	marked.MarkReady()
	for name, c := range map[string]struct {
		gate     *health.Gate
		upstream health.Upstream
		status   int
		body     string
	}{
		"boot not done":      {&health.Gate{}, fakeUpstream(true), 503, notReady},
		"upstream not ready": {marked, fakeUpstream(false), 503, notReady},
		"both":               {marked, fakeUpstream(true), 200, `{"status":"ready"}`},
		"no upstream":        {marked, nil, 200, `{"status":"ready"}`},
		"no upstream, boot":  {&health.Gate{}, nil, 503, notReady},
	} {
		var logs bytes.Buffer
		response := get(engineWith(t, c.gate, c.upstream, &logs), "/api/health/ready")
		if response.Code != c.status || response.Body.String() != c.body {
			t.Errorf("%s: %d %q", name, response.Code, response.Body)
		}
		if logs.Len() != 0 {
			t.Errorf("%s: not ready is not a fault: %s", name, logs.String())
		}
	}
}
