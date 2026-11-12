package authentication

import (
	"net/http"

	"hrm/api/internal/authentication/credential"
	"hrm/api/internal/httpapi"
)

// RequestAuth is the early check of an authenticated route, by the shape of the session cookie only: the
// service resolves the session itself under the fence, so a lookup here would add a transaction outside it.
type RequestAuth struct{ Origin string }

func (a RequestAuth) Authenticate(request *http.Request) error {
	secret, err := httpapi.SessionSecret(request, a.Origin)
	if err != nil {
		return err
	}
	_, err = credential.SessionDigest(secret)
	return err
}
