// Package health answers liveness, readiness and the runner metrics.
package health

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/httpapi"
)

// Register adds the three routes.
func Register(group *httpapi.Group, gate *Gate, metrics *Metrics) error {
	if metrics == nil {
		return errors.New("health: metrics collector is required")
	}
	if err := httpapi.Register(group, http.MethodGet, "/api/health/live", enforcement.Public(), func(c *gin.Context) {
		httpapi.WriteJSONBytes(c, http.StatusOK, []byte(`{"status":"ok"}`))
	}); err != nil {
		return err
	}
	if err := httpapi.Register(group, http.MethodGet, "/api/health/metrics", enforcement.Public(), func(c *gin.Context) {
		body, err := json.Marshal(metrics.Snapshot())
		if err != nil {
			httpapi.WriteError(c, err)
			return
		}
		httpapi.WriteJSONBytes(c, http.StatusOK, body)
	}); err != nil {
		return err
	}
	return httpapi.Register(group, http.MethodGet, "/api/health/ready", enforcement.Public(), func(c *gin.Context) {
		if !gate.Ready() {
			httpapi.WriteError(c, apperror.ErrUnavailable)
			return
		}
		httpapi.WriteJSONBytes(c, http.StatusOK, []byte(`{"status":"ready"}`))
	})
}
