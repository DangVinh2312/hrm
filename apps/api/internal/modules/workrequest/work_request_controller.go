package workrequest

import (
	"context"
	"encoding/json/v2"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/enforcement"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/httpapi"
)

// Routes are the caller's own requests (submit, list, detail) and decisions on others' (decide, the queues,
// the decided history).
type Routes struct {
	Requests HTTPPort
	Origin   string
}

func (r Routes) Register(group *httpapi.Group) error {
	request := string(keys.WorkRequestResourceWorkRequest)
	read := enforcement.Authorize(request, string(keys.WorkRequestActionRead))
	for _, route := range []struct {
		method, path string
		class        enforcement.Classification
		handle       func(*gin.Context) error
	}{
		{http.MethodPost, "/api/hr/requests", enforcement.Authorize(string(keys.EmployeeResourceEmployee), string(keys.EmployeeActionSubmitRequest)), r.submit},
		{http.MethodGet, "/api/hr/requests", read, r.list},
		{http.MethodGet, "/api/hr/requests/:id", read, r.detail},
		// The permission follows the stored state, never the caller: classified by session only, the service
		// authorizes the stage on the locked row.
		{http.MethodPost, "/api/hr/requests/:id/decision", enforcement.Authenticated(), r.decide},
		{http.MethodPost, "/api/hr/requests/:id/cancel", enforcement.Authenticated(), r.cancel},
		{http.MethodGet, "/api/hr/approvals/lead", enforcement.Authorize(request, string(keys.WorkRequestActionDecideLead)), page(r, r.Requests.LeadQueue)},
		{http.MethodGet, "/api/hr/approvals/final", enforcement.Authorize(request, string(keys.WorkRequestActionDecideFinal)), page(r, r.Requests.FinalQueue)},
		{http.MethodGet, "/api/hr/approvals/decided", enforcement.Authorize(request, string(keys.WorkRequestActionReadDecided)), page(r, r.Requests.Decided)},
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
	return page(r, r.Requests.List)(c)
}

// page answers a `?limit=&offset=` list of the session.
func page[V any](r Routes, read func(context.Context, string, ListQuery) (V, error)) func(*gin.Context) error {
	return func(c *gin.Context) error {
		secret, err := httpapi.SessionSecret(c.Request, r.Origin)
		if err != nil {
			return err
		}
		query, err := parseRequestList(c.Request.URL.RawQuery)
		if err != nil {
			return err
		}
		view, err := read(c.Request.Context(), secret, query)
		if err != nil {
			return err
		}
		return answer(c, http.StatusOK, view)
	}
}

// decide checks Origin and CSRF before the body, the key or the session is read.
func (r Routes) decide(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[decisionBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseDecision(c.Param("id"), c.Request.Header.Values("Idempotency-Key"), body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	result, found, err := r.Requests.Decide(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	if !found {
		return apperror.ErrNotFound
	}
	return answer(c, http.StatusOK, result)
}

// cancel checks Origin and CSRF before the body, the key or the session is read.
func (r Routes) cancel(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[cancelBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseCancel(c.Param("id"), c.Request.Header.Values("Idempotency-Key"), body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	result, found, err := r.Requests.Cancel(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	if !found {
		return apperror.ErrNotFound
	}
	return answer(c, http.StatusOK, result)
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
