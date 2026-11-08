package authentication

import (
	"encoding/json/v2"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/httpapi"
)

// Routes is the HTTP side of auth/*. RequestAuth reads only the shape of the session cookie, so a handler
// gets no account of its own: it hands the cookie to a service, which resolves the session in its
// transaction and answers ErrAuthenticationFailed when there is none.
type Routes struct {
	Identity   *Service
	Mfa        *MfaService
	Oidc       *OidcService
	Origin     string
	TrustProxy int
}

// Register adds the routes of auth/* that internal/httpapi does not serve itself.
func (r Routes) Register(group *httpapi.Group) error {
	authenticated, public := enforcement.Authenticated(), enforcement.Public()
	for _, route := range []struct {
		method, path string
		class        enforcement.Classification
		handle       func(*gin.Context) error
	}{
		{http.MethodPost, "/api/auth/logout", authenticated, func(c *gin.Context) error { return r.logout(c, false) }},
		{http.MethodPost, "/api/auth/logout-all", authenticated, func(c *gin.Context) error { return r.logout(c, true) }},
		{http.MethodGet, "/api/auth/account", authenticated, r.account},
		{http.MethodPost, "/api/auth/mfa/totp/setup", authenticated, r.mfaSetup},
		{http.MethodPost, "/api/auth/mfa/totp/confirm", authenticated, r.mfaConfirm},
		{http.MethodPost, "/api/auth/mfa/verify", authenticated, r.mfaVerify},
		{http.MethodPost, "/api/auth/mfa/recovery-codes", authenticated, r.mfaRecoveryCodes},
		{http.MethodDelete, "/api/auth/mfa/totp", authenticated, r.mfaRemove},
		{http.MethodPost, "/api/auth/oidc/begin", public, r.oidcBegin},
		{http.MethodPost, "/api/auth/oidc/activate", public, r.oidcActivate},
		{http.MethodGet, callbackPath, public, r.oidcCallback},
	} {
		handler := func(c *gin.Context) {
			if err := route.handle(c); err != nil {
				httpapi.WriteError(c, err)
			}
		}
		if err := httpapi.Register(group, route.method, route.path, route.class, handler); err != nil {
			return err
		}
	}
	return nil
}

// clientKey is what the limiter counts for this request; a socket always has an address, a test may not.
func (r Routes) clientKey(c *gin.Context) string {
	if address := httpapi.ClientIP(c, r.TrustProxy); address != "" {
		return address
	}
	return "unknown"
}

// writeAnswer answers value as JSON v2, which leaves & in a URL as it is and writes a nil slice as [].
func writeAnswer[T any](c *gin.Context, value T) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	httpapi.WriteJSONBytes(c, http.StatusOK, body)
	return nil
}

type statusAnswer struct {
	Status string `json:"status"`
}

// logout clears the cookie only after the service ended the session: a refused logout keeps it.
func (r Routes) logout(c *gin.Context, all bool) error {
	if err := httpapi.EnforceCSRF(c.Request, r.Origin); err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	if err := r.Identity.Logout(c.Request.Context(), secret, all); err != nil {
		return err
	}
	httpapi.SetCookie(c.Writer.Header(), r.Origin, httpapi.SessionCookie, "", 0)
	return writeAnswer(c, statusAnswer{"revoked"})
}

type mfaStatusAnswer struct {
	Status                 string `json:"status"`
	RecoveryCodesRemaining int    `json:"recoveryCodesRemaining"`
}

type accountAnswer struct {
	Email      *string         `json:"email"`
	Identities []Identity      `json:"identities"`
	Mfa        mfaStatusAnswer `json:"mfa"`
}

// account names bindings by reference; the provider subject never leaves the server.
func (r Routes) account(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	account, err := r.Identity.OwnAccount(c.Request.Context(), secret)
	if err != nil {
		return err
	}
	return writeAnswer(c, accountAnswer{
		Email: account.Email, Identities: account.Identities,
		Mfa: mfaStatusAnswer{account.Mfa.Status, account.Mfa.RecoveryCodesRemaining},
	})
}
