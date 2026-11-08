// Package health answers liveness and readiness. The metrics route stays with NestJS until M8.
package health

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/httpapi"
)

// Upstream is the NestJS API while routes are still proxied. The boot steps of this process are only a
// part of what NestJS runs, so this process is ready only when it says so too.
type Upstream interface {
	Ready(ctx context.Context) bool
}

// Register adds both routes; upstream is nil once no route is proxied.
func Register(group *httpapi.Group, gate *Gate, upstream Upstream) error {
	if err := httpapi.Register(group, http.MethodGet, "/api/health/live", enforcement.Public(), func(c *gin.Context) {
		httpapi.WriteJSONBytes(c, http.StatusOK, []byte(`{"status":"ok"}`))
	}); err != nil {
		return err
	}
	return httpapi.Register(group, http.MethodGet, "/api/health/ready", enforcement.Public(), func(c *gin.Context) {
		if !gate.Ready() || (upstream != nil && !upstream.Ready(c.Request.Context())) {
			httpapi.WriteError(c, apperror.ErrUnavailable)
			return
		}
		httpapi.WriteJSONBytes(c, http.StatusOK, []byte(`{"status":"ready"}`))
	})
}
