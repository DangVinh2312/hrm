package authentication

import (
	"github.com/gin-gonic/gin"

	"hrm/api/internal/httpapi"
)

type setupAnswer struct {
	URI    string `json:"uri"`
	Secret string `json:"secret"`
}

type confirmAnswer struct {
	ExpiresAt     string   `json:"expiresAt"`
	RecoveryCodes []string `json:"recoveryCodes"`
}

type sessionAnswer struct {
	ExpiresAt string `json:"expiresAt"`
}

type recoveryCodesAnswer struct {
	RecoveryCodes []string `json:"recoveryCodes"`
}

// setSession is the cookie of a session the service continued; Max-Age is the database's count of seconds
// left of the old deadline.
func (r Routes) setSession(c *gin.Context, session Session) {
	httpapi.SetCookie(c.Writer.Header(), r.Origin, httpapi.SessionCookie, session.Secret, session.MaxAge)
}

func (r Routes) mfaSetup(c *gin.Context) error {
	if err := httpapi.DecodeEmptyCommand(c, r.Origin); err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	setup, err := r.Mfa.Setup(c.Request.Context(), secret, r.clientKey(c))
	if err != nil {
		return err
	}
	return writeAnswer(c, setupAnswer(setup))
}

func (r Routes) mfaConfirm(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[confirmBody](c, r.Origin)
	if err != nil {
		return err
	}
	code, err := parseTotpCode(body.Code)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	confirmation, err := r.Mfa.Confirm(c.Request.Context(), secret, code, r.clientKey(c))
	if err != nil {
		return err
	}
	r.setSession(c, confirmation.Session)
	return writeAnswer(c, confirmAnswer{confirmation.Session.ExpiresAt, confirmation.RecoveryCodes})
}

func (r Routes) mfaVerify(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[proofBody](c, r.Origin)
	if err != nil {
		return err
	}
	proof, err := parseMfaProof(body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	session, err := r.Mfa.Verify(c.Request.Context(), secret, proof, r.clientKey(c))
	if err != nil {
		return err
	}
	r.setSession(c, session)
	return writeAnswer(c, sessionAnswer{session.ExpiresAt})
}

func (r Routes) mfaRecoveryCodes(c *gin.Context) error {
	if err := httpapi.DecodeEmptyCommand(c, r.Origin); err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	codes, err := r.Mfa.RegenerateRecoveryCodes(c.Request.Context(), secret, r.clientKey(c))
	if err != nil {
		return err
	}
	return writeAnswer(c, recoveryCodesAnswer{codes})
}

func (r Routes) mfaRemove(c *gin.Context) error {
	if err := httpapi.EnforceCSRF(c.Request, r.Origin); err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	session, err := r.Mfa.Remove(c.Request.Context(), secret, r.clientKey(c))
	if err != nil {
		return err
	}
	r.setSession(c, session)
	return writeAnswer(c, sessionAnswer{session.ExpiresAt})
}
