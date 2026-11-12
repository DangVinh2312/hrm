package attendance

import (
	"encoding/json/v2"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/enforcement"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/httpapi"
)

// Routes are the monthly sheets, the close and reopen of a month and HR's adjustments; absent and not
// visible are the same 404.
type Routes struct {
	Attendance HTTPPort
	Origin     string
}

func (r Routes) Register(group *httpapi.Group) error {
	employee, company := string(keys.EmployeeResourceEmployee), string(keys.CompanyResourceCompany)
	managePeriod := enforcement.Authorize(company, string(keys.CompanyActionManagePeriod))
	for _, route := range []struct {
		method, path string
		class        enforcement.Classification
		handle       func(*gin.Context) error
	}{
		{http.MethodGet, "/api/hr/employees/:id/attendance", enforcement.Authorize(employee, string(keys.EmployeeActionReadAttendance)), r.sheet},
		{http.MethodGet, "/api/hr/attendance/periods/:month", enforcement.Authorize(company, string(keys.CompanyActionRead)), r.periodState},
		{http.MethodPost, "/api/hr/attendance/periods/:month/close", managePeriod, r.closePeriod},
		{http.MethodPost, "/api/hr/attendance/periods/:month/reopen", managePeriod, r.reopenPeriod},
		{http.MethodGet, "/api/hr/employees/:id/attendance-adjustments", enforcement.Authorize(employee, string(keys.EmployeeActionReadAttendanceAdjustment)), r.adjustments},
		{http.MethodPost, "/api/hr/employees/:id/attendance-adjustments", enforcement.Authorize(employee, string(keys.EmployeeActionAdjustAttendance)), r.adjust},
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

func answerFound[T any](c *gin.Context, value T, ok bool, err error) error {
	if err != nil {
		return err
	}
	if !ok {
		return apperror.ErrNotFound
	}
	return answer(c, http.StatusOK, value)
}

func (r Routes) sheet(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	query, err := parseSheetQuery(c.Param("id"), c.Request.URL.RawQuery)
	if err != nil {
		return err
	}
	view, ok, err := r.Attendance.Sheet(c.Request.Context(), secret, query)
	return answerFound(c, view, ok, err)
}

func (r Routes) periodState(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	month, err := parseMonth(c.Param("month"))
	if err != nil {
		return err
	}
	view, ok, err := r.Attendance.PeriodState(c.Request.Context(), secret, month)
	return answerFound(c, view, ok, err)
}

func (r Routes) adjustments(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	query, err := parseAdjustmentQuery(c.Param("id"), c.Request.URL.RawQuery)
	if err != nil {
		return err
	}
	view, ok, err := r.Attendance.Adjustments(c.Request.Context(), secret, query)
	return answerFound(c, view, ok, err)
}

// closePeriod takes no body or `{}`; Origin and CSRF come before the body, the month or the session.
func (r Routes) closePeriod(c *gin.Context) error {
	if err := httpapi.DecodeEmptyCommand(c, r.Origin); err != nil {
		return err
	}
	month, err := parseMonth(c.Param("month"))
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	result, err := r.Attendance.ClosePeriod(c.Request.Context(), secret, month)
	if err != nil {
		return err
	}
	return answer(c, http.StatusOK, result)
}

func (r Routes) reopenPeriod(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[reopenBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseReopen(c.Param("month"), body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	result, err := r.Attendance.ReopenPeriod(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return answer(c, http.StatusOK, result)
}

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
	result, err := r.Attendance.Adjust(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return answer(c, http.StatusCreated, result)
}
