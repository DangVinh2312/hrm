package leave

import (
	"encoding/json/v2"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/enforcement"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/httpapi"
)

// Routes are the balance reads and HR's ledger adjustment; absent and not visible are the same 404.
type Routes struct {
	Leave  HTTPPort
	Origin string
}

func (r Routes) Register(group *httpapi.Group) error {
	resource := string(keys.EmployeeResourceEmployee)
	read := enforcement.Authorize(resource, string(keys.EmployeeActionReadLeaveBalance))
	for _, route := range []struct {
		method, path string
		class        enforcement.Classification
		handle       func(*gin.Context) error
	}{
		{http.MethodGet, "/api/hr/employees/:id/leave-balance", read, r.balance},
		{http.MethodGet, "/api/hr/leave/reconciliation", read, r.reconciliation},
		{http.MethodPost, "/api/hr/employees/:id/leave-adjustments", enforcement.Authorize(resource, string(keys.EmployeeActionAdjustLeaveBalance)), r.adjust},
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

func (r Routes) balance(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	query, err := parseBalanceQuery(c.Param("id"), c.Request.URL.RawQuery)
	if err != nil {
		return err
	}
	view, found, err := r.Leave.Balance(c.Request.Context(), secret, query)
	if err != nil {
		return err
	}
	if !found {
		return apperror.ErrNotFound
	}
	return answer(c, http.StatusOK, view)
}

func (r Routes) reconciliation(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	query, err := parseReconciliationQuery(c.Request.URL.RawQuery)
	if err != nil {
		return err
	}
	view, err := r.Leave.Reconciliation(c.Request.Context(), secret, query)
	if err != nil {
		return err
	}
	return answer(c, http.StatusOK, view)
}

// adjust checks Origin and CSRF before the body, the key or the session is read.
func (r Routes) adjust(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[adjustmentBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseAdjustment(c.Param("id"), c.Request.Header.Values("Idempotency-Key"), body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	result, err := r.Leave.Adjust(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return answer(c, http.StatusCreated, result)
}
