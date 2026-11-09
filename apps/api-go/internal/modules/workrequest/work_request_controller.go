package workrequest

import (
	"encoding/json/v2"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/httpapi"
)

// Routes are the caller's own requests: submit, list and one request's detail.
type Routes struct {
	Requests HTTPPort
	Origin   string
}

func (r Routes) Register(group *httpapi.Group) error {
	read := enforcement.Authorize(string(keys.WorkRequestResourceWorkRequest), string(keys.WorkRequestActionRead))
	for _, route := range []struct {
		method, path string
		class        enforcement.Classification
		handle       func(*gin.Context) error
	}{
		{http.MethodPost, "/api/hr/requests", enforcement.Authorize(string(keys.EmployeeResourceEmployee), string(keys.EmployeeActionSubmitRequest)), r.submit},
		{http.MethodGet, "/api/hr/requests", read, r.list},
		{http.MethodGet, "/api/hr/requests/:id", read, r.detail},
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

func answer[T any](c *gin.Context, status int, value T) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	httpapi.WriteJSONBytes(c, status, body)
	return nil
}

// submit checks Origin and CSRF before the body, the key or the session is read.
func (r Routes) submit(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[submitBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseSubmit(c.Request.Header.Values("Idempotency-Key"), body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	result, err := r.Requests.Submit(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return answer(c, http.StatusCreated, result)
}

func (r Routes) list(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	query, err := parseRequestList(c.Request.URL.RawQuery)
	if err != nil {
		return err
	}
	view, err := r.Requests.List(c.Request.Context(), secret, query)
	if err != nil {
		return err
	}
	return answer(c, http.StatusOK, view)
}

func (r Routes) detail(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	id, err := httpapi.InputUUID(c.Param("id"))
	if err != nil {
		return err
	}
	view, found, err := r.Requests.Detail(c.Request.Context(), secret, id)
	if err != nil {
		return err
	}
	if !found {
		return apperror.ErrNotFound
	}
	return answer(c, http.StatusOK, view)
}
