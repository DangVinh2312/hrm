package health_test

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/database"
	"hrm/api-go/internal/health"
	"hrm/api-go/internal/httpapi"
)

func engineWith(t *testing.T, gate *health.Gate, logs *bytes.Buffer) *gin.Engine {
	t.Helper()
	return engineObserving(t, gate, &health.Metrics{}, logs)
}

func engineObserving(t *testing.T, gate *health.Gate, metrics *health.Metrics, logs *bytes.Buffer) *gin.Engine {
	t.Helper()
	engine := httpapi.NewEngine(slog.New(slog.NewTextHandler(logs, nil)))
	if err := health.Register(httpapi.NewGroup(engine.Group(""), nil), gate, metrics); err != nil {
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
	response := get(engineWith(t, &health.Gate{}, &logs), "/api/health/live")
	if response.Code != 200 || response.Body.String() != `{"status":"ok"}` ||
		response.Header().Get("Content-Type") != "application/json; charset=utf-8" || response.Header().Get("Content-Length") != "15" {
		t.Errorf("%d %q %v", response.Code, response.Body, response.Header())
	}
}

func TestReadyNeedsTheGate(t *testing.T) {
	const notReady = `{"statusCode":503,"code":"error.unavailable"}`
	marked := &health.Gate{}
	marked.MarkReady()
	for name, c := range map[string]struct {
		gate   *health.Gate
		status int
		body   string
	}{
		"boot not done": {&health.Gate{}, 503, notReady},
		"boot done":     {marked, 200, `{"status":"ready"}`},
	} {
		var logs bytes.Buffer
		response := get(engineWith(t, c.gate, &logs), "/api/health/ready")
		if response.Code != c.status || response.Body.String() != c.body {
			t.Errorf("%s: %d %q", name, response.Code, response.Body)
		}
		if logs.Len() != 0 {
			t.Errorf("%s: not ready is not a fault: %s", name, logs.String())
		}
	}
}

func TestMetricsAnswersTheSnapshotBeforeTheBootEnds(t *testing.T) {
	var logs bytes.Buffer
	metrics := &health.Metrics{}
	engine := engineObserving(t, &health.Gate{}, metrics, &logs)
	if response := get(engine, "/api/health/metrics"); response.Code != 200 || response.Body.String() != "[]" ||
		response.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Errorf("%d %q %v", response.Code, response.Body, response.Header())
	}
	metrics.Observe(database.MetricRetry, database.ModeWrite, 1)
	want := `[{"metric":"retry","mode":"write","count":1,"sum":1,"buckets":[{"upper":1,"count":1},{"upper":5,"count":1},` +
		`{"upper":10,"count":1},{"upper":25,"count":1},{"upper":50,"count":1},{"upper":100,"count":1},{"upper":250,"count":1},` +
		`{"upper":500,"count":1},{"upper":1000,"count":1},{"upper":2000,"count":1},{"upper":5000,"count":1}]}]`
	if response := get(engine, "/api/health/metrics"); response.Code != 200 || response.Body.String() != want {
		t.Errorf("%d %s", response.Code, response.Body)
	}
	if logs.Len() != 0 {
		t.Errorf("%s", logs.String())
	}
}
