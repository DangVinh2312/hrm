// Package openapi serves contract/openapi.json byte for byte.
package openapi

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/httpapi"
)

func Register(group *httpapi.Group, document string) error {
	body := []byte(document)
	return httpapi.Register(group, http.MethodGet, "/api/openapi.json", enforcement.Public(), func(c *gin.Context) {
		httpapi.WriteJSONBytes(c, http.StatusOK, body)
	})
}
