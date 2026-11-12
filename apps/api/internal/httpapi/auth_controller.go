package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api/internal/authorization/enforcement"
)

// csrfCookieMaxAge is what the web refreshes against: see CSRF_REFRESH_MS of its HTTP client.
const csrfCookieMaxAge = 3600

type csrfAnswer struct {
	CSRFToken string `json:"csrfToken"`
}

var signInMethods = []byte(`{"methods":["oidc"]}`)

// RegisterAuth adds the two public routes of auth that need nothing past config: the rest of auth comes
// with internal/authentication.
func RegisterAuth(group *Group, origin string) error {
	if err := Register(group, http.MethodGet, "/api/auth/options", enforcement.Public(), func(c *gin.Context) {
		WriteJSONBytes(c, http.StatusOK, signInMethods)
	}); err != nil {
		return err
	}
	return Register(group, http.MethodGet, "/api/auth/csrf", enforcement.Public(), func(c *gin.Context) {
		token := NewCSRF()
		body, err := json.Marshal(csrfAnswer{token})
		if err != nil {
			WriteError(c, err)
			return
		}
		SetCookie(c.Writer.Header(), origin, CSRFCookie, token, csrfCookieMaxAge)
		WriteJSONBytes(c, http.StatusOK, body)
	})
}
