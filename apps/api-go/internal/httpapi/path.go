package httpapi

import (
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
)

// NewHandler serves engine. Gin unescapes the parameters of a raw path with url.QueryUnescape, where +
// is a space, so a + in the path is escaped first.
func NewHandler(engine *gin.Engine) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.URL.RawPath = strings.ReplaceAll(r.URL.RawPath, "+", "%2B")
		engine.ServeHTTP(w, r)
	})
}

// refuseUndecodablePath answers 400 in the error shape for a path whose escapes are not UTF-8.
func refuseUndecodablePath(c *gin.Context) {
	decoded, err := url.PathUnescape(c.Request.URL.EscapedPath())
	if err != nil || !utf8.ValidString(decoded) {
		WriteError(c, apperror.ErrInvalidRequest)
	}
}
