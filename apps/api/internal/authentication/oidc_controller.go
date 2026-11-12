package authentication

import (
	"errors"
	"net/http"
	"net/url"

	"github.com/gin-gonic/gin"

	"hrm/api/internal/apperror"
	"hrm/api/internal/httpapi"
)

const (
	callbackPath = "/api/auth/oidc/callback"
	// browserCookieMaxAge outlives the attempt's five minutes, so an expired attempt is answered by the
	// database and not by a missing cookie.
	browserCookieMaxAge = 600
	targetAuthenticated = "/"
	targetFailed        = "/login?error=oidc"
)

type beginBody struct {
	Issuer bodyText `json:"issuer"`
}

type activateBody struct {
	Issuer bodyText `json:"issuer"`
	Token  bodyText `json:"token"`
}

type authorizationAnswer struct {
	AuthorizationURL string `json:"authorizationUrl"`
}

func (r Routes) newBrowser(c *gin.Context) string {
	browser := httpapi.NewCSRF()
	httpapi.SetCookie(c.Writer.Header(), r.Origin, httpapi.BrowserCookie, browser, browserCookieMaxAge)
	return browser
}

func (r Routes) oidcBegin(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[beginBody](c, r.Origin)
	if err != nil {
		return err
	}
	issuer, err := body.Issuer.required()
	if err != nil {
		return err
	}
	authorization, err := r.Oidc.Begin(c.Request.Context(), issuer, r.newBrowser(c), r.clientKey(c))
	if err != nil {
		return err
	}
	return writeAnswer(c, authorizationAnswer{authorization})
}

func (r Routes) oidcActivate(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[activateBody](c, r.Origin)
	if err != nil {
		return err
	}
	issuer, err := body.Issuer.required()
	if err != nil {
		return err
	}
	token, err := body.Token.required()
	if err != nil {
		return err
	}
	authorization, err := r.Oidc.Activate(c.Request.Context(), issuer, r.newBrowser(c), token, r.clientKey(c))
	if err != nil {
		return err
	}
	return writeAnswer(c, authorizationAnswer{authorization})
}

// oidcCallback answers fixed targets only. The URL comes from the configured origin, since the route's path
// is exact and the Host header is the client's word. An authentication failure ends in the login page with
// the browser cookie gone; any other fault keeps the cookie and answers as a fault.
func (r Routes) oidcCallback(c *gin.Context) error {
	own, err := httpapi.Cookies(c.Request, r.Origin)
	if err != nil {
		return err
	}
	current, err := url.Parse(r.Origin + callbackPath)
	if err != nil {
		return err
	}
	current.RawQuery = c.Request.URL.RawQuery
	session, err := r.Oidc.Callback(c.Request.Context(), current, own[httpapi.CookieName(r.Origin, httpapi.BrowserCookie)])
	if err != nil && !errors.Is(err, apperror.ErrAuthenticationFailed) {
		return err
	}
	target := targetFailed
	httpapi.SetCookie(c.Writer.Header(), r.Origin, httpapi.BrowserCookie, "", 0)
	if err == nil {
		target = targetAuthenticated
		r.setSession(c, session)
	}
	c.Writer.Header().Set("Location", target)
	c.Status(http.StatusSeeOther)
	c.Writer.WriteHeaderNow()
	return nil
}
